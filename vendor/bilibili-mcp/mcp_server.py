#!/usr/bin/env python3
"""
Bilibili MCP Server
B站数据采集 MCP 服务，支持 OpenClaw / Claude Code / Cursor / Cline

功能：搜索视频、抓取评论、获取字幕、弹幕、回复评论
首次运行需扫码登录B站，凭证自动保存复用
"""

# ⭐ 这个文件是从上游 AGI_Ananas/bilibili-mcp（MIT，见同目录 LICENSE）vendor 进来的。
#    本插件在它上面只加了下面这几处 —— **将来重新 vendor 时，这几处要原样补回来**（漏一处就少一道闸 ✗）：
#      ① `_ALLOWED` + `tool()` 白名单替身：工具按名单注册，名单外的连名字都不出现（见下）
#      ② `load_credential` 读取容错 + encoding="utf-8" + isinstance(data, dict) 校验
#      ③ 登录成功后凭证**原子写**（先写 .tmp 再 os.replace）
#      ④ `bili_comments` 把抓取异常带进返回（风控 -412 不再伪装成"这条视频 0 条评论"）
#      ⑤ `bili_reply` 回执带上 `rpid` / `rpid_str` / `root` / `parent`（判重表与评论复核要用）
#      ⑥ `bili_cover` / `bili_frames`：封面和画面帧**作为图片**返回（上游没有；
#         图能不能进模型上下文由宿主判断）
import asyncio
import json
import base64
import os
import re
import struct
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from mcp.server.fastmcp import FastMCP
from mcp.types import ImageContent, TextContent

from bilibili_api import video, search, comment, Credential, dynamic, opus
from bilibili_api import hot, rank, user, session, favorite_list
from bilibili_api.video_uploader import (
    VideoUploader, VideoUploaderPage, VideoMeta, Lines,
)
from bilibili_api.utils.picture import Picture
from bilibili_api.login_v2 import QrCodeLogin, QrCodeLoginEvents

# ========== 初始化 ==========

CRED_FILE = Path(__file__).parent / "bili_credential.json"

mcp = FastMCP("bilibili-mcp")

# ⭐ 工具白名单（2026-10-17 审查里的 H3）：宿主通过 overlay 的 env 下发 BILI_MCP_TOOLS（逗号分隔）。
#    · 不给这个变量 ⇒ **全放**（手工跑、或老配置，行为一点不变 ✓）
#    · 给了 ⇒ 只注册名单里的；不在名单里的工具**连名字都不会出现在 list_tools 里**，
#      模型那边等于根本不存在 —— 这才是真的闸门（光靠提示词说"别用"不算）✓
_ALLOWED = {t.strip() for t in os.environ.get("BILI_MCP_TOOLS", "").split(",") if t.strip()}

# ⭐ 2026-10-24：私信收件人白名单（宿主 overlay 下发 BILI_DUTY_DM_UID）。
#    白名单只能决定"这个工具在不在"，管不了"发给谁" —— 被注入的提示词可以把报告内容私信给第三个人。
#    宿主下发后就只允许发给这个 UID；没下发则保持旧行为。
_DM_UIDS = set()
for _x in os.environ.get("BILI_DUTY_DM_UID", "").split(","):
    _x = _x.strip()
    if _x.isdigit():
        _DM_UIDS.add(int(_x))


def tool():
    """@tool() 的替身：白名单里没有这个函数名，就原样返回、**不注册**。"""
    def deco(fn):
        if _ALLOWED and fn.__name__ not in _ALLOWED:
            return fn
        return mcp.tool()(fn)
    return deco


# ⭐⭐ 2026-10-23 安全加固（issue #39）：**白名单以前只挡"注册"，不挡"直接调用"** ——
#    agent 手里有 python/shell，可以自己写脚本 import 这个文件再调函数 ⇒ 闸门形同虚设。
#    ⇒ 每个"会往 B站 写东西"的函数入口都过一遍 _guard()；没开就直接返回、什么都不做 ✓
def _guard(name: str) -> str:
    """没开这个工具就返回一句提示；开着返回空串。"""
    if _ALLOWED and name not in _ALLOWED:
        print(f"[bili-mcp] 拒绝调用 {name}（不在 BILI_MCP_TOOLS 白名单里）", file=sys.stderr)
        return f"这个工具没开：{name}"
    return ""


def load_credential() -> Credential:
    """从文件加载凭证"""
    if not CRED_FILE.exists():
        return None
    try:
        with open(CRED_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        # ⚠️ 文件写坏一次（上一次写被打断）会让**所有**工具一起 JSONDecodeError：
        #    这里退化成「没登录」，重新扫一次码就能恢复。（2026-10-16 审查修）
        print(f"[bili-mcp] 凭证读不了（{type(e).__name__}: {e}）：{CRED_FILE}", file=sys.stderr)
        return None
    if not isinstance(data, dict):
        return None
    return Credential(
        sessdata=data.get("sessdata", ""),
        bili_jct=data.get("bili_jct", ""),
        buvid3=data.get("buvid3") or "",
        dedeuserid=data.get("dedeuserid", ""),
    )


# ========== Tool: 值班轮的「窄接口」（读判重表 / 写报告 / 追加判重） ==========

# ⭐⭐ 2026-10-24 安全加固（值班轮权限面）：
#    值班那一轮**不再有 shell 和文件工具**（overlay 里把 tool-fs / tool-bash 这些行禁用），
#    读判重表、写报告、追加归档只能走下面三个接口 —— **校验在服务端做、落盘之前拦**。
#    · 路径一律服务端拼，参数里不接受路径（没有 date 之外的路径参数）
#    · 拒绝本机私有信息（/root/、/sdcard/、~/.dsh、会话 id、密钥、凭证文件名）
#    · 报告 ≤ 64 KB；标题行只能是「### BV号」（宿主靠它数今天挑了几条）
#    · 判重表一次最多追加 200 行，只接受表格行
_ROOT = Path(__file__).parent
_REPORT_DIR = _ROOT / "out"
_SEEN_FILE = _ROOT / "seen.md"
_DIGEST_DIR = _ROOT / "digest"
_MAX_REPORT_BYTES = 64 * 1024
_MAX_ROWS = 200
_MAX_SEEN_LINES = 2000
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_BV_RE = re.compile(r"BV[0-9A-Za-z]{8,}")
_BV_HEAD_RE = re.compile(r"^###\s*BV[0-9A-Za-z]{8,}\s*$")
_ROW_COLS = 5  # | 日期 | BV | 标题 | UP | 状态 |
_PRIVATE = [
    (re.compile(r"/root/", re.I), "本机绝对路径 /root/"),
    (re.compile(r"/sdcard/", re.I), "本机绝对路径 /sdcard/"),
    (re.compile(r"\.dsh", re.I), "DSH 数据目录"),
    (re.compile(r"session-[0-9a-f]{8}", re.I), "会话 id"),
    (re.compile(r"sk-[A-Za-z0-9_-]{12,}", re.I), "密钥"),
    (re.compile(r"bili_credential", re.I), "凭证文件名"),
]


def _reject_private(text: str) -> str:
    """内容里出现本机私有信息就拒；返回拒绝原因，没问题返回空串。"""
    for rx, label in _PRIVATE:
        if rx.search(text):
            return f"拒绝：内容里出现{label}（{rx.pattern}）—— 报告/归档不许带本机私有信息"
    return ""


def _checkReport(text: str) -> str:
    if not str(text).strip():
        return "拒绝：报告是空的"
    size = len(str(text).encode("utf-8"))
    if size > _MAX_REPORT_BYTES:
        return f"拒绝：报告太大（{size} 字节，上限 {_MAX_REPORT_BYTES // 1024} KB）"
    bad = _reject_private(str(text))
    if bad:
        return bad
    for line in str(text).splitlines():
        if line.startswith("### ") and not _BV_HEAD_RE.match(line.strip()):
            return f"拒绝：标题行只能写「### BV号」，不许多加别的 ### 标题（宿主靠它数挑中几条）：{line[:60]}"
    return ""


def _checkRows(rows) -> str:
    if not isinstance(rows, list):
        return "拒绝：rows 必须是字符串数组，一行一条"
    if not rows:
        return "拒绝：rows 是空的"
    if len(rows) > _MAX_ROWS:
        return f"拒绝：一次最多追加 {_MAX_ROWS} 行（给了 {len(rows)} 行）"
    for raw in rows:
        line = str(raw).strip()
        if not line.startswith("|") or not line.endswith("|"):
            return f"拒绝：只接受表格行（| 日期 | BV号 | 标题 | UP | 状态 |）：{line[:60]}"
        cols = [c.strip() for c in line.strip("|").split("|")]
        if len(cols) != _ROW_COLS:
            return f"拒绝：表格行要有 {_ROW_COLS} 列（日期/BV号/标题/UP/状态），这行有 {len(cols)} 列：{line[:60]}"
        if not _DATE_RE.match(cols[0]):
            return f"拒绝：第一列必须是日期 YYYY-MM-DD：{line[:60]}"
        if not _BV_RE.search(cols[1]):
            return f"拒绝：第二列必须是 BV 号：{line[:60]}"
    bad = _reject_private("\n".join(str(r) for r in rows))
    if bad:
        return bad
    return ""


def _atomicWrite(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


@tool()
async def read_seen(days: int = 30) -> str:
    """
    读判重表（含「评论记录」那张表）。值班轮没有文件工具，判重只能走这里。

    Args:
        days: 只把多少天内的视频表格行带上（评论记录表整段带上）；默认 30，上限 365

    Returns:
        包含 lines 与 text 的 JSON；text 是判重表原文（表头 + 近期视频行 + 评论记录）
    """
    try:
        d = max(1, min(365, int(days or 30)))
    except (TypeError, ValueError):
        d = 30
    cutoff = (datetime.now() - timedelta(days=d)).strftime("%Y-%m-%d")
    if not _SEEN_FILE.exists():
        return json.dumps({"ok": True, "lines": 0, "text": "", "note": "判重表还不存在（第一次跑）"}, ensure_ascii=False)
    try:
        raw = _SEEN_FILE.read_text(encoding="utf-8")
    except OSError as e:
        return json.dumps({"ok": False, "error": f"判重表读不出来：{e}"}, ensure_ascii=False)
    lines = raw.splitlines()
    kept = []
    comment_section = False
    for ln in lines:
        stripped = ln.strip()
        if stripped.startswith("## "):
            comment_section = "评论记录" in stripped
            kept.append(ln)
            continue
        if not stripped.startswith("|"):
            kept.append(ln)
            continue
        if comment_section:
            kept.append(ln)
            continue
        first = stripped.strip("|").split("|")[0].strip()
        if _DATE_RE.match(first):
            if first >= cutoff:
                kept.append(ln)
        else:
            kept.append(ln)   # 表头 / 分隔行
    kept = kept[-_MAX_SEEN_LINES:]
    text = "\n".join(kept).strip("\n")
    return json.dumps({"ok": True, "days": d, "cutoff": cutoff, "text": text}, ensure_ascii=False)


@tool()
async def append_seen(date: str, rows: list) -> str:
    """
    往判重表和归档里追加记录（挑中的、跳过的都写）。值班轮没有文件工具，只能走这里。

    Args:
        date: 今天，YYYY-MM-DD
        rows: 字符串数组，一行一条，格式 `| 日期 | BV号 | 标题 | UP | 状态 |`
              例：`["| 2026-10-24 | BV1abc12345 | 某个标题 | 某UP | 挑中 · 值得看 |"]`

    Returns:
        JSON：写了几行、写到哪两个文件；被拒时 ok=false 并说明原因
    """
    day = str(date or "").strip()
    if not _DATE_RE.match(day):
        return json.dumps({"ok": False, "error": f"拒绝：date 必须是 YYYY-MM-DD，收到 {day!r}"}, ensure_ascii=False)
    err = _checkRows(rows)
    if err:
        return json.dumps({"ok": False, "error": err}, ensure_ascii=False)
    body = "".join(str(r).strip() + "\n" for r in rows)
    try:
        _SEEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        if not _SEEN_FILE.exists():
            _atomicWrite(_SEEN_FILE, "# 刷B站的判重表\n\n## 看过的视频\n\n| 日期 | BV号 | 标题 | UP | 状态 |\n|---|---|---|---|---|\n" + body)
        else:
            try:
                cur = _SEEN_FILE.read_text(encoding="utf-8")
            except OSError:
                cur = ""
            # 表头缺就补一次（宿主预建的文件里，「看过的视频」下面一开始没有表头）
            if "| 日期 | BV号" not in cur:
                with open(_SEEN_FILE, "a", encoding="utf-8") as f:
                    f.write("| 日期 | BV号 | 标题 | UP | 状态 |\n|---|---|---|---|---|\n")
            with open(_SEEN_FILE, "a", encoding="utf-8") as f:
                f.write(body)
        digest = _DIGEST_DIR / f"{day[:7]}.md"
        if not digest.exists():
            _atomicWrite(digest, f"# 刷B站的归档 · {day[:7]}\n\n（看过的每一条都在这里，只为留档）\n\n" + body)
        else:
            with open(digest, "a", encoding="utf-8") as f:
                f.write(body)
    except OSError as e:
        return json.dumps({"ok": False, "error": f"写不进去：{e}"}, ensure_ascii=False)
    return json.dumps({"ok": True, "rows": len(rows), "seen": str(_SEEN_FILE), "digest": str(digest)}, ensure_ascii=False)


@tool()
async def append_comment(bv: str, rpid: str, root: str = "", time: str = "", excerpt: str = "") -> str:
    """
    把「发出去的评论」记进判重表的「评论记录」表（宿主复核要认 rpid）。值班轮没有文件工具，只能走这里。

    Args:
        bv: 视频 BV 号，如 BV1abc12345
        rpid: bili_reply 返回里的 rpid（数字）；拿不到就传空串，服务端会写「未取到」
        root: 回复楼中楼时，被回复那条根评论的 rpid；不是楼中楼就留空
        time: 时间，随便写，如 2026-10-24 18:20
        excerpt: 正文前 20 字

    Returns:
        JSON：写没写进去；被拒时 ok=false（要在报告里如实写"被拒"）
    """
    b = str(bv or "").strip()
    if not re.fullmatch(r"BV[0-9A-Za-z]{8,}", b):
        return json.dumps({"ok": False, "error": f"拒绝：bv 不像 BV 号：{b!r}"}, ensure_ascii=False)
    r = str(rpid or "").strip()
    if r and not r.isdigit():
        return json.dumps({"ok": False, "error": f"拒绝：rpid 必须是数字（拿不到就传空串，别编）：{r!r}"}, ensure_ascii=False)
    rt = str(root or "").strip()
    if rt and not rt.isdigit():
        return json.dumps({"ok": False, "error": f"拒绝：root 必须是数字或空：{rt!r}"}, ensure_ascii=False)
    tm = " ".join(str(time or "").split())[:40]
    ex = " ".join(str(excerpt or "").split())[:60]
    bad = _reject_private(" ".join([b, r, rt, tm, ex]))
    if bad:
        return json.dumps({"ok": False, "error": bad}, ensure_ascii=False)
    row = f"| {b} | {r or '未取到 rpid'} | {rt or ''} | {tm} | {ex} |\n"
    header = "## 评论记录（BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字）\n\n| BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字 |\n| --- | --- | --- | --- | --- |\n"
    try:
        _SEEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        if not _SEEN_FILE.exists():
            _atomicWrite(_SEEN_FILE, "# 刷B站的判重表\n\n" + header + row + "\n## 看过的视频\n\n")
        else:
            lines = _SEEN_FILE.read_text(encoding="utf-8").splitlines(keepends=True)
            at = -1
            for i, ln in enumerate(lines):
                if ln.strip().startswith("| BV | rpid"):
                    at = i + 2  # 表头 + 分隔行之后
                    break
            if at < 0:
                with open(_SEEN_FILE, "a", encoding="utf-8") as f:
                    f.write("\n" + header + row)
            else:
                lines.insert(at, row)
                _atomicWrite(_SEEN_FILE, "".join(lines))
    except OSError as e:
        return json.dumps({"ok": False, "error": f"写不进去：{e}"}, ensure_ascii=False)
    return json.dumps({"ok": True, "bv": b, "rpid": r or "未取到 rpid", "root": rt, "seen": str(_SEEN_FILE)}, ensure_ascii=False)


@tool()
async def write_report(date: str, markdown: str, replace: bool = False) -> str:
    """
    写当天的日报（out/<日期>.md）。值班轮没有文件工具，写报告只能走这里。
    服务端会校验：非空、≤64 KB、不许带本机私有信息、`### ` 标题只能是 BV 号。

    Args:
        date: 今天，YYYY-MM-DD
        markdown: 报告正文（每条挑中的视频第一行写 `### BV号`）
        replace: true = 覆盖整天；默认 false = 追加到已有报告末尾（配额按全天算）

    Returns:
        JSON：落盘路径与字节数；被拒时 ok=false 并说明原因（要如实写进报告）
    """
    day = str(date or "").strip()
    if not _DATE_RE.match(day):
        return json.dumps({"ok": False, "error": f"拒绝：date 必须是 YYYY-MM-DD，收到 {day!r}"}, ensure_ascii=False)
    text = str(markdown or "")
    err = _checkReport(text)
    if err:
        return json.dumps({"ok": False, "error": err}, ensure_ascii=False)
    path = _REPORT_DIR / f"{day}.md"
    try:
        if path.exists() and not replace:
            old = path.read_text(encoding="utf-8").rstrip("\n")
            text = old + "\n\n" + text.strip() + "\n"
        else:
            text = text.strip() + "\n"
        _atomicWrite(path, text)
    except OSError as e:
        return json.dumps({"ok": False, "error": f"写不进去：{e}"}, ensure_ascii=False)
    return json.dumps({"ok": True, "file": str(path), "bytes": len(text.encode("utf-8")), "replaced": bool(replace)}, ensure_ascii=False)


# ========== 登录会话（进程级缓存） ==========

_login_session: QrCodeLogin | None = None


def get_cred() -> Credential:
    """获取凭证，未登录时引导用户调用 bili_login"""
    cred = load_credential()
    if not cred:
        raise Exception("未登录B站！请先调用 bili_login 工具获取登录二维码，让用户扫码登录。")
    return cred


# ========== Tool: 扫码登录（生成二维码） ==========

@tool()
async def bili_login() -> str:
    """
    生成B站登录二维码，返回二维码图片（base64）供用户扫码。
    用户扫码后，调用 bili_login_check 检查登录状态。

    Returns:
        包含二维码base64图片数据的JSON，前端可直接渲染为图片展示给用户
    """
    global _login_session

    # 如果已有凭证，直接返回
    cred = load_credential()
    if cred:
        return json.dumps({
            "status": "already_logged_in",
            "message": "已登录B站，无需重复登录",
        }, ensure_ascii=False)

    # 生成新的登录会话
    _login_session = QrCodeLogin()
    await _login_session.generate_qrcode()

    # 获取二维码图片的 base64（无损PNG）
    pic = _login_session.get_qrcode_picture()
    img_base64 = base64.b64encode(pic.content).decode("utf-8")

    # 保存二维码图片到项目根目录
    qr_file = Path(__file__).parent / "qrcode_login.png"
    with open(qr_file, "wb") as f:
        f.write(pic.content)

    # 获取终端文本版二维码（纯文本客户端备用）
    terminal_qr = _login_session.get_qrcode_terminal()

    # 获取原始扫码URL（用户也可以手动在B站App打开）
    qr_url = getattr(_login_session, "_QrCodeLogin__qr_link", "")

    return json.dumps({
        "status": "qrcode_ready",
        "message": "请用B站App扫描二维码登录（180秒内有效）",
        "qrcode_image": f"data:image/png;base64,{img_base64}",
        "qrcode_file": str(qr_file),
        "qrcode_terminal": terminal_qr,
        "qrcode_url": qr_url,
        "next_step": "用户扫码后，请调用 bili_login_check 检查登录状态",
    }, ensure_ascii=False)


# ========== Tool: 检查登录状态 ==========

@tool()
async def bili_login_check() -> str:
    """
    检查B站扫码登录状态。在用户扫码后调用此工具。
    如果返回 "scanning" 或 "confirming"，请等待几秒后再次调用。
    如果返回 "done"，登录成功，可以使用其他工具了。
    如果返回 "timeout"，需要重新调用 bili_login 生成新二维码。

    Returns:
        当前登录状态
    """
    global _login_session

    if not _login_session:
        # 没有登录会话，检查是否已登录
        cred = load_credential()
        if cred:
            return json.dumps({
                "status": "already_logged_in",
                "message": "已登录B站",
            }, ensure_ascii=False)
        return json.dumps({
            "status": "no_session",
            "message": "没有进行中的登录，请先调用 bili_login 生成二维码",
        }, ensure_ascii=False)

    state = await _login_session.check_state()

    if state == QrCodeLoginEvents.SCAN:
        return json.dumps({
            "status": "scanning",
            "message": "已扫码，等待用户在手机上确认...",
            "next_step": "请等待3秒后再次调用 bili_login_check",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.CONF:
        return json.dumps({
            "status": "confirming",
            "message": "用户已确认，正在处理...",
            "next_step": "请等待2秒后再次调用 bili_login_check",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.TIMEOUT:
        _login_session = None
        # 清理二维码文件
        qr_file = Path(__file__).parent / "qrcode_login.png"
        if qr_file.exists():
            qr_file.unlink()
        return json.dumps({
            "status": "timeout",
            "message": "二维码已过期，请重新调用 bili_login 生成新二维码",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.DONE:
        # 登录成功，保存凭证
        cred = _login_session.get_credential()
        # ⚠️ 原子写：原来直接 open(w) 先截断再 dump，写到一半被打断就毁掉旧凭证，
        #    此后所有工具都读不了。（2026-10-16 审查修）
        tmp_cred = CRED_FILE.with_name(CRED_FILE.name + ".tmp")
        with open(tmp_cred, "w", encoding="utf-8") as f:
            json.dump({
                "sessdata": cred.sessdata,
                "bili_jct": cred.bili_jct,
                "buvid3": cred.buvid3,
                "dedeuserid": cred.dedeuserid,
            }, f)
        os.replace(tmp_cred, CRED_FILE)
        _login_session = None
        # 清理二维码文件
        qr_file = Path(__file__).parent / "qrcode_login.png"
        if qr_file.exists():
            qr_file.unlink()
        return json.dumps({
            "status": "done",
            "message": "登录成功！凭证已保存，现在可以使用所有B站功能了",
        }, ensure_ascii=False)

    return json.dumps({
        "status": "unknown",
        "message": f"未知状态: {state}",
    }, ensure_ascii=False)


# ========== Tool: 登录状态查询 ==========

@tool()
async def bili_check_credential() -> str:
    """
    检查当前B站登录凭证是否有效

    Returns:
        登录状态信息
    """
    cred = load_credential()
    if not cred:
        return json.dumps({
            "logged_in": False,
            "message": "未登录，请调用 bili_login 进行扫码登录",
        }, ensure_ascii=False)

    # 尝试用凭证请求一下，验证是否过期
    try:
        my_info = await user.User(
            uid=int(cred.dedeuserid), credential=cred
        ).get_user_info()
        return json.dumps({
            "logged_in": True,
            "uid": cred.dedeuserid,
            "username": my_info.get("name", ""),
            "message": "凭证有效",
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "logged_in": False,
            "message": f"凭证可能已过期: {str(e)}，请重新调用 bili_login 登录",
        }, ensure_ascii=False)


# ========== Tool 1: 搜索视频 ==========

@tool()
async def bili_search(keyword: str, num: int = 10, order: str = "totalrank") -> str:
    """
    搜索B站视频

    Args:
        keyword: 搜索关键词，如"AI Agent"、"大模型教程"
        num: 返回视频数量，默认10，最大50
        order: 排序方式 totalrank=综合 click=播放量 pubdate=最新 dm=弹幕
    
    Returns:
        JSON格式的视频列表，包含标题、BV号、播放量、评论数、UP主等
    """
    order_map = {
        "totalrank": search.OrderVideo.TOTALRANK,
        "click": search.OrderVideo.CLICK,
        "pubdate": search.OrderVideo.PUBDATE,
        "dm": search.OrderVideo.DM,
    }
    order_enum = order_map.get(order, search.OrderVideo.TOTALRANK)

    result = await search.search_by_type(
        keyword=keyword,
        search_type=search.SearchObjectType.VIDEO,
        page=1,
        order_type=order_enum,
    )

    videos = []
    for item in result.get("result", [])[:num]:
        title = item.get("title", "").replace('<em class="keyword">', "").replace("</em>", "")
        videos.append({
            "bvid": item.get("bvid", ""),
            "aid": item.get("aid", 0),
            "title": title,
            "author": item.get("author", ""),
            "play": item.get("play", 0),
            "review": item.get("review", 0),
            "danmaku": item.get("video_review", 0),
            "duration": item.get("duration", ""),
            "description": item.get("description", "")[:200],
        })

    return json.dumps({"keyword": keyword, "count": len(videos), "videos": videos}, ensure_ascii=False)


# ========== Tool 2: 获取评论 ==========

@tool()
async def bili_comments(bvid: str, num: int = 30) -> str:
    """
    获取B站视频的热门评论

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
        num: 获取评论数量，默认30
    
    Returns:
        JSON格式的评论列表，包含用户名、评论内容、点赞数、回复数
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = info["aid"]

    comments = []
    page = 1
    fetch_error = None
    while len(comments) < num:
        try:
            resp = await comment.get_comments(
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                page_index=page,
                order=comment.OrderType.LIKE,
                credential=cred,
            )
            replies = resp.get("replies") or []
            if not replies:
                break

            for r in replies:
                member = r.get("member", {})
                content = r.get("content", {})
                c = {
                    "rpid": r.get("rpid", 0),
                    "user": member.get("uname", ""),
                    "content": content.get("message", ""),
                    "like": r.get("like", 0),
                    "reply_count": r.get("rcount", 0),
                    "time": r.get("ctime", 0),
                }
                # 子评论
                sub_replies = []
                for sub in (r.get("replies") or [])[:2]:
                    sub_replies.append({
                        "user": sub.get("member", {}).get("uname", ""),
                        "content": sub.get("content", {}).get("message", ""),
                        "like": sub.get("like", 0),
                    })
                if sub_replies:
                    c["top_replies"] = sub_replies
                comments.append(c)

            page += 1
            await asyncio.sleep(0.5)
        except Exception as e:
            # ⚠️ 抓取失败（风控 -412 / 网络错）不能吞成「这条视频 0 条评论」：
            #    调用方必须能分辨「真没评论」和「没抓到」，否则日报静默失真。（2026-10-16 审查修）
            fetch_error = f"{type(e).__name__}: {e}"
            break

    out = {"bvid": bvid, "count": len(comments[:num]), "comments": comments[:num]}
    if fetch_error:
        out["error"] = fetch_error
    return json.dumps(out, ensure_ascii=False)


# ========== Tool 3: 获取字幕 ==========

@tool()
async def bili_subtitle(bvid: str) -> str:
    """
    获取B站视频的AI字幕（语音转文字）

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
    
    Returns:
        视频的完整字幕文本
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)

    info = await v.get_info()
    cid = info.get("cid", 0)
    if not cid and info.get("pages"):
        cid = info["pages"][0].get("cid", 0)

    if not cid:
        return json.dumps({"error": "无法获取cid"}, ensure_ascii=False)

    subtitle_list = await v.get_subtitle(cid=cid)
    subtitles = subtitle_list.get("subtitles", [])

    if not subtitles:
        return json.dumps({"message": "该视频没有字幕"}, ensure_ascii=False)

    # 优先AI中文字幕
    target = None
    for s in subtitles:
        if s.get("lan") in ["ai-zh", "zh-CN", "zh"]:
            target = s
            break
    if not target:
        target = subtitles[0]

    # 下载字幕
    import aiohttp
    sub_url = target.get("subtitle_url", "")
    if sub_url.startswith("//"):
        sub_url = "https:" + sub_url

    async with aiohttp.ClientSession() as session:
        async with session.get(sub_url) as resp:
            sub_data = await resp.json()

    texts = [item.get("content", "") for item in sub_data.get("body", [])]
    full_text = "\n".join(texts)

    return json.dumps({
        "bvid": bvid,
        "title": info.get("title", ""),
        "language": target.get("lan_doc", ""),
        "segments": len(texts),
        "text": full_text,
    }, ensure_ascii=False)


# ========== Tool 4: 获取弹幕 ==========

@tool()
async def bili_danmaku(bvid: str, num: int = 100) -> str:
    """
    获取B站视频的弹幕

    Args:
        bvid: 视频BV号
        num: 获取弹幕数量，默认100
    
    Returns:
        弹幕列表，包含弹幕文本和出现时间
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)

    danmakus = await v.get_danmakus(page_index=0)
    result = []
    for d in danmakus[:num]:
        result.append({
            "text": d.text,
            "time": d.dm_time,
        })

    return json.dumps({"bvid": bvid, "count": len(result), "danmakus": result}, ensure_ascii=False)


# ========== Tool 5: 视频详情 ==========

@tool()
async def bili_video_info(bvid: str) -> str:
    """
    获取B站视频的详细信息

    Args:
        bvid: 视频BV号
    
    Returns:
        视频标题、描述、UP主、播放量、评论数、收藏数等详细数据
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    stat = info.get("stat", {})

    return json.dumps({
        "bvid": info.get("bvid"),
        "aid": info.get("aid"),
        "title": info.get("title"),
        "description": info.get("desc"),
        "author": info.get("owner", {}).get("name"),
        "duration": info.get("duration"),
        "pages": len(info.get("pages", [])),
        "tags": [t.get("tag_name") for t in info.get("tag", []) if t.get("tag_name")],
        "stat": {
            "view": stat.get("view", 0),
            "danmaku": stat.get("danmaku", 0),
            "reply": stat.get("reply", 0),
            "favorite": stat.get("favorite", 0),
            "coin": stat.get("coin", 0),
            "like": stat.get("like", 0),
            "share": stat.get("share", 0),
        },
    }, ensure_ascii=False)


# ========== Tool 6: 回复评论 ==========

@tool()
async def bili_reply(bvid: str, text: str, rpid: int = 0, root: int = 0) -> str:
    """
    在B站视频下发表评论或回复某条评论

    Args:
        bvid: 视频BV号
        text: 评论/回复的文本内容
        rpid: 要回复的目标评论ID（0表示发表新评论）
        root: 楼层根评论ID（回复一级评论时不用填，回复楼中楼时填根评论ID）
    
    Returns:
        发表结果
    """
    _deny = _guard("bili_reply")
    if _deny: return _deny
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = info["aid"]

    try:
        if rpid == 0:
            # 发表新评论
            result = await comment.send_comment(
                text=text,
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                credential=cred,
            )
        else:
            # 回复评论
            # root=0 表示回复一级评论，root=rpid
            # root!=0 表示回复楼中楼，root=根评论，parent=目标评论
            actual_root = root if root != 0 else rpid
            result = await comment.send_comment(
                text=text,
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                root=actual_root,
                parent=rpid,
                credential=cred,
            )

        # ⭐ 把回执里的 rpid 带回去：判重表要靠它记「我们发过哪条」，宿主的评论复核
        #    （lib/verify.mjs）也要拿它去 B站 查公开可见性。只回 success 的话那条链是断的。
        #（2026-10-16 审查修：原实现把上面的 result 丢掉了）
        out = {"success": True, "message": "评论发送成功"}
        if isinstance(result, dict):
            for key in ("rpid", "rpid_str", "root", "parent"):
                val = result.get(key)
                if isinstance(val, (int, str)) and str(val).strip() and str(val) != "0":
                    out[key] = val
        return json.dumps(out, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 7: 批量采集 ==========

@tool()
async def bili_crawl(keyword: str, max_videos: int = 5, comments_per_video: int = 20, get_subtitles: bool = True) -> str:
    """
    批量采集：搜索B站视频并抓取每个视频的评论和字幕

    Args:
        keyword: 搜索关键词
        max_videos: 最多采集视频数，默认5
        comments_per_video: 每个视频采集评论数，默认20
        get_subtitles: 是否获取字幕，默认True
    
    Returns:
        包含视频信息、评论和字幕的完整采集数据
    """
    cred = get_cred()

    # 搜索
    search_result = await search.search_by_type(
        keyword=keyword,
        search_type=search.SearchObjectType.VIDEO,
        page=1,
        order_type=search.OrderVideo.TOTALRANK,
    )

    results = []
    for item in search_result.get("result", [])[:max_videos]:
        bvid = item.get("bvid", "")
        if not bvid:
            continue

        title = item.get("title", "").replace('<em class="keyword">', "").replace("</em>", "")
        video_data = {
            "bvid": bvid,
            "title": title,
            "author": item.get("author", ""),
            "play": item.get("play", 0),
            "review": item.get("review", 0),
        }

        # 评论
        comments_json = await bili_comments(bvid=bvid, num=comments_per_video)
        comments_data = json.loads(comments_json)

        # 字幕
        subtitle_text = ""
        if get_subtitles:
            try:
                subtitle_json = await bili_subtitle(bvid=bvid)
                subtitle_data = json.loads(subtitle_json)
                subtitle_text = subtitle_data.get("text", "")
            except:
                pass

        results.append({
            "video": video_data,
            "comments": comments_data.get("comments", []),
            "subtitle_text": subtitle_text,
        })

        await asyncio.sleep(1)

    return json.dumps({
        "keyword": keyword,
        "video_count": len(results),
        "total_comments": sum(len(r["comments"]) for r in results),
        "results": results,
    }, ensure_ascii=False)


# ========== 辅助：封面处理 ==========

import subprocess


def _extract_cover_from_video(video_path: str) -> Picture:
    """从视频第3秒截取一帧作为封面，返回 Picture 对象"""
    tmp_cover = os.path.join(tempfile.gettempdir(), f"bili_cover_{os.getpid()}.png")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", "3", "-i", video_path,
             "-vframes", "1", "-q:v", "2", tmp_cover],
            capture_output=True, timeout=30,
        )
        if os.path.isfile(tmp_cover) and os.path.getsize(tmp_cover) > 0:
            return Picture.from_file(tmp_cover)
    finally:
        if os.path.isfile(tmp_cover):
            os.remove(tmp_cover)
    # fallback: 第0秒
    tmp_cover2 = os.path.join(tempfile.gettempdir(), f"bili_cover2_{os.getpid()}.png")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", "0", "-i", video_path,
             "-vframes", "1", "-q:v", "2", tmp_cover2],
            capture_output=True, timeout=30,
        )
        if os.path.isfile(tmp_cover2) and os.path.getsize(tmp_cover2) > 0:
            return Picture.from_file(tmp_cover2)
    finally:
        if os.path.isfile(tmp_cover2):
            os.remove(tmp_cover2)
    raise RuntimeError(f"无法从视频截取封面: {video_path}")

@tool()
async def bili_video_zones() -> str:
    """
    获取B站视频常用分区ID列表，供上传视频时选择tid参数

    Returns:
        常用分区ID及名称
    """
    zones = {
        "科技": {
            188: "科技资讯", 122: "野生技术协会", 95: "数码",
            208: "科技", 209: "手工",
        },
        "知识": {
            201: "科学", 124: "社科·法律·心理", 207: "财经商业",
            228: "人文历史", 36: "科技(知识)",
        },
        "生活": {
            21: "日常", 160: "生活记录", 230: "其他",
            231: "美食", 234: "健身", 161: "搞笑",
        },
        "游戏": {
            17: "单机游戏", 171: "电子竞技", 172: "手机游戏",
            65: "网络游戏",
        },
        "影视": {
            183: "影视杂谈", 138: "搞笑", 182: "影视剪辑",
        },
        "动画": {
            32: "完结动画", 33: "连载动画", 51: "MAD·AMV",
        },
        "音乐": {
            28: "原创音乐", 31: "翻唱", 59: "演奏",
        },
    }
    return json.dumps(zones, ensure_ascii=False)


# ========================================================================
#                        V1.2 — 数据分析 & 互动运营
# ========================================================================


# ========== Tool 13: 热门视频 ==========

@tool()
async def bili_hot_videos(pn: int = 1, ps: int = 20) -> str:
    """
    获取B站当前热门视频列表

    Args:
        pn: 页码，默认1
        ps: 每页数量，默认20，最大50

    Returns:
        热门视频列表，包含标题、播放量、UP主等
    """
    result = await hot.get_hot_videos(pn=pn, ps=min(ps, 50))
    videos = []
    for item in result.get("list", []):
        stat = item.get("stat", {})
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "author": item.get("owner", {}).get("name", ""),
            "play": stat.get("view", 0),
            "like": stat.get("like", 0),
            "danmaku": stat.get("danmaku", 0),
            "reply": stat.get("reply", 0),
            "desc": (item.get("desc", "") or "")[:100],
            "duration": item.get("duration", 0),
            "tname": item.get("tname", ""),
        })
    return json.dumps({"page": pn, "count": len(videos), "videos": videos}, ensure_ascii=False)


# ========== Tool 14: 热搜关键词 ==========

@tool()
async def bili_hot_buzzwords(page_num: int = 1, page_size: int = 20) -> str:
    """
    获取B站热搜词/热门关键词

    Args:
        page_num: 页码，默认1
        page_size: 每页数量，默认20

    Returns:
        热搜词列表
    """
    result = await hot.get_hot_buzzwords(page_num=page_num, page_size=page_size)
    return json.dumps(result, ensure_ascii=False)


# ========== Tool 15: 每周必看 ==========

@tool()
async def bili_weekly_hot(week: int = 0) -> str:
    """
    获取B站每周必看视频推荐

    Args:
        week: 期数（0表示获取期数列表，>0表示获取该期的视频）

    Returns:
        每周必看期数列表或指定期的视频列表
    """
    if week <= 0:
        result = await hot.get_weekly_hot_videos_list()
        return json.dumps(result, ensure_ascii=False)
    else:
        result = await hot.get_weekly_hot_videos(week=week)
        return json.dumps(result, ensure_ascii=False)


# ========== Tool 16: 排行榜 ==========

@tool()
async def bili_rank(category: str = "all", day: int = 3) -> str:
    """
    获取B站各分区排行榜

    Args:
        category: 分区名，可选值：
            all=全站 original=原创 rookie=新人
            douga=动画 music=音乐 dance=舞蹈 game=游戏
            knowledge=知识 technology=科技 sports=运动 car=汽车
            life=生活 food=美食 animal=动物 fashion=时尚
            ent=娱乐 cinephile=影视
        day: 时间维度，3=三日 7=七日

    Returns:
        排行榜视频列表
    """
    type_map = {
        "all": rank.RankType.All, "original": rank.RankType.Original,
        "rookie": rank.RankType.Rookie, "douga": rank.RankType.Douga,
        "music": rank.RankType.Music, "dance": rank.RankType.Dance,
        "game": rank.RankType.Game, "knowledge": rank.RankType.Knowledge,
        "technology": rank.RankType.Technology, "sports": rank.RankType.Sports,
        "car": rank.RankType.Car, "life": rank.RankType.Life,
        "food": rank.RankType.Food, "animal": rank.RankType.Animal,
        "fashion": rank.RankType.Fashion, "ent": rank.RankType.Ent,
        "cinephile": rank.RankType.Cinephile,
    }
    day_map = {3: rank.RankDayType.THREE_DAY, 7: rank.RankDayType.WEEK}

    rank_type = type_map.get(category.lower(), rank.RankType.All)
    rank_day = day_map.get(day, rank.RankDayType.THREE_DAY)

    result = await rank.get_rank(type_=rank_type, day=rank_day)
    videos = []
    for item in result.get("list", []):
        stat = item.get("stat", {})
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "author": item.get("owner", {}).get("name", ""),
            "play": stat.get("view", 0),
            "like": stat.get("like", 0),
            "coin": stat.get("coin", 0),
            "score": item.get("score", 0),
            "tname": item.get("tname", ""),
        })
    return json.dumps({"category": category, "day": day, "count": len(videos), "videos": videos}, ensure_ascii=False)


# ========== Tool 17: 用户信息 ==========

@tool()
async def bili_user_info(uid: int) -> str:
    """
    获取B站用户的详细信息

    Args:
        uid: 用户UID

    Returns:
        用户昵称、粉丝数、关注数、签名、等级、视频数等
    """
    cred = get_cred()
    u = user.User(uid=uid, credential=cred)
    info = await u.get_user_info()

    # 尝试获取UP主数据
    up_stat = {}
    try:
        up_stat = await u.get_up_stat()
    except:
        pass

    relation = {}
    try:
        relation = await u.get_relation_info()
    except:
        pass

    return json.dumps({
        "uid": uid,
        "name": info.get("name", ""),
        "sign": info.get("sign", ""),
        "level": info.get("level", 0),
        "face": info.get("face", ""),
        "fans": relation.get("follower", info.get("follower", 0)),
        "following": relation.get("following", info.get("following", 0)),
        "likes": up_stat.get("likes", 0),
        "archive_view": up_stat.get("archive", {}).get("view", 0),
        "article_view": up_stat.get("article", {}).get("view", 0),
        "is_senior_member": info.get("is_senior_member", 0),
        "top_photo": info.get("top_photo", ""),
    }, ensure_ascii=False)


# ========== Tool 18: 用户视频列表 ==========

@tool()
async def bili_user_videos(uid: int, pn: int = 1, ps: int = 30, order: str = "pubdate", keyword: str = "") -> str:
    """
    获取B站用户的投稿视频列表

    Args:
        uid: 用户UID
        pn: 页码，默认1
        ps: 每页数量，默认30
        order: 排序方式 pubdate=最新 click=播放量 stow=收藏
        keyword: 搜索关键词（在该用户视频中搜索）

    Returns:
        视频列表
    """
    cred = get_cred()
    u = user.User(uid=uid, credential=cred)

    order_map = {
        "pubdate": user.VideoOrder.PUBDATE,
        "click": user.VideoOrder.VIEW,
        "stow": user.VideoOrder.FAVORITE,
    }
    order_enum = order_map.get(order, user.VideoOrder.PUBDATE)

    result = await u.get_videos(pn=pn, ps=ps, order=order_enum, keyword=keyword)
    videos = []
    for item in result.get("list", {}).get("vlist", []):
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "play": item.get("play", 0),
            "comment": item.get("comment", 0),
            "created": item.get("created", 0),
            "length": item.get("length", ""),
            "description": (item.get("description", "") or "")[:100],
        })
    return json.dumps({
        "uid": uid,
        "page": pn,
        "total": result.get("page", {}).get("count", 0),
        "count": len(videos),
        "videos": videos,
    }, ensure_ascii=False)


# ========== Tool 19: 收藏夹列表 ==========

@tool()
async def bili_favorite_lists(uid: int = 0) -> str:
    """
    获取用户的收藏夹列表

    Args:
        uid: 用户UID（0表示获取自己的收藏夹）

    Returns:
        收藏夹列表，包含ID、名称、视频数量
    """
    cred = get_cred()
    if uid == 0:
        # 从凭证获取自己的UID
        import json as _json
        with open(CRED_FILE) as f:
            data = _json.load(f)
        uid = int(data.get("dedeuserid", 0))

    result = await favorite_list.get_video_favorite_list(uid=uid, credential=cred)
    fav_lists = []
    for item in (result.get("list", []) or []):
        fav_lists.append({
            "id": item.get("id", 0),
            "title": item.get("title", ""),
            "media_count": item.get("media_count", 0),
            "fav_state": item.get("fav_state", 0),
        })
    return json.dumps({"uid": uid, "count": len(fav_lists), "lists": fav_lists}, ensure_ascii=False)


# ========== Tool 20: 收藏夹内容 ==========

@tool()
async def bili_favorite_content(media_id: int, page: int = 1, keyword: str = "") -> str:
    """
    获取收藏夹内的视频列表

    Args:
        media_id: 收藏夹ID（从 bili_favorite_lists 获取）
        page: 页码，默认1
        keyword: 搜索关键词（在收藏夹内搜索）

    Returns:
        收藏夹内的视频列表
    """
    cred = get_cred()
    result = await favorite_list.get_video_favorite_list_content(
        media_id=media_id,
        page=page,
        keyword=keyword if keyword else None,
        credential=cred,
    )
    medias = []
    for item in (result.get("medias", []) or []):
        medias.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "play": item.get("cnt_info", {}).get("play", 0),
            "collect": item.get("cnt_info", {}).get("collect", 0),
            "author": item.get("upper", {}).get("name", ""),
            "duration": item.get("duration", 0),
            "fav_time": item.get("fav_time", 0),
        })
    return json.dumps({
        "media_id": media_id,
        "page": page,
        "has_more": result.get("has_more", False),
        "count": len(medias),
        "medias": medias,
    }, ensure_ascii=False)


# ========== Tool 21: 发私信 ==========

@tool()
async def bili_send_message(receiver_uid: int, text: str) -> str:
    """
    给B站用户发送私信

    Args:
        receiver_uid: 接收者的UID
        text: 私信文本内容

    Returns:
        发送结果
    """
    _deny = _guard("bili_send_message")
    if _deny: return _deny
    # 🔒 收件人白名单：宿主下发了 BILI_DUTY_DM_UID 时，只许发给这里列的人。
    #    被注入的提示词想"把报告发给别人"，到这一步就被拒。
    if _DM_UIDS and int(receiver_uid) not in _DM_UIDS:
        return json.dumps({
            "success": False,
            "error": f"拒绝：私信只允许发给配置里的 UID（{sorted(_DM_UIDS)}），不发给 {receiver_uid}",
        }, ensure_ascii=False)
    cred = get_cred()

    if not text or not text.strip():
        return json.dumps({"success": False, "error": "text 不能为空"}, ensure_ascii=False)

    try:
        result = await session.send_msg(
            credential=cred,
            receiver_id=receiver_uid,
            msg_type=session.EventType.TEXT,
            content=text.strip(),
        )
        # ⭐ 2.0.4（issue #35）：**接口没抛异常 ≠ 真的送到了** ——
        #    以前只要不抛就报 success: True，而 B站 可能出现 code=0 却没给投递回执（msg_key）的情况 ✗
        #    回执就在返回值里：有 msg_key 才算发出去；code 非 0 直接算失败 ✓
        data = result if isinstance(result, dict) else {}
        code = data.get("code", 0)
        inner = data.get("data")
        msg_key = data.get("msg_key") or (inner.get("msg_key") if isinstance(inner, dict) else None)
        if code not in (0, None):
            return json.dumps({
                "success": False,
                "error": f"接口拒绝（code={code}）：{data.get('message') or data.get('msg') or '未知原因'}",
                "data": data,
            }, ensure_ascii=False)
        if not msg_key:
            return json.dumps({
                "success": False,
                "error": "接口回了成功，但**没有投递回执（msg_key）** ⇒ 可能没真正送到（常见于：对方不接受陌生人私信 / 被风控）",
                "data": data,
            }, ensure_ascii=False)
        return json.dumps({
            "success": True,
            "message": f"私信已投递（回执 {str(msg_key)[:12]}…）",
            "data": data,
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 22: 未读消息 ==========

@tool()
async def bili_unread_messages() -> str:
    """
    获取B站未读消息数（私信、@、回复、点赞等）

    Returns:
        各类未读消息数量
    """
    cred = get_cred()
    try:
        result = await session.get_unread_messages(credential=cred)
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


# ========== Tool 23: 最近收到的回复 ==========

@tool()
async def bili_received_replies() -> str:
    """
    获取最近收到的评论回复通知

    Returns:
        回复列表
    """
    cred = get_cred()
    try:
        result = await session.get_replies(credential=cred)
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


# ========== Tool 24: 最近收到的@和点赞 ==========

@tool()
async def bili_received_at_and_likes() -> str:
    """
    获取最近收到的@提及和点赞通知

    Returns:
        包含 at 和 likes 两部分的通知数据
    """
    cred = get_cred()
    result = {}
    try:
        result["at"] = await session.get_at(credential=cred)
    except Exception as e:
        result["at_error"] = str(e)
    try:
        result["likes"] = await session.get_likes(credential=cred)
    except Exception as e:
        result["likes_error"] = str(e)
    return json.dumps(result, ensure_ascii=False)


# ========== Tool 25: 看画面（封面） ==========
#
# 图作为 MCP image content 返回，由宿主决定能否进模型上下文。
# 缩图交给 B 站图片 CDN（URL 后缀 @512w.jpg），不引 Pillow、不落临时文件。

_WEB_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_COVER_WIDTH = 512
_HTTP_TIMEOUT = 25               # 图床 / 快照下载统一超时（秒）
# 防御性上限：实测封面 23–36KB、帧 2.6–29KB，正常走不到这一行
_MAX_IMAGE_BYTES = 1_500_000


def _https(url: str) -> str:
    """把 B 站的图片/资源地址统一成 https。

    view 接口给的 `pic` 实测 10/10 都是 `http://`，而 http 不会跳转 https；
    图床请求再带上 SESSDATA 就等于把登录凭据明文发出去。
    """
    u = str(url or "")
    if u.startswith("//"):
        return "https:" + u
    if u.startswith("http://"):
        return "https://" + u[len("http://"):]
    return u


def _cover_url(pic: str, width: int = _COVER_WIDTH) -> str:
    """封面原图地址 → 带 CDN 缩放后缀（@<宽>w.jpg）的地址，等比不裁切。"""
    base = _https(str(pic).split("@", 1)[0])
    return f"{base}@{width}w.jpg"


def _image_headers() -> dict:
    """图床请求头：只给 UA + Referer，**不带 Cookie**（图床不需要登录态）。"""
    return {"User-Agent": _WEB_UA, "Referer": "https://www.bilibili.com/"}


def _text_only(payload: dict) -> list:
    return [TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))]


@tool()
async def bili_cover(bvid: str) -> list:
    """
    看这个视频的封面（等比缩到 512px 宽）

    最便宜的一档"看一眼"：能看出风格、标题美术、大致题材，但看不出具体发生了什么。

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"

    Returns:
        封面图 + 一句说明（标题、时长、图多大）。
        图能不能真被看见取决于当前模型是否支持图片输入；不支持时会被降级成文字。
    """
    import aiohttp

    cred = load_credential()          # 封面是公开的，没登录也取得到
    try:
        v = video.Video(bvid=bvid, credential=cred)   # 格式不对时**构造时就抛**
        info = await v.get_info()
    except Exception as e:
        # ⚠️ 2026-10-23 实测两种失败：`62002 稿件不可见`（BV 不存在）
        #    和 `ArgsException`（格式不对，构造时就抛）。都收成 ok:false。
        return _text_only({"bvid": bvid, "ok": False, "error": f"取视频信息失败：{e}"})

    pic = str(info.get("pic") or "")
    if not pic:
        return _text_only({"bvid": bvid, "ok": False, "error": "这个视频没有封面地址"})

    url = _cover_url(pic)
    try:
        timeout = aiohttp.ClientTimeout(total=_HTTP_TIMEOUT)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.get(url, headers=_image_headers()) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"HTTP {resp.status}")
                raw = await resp.read()
                mime = (resp.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
    except Exception as e:
        return _text_only({"bvid": bvid, "ok": False, "error": f"下载封面失败：{e}"})

    allowed = ("image/jpeg", "image/png", "image/webp", "image/gif")
    if mime not in allowed:
        return _text_only({"bvid": bvid, "ok": False, "error": f"封面不是可用的图片类型：{mime}"})
    if len(raw) > _MAX_IMAGE_BYTES:
        return _text_only({
            "bvid": bvid, "ok": False,
            "error": f"封面太大（{len(raw) // 1024}KB），没放进来",
        })

    return [
        TextContent(type="text", text=json.dumps({
            "bvid": bvid,
            "ok": True,
            "title": info.get("title"),
            "duration": info.get("duration"),
            "cover_kb": round(len(raw) / 1024, 1),
        }, ensure_ascii=False)),
        ImageContent(
            type="image",
            data=base64.b64encode(raw).decode("ascii"),
            mimeType=mime,
        ),
    ]


# ========== Tool 26: 看画面（画面帧） ==========
#
# 画面来自 B 站自带的故事板（x/player/videoshot），不解码视频、不用 ffmpeg。
# Video.get_video_snapshot() 有封装，但 pvideo 默认 True 会走老接口，必须传 False。
# 裁切用 Pillow（requirements 里的 qrcode[pil] 已经带进来）。

_FRAME_MAX = 6
_TILE_W_DEFAULT = 480
_TILE_H_DEFAULT = 270


def _snapshot_entries(data: dict, duration: float = 0.0) -> list:
    """把 videoshot 的 index 归一成 [(秒, 块序号), ...]。

    时间单位实测两种都出现过（秒 / 毫秒），只能靠和时长比较来判断：
    超过时长 1.5 倍才当毫秒。⚠️ 别再加"绝对值大于某个数就当毫秒"这类判据 ——
    6 小时视频的秒数（22163）会被误判成毫秒，三帧全塌到同一块、时间缩小 1000 倍。
    """
    raws = []
    for i, item in enumerate(data.get("index") or []):
        ts = item.get("timestamp") if isinstance(item, dict) else item
        try:
            raws.append((float(ts), i))
        except (TypeError, ValueError):
            continue
    if not raws:
        return []

    biggest = max(v for v, _ in raws)
    looks_ms = duration > 0 and biggest > duration * 1.5
    scale = 1000.0 if looks_ms else 1.0
    return [(v / scale, i) for v, i in raws]


async def _entries_from_pvdata(data: dict) -> list:
    """index 为空时的兜底：pvdata 指向一个大端 uint16 秒数数组，与 index 逐项相同。"""
    url = _https(data.get("pvdata") or "")
    if not url:
        return []
    try:
        raw = await _fetch_bytes(url, _image_headers())
    except Exception:
        return []
    if not raw or len(raw) % 2:
        return []
    count = len(raw) // 2
    if count > 20000:            # 明显不对，别乱解
        return []
    return [(float(sec), i) for i, sec in enumerate(struct.unpack(f">{count}H", raw))]


async def _fetch_bytes(url: str, headers: dict) -> bytes:
    import aiohttp

    timeout = aiohttp.ClientTimeout(total=_HTTP_TIMEOUT)
    async with aiohttp.ClientSession(timeout=timeout) as s:
        async with s.get(_https(url), headers=headers) as resp:
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}")
            return await resp.read()


def _crop_tile(sheet: bytes, tile_index: int, tw: int, th: int) -> bytes:
    """从拼图里裁出第 tile_index 块，返回 jpeg 字节。"""
    import io

    from PIL import Image

    img = Image.open(io.BytesIO(sheet))
    cols = max(1, img.width // tw)
    rows = max(1, img.height // th)
    if tile_index >= cols * rows:
        raise RuntimeError(f"第 {tile_index} 块超出拼图（只有 {cols}×{rows}）")
    col, row = tile_index % cols, tile_index // cols
    tile = img.crop((col * tw, row * th, (col + 1) * tw, (row + 1) * th)).convert("RGB")
    buf = io.BytesIO()
    tile.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


@tool()
async def bili_frames(bvid: str, num: int = 3, at: list | None = None) -> list:
    """
    看这个视频里的画面（从 B 站自带的故事板里裁几帧）

    想看"它到底拍了什么"就用它。默认按时长均匀取 3 帧；
    想盯某个时刻（比如字幕里提到的那一段）就传 at（单位：秒），会取**最接近的那一块**。

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
        num: 取几帧，1-6，默认 3
        at: 指定时间点（秒）的列表；传了就以它为准，忽略 num

    Returns:
        若干张 480×270 的画面 + 一句说明（时长、实际取到的那一刻、哪几帧失败）。
        失败会写进 failed。**多P 视频的故事板通常只覆盖第 1P**，返回里会用
        covered_sec / pages 标明实际覆盖范围。图能否被看见取决于模型是否支持图片输入。
    """
    cred = load_credential()          # 故事板不登录也能取
    try:
        v = video.Video(bvid=bvid, credential=cred)
        info = await v.get_info()
    except Exception as e:
        return _text_only({"bvid": bvid, "ok": False, "error": f"取视频信息失败：{e}"})
    duration = float(info.get("duration") or 0)
    pages = info.get("pages") or []
    cid = info.get("cid") or ((pages or [{}])[0].get("cid") or 0)
    if not cid:
        return _text_only({"bvid": bvid, "ok": False, "error": "拿不到 cid"})

    # 故事板只覆盖第 1P：目标时间点按"实际覆盖的长度"算，别落到没采样的 P2 上
    covered = float(pages[0].get("duration") or duration) if pages else duration
    covered = covered or duration

    # index 会偶发返回空（实测约 25%）：先用 pvdata 兜底，两个都空才重试
    snap = {}
    entries = []
    last_err = None
    for attempt in range(2):
        try:
            snap = await v.get_video_snapshot(cid=cid, json_index=True, pvideo=False) or {}
            last_err = None
        except Exception as e:
            snap, last_err = {}, e
        entries = _snapshot_entries(snap, covered)
        if not entries:
            entries = await _entries_from_pvdata(snap)
        if entries and (snap.get("image") or []):
            break
        if attempt < 1:
            await asyncio.sleep(1.0)

    sheets = snap.get("image") or []
    if not entries or not sheets:
        err = f"（最后一次错误：{last_err}）" if last_err is not None else ""
        return _text_only({
            "bvid": bvid, "ok": False,
            "error": f"取不到画面快照（试了 2 次）{err}",
        })

    # 覆盖长度以**故事板实测到的那一刻**为准（比 P1 的标称时长保守，通常短 1–10%）
    story_max = max((e[0] for e in entries), default=0.0)
    if story_max > 0:
        covered = min(covered, story_max)

    # 目标时间点：传了 at 就用它；否则按"覆盖长度"均分
    if at:
        targets = [min(max(0.0, float(t)), max(0.0, covered - 0.1)) for t in at][:_FRAME_MAX]
    else:
        n = max(1, min(int(num or 3), _FRAME_MAX))
        targets = [covered * (i + 1) / (n + 1) for i in range(n)]

    picked = []
    for t in targets:
        ts, tile = min(entries, key=lambda e: abs(e[0] - t))
        picked.append((round(t, 1), round(ts, 1), tile))

    tw = int(snap.get("img_x_size") or _TILE_W_DEFAULT)
    th = int(snap.get("img_y_size") or _TILE_H_DEFAULT)
    headers = _image_headers()

    cache = {}

    async def get_sheet(no: int) -> bytes:
        if no not in cache:
            if no >= len(sheets):
                raise RuntimeError(f"拼图 {no} 不存在（共 {len(sheets)} 张）")
            cache[no] = await _fetch_bytes(str(sheets[no]), headers)
        return cache[no]

    # 每张拼图装几块要等第一张下来才知道（列数 = 宽 // 块宽）
    blocks, frames, failed = [], [], []
    cap = None
    for i, (want, got, tile) in enumerate(picked):
        try:
            if cap is None:
                first = await get_sheet(0)
                import io

                from PIL import Image

                im = Image.open(io.BytesIO(first))
                cap = max(1, (im.width // tw) * (im.height // th))
            sheet_no, pos = tile // cap, tile % cap
            raw = _crop_tile(await get_sheet(sheet_no), pos, tw, th)
            if len(raw) > _MAX_IMAGE_BYTES:
                raise RuntimeError(f"这一帧太大（{len(raw) // 1024}KB）")
            blocks.append(ImageContent(
                type="image",
                data=base64.b64encode(raw).decode("ascii"),
                mimeType="image/jpeg",
            ))
            frames.append({"index": i, "want_sec": want, "got_sec": got,
                           "kb": round(len(raw) / 1024, 1)})
        except Exception as e:
            failed.append({"index": i, "want_sec": want, "got_sec": got, "reason": str(e)})

    if not blocks:
        return _text_only({
            "bvid": bvid, "ok": False,
            "error": "一帧都没取到", "failed": failed,
        })

    return [
        TextContent(type="text", text=json.dumps({
            "bvid": bvid,
            "ok": True,
            "title": info.get("title"),
            "duration": duration,
            "covered_sec": round(covered, 1),
            "pages": max(1, len(pages)),
            "tile": f"{tw}x{th}",
            "frames": frames,
            "failed": failed,        # 空列表 = 全成
            "note": "want_sec 是想要的时刻，got_sec 是实际取到的那一块（故事板按固定间隔切）；"
                    "多P 视频只覆盖第 1P，看 covered_sec",
        }, ensure_ascii=False)),
        *blocks,
    ]


# ========== 启动 ==========

if __name__ == "__main__":
    mcp.run(transport="stdio")