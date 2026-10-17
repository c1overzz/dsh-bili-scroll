#!/usr/bin/env python3
"""frames.py — 给一条 B站 视频抽一张「九宫格关键帧」拼图，让多模态模型能真的"看"。

用法:
  <家目录>/.venv/bin/python <家目录>/frames.py <BV号> [--n 9] [--cols 3] [--height 480]

  n      抽几帧（默认 9，3x3）
  cols   每行几帧（默认 3）
  height 下载的视频高度上限（默认 480；调大更清楚但更慢）

stdout 最后一行是 JSON:
  {"ok":true,"bvid":"BV...","title":"...","duration":612.0,"pubdate":1697000000,
   "days_ago":3.2,"sheet":"/abs/path/BVxxx.jpg","cells":9,"times":[30.6,...]}
失败时: {"ok":false,"error":"..."}，退出码 1。

设计要点（为什么这样抽）:
- 只拉 video-only 的 480p 轨（B站 DASH 音视频分离，不用合并、不要音频），
  十来分钟的视频通常 2~5 MB，一两秒下完。
- **长视频只下"每帧前后 8 秒"的小片段**（yt-dlp --download-sections），
  一小时的视频也只下几 MB —— 不会为了 9 张图把整支视频拖下来。
- 时间点从 5% 到 95% 均匀取，避开片头（封面/LOGO）和片尾（"关注三连"）。
- 每格左上角烧时间码（Pillow 画，不用 ffmpeg 的 drawtext —— 本机这个 ffmpeg 没编 freetype）。
- 拼成一张图 ⇒ 只花**一次**视觉调用的钱。
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(HERE, "tmp", "frames")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

LONG_SECONDS = 1200      # 超过 20 分钟走"片段下载"
SECTION_LEN = 8          # 每段多长（秒）
KEEP_SHEETS_DAYS = 4     # 旧的拼图留几天
COOKIE_ARGS = []         # --cookie 时由 main() 填
AUDIO_FULL_LIMIT = 600   # 10 分钟以内整条音频转写；更长只转每帧前后各 6 秒
CLIP_HALF = 6            # 每帧前后各留几秒音频


def fail(msg):
    print(json.dumps({"ok": False, "error": str(msg)}, ensure_ascii=False))
    sys.exit(1)


def find_bin(names, extra=()):
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    for p in extra:
        if os.path.exists(p):
            return p
    return None


def ytdlp():
    for cand in (
        os.path.join(HERE, ".venv-asr", "bin", "yt-dlp"),
        os.path.join(HERE, ".venv", "bin", "yt-dlp"),
        "/opt/homebrew/bin/yt-dlp",
        "/usr/local/bin/yt-dlp",
    ):
        if os.path.exists(cand):
            return cand
    return shutil.which("yt-dlp")


def ffmpeg_pair():
    ff = find_bin(["ffmpeg"], ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"))
    fp = find_bin(["ffprobe"], ("/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"))
    return ff, fp


def cookie_args():
    """设置页开了「下载时用账号 Cookie」才走这儿：拿 bili_credential.json 拼一个 Cookie 头。"""
    p = os.path.join(HERE, "bili_credential.json")
    try:
        with open(p) as f:
            d = json.load(f)
    except Exception:
        return []
    parts = []
    for src, dst in (("sessdata", "SESSDATA"), ("bili_jct", "bili_jct"),
                     ("buvid3", "buvid3"), ("dedeuserid", "DedeUserID")):
        v = d.get(src) or d.get(dst)
        if v:
            parts.append(f"{dst}={v}")
    return ["--add-header", "Cookie: " + "; ".join(parts)] if parts else []


def api_meta(bvid):
    """公开接口拿标题/时长/发布日 —— 只为标注和"要不要走片段下载"，拿不到就算了。"""
    out = {}
    try:
        url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=8) as r:
            j = json.load(r)
        d = (j or {}).get("data") or {}
        out = {
            "title": d.get("title"),
            "duration": float(d.get("duration") or 0) or None,
            "pubdate": d.get("pubdate"),
            "cover": d.get("pic"),
            "author": (d.get("owner") or {}).get("name"),
        }
    except Exception:
        pass
    return out


def probe_duration(ffprobe, path):
    try:
        r = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=30,
        )
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def download_full(yt, bvid, height, workdir):
    """整条视频的纯视频轨（短视频用这个）。返回本地路径。"""
    target = os.path.join(workdir, "v.%(ext)s")
    cmd = [
        yt, "--no-warnings", "--no-part", "--no-playlist", *COOKIE_ARGS,
        "-f", f"bv*[height<={height}]/b[height<={height}]/bv*/b",
        "--print", "after_move:filepath",
        "-o", target,
        f"https://www.bilibili.com/video/{bvid}",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "").strip().splitlines()[-1:] or "yt-dlp 失败")
    for p in reversed([ln.strip() for ln in r.stdout.splitlines() if ln.strip()]):
        if os.path.exists(p):
            return p
    for f in os.listdir(workdir):
        if f.startswith("v."):
            return os.path.join(workdir, f)
    raise RuntimeError("下载完成但找不到文件")


def download_sections(yt, bvid, height, stamps, workdir):
    """只下每个时间点前后一小段（长视频用这个）。返回 {起始秒: 文件路径}。"""
    cmd = [
        yt, "--no-warnings", "--no-part", "--no-playlist", "--no-cache-dir", *COOKIE_ARGS,
        "-f", f"bv*[height<={height}]/b[height<={height}]/bv*/b",
        "-o", os.path.join(workdir, "s_%(section_start)s.%(ext)s"),
        f"https://www.bilibili.com/video/{bvid}",
    ]
    for s in stamps:
        cmd.insert(-1, "--download-sections")
        cmd.insert(-1, f"*{int(s)}-{int(s) + SECTION_LEN}")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    out = {}
    for f in glob.glob(os.path.join(workdir, "s_*")):
        base = os.path.basename(f)
        try:
            key = int(base.split("_")[1].split(".")[0])
        except Exception:
            continue
        out[key] = f
    if r.returncode != 0 and not out:
        raise RuntimeError((r.stderr or "").strip().splitlines()[-1:] or "分段下载失败")
    return out


def download_audio_full(yt, bvid, workdir):
    """整条音轨（短视频用）。"""
    cmd = [yt, "--no-warnings", "--no-part", "--no-playlist", *COOKIE_ARGS,
           "-f", "ba/b", "--print", "after_move:filepath",
           "-o", os.path.join(workdir, "a.%(ext)s"),
           f"https://www.bilibili.com/video/{bvid}"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "").strip().splitlines()[-1:] or "音频下载失败")
    for pth in reversed([ln.strip() for ln in r.stdout.splitlines() if ln.strip()]):
        if os.path.exists(pth):
            return pth
    for f in os.listdir(workdir):
        if f.startswith("a."):
            return os.path.join(workdir, f)
    raise RuntimeError("音频下载完成但找不到文件")


def download_audio_clips(yt, bvid, workdir, stamps):
    """只下每个时间点前后 CLIP_HALF 秒的音频（长视频用）。返回 [(t, path)]"""
    cmd = [yt, "--no-warnings", "--no-part", "--no-playlist", "--no-cache-dir", *COOKIE_ARGS,
           "-f", "ba/b", "-o", os.path.join(workdir, "a_%(section_start)s.%(ext)s"),
           f"https://www.bilibili.com/video/{bvid}"]
    for t in stamps:
        lo = max(0, int(t) - CLIP_HALF)
        cmd.insert(-1, "--download-sections")
        cmd.insert(-1, f"*{lo}-{lo + CLIP_HALF * 2}")
    subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    got = {}
    for f in glob.glob(os.path.join(workdir, "a_*")):
        try:
            key = int(os.path.basename(f).split("_")[1].split(".")[0])
        except Exception:
            continue
        got[key] = f
    out = []
    for t in stamps:
        lo = max(0, int(t) - CLIP_HALF)
        if lo in got:
            out.append((t, got[lo]))
    return out


def run_asr(files, model):
    """调家目录的 asr.py（独立环境）一次性转多个文件 → [[{start,end,text}], …]"""
    py = None
    for cand in (os.path.join(HERE, ".venv-asr", "bin", "python"),
                 os.path.join(HERE, ".venv-asr", "Scripts", "python.exe"),
                 os.path.join(HERE, ".venv-asr", "Scripts", "python")):
        if os.path.exists(cand):
            py = cand
            break
    script = os.path.join(HERE, "asr.py")
    if not py or not os.path.exists(script):
        raise RuntimeError("没装本地转写环境（.venv-asr）")
    cmd = [py, script, *files, "--json", "--model", model or "small"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "").strip()[-200:] or "转写失败")
    lines = [x for x in (r.stdout or "").strip().splitlines() if x.strip()]
    if not lines:
        raise RuntimeError("转写没有输出")
    data = json.loads(lines[-1])
    return [f.get("segments") or [] for f in data.get("files", [])]


def window_text(segs, lo, hi):
    return "".join((sg.get("text") or "") for sg in segs
                   if float(sg.get("end", 0) or 0) >= lo and float(sg.get("start", 0) or 0) <= hi)


def grab(ff, src, t, out_path):
    r = subprocess.run(
        [ff, "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", src,
         "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "3", out_path],
        capture_output=True, text=True, timeout=90,
    )
    return r.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 512


def compose(ims, cols, sheet_path):
    """Pillow 拼图 + 烧时间码。"""
    from PIL import Image, ImageDraw, ImageFont

    cell_h = max(im.height for _, im in ims)
    rows = (len(ims) + cols - 1) // cols
    pad, bar = 6, 22
    sheet = Image.new("RGB", (cols * 480 + (cols + 1) * pad,
                               rows * (cell_h + bar) + (rows + 1) * pad), (18, 18, 20))
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 17)
    except Exception:
        font = ImageFont.load_default()

    for i, (t, im) in enumerate(ims):
        r, c = divmod(i, cols)
        x = pad + c * (480 + pad)
        y = pad + r * (cell_h + bar + pad)
        sheet.paste(im, (x, y))
        mm, ss = divmod(int(t), 60)
        d.rectangle([x, y + cell_h, x + 480, y + cell_h + bar], fill=(28, 28, 32))
        d.text((x + 6, y + cell_h + 2), f"#{i + 1}  {mm:02d}:{ss:02d}", font=font, fill=(240, 240, 240))

    sheet.save(sheet_path, quality=86, optimize=True)


def prune():
    """清掉几天的旧拼图。"""
    cutoff = time.time() - KEEP_SHEETS_DAYS * 86400
    for f in glob.glob(os.path.join(TMP, "*.jpg")):
        try:
            if os.path.getmtime(f) < cutoff:
                os.remove(f)
        except Exception:
            pass


def main():
    global COOKIE_ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("bvid")
    ap.add_argument("--n", type=int, default=9)
    ap.add_argument("--cols", type=int, default=0)   # 0 = 按帧数自动排（4→2×2，9→3×3，16→4×4）
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--audio", action="store_true",
                    help="顺便下音轨用本地 Whisper 转出「每帧前后说了什么」（不受 UP 改字幕影响，但慢）")
    ap.add_argument("--asr-model", default="small", help="本地转写用的模型（默认 small）")
    ap.add_argument("--cookie", action="store_true",
                    help="下载时带账号 Cookie（设置页那个开关）：能拿更高清，但请求挂在账号上")
    ap.add_argument("--keep", action="store_true", help="保留下载的视频（调试用）")
    a = ap.parse_args()

    if a.cookie:
        COOKIE_ARGS = cookie_args()

    bvid = a.bvid.strip()
    if not bvid.upper().startswith("BV"):
        fail("请传 BV 号，例如 BV1awJX6HEDM")

    ff, fp = ffmpeg_pair()
    if not ff:
        fail("本机找不到 ffmpeg")
    yt = ytdlp()
    if not yt:
        fail("找不到 yt-dlp（.venv-asr/bin/yt-dlp）")

    os.makedirs(TMP, exist_ok=True)
    prune()
    workdir = tempfile.mkdtemp(prefix=f"{bvid}-", dir=TMP)
    meta = api_meta(bvid)

    try:
        dur = float(meta.get("duration") or 0)
        if not dur:
            dur = probe_duration(fp, download_full(yt, bvid, a.height, workdir))

        n = max(1, min(a.n, 16))
        if dur < 25:
            n = min(n, 4)
        lo, hi = dur * 0.05, max(dur * 0.06, dur * 0.95)
        step = (hi - lo) / max(1, n - 1) if n > 1 else 0
        times = [lo + i * step for i in range(n)]

        from PIL import Image

        def collect(srcs):
            ims = []
            for i, (t, src, offset) in enumerate(srcs):
                out = os.path.join(workdir, f"f{i:02d}.jpg")
                if not grab(ff, src, t + offset, out):
                    continue
                im = Image.open(out).convert("RGB")
                h = int(im.height * 480 / im.width)
                ims.append((t, im.resize((480, h), Image.LANCZOS)))
            return ims

        ims = []
        if dur > LONG_SECONDS:
            try:
                segs = download_sections(yt, bvid, a.height, [int(t) for t in times], workdir)
                if segs:
                    ims = collect([(t, segs.get(int(t), next(iter(segs.values()))),
                                    t - int(t)) for t in times])
            except Exception:
                ims = []
        if len(ims) < 2:                       # 短视频 / 分段失败 ⇒ 整条下
            video = download_full(yt, bvid, a.height, workdir)
            ims = collect([(t, video, 0.0) for t in times])
        if not ims:
            fail("一帧都没抽出来（视频可能加密或格式异常）")

        sheet = os.path.join(TMP, f"{bvid}.jpg")
        grid = {4: 2, 9: 3, 16: 4}.get(len(ims)) or max(1, int(len(ims) ** 0.5 + 0.5))
        compose(ims, max(1, min(a.cols or grid, 4)), sheet)

        # ⭐ 音频来源的「每帧说了什么」：不受 UP 改字幕影响（画面上的硬字幕可能是规避写法）
        audio_lines = []
        audio_src = "off"
        if a.audio:
            try:
                if dur <= AUDIO_FULL_LIMIT:
                    af = download_audio_full(yt, bvid, workdir)
                    segs = run_asr([af], a.asr_model)[0]
                    audio_lines = [{"i": i + 1, "t": round(t, 1),
                                    "text": window_text(segs, t - 2.0, t + 4.0)[:140]}
                                   for i, t in enumerate(times)]
                    audio_src = "local-asr-full"
                else:
                    clips = download_audio_clips(yt, bvid, workdir, times)
                    segs_list = run_asr([pp for _, pp in clips], a.asr_model) if clips else []
                    audio_lines = [{"i": i + 1, "t": round(tt, 1),
                                    "text": "".join(sg.get("text") or "" for sg in sgs)[:140]}
                                   for i, ((tt, _), sgs) in enumerate(zip(clips, segs_list))]
                    audio_src = "local-asr-clips"
            except Exception as e:
                audio_src = "error:" + str(e)[:120]

        pub = meta.get("pubdate")
        print(json.dumps({
            "ok": True,
            "bvid": bvid,
            "title": meta.get("title"),
            "author": meta.get("author"),
            "duration": round(dur, 1),
            "pubdate": pub,
            "days_ago": round((time.time() - pub) / 86400, 1) if pub else None,
            "sheet": sheet,
            "cells": len(ims),
            "times": [round(t, 1) for t, _ in ims],
            "note": "用 read_image 看这张拼图；格子从左到右、从上到下排，每格左下角是时间码。",
            "audio_lines": audio_lines,
            "audio_source": audio_src,
        }, ensure_ascii=False))
    except Exception as e:
        fail(e)
    finally:
        if a.keep:
            print(f"[keep] {workdir}", file=sys.stderr)
        else:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
