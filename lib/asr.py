#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr.py —— 把一条 B站 视频（或本地音视频文件）转成文字。
给"这个视频没有字幕、但又值得判断"的情况用。

用法（在插件的 ASR 环境里跑）：
    .venv-asr/Scripts/python.exe asr.py BV1xxxxxxxxx          # Windows
    .venv-asr/bin/python       asr.py https://www.bilibili.com/video/BV1xx
    .venv-asr/Scripts/python.exe asr.py D:\\some\\clip.mp4 -o out.txt
    …还可以加 --model small / --model medium 换模型（默认 small）
    …需要限制正文时加 --max-chars 20000（默认 0，不截断）

退出码：0 = 非空正文成功输出；2 = 参数错误或输入文件不存在；
        3 = 无转写正文（stdout 为空，保留既有输出文件）；
        4 = 锁/输出路径等环境错误；6 = 同一目标正被其它进程转写。
        未处理的下载、依赖或转写异常通常退出 1，诊断写入 stderr。
调用方应检查退出码；不要仅凭输出文件存在判定本次运行成功。

设计上的两个要点：
  ① **模型走国内镜像**（HF_ENDPOINT=hf-mirror.com）—— 否则 HuggingFace 拉不动
  ② **音频不落盘到别处**：yt-dlp 下到临时目录，转写完就随系统清理
"""
import argparse
import os
import re
import sys
import tempfile

# ⭐ Windows 上 Python 默认按 GBK 编/解码标准输出 —— 中文或 emoji 打进管道会直接炸
#    （有用户反馈装依赖 / 跑转写时报 UnicodeDecodeError 或乱码）⇒ 这里钉死 UTF-8
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# ⚠️ 临时目录必须待在家目录里：值班那一轮跑在沙箱里（只允许写工作区/cwd），
#    yt-dlp 默认往 %TEMP% 写、会被直接拒掉（2026-10-14 在主人机器上实证：
#    yt_dlp DownloadError: unable to open for writing: [Errno 13] Permission denied）
_HOME = os.path.dirname(os.path.abspath(__file__))
_TMP = os.path.join(_HOME, 'tmp', 'asr')
try:
    os.makedirs(_TMP, exist_ok=True)
    tempfile.tempdir = _TMP
except Exception:
    pass

# 部分 httpx 环境不能解析 no_proxy 中的 [::1] 等方括号 IPv6 条目。
# 仅在本子进程移除这些条目，以避免模型下载初始化抛 InvalidURL。
for _k in ('no_proxy', 'NO_PROXY'):
    _v = os.environ.get(_k)
    if _v:
        try:
            _kept = [p for p in _v.split(',') if '[' not in p and ']' not in p]
            os.environ[_k] = ','.join(_kept)
        except Exception:
            pass

# ⭐ 必须在 import faster_whisper **之前**设好，否则它已经去连 HuggingFace 了
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
# 模型缓存放本脚本所在目录（= 插件家）：默认的 ~/.cache 在本机拒绝写入
os.environ.setdefault('HF_HOME', os.path.join(os.path.dirname(os.path.abspath(__file__)), '.hf-cache'))
# HuggingFace 新版存储（Xet）国内镜像不代理 ⇒ 关掉它，走老 CDN 通道（否则 401）
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')


def to_url(target: str) -> str:
    t = target.strip()
    if t.upper().startswith('BV') and len(t) <= 20:
        return 'https://www.bilibili.com/video/' + t
    return t


def fetch_audio(url: str, tmp: str, tag: str) -> str:
    """用 yt-dlp 把音频拉下来（B站 是 DASH 音视频分离，取 bestaudio 即可，不需要 ffmpeg 合并）"""
    from yt_dlp import YoutubeDL
    opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(tmp, tag + '.%(ext)s'),   # ⭐ 用 BV 号当文件名：固定名会和别的轮次撞车（踩过）
        'paths': {'home': tmp, 'temp': tmp},   # 别让 yt-dlp 往 %TEMP% 写（沙箱会拒）
        'cachedir': False,                      # 顺手别去动用户目录里的缓存
        # ⭐ nopart：不写 .part 再改名，直接落最终文件。
        #    沙箱里"新建文件 + 改名"会被拒，而这条能绕开（2026-10-14 值班那一轮自己试出来的）
        'nopart': True,
        # [本地修复 2026-10-18 · 审计 H2] 进度条默认打到 stdout，调用方按 stdout 取正文时
        # 拿到的前 1KB 全是 [download] xx%（实测 1046~3488 B），且「输出非空=成功」恒真。
        'noprogress': True,
        'quiet': True,
        'no_warnings': True,
        # [本地修复 · 审计 H3] 残留文件不续传、直接覆盖：否则 yt-dlp 会尝试 Range 续传并撞 HTTP 416
        'overwrites': True,
        'continuedl': False,
        'noplaylist': True,
        'http_headers': {
            'Referer': 'https://www.bilibili.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
    }
    # Clear only this target's owned audio files. A failure must not silently
    # reuse a partial download; the lock inode lives in the parent directory.
    import glob
    for old in glob.glob(os.path.join(tmp, tag + '.*')):
        try:
            os.remove(old)
        except FileNotFoundError:
            pass
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        for downloaded in info.get('requested_downloads') or []:
            path = downloaded.get('filepath')
            if path and os.path.isfile(path):
                return path
        return ydl.prepare_filename(info)


def acquire_target_lock(path):
    """Kernel-owned advisory lock: process death releases it automatically.

    Keep its inode outside the audio directory and never unlink it. Removing
    an open lock lets another process acquire a different inode for the same
    target, defeating exclusion.
    """
    import errno
    handle = open(path, 'a+b')
    try:
        if os.name == 'nt':
            import msvcrt
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b'0')
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except OSError as error:
        handle.close()
        if error.errno in (errno.EACCES, errno.EAGAIN):
            return None
        raise
    except BaseException:
        handle.close()
        raise


def main() -> int:
    import hashlib
    import shutil
    ap = argparse.ArgumentParser(description='把一条视频转成文字（默认中文）')
    ap.add_argument('target', help='BV 号 / B站链接 / 本地音视频文件')
    ap.add_argument('-o', '--out', help='写到这个文件（不给就打到标准输出）')
    ap.add_argument('--max-chars', type=int, default=0,
                    help='正文字符上限，包含截断提示（默认 0 = 不限）')
    ap.add_argument('--model', default=os.environ.get('BILI_DUTY_ASR_MODEL', 'small'))
    ap.add_argument('--lang', default='zh', help='语言（默认 zh；自动判断请传 auto）')
    args = ap.parse_args()
    if args.max_chars < 0:
        ap.error('--max-chars 必须为非负整数')
    src = args.target
    if not os.path.isfile(src):
        src = src.strip()
    if args.out is not None:
        args.out = os.path.abspath(args.out)
        out_dir = os.path.dirname(args.out)
        if not os.path.isdir(out_dir):
            print('[asr] 输出目录不存在：' + out_dir, file=sys.stderr)
            return 4
        if os.path.isdir(args.out):
            print('[asr] 输出路径是目录：' + args.out, file=sys.stderr)
            return 4

    remote = not os.path.isfile(src) and bool(re.match(r'^https?://', src, re.I) or re.fullmatch(r'BV[0-9A-Za-z]{10}', src, re.I))
    identity = to_url(src).rstrip('/') if remote else os.path.normcase(os.path.realpath(src))
    label = re.sub(r'[^0-9A-Za-z_-]', '_', os.path.basename(identity).rsplit('.', 1)[0])[:40] or 'clip'
    tag = label + '-' + hashlib.sha256(os.fsencode(identity)).hexdigest()[:12]
    tmp = os.path.join(_TMP, tag)
    try:
        lock = acquire_target_lock(os.path.join(_TMP, tag + '.lock'))
    except OSError as error:
        print('[asr] 无法取得转写锁：%s' % error, file=sys.stderr)
        return 4
    if lock is None:
        print('[asr] 同一个内容正在被另一轮转写，先跳过（exit 6）', file=sys.stderr)
        return 6
    try:
        os.makedirs(tmp, exist_ok=True)
        if remote:
            print('[asr] 先下音频…', file=sys.stderr)
            src = fetch_audio(to_url(src), tmp, tag)
        if not os.path.exists(src):
            print('[asr] 找不到文件：' + src, file=sys.stderr)
            return 2
        from faster_whisper import WhisperModel
        print('[asr] 加载模型 %s…' % args.model, file=sys.stderr)
        model = WhisperModel(args.model, device='cpu', compute_type='int8')
        print('[asr] 开始转写…', file=sys.stderr)
        segments, _info = model.transcribe(src,
            language=None if args.lang == 'auto' else args.lang, vad_filter=True)
        text = ''.join(seg.text for seg in segments).strip()
        if not text:
            print('[asr] 没转出任何文字（exit 3）；保留已有输出文件', file=sys.stderr)
            return 3
        limit = args.max_chars
        if limit > 0 and len(text) > limit:
            print('[asr] 正文 %d 字，超过上限 %d，已截断' % (len(text), limit), file=sys.stderr)
            marker = '\n…（已截断）'
            text = text[:limit-len(marker)] + marker if limit > len(marker) else text[:limit]
        if args.out:
            staged = None
            try:
                # A failed write must not truncate the previous good result.
                with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                        dir=out_dir, prefix='.' + os.path.basename(args.out) + '.',
                        suffix='.tmp', delete=False) as output:
                    staged = output.name
                    output.write(text)
                os.replace(staged, args.out)
                staged = None
            except OSError as error:
                print('[asr] 写文件失败：%s' % error, file=sys.stderr)
                return 4
            finally:
                if staged is not None:
                    try: os.remove(staged)
                    except OSError: pass
            print('[asr] 已写入：' + args.out, file=sys.stderr)
        else:
            print(text)
        return 0
    finally:
        try:
            shutil.rmtree(tmp, ignore_errors=True)
        finally:
            lock.close()


if __name__ == '__main__':
    raise SystemExit(main())
