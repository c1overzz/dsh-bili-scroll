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

设计上的两个要点：
  ① **模型走国内镜像**（HF_ENDPOINT=hf-mirror.com）—— 否则 HuggingFace 拉不动
  ② **音频不落盘到别处**：yt-dlp 下到临时目录，转写完就随系统清理
"""
import argparse
import asyncio
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


# [patch-asr v2 backup_url]
def _fetch_audio_bili_api(url: str, tmp: str, tag: str) -> str:
    """[本机补丁] 用已登录的 bilibili_api 取 DASH 音频流并下载。

    为什么不再依赖 yt-dlp：2026-10-22 起 B站 把网页里的 window.__INITIAL_STATE__
    改成了「先赋值再读」的写法，yt-dlp 全部版本（实测到 2026.10.21）都报
    "Unable to extract initial state" 直接放弃。我们有凭证、有 bilibili_api，
    走 playurl API 就能拿到音频，不需要解析网页。

    依赖：bilibili-api-python + aiohttp（已装进 .venv-asr）。
    """
    import importlib
    import json

    from bilibili_api import Credential, register_client, video

    # [本机补丁] bilibili_api 17.4.2 的 __register_all_clients 有 bug：
    #   curl_cffi / aiohttp / httpx 都不在时，异常被吞，一个请求客户端都没注册 ⇒
    #   任何 API 调用都报「尚未安装第三方请求库或未注册自定义第三方请求库」。
    _registered = False
    for _mod, _name in (('AioHTTPClient', 'AioHTTPClient'), ('HTTPXClient', 'HTTPXClient')):
        try:
            _m = importlib.import_module('bilibili_api.clients.' + _mod)
            register_client(_name, getattr(_m, _name), {})
            _registered = True
            break
        except Exception:
            continue
    if not _registered:
        raise RuntimeError('bilibili_api 没有可用的请求客户端（asr 环境里 aiohttp / httpx 都没装）')

    cred_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bili_credential.json')
    cred = None
    if os.path.exists(cred_file):
        try:
            with open(cred_file, encoding='utf-8') as f:
                c = json.load(f)
            cred = Credential(
                sessdata=c.get('sessdata', ''),
                bili_jct=c.get('bili_jct', ''),
                buvid3=c.get('buvid3') or '',
                dedeuserid=c.get('dedeuserid', ''),
            )
        except Exception:
            cred = None

    m = re.search(r'(BV[0-9A-Za-z]{10})', url)
    if not m:
        raise RuntimeError('不是 B站 视频链接，拿不到 BV 号：' + url)
    bvid = m.group(1)

    async def _get_urls() -> list:
        v = video.Video(bvid=bvid, credential=cred)
        info = await v.get_info()
        cid = info.get('cid') or (info.get('pages') or [{}])[0].get('cid')
        if not cid:
            raise RuntimeError('取不到 cid')
        data = await v.get_download_url(cid=int(cid))
        audios = ((data or {}).get('dash') or {}).get('audio') or []
        if not audios:
            raise RuntimeError('这条视频没有 DASH 音频流（可能是纯图文/互动视频）')
        best = max(audios, key=lambda a: a.get('bandwidth') or 0)
        # [本机补丁 · 2.2.0] playurl 每条流除了 base_url 还有 backup_url（2~3 个备用 CDN 域名）。
        #   CDN 域名是**每次随机分配**的，某个节点连不上（实测 809ak83l.edge.mountaintoys.cn:4483
        #   直接 signal timeout）时，换 backup_url 里的域名通常就能下 ⇒ 全部收集起来挨个试。
        urls = []
        for u in [best.get('base_url')] + list(best.get('backup_url') or []):
            if u and u not in urls:
                urls.append(u)
        return urls

    stream_urls = asyncio.run(_get_urls())
    out = os.path.join(tmp, tag + '.m4s')
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                      '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com',
    }

    # [本机补丁] 音频 CDN 是 mcdn.bilivideo.cn:8082 这类带端口的镜像，
    #   urllib 在本机会 SSL: UNEXPECTED_EOF_WHILE_READING；实测 aiohttp 同 URL 200 ⇒ 主用 aiohttp。
    def _dl_aiohttp(u: str) -> None:
        import aiohttp

        async def _run():
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=180)) as s:
                async with s.get(u, headers=headers) as r:
                    if r.status != 200:
                        raise RuntimeError('CDN 返回 %s' % r.status)
                    with open(out, 'wb') as f:
                        async for chunk in r.content.iter_chunked(1 << 16):
                            f.write(chunk)

        asyncio.run(_run())

    def _dl_urllib(u: str) -> None:
        import urllib.request
        req = urllib.request.Request(u, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as resp, open(out, 'wb') as f:
            while True:
                chunk = resp.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)

    last_err = None
    for su in stream_urls:
        done = False
        for dl in (_dl_aiohttp, _dl_urllib):
            try:
                dl(su)
                last_err = None
                done = True
                break
            except Exception as e:
                last_err = e
                print('[asr] 下载失败（%s: %s），换下一种方式…'
                      % (type(e).__name__, str(e)[:120]), file=sys.stderr)
        if done:
            break
        print('[asr] 这个 CDN 域名不通，换 backup_url 里的下一个…', file=sys.stderr)
    if last_err is not None:
        raise last_err
    if not os.path.exists(out) or os.path.getsize(out) < 1024:
        raise RuntimeError('音频流下下来是空的（风控？）')
    return out


def fetch_audio(url: str, tmp: str, tag: str) -> str:
    """把 B站 视频的音频拉下来。

    ① 优先走 bilibili_api（凭证 + playurl，不解析网页，不受前端改版影响）
    ② 失败才退回 yt-dlp（老路径留作保险）
    """
    try:
        return _fetch_audio_bili_api(url, tmp, tag)
    except Exception as e:
        print('[asr] bilibili_api 取音频失败（%s: %s），退回 yt-dlp…'
              % (type(e).__name__, str(e)[:200]), file=sys.stderr)

    # ② 老路径：yt-dlp（B站改版后大概率失败，留着当保险）
    import subprocess
    os.makedirs(tmp, exist_ok=True)
    out = os.path.join(tmp, tag + '.m4a')
    if os.path.exists(out) and os.path.getsize(out) > 1024:
        return out
    cmd = [
        sys.executable, '-m', 'yt_dlp', '-f', 'bestaudio/best',
        '--no-playlist', '--no-warnings', '-o', out, url,
    ]
    try:
        subprocess.run(cmd, check=True, timeout=180,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except Exception as e:
        raise RuntimeError('取音频彻底失败（bilibili_api 与 yt-dlp 都没成）：%s' % e)
    if not os.path.exists(out):
        raise RuntimeError('yt-dlp 说成功但没落文件')
    return out

def main() -> int:
    ap = argparse.ArgumentParser(description='把一条视频转成文字（默认中文）')
    ap.add_argument('target', help='BV 号 / B站链接 / 本地音视频文件')
    ap.add_argument('-o', '--out', help='写到这个文件（不给就打到标准输出）')
    ap.add_argument('--model', default=os.environ.get('BILI_DUTY_ASR_MODEL', 'small'),
                    help='Whisper 模型大小：tiny / base / small / medium（默认 small）')
    ap.add_argument('--lang', default='zh', help='语言（默认 zh；不给就自动判断请传 auto）')
    args = ap.parse_args()

    src = args.target
    # ⚠️ 不用 mkdtemp：沙箱只允许写"子进程启动前就存在"的目录，新建的会被拒 ✗
    #    这个目录由宿主（插件）预先建好；文件名固定，跑完自己清掉
    tmp = _TMP
    # ⭐ 每个视频用**自己的**文件名：以前写死 audio.m4a ⇒ 两轮同时跑会互相覆盖，
    #    上一轮转出来的其实是另一个视频的内容（2026-10-14 值班那轮亲踩 ✗）
    tag = os.path.basename(src).rsplit('.', 1)[0] or 'clip'
    tag = re.sub(r'[^0-9A-Za-z_-]', '_', tag)[:40] or 'clip'
    try:
        if src.lower().startswith('http') or src.upper().startswith('BV'):
            print('[asr] 先下音频…', file=sys.stderr)
            src = fetch_audio(to_url(src), tmp, tag)
        if not os.path.exists(src):
            print('[asr] 找不到文件：' + src, file=sys.stderr)
            return 2

        from faster_whisper import WhisperModel
        print('[asr] 加载模型 %s（第一次会自动下模型，之后就是本地读）…' % args.model, file=sys.stderr)
        model = WhisperModel(args.model, device='cpu', compute_type='int8')
        print('[asr] 开始转写…', file=sys.stderr)
                # [本机补丁] 显式解码成 16k 单声道再喂给 Whisper（.m4s 后缀它按扩展名不认）
        audio_input = src
        try:
            import av
            import numpy as np
            container = av.open(src)
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
            chunks = [rf.to_ndarray().reshape(-1)
                      for frame in container.decode(stream)
                      for rf in resampler.resample(frame)]
            container.close()
            audio_input = np.concatenate(chunks).astype(np.float32) / 32768.0
            print('[asr] 音频 %.1f 秒' % (len(audio_input) / 16000.0), file=sys.stderr)
        except Exception as e:
            print('[asr] PyAV 解码失败（%s: %s），交给 faster-whisper 处理'
                  % (type(e).__name__, str(e)[:120]), file=sys.stderr)

        segments, _info = model.transcribe(
            audio_input,

            language=None if args.lang == 'auto' else args.lang,
            vad_filter=True,          # 掐掉静音段，省时间也少出错
        )
        text = ''.join(seg.text for seg in segments).strip()
    finally:
        # 临时音频不留在磁盘上
        try:
            import glob
            for f in glob.glob(os.path.join(tmp, tag + '.*')):
                try:
                    os.remove(f)
                except Exception:
                    pass
        except Exception:
            pass

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(text)
        print('[asr] 已写入：' + args.out, file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
