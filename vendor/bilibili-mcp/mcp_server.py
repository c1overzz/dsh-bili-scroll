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
#      ⑦ `duty_seen_append_batch`：整轮的判重行一次写完（2026-11-27 加；一条调用顶十几条）
#      ⑧ `bili_search_batch`：一轮的全部关键词一次搜完（2026-11-27 加；紧凑行、按 BV 去重；白名单沿用 bili_search）
import asyncio
import random
import json
import re
import base64
import os
import struct
import sys
import tempfile
from pathlib import Path
from mcp.server.fastmcp import FastMCP
from mcp.types import ImageContent, TextContent

from bilibili_api import video, search, comment, Credential, dynamic, opus
from bilibili_api import hot, rank, user, session, favorite_list
from bilibili_api import homepage
from bilibili_api.video_uploader import (
    VideoUploader, VideoUploaderPage, VideoMeta, Lines,
)
from bilibili_api.utils.picture import Picture
from bilibili_api.login_v2 import QrCodeLogin, QrCodeLoginEvents

# 2.3.0 throttle: every read tool sleeps 0.6-1.6s before running
async def _throttle():
    try:
        await asyncio.sleep(random.uniform(0.6, 1.6))
    except Exception:
        pass

# ========== 初始化 ==========

CRED_FILE = Path(__file__).parent / "bili_credential.json"

mcp = FastMCP("bilibili-mcp")

# ⭐ 工具白名单（2026-10-17 审查里的 H3）：宿主通过 overlay 的 env 下发 BILI_MCP_TOOLS（逗号分隔）。
#    · 不给这个变量 ⇒ **全放**（手工跑、或老配置，行为一点不变 ✓）
#    · 给了 ⇒ 只注册名单里的；不在名单里的工具**连名字都不会出现在 list_tools 里**，
#      模型那边等于根本不存在 —— 这才是真的闸门（光靠提示词说"别用"不算）✓
_ALLOWED = {t.strip() for t in os.environ.get("BILI_MCP_TOOLS", "").split(",") if t.strip()}

# ⭐ 2026-11-27：批量记账工具和 duty_seen_append 是同一权限（同一个文件、同一把锁）。
#    老宿主的内存里还是旧白名单（没有 duty_seen_append_batch），这里自动补齐，
#    省得为一行白名单去重启宿主；能力没有放大。
for _implied, _need in {"duty_seen_append_batch": "duty_seen_append", "bili_search_batch": "bili_search", "bili_subtitle_batch": "bili_subtitle", "bili_comments_batch": "bili_comments"}.items():
    if _implied not in _ALLOWED and _need in _ALLOWED:
        _ALLOWED.add(_implied)


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


# ⭐⭐ 语感闸门（治"鱼八股"）：**发评论之前，先在函数里拦一道**
#   背景：章程里写"要有具体细节、别客套"，模型照样写"这条我认""值得一看" ——
#         禁令没有范例有效、自觉没有拦截可靠 ⇒ 在执行层做最后一道检查（跟 _guard 同一思路）。
#   三道检查（便宜、纯本地 / 一次轻请求）：
#     ① 开头八股黑名单（正则）
#     ② 跟**自己以前发过的评论**太像（bigram 相似度）—— 治"每条一个味"
#     ③ 跟**这条视频现有热评**太像 —— 治"跟别的鱼撞车"
#   ⚠️ 撞了就**不发**，把原因和改法返回给模型，让它重写一句。
#   ⚠️ 关掉：`BILI_STYLE_OFF=1`。
_STYLE_OFF = os.environ.get("BILI_STYLE_OFF", "") in ("1", "true", "yes")
_STYLE_LEAD = re.compile(
    r"^\s*(?:"
    r"这条(?:我认|我记下了|值得)|我记下了|值得一看|确实值得|不得不说|"
    r"好家伙|这个(?:必须|真的要)|强烈推荐|感谢分享|学到了|受教了|"
    r"作为一个|总之|综上"
    r")"
)


def _bigrams(s: str) -> set:
    t = re.sub(r"[^\w\u4e00-\u9fff]", "", "".join(ch for ch in str(s or "") if not ch.isspace()))
    if len(t) < 2:
        return set(t)
    return {t[i:i + 2] for i in range(len(t) - 1)}


def _sim(a: str, b: str) -> float:
    """bigram Jaccard —— 够用、够快、零依赖"""
    x, y = _bigrams(a), _bigrams(b)
    if not x or not y:
        return 0.0
    return len(x & y) / max(1, len(x | y))


def _ledger_path():
    try:
        return DUTY_HOME / "comments.md"
    except Exception:
        return Path(__file__).parent / "comments.md"


def _ledger_recent(n: int = 30):
    """最近 n 条"自己发过的评论"正文（台账一行：`- 日期 BVID rpid=… · 正文`）"""
    try:
        p = _ledger_path()
        if not p.exists():
            return []
        out = []
        for ln in p.read_text(encoding="utf-8").splitlines():
            ln = ln.strip()
            if not ln.startswith("- "):
                continue
            body = ln.split("·", 1)[1].strip() if "·" in ln else ln[2:].strip()
            if body:
                out.append(body)
        return out[-n:]
    except Exception:
        return []


def _ledger_append(text: str, bvid: str, rpid=None):
    try:
        p = _ledger_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(f"- {_dt.datetime.now().strftime('%Y-%m-%d %H:%M')} {bvid} rpid={rpid or 0} · {' '.join(str(text).split())}\n")
    except Exception:
        pass


async def _style_reason(text: str, bvid: str, cred) -> str:
    """返回"为什么这句不能发"；空串 = 可以发"""
    if _STYLE_OFF:
        return ""
    body = " ".join(str(text or "").split())
    if not body:
        return "评论是空的。"
    m = _STYLE_LEAD.match(body)
    if m:
        return (f"开头「{m.group(0).strip()}」是鱼八股。直接说这条视频里的具体东西："
                "「这期讲了什么 + 一个只有看了才说得出的细节」，开头别用套话。")
    for old in _ledger_recent(30):
        s = _sim(body, old)
        if s >= 0.55:
            return (f"这句跟你以前发过的「{old[:18]}…」太像了（相似度 {s:.2f}）。"
                    "换开头、换关注点，别套同一个句式。")
    try:
        v = video.Video(bvid=bvid, credential=cred)
        aid = (await v.get_info())["aid"]
        resp = await comment.get_comments(
            oid=aid, type_=comment.CommentResourceType.VIDEO, page_index=1,
            order=comment.OrderType.LIKE, credential=cred,
        )
        for c in (resp.get("replies") or [])[:20]:
            other = " ".join(str((c.get("content") or {}).get("message", "")).split())
            if not other:
                continue
            s = _sim(body, other)
            if s >= 0.5:
                return (f"这条视频底下已经有一句很像的（相似度 {s:.2f}）：{other[:24]}… "
                        "撞车了 —— 换个角度写，或者这一轮不发。")
    except Exception:
        pass  # 读不到热评就不做这道检查（不能因为读不到就不让发）
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
async def bili_search(keyword: str, num: int = 10, order: str = "totalrank", page: int = 1) -> str:
    """
    搜索B站视频

    Args:
        keyword: 搜索关键词，如"AI Agent"、"大模型教程"
        num: 返回视频数量，默认10，最大50
        order: 排序方式 totalrank=综合 click=播放量 pubdate=最新 dm=弹幕
        page: 第几页，从 1 开始（一页约 20 条；想多看一屏就翻页）
    
    Returns:
        JSON格式的视频列表，包含标题、BV号、播放量、评论数、UP主等
    """
    await _throttle()
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
        page=max(1, int(page or 1)),
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
            "pubdate": item.get("pubdate", 0),
            "description": item.get("description", "")[:200],
        })

    return json.dumps({"keyword": keyword, "count": len(videos), "videos": videos}, ensure_ascii=False)


# ========== Tool 1b: 批量搜索（2026-11-27 加：一轮的关键词一次发完，省 2 个回合） ==========

def _fmt_count(n) -> str:
    """播放量/弹幕数压成 1.2万 / 3.4亿 这种短格式。"""
    try:
        n = int(n or 0)
    except Exception:
        return "0"
    if n >= 100000000:
        return (f"{n / 100000000:.1f}亿").replace(".0亿", "亿")
    if n >= 10000:
        return (f"{n / 10000:.1f}万").replace(".0万", "万")
    return str(n)


def _fmt_pubdate(ts) -> str:
    """发布时间压成 今天 / 昨天 / 11-27。"""
    from datetime import date, timedelta
    try:
        ts = int(ts or 0)
    except Exception:
        return "?"
    if ts <= 0:
        return "?"
    try:
        d = date.fromtimestamp(ts)
    except Exception:
        return "?"
    today = date.today()
    if d == today:
        return "今天"
    if d == today - timedelta(days=1):
        return "昨天"
    return d.strftime("%m-%d")


# ⭐ 2026-11-28：标题里带这些词的多半是课程/合集/带课/推广 —— 模型今天 226 行里一条没挑，
#    铺开写要 25 行 × 78 字符；折叠成「BV + 标题前 28 字」一行 40 字符，标题还能看见，判断不用改。
#    只匹配标题（简介里"带你/教你"太容易误伤正经技术视频）。
_FOLD_TITLE_RE = re.compile(
    r"合集|全套|保姆级|入门到精通|零基础|课程|训练营|包教包会|一对一"
    r"|变现|副业|赚钱|日入|月入|白嫖|领资料|交流群|加群|速成|手把手|带你|教你"
)


# ⭐ 2026-11-28 调优：一轮的所有关键词**一次搜完**（原来 6~8 个词 = 6~8 个回合、搜索 46k 字符）。
#    同一趟还顺带做了：剔判重表已看过的、剔今天扫过标题的（scan.md 台账）、折叠疑似课程行、并发抓 3 路。
#    实测 6 词 x 2 页 = 170 条 / 18.6k 字符（同样内容原来 23.7k）；今天中午那轮 8 次搜索 -> 1 次。
#    简介默认留 30 字、fold 默认开，都是按「一条没挑」的实测调的。
@tool()
async def bili_search_batch(keywords: str, num: int = 15, order: str = "pubdate", pages: int = 2, desc_chars: int = 30, fold: bool = True) -> str:
    """
    一次搜多个关键词（一轮的全部词一次发完，省回合）

    Args:
        keywords: 关键词，用逗号/顿号/空格分隔，如 "AI,编程,网络安全,渗透测试,技术,科普"
        num: 每个关键词每页取几条，默认 15，最大 30
        order: 排序 totalrank=综合 click=播放量 pubdate=最新 dm=弹幕
        pages: 每个关键词翻几页，默认 2
        desc_chars: 每条简介留多少字（默认 30；0~120，0 = 不输出简介）。实测 120 条结果里简介占 1.6k 字符（30 字）/ 4.2k（不截），标题+播放+UP 通常够判断题材
        fold: 把标题疑似课程/合集/带课/推广的行折叠成「BV + 标题前 28 字」（默认开；实测今天 226 行里 25 行是这种，
              实际一条没挑，折叠后省约 2.6k 字符）。传 fold=False 全部铺开

    Returns:
        紧凑文本列表：每个视频一行，已按 BV 去重、按发布时间倒序
        `BV号 | 发布时间 | 播放 | 时长 | UP | 标题 | 简介前 60 字`
    """
    kws = [k for k in re.split(r"[,，、;；\s]+", str(keywords or "")) if k.strip()]
    if not kws:
        return "没给关键词（keywords 用逗号分隔）"
    kws = kws[:8]
    num = max(1, min(30, int(num or 15)))
    pages = max(1, min(5, int(pages or 2)))
    desc_n = max(0, min(int(desc_chars if desc_chars is not None else 30), 120))
    order_map = {
        "totalrank": search.OrderVideo.TOTALRANK,
        "click": search.OrderVideo.CLICK,
        "pubdate": search.OrderVideo.PUBDATE,
        "dm": search.OrderVideo.DM,
    }
    order_enum = order_map.get(order, search.OrderVideo.TOTALRANK)

    seen = {}
    raw = 0
    limit_rows = 300  # 输出上限：再多模型也读不完，还白烧 token
    errors = []
    # ⭐ 2026-11-28：并发抓（默认 3，BILI_FETCH_CONCURRENCY 可调 1~5）。
    #    原来 6 词 × 2 页 = 12 次串行，每次 throttle 0.6~1.6s ⇒ 实测 18.8 秒；
    #    并发 3 后同样的活约 6~7 秒，_throttle() 仍在每个任务里，不会把请求打成一片。
    try:
        _conc = max(1, min(int(os.environ.get("BILI_FETCH_CONCURRENCY") or 3), 5))
    except Exception:
        _conc = 3
    _sem = asyncio.Semaphore(_conc)

    async def _one_page(kw, page):
        await _throttle()
        try:
            res = await search.search_by_type(
                keyword=kw,
                search_type=search.SearchObjectType.VIDEO,
                page=page,
                order_type=order_enum,
            )
            return kw, page, res, None
        except Exception as e:
            return kw, page, None, f"{kw} 第{page}页: {type(e).__name__}: {e}"

    async def _guarded_page(kw, page):
        async with _sem:
            return await _one_page(kw, page)

    _tasks = [(kw, p) for kw in kws for p in range(1, pages + 1)]
    _outs = await asyncio.gather(*[_guarded_page(kw, p) for kw, p in _tasks])
    for kw, page, result, err in _outs:
        if err:
            errors.append(err)
            continue
        if len(seen) >= limit_rows:
            continue
        for item in (result.get("result") or [])[:num]:
                bvid = item.get("bvid", "")
                if not bvid:
                    continue
                raw += 1
                if bvid in seen:
                    continue
                title = item.get("title", "").replace('<em class="keyword">', "").replace("</em>", "")
                seen[bvid] = {
                    "title": title,
                    "up": item.get("author", ""),
                    "play": item.get("play", 0),
                    "duration": item.get("duration", ""),
                    "pubdate": item.get("pubdate", 0),
                    "desc": item.get("description", "").replace("\n", " ")[:desc_n],
                }

    rows = sorted(seen.items(), key=lambda kv: kv[1]["pubdate"], reverse=True)
    # ⭐ 2026-11-28：搜到过的 BV→标题/UP 记进缓存（日报里「- 跳过：BV…」只有 BV，靠它补标题）
    try:
        _seen_cache_save({bv: [v["title"], v["up"], v["play"], v["duration"]] for bv, v in seen.items()})
    except Exception:
        pass
    # ⭐ 2026-11-28：判重表里已有的 BV 直接不返回 —— 模型看了也只会跳过，
    #    实测今天 226 条结果里 17 条是看过的（2.5k 字符白读），剔掉还能防"重复挑"。
    skipped_seen = 0
    seen_ok = True          # ⭐ 2026-11-28：判重表读不到要在结果里出声（下游据此决定不发评论）
    try:
        _sp = DUTY_HOME / "seen.md"
        if _sp.exists():
            _seen_bv = set(re.findall(r"BV[0-9A-Za-z]{10}", _sp.read_text(encoding="utf-8", errors="replace")))
            if _seen_bv:
                _before = len(rows)
                rows = [(bv, v) for bv, v in rows if bv not in _seen_bv]
                skipped_seen = _before - len(rows)
        else:
            seen_ok = False
    except Exception:
        skipped_seen = 0
        seen_ok = False
    # ⭐ 2026-11-28：今天已经扫过标题、当场判掉的视频不再返回（晚上那轮以前要把中午的行重读一遍）。
    #    剔完不够 60 条时，从"今天扫过的"里按发布时间补回来，免得一轮没东西可挑。
    scan_skipped = refilled = 0
    try:
        _scanned = _scan_today()
        if _scanned:
            _keep = [(bv, v) for bv, v in rows if bv not in _scanned]
            _drop = [(bv, v) for bv, v in rows if bv in _scanned]
            scan_skipped = len(_drop)
            rows = _keep
            if len(rows) < 60 and _drop:
                refilled = min(60 - len(rows), len(_drop))
                rows = sorted(rows + _drop[:refilled], key=lambda kv: kv[1]["pubdate"], reverse=True)
    except Exception:
        scan_skipped = refilled = 0
    try:
        _scan_record([bv for bv, _ in rows])
    except Exception:
        pass
    capped = "（已到 300 条上限，后面的没取）" if len(seen) >= limit_rows else ""
    skip_note = f" · 已剔掉 {skipped_seen} 条看过的" if skipped_seen else ""
    if scan_skipped:
        skip_note += f" · 另有 {scan_skipped} 条今天已经扫过标题（也剔了）"
    if refilled:
        skip_note += f"（新的太少，补回 {refilled} 条今天扫过的）"
    # ⭐ 2026-11-28：疑似课程/合集的行折叠到列表末尾，只留 BV + 标题前 28 字。
    kept, folded = [], []
    for bvid, v in rows:
        if fold and _FOLD_TITLE_RE.search(v["title"] or ""):
            folded.append((bvid, v))
        else:
            kept.append((bvid, v))
    if folded:
        skip_note += f" · 折起 {len(folded)} 条疑似课程/合集"
    lines = [
        f"关键词 {len(kws)} 个（{' / '.join(kws)}）· 每词 {pages} 页 · 原始 {raw} 条 · 去重后 {len(rows)} 条"
        f"（按发布时间倒序）{skip_note}{capped}"
    ]
    if not rows:
        lines.append("（全是被判重表 / 扫描台账挡掉的老视频 —— 换个关键词或换个排序再搜）")
    for bvid, v in kept:
        desc = v["desc"].strip()
        row = (f"{bvid} | {_fmt_pubdate(v['pubdate'])} | 播放 {_fmt_count(v['play'])} | {v['duration'] or '?'}"
               f" | {v['up'] or '?'} | {v['title']}")
        if desc:
            row += " | " + desc
        lines.append(row)
    if folded:
        lines.append(f"—— 疑似课程/合集/带课 {len(folded)} 条（折叠成 BV+标题，要展开传 fold=False）：")
        for bvid, v in folded:
            lines.append(f"{bvid} {(v['title'] or '')[:28]}")
    # ⭐ 2026-11-28：判重表读不到必须出声 —— 章程规定这种轮次不发评论（当成"全没看过"会重复打扰人）
    if not seen_ok:
        lines.append("⚠️ 判重表读不到（seen.md 不存在或打不开）⇒ 这一轮**不要发评论**，报告里写明「判重表读不到」")
    if errors:
        lines.append("⚠️ 部分搜索失败：" + "；".join(errors[:3]))
    return "\n".join(lines)


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
    await _throttle()
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


# ========== Tool 2b: 批量取热评（2026-11-28 加：一轮几条视频的评论一次取完） ==========

def _cmt_line(c: dict, cap: int) -> str:
    """把一条热评压成一行：赞 · 用户 · 正文(截断) · 回复数。"""
    txt = re.sub(r"\s+", " ", (c.get("content") or "")).strip()
    if len(txt) > cap:
        txt = txt[:cap] + "…"
    user = (c.get("user") or "").strip()[:16]
    rc = c.get("reply_count") or 0
    tail = f"（{rc} 回复）" if rc else ""
    return f"· 赞{c.get('like', 0)} {user}：{txt}{tail}"


async def _fetch_hot(cred, aid, want: int) -> tuple:
    """取热评（按赞排序，最多一页页翻到 want 条）；返回 (评论列表, 错误文本或 None)。"""
    got, fetch_error, page = [], None, 1
    while len(got) < want:
        try:
            resp = await comment.get_comments(
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                page_index=page,
                order=comment.OrderType.LIKE,
                credential=cred,
            )
        except Exception as e:
            fetch_error = f"{type(e).__name__}: {e}"
            break
        replies = resp.get("replies") or []
        if not replies:
            break
        for r in replies:
            got.append({
                "user": (r.get("member") or {}).get("uname", ""),
                "content": (r.get("content") or {}).get("message", ""),
                "like": r.get("like", 0),
                "reply_count": r.get("rcount", 0),
            })
        page += 1
        await asyncio.sleep(0.4)
    return got[:want], fetch_error


# ⭐ 2026-11-28 调优：多条视频的热评**一次取完**，压成「· 赞N 用户：正文」一行一条。
#    原来 bili_comments 返回整段 JSON（rpid/时间/uid 全在），3 条 2,816 字符；这里 1,057 字符（-62%）。
@tool()
async def bili_comments_batch(bvids: str, num: int = 10, max_chars: int = 120) -> str:
    """
    一次取多条视频的热门评论，压成一行一条

    Args:
        bvids: 逗号/空格分隔的 BV 号，最多 20 条
        num: 每条视频取几条热评（默认 10；1~30）
        max_chars: 每条评论正文最多留多少字（默认 120；40~400）

    Returns:
        紧凑文本：每条视频一段「■ BV · 标题 · N 条热评」+ 每行一条评论；末尾总计
    """
    ids = [x for x in re.split(r"[,，、;；\s]+", bvids or "") if x]
    seen_ids, uniq = set(), []
    for x in ids:
        if x not in seen_ids:
            seen_ids.add(x)
            uniq.append(x)
    ids = uniq[:20]
    if not ids:
        return "没给 BV 号"
    want = max(1, min(int(num or 10), 30))
    cap = max(40, min(int(max_chars or 120), 400))

    # ⭐ 2026-11-28：同字幕批量，逐条串行 → 并发 3（BILI_FETCH_CONCURRENCY 可调）
    async def _one_bv_cmt(bv):
        out = {"blocks": [], "ok": 0, "errs": 0}
        try:
            await _throttle()
            cred = get_cred()
            v = video.Video(bvid=bv, credential=cred)
            info = await v.get_info()
            aid = info.get("aid")
            title = (info.get("title") or "").strip()[:24]
            if not aid:
                out["blocks"] = [f"■ {bv} · ⚠️ 拿不到 aid"]
                out["errs"] = 1
                return out
            got, fetch_error = await _fetch_hot(cred, aid, want)
            head = f"■ {bv} · {title} · {len(got)} 条热评"
            if fetch_error:
                head += f" · ⚠️ 抓取中断：{fetch_error}"
            out["blocks"] = [head] + [_cmt_line(c, cap) for c in got]
            out["ok"] = 1
        except Exception as e:
            out["blocks"] = [f"■ {bv} · ⚠️ 取评论失败：{type(e).__name__}: {e}"]
            out["errs"] = 1
        return out

    try:
        _conc = max(1, min(int(os.environ.get("BILI_FETCH_CONCURRENCY") or 3), 5))
    except Exception:
        _conc = 3
    _sem = asyncio.Semaphore(_conc)

    async def _guarded_cmt(bv):
        async with _sem:
            return await _one_bv_cmt(bv)

    blocks = []
    ok = errs = 0
    for _r in await asyncio.gather(*[_guarded_cmt(bv) for bv in ids]):
        blocks.extend(_r["blocks"])
        ok += _r["ok"]
        errs += _r["errs"]

    body = "\n".join(blocks)
    head = f"评论 {len(ids)} 条：{ok} 取到 · {errs} 失败 · 合计 {len(body)} 字"
    return head + "\n\n" + body


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
    await _throttle()
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


# ========== Tool 3b: 批量取字幕（2026-11-28 加：一轮十几条字幕一次取完） ==========

def _sub_flatten(body) -> tuple:
    """把逐段字幕压成一段连续文本；返回 (文本, 段数)。"""
    parts = []
    for item in body or []:
        s = (item.get("content") or "").strip()
        if s:
            parts.append(s)
    text = "".join(parts)
    text = re.sub(r"[ \t\u3000]{2,}", " ", text)
    return text, len(parts)


def _sub_clip(text: str, max_chars: int) -> str:
    """超长时留头 70% + 尾 30%，中间标出省略了多少字。"""
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    head = max(1, int(max_chars * 0.7))
    tail = max(1, max_chars - head)
    cut = len(text) - head - tail
    return text[:head] + f"…（中略 {cut} 字）…" + text[-tail:]


# ⭐ 2026-11-28 调优：**批量字幕** —— 一轮 11 次逐条 bili_subtitle（12 个回合、52k 字符）-> 1 次调用。
#    · max_chars 默认 3000 -> 2000 -> 1600：今天 11 条真实字幕 16,905 -> 13,975 -> 12,376 字符，
#      被截的仍是同样 4 条，判断「讲的是什么机制」够用；
#    · comments=N 把热评并进**同一趟**（省 1 个回合，抓取时间 -40%）；
#    · frames=N 给没字幕的那几条顺带带回画面（以前要等看完字幕再单独调 bili_frames，白多一个回合）；
#    · 20 条以内一次发完（原 12 条上限，20 条候选时要拆两次）。
@tool()
async def bili_subtitle_batch(bvids: str, max_chars: int = 1600, comments: int = 0, comment_chars: int = 120, frames: int = 0) -> list:
    """
    一次取多条视频的字幕（AI 字幕），可选把热评一起带上 —— 细看一条视频一次取完

    Args:
        bvids: 逗号/空格分隔的 BV 号，如 "BV1xx,BV2yy"，最多 20 条
        max_chars: 每条字幕最多留多少字（默认 1600；200~20000）。实测 11 条真实字幕平均 1.9k 字，2000 砍到 14.0k 字符、1600 砍到 12.4k（被截仍是同样 4 条，只是那 4 条中间多丢 400 字）
                截到 2000 只动 3 条长的（-19%），判断"讲的是什么机制"足够
        comments: 每条视频顺带取几条热评（默认 0 = 不取；0~20）
        comment_chars: 每条热评正文最多留多少字（默认 120；40~400）
        frames: 无字幕的视频顺带取几张画面（默认 0 = 不取；1~3）。取得到的图附在文本后面，
                这样"没字幕只能看画面"的判定和字幕是**同一趟**回来的，不用再单独调 bili_frames

    Returns:
        紧凑文本：每条一段「■ BV · 标题 · 时长 · N 段」+ 字幕正文（可选「  热评 N 条」+ 一行一条）；末尾总计
    """
    import aiohttp
    ids = [x for x in re.split(r"[,，、;；\s]+", bvids or "") if x]
    seen_ids, uniq = set(), []
    for x in ids:
        if x not in seen_ids:
            seen_ids.add(x)
            uniq.append(x)
    ids = uniq[:20]
    if not ids:
        return "没给 BV 号"
    cap = max(200, min(int(max_chars or 2000), 20000))
    want_c = max(0, min(int(comments or 0), 20))
    ccap = max(40, min(int(comment_chars or 120), 400))
    want_f = max(0, min(int(frames or 0), 3))

    # ⭐ 2026-11-28：逐条串行 → 并发 3（BILI_FETCH_CONCURRENCY 可调 1~5）。
    #    实测 11 条字幕串行 17.5 秒（每条 get_info + 字幕 JSON 两跳），并发 3 约 6~7 秒。
    #    每条仍各自 _throttle()，请求不会攒成一片；结果按传入顺序拼回去，报告顺序不变。
    async def _one_bv(bv):
        r = {"lines": [], "ok": 0, "trunc": 0, "nosub": 0, "failed": 0,
             "raw": 0, "kept": 0, "cmt": 0, "images": []}
        try:
            await _throttle()
            cred = get_cred()
            v = video.Video(bvid=bv, credential=cred)
            info = await v.get_info()
            cid = info.get("cid", 0)
            if not cid and info.get("pages"):
                cid = info["pages"][0].get("cid", 0)
            title = (info.get("title") or "").strip()[:48]
            dur = int(info.get("duration") or 0)
            dur_s = f"{dur // 60}:{dur % 60:02d}" if dur else "?"
            head_parts = [f"■ {bv} · {title} · {dur_s}"]
            body_lines = []
            # ---- 字幕 ----
            if not cid:
                head_parts.append("⚠️ cid 拿不到")
                r["failed"] = 1
            else:
                subtitle_list = await v.get_subtitle(cid=cid)
                subtitles = subtitle_list.get("subtitles") or []
                if not subtitles:
                    r["nosub"] = 1
                    if want_f:
                        # ⭐ 2026-11-28：无字幕的视频顺手把画面带回来（省掉单独一次 bili_frames 往返）
                        try:
                            await _throttle()
                            f_res = await bili_frames(bv, num=want_f)
                            f_imgs, f_txt = [], ""
                            for _blk in (f_res or []):
                                if isinstance(_blk, ImageContent):
                                    f_imgs.append(_blk)
                                elif isinstance(_blk, TextContent):
                                    f_txt = _blk.text or ""
                            f_meta = {}
                            if f_txt:
                                try:
                                    f_meta = json.loads(f_txt)
                                except Exception:
                                    f_meta = {}
                            if f_imgs:
                                r["images"].extend(f_imgs)
                                head_parts.append(f"⚠️ 没有字幕 · 带回 {len(f_imgs)} 帧画面（480x270，看画面判断）")
                            else:
                                head_parts.append("⚠️ 没有字幕 · 抽帧也没取到：" + str(f_meta.get("error") or "未知"))
                        except Exception as fe:
                            head_parts.append(f"⚠️ 没有字幕 · 抽帧失败：{type(fe).__name__}")
                    else:
                        head_parts.append("⚠️ 没有字幕")
                else:
                    target = None
                    for s in subtitles:
                        if s.get("lan") in ("ai-zh", "zh-CN", "zh"):
                            target = s
                            break
                    if not target:
                        target = subtitles[0]
                    sub_url = target.get("subtitle_url", "") or ""
                    if sub_url.startswith("//"):
                        sub_url = "https:" + sub_url
                    async with aiohttp.ClientSession() as session:
                        async with session.get(sub_url) as resp:
                            sub_data = await resp.json()
                    text, segs = _sub_flatten(sub_data.get("body"))
                    r["raw"] = len(text)
                    clipped = _sub_clip(text, cap)
                    if len(clipped) != len(text):
                        r["trunc"] = 1
                    r["kept"] = len(clipped)
                    head_parts.append(f"{segs} 段")
                    body_lines.append(clipped if clipped else "（字幕是空的）")
                    r["ok"] = 1
            # ---- 热评（可选，和字幕同一趟取完）----
            if want_c:
                aid = info.get("aid")
                if not aid:
                    body_lines.append("  热评：⚠️ 拿不到 aid")
                else:
                    got, cerr = await _fetch_hot(cred, aid, want_c)
                    body_lines.append(f"  热评 {len(got)} 条" + (f" · ⚠️ 抓取中断：{cerr}" if cerr else ""))
                    body_lines.extend("  " + _cmt_line(c, ccap) for c in got)
                    r["cmt"] = len(got)
            r["lines"] = [" · ".join(head_parts)] + body_lines
        except Exception as e:
            r["lines"] = [f"■ {bv} · ⚠️ 取字幕失败：{type(e).__name__}: {e}"]
            r["failed"] = 1
        return r

    try:
        _conc = max(1, min(int(os.environ.get("BILI_FETCH_CONCURRENCY") or 3), 5))
    except Exception:
        _conc = 3
    _sem = asyncio.Semaphore(_conc)

    async def _guarded_bv(bv):
        async with _sem:
            return await _one_bv(bv)

    _results = await asyncio.gather(*[_guarded_bv(bv) for bv in ids])
    lines = []
    ok = truncated = nosub = failed = raw_total = kept_total = got_cmt = 0
    for _r in _results:
        ok += _r["ok"]
        truncated += _r["trunc"]
        nosub += _r["nosub"]
        failed += _r["failed"]
        raw_total += _r["raw"]
        kept_total += _r["kept"]
        got_cmt += _r["cmt"]
        lines.extend(_r["lines"])

    imgs = [im for _r in _results for im in (_r.get("images") or [])]
    head = (f"细看 {len(ids)} 条：{ok} 有字幕（截断 {truncated}）· {nosub} 无字幕 · {failed} 失败"
            + (f" · 热评 {got_cmt} 条" if want_c else "")
            + (f" · 兜底画面 {len(imgs)} 帧" if imgs else "")
            + f" · 合计 {kept_total} 字（原 {raw_total} 字）")
    text = head + "\n\n" + "\n".join(lines)
    if imgs:
        return [TextContent(type="text", text=text), *imgs]
    return text


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


def _normalize_mention(text: str) -> str:
    """把「@ 昵称」压成「@昵称」。

    B站 只认紧挨着的写法：`@ No3799` 会被当成普通文字，**不会真的 @ 到人**，
    而且不会有任何报错 —— 评论照样发出去、接口照样返回成功，只是对方收不到通知。
    模型写中文时习惯在 @ 后面加一个空格，所以这里在发送前统一压一遍。
    """
    return re.sub(r"@\s+", "@", text or "")


# ========== Tool 6: 回复评论 ==========

# ⭐ 2026-11-28 调优：发送成功后自动往判重表记一行「评论」（auto_seen）——
#    模型收尾不用再手写 rows（实测 1,740 字符 ≈ 1.2k 输出 token），报告里也不用抄 rpid。
@tool()
async def bili_reply(bvid: str, text: str, rpid: int = 0, root: int = 0, auto_seen: bool = True) -> str:
    """
    在B站视频下发表评论或回复某条评论

    ⭐ 2026-11-28：发送成功后**自动**往判重表记一行「评论」（带 rpid）——
    所以收尾的 duty_seen_append_batch 里**不用再写「评论」那几行**了（写了也会被去重挡掉）。

    Args:
        bvid: 视频BV号
        text: 评论/回复的文本内容
        rpid: 要回复的目标评论ID（0表示发表新评论）
        root: 楼层根评论ID（回复一级评论时不用填，回复楼中楼时填根评论ID）
        auto_seen: 默认 true = 成功后自动往判重表记「评论」行；false = 不记
    
    Returns:
        发表结果
    """
    _deny = _guard("bili_reply")
    if _deny: return _deny
    # ⭐「@ 昵称」压成「@昵称」：B站 只认紧挨着的写法，带空格等于没 @ 到人（而且不报错）
    text = _normalize_mention(text)
    # ⭐ 语感闸门：撞八股 / 撞自己以前的 / 撞这条视频的热评 ⇒ 不发，把改法告诉模型
    _style = await _style_reason(text, bvid, get_cred())
    if _style:
        return json.dumps({"ok": False, "sent": False, "blocked_by": "style", "error": _style}, ensure_ascii=False)
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
        _ledger_append(text, bvid, result.get("rpid") if isinstance(result, dict) else None)
        # ⭐ 2026-11-28：成功即记一行判重（「评论」+ rpid），收尾时模型不用再抄一遍这十几行
        if auto_seen:
            try:
                _rp = result.get("rpid") if isinstance(result, dict) else None
                _up = ""
                try:
                    _up = str(((info.get("owner") or {}).get("name")) or "")
                except Exception:
                    _up = ""
                _seen_append_row(
                    bvid,
                    "评论记录 rpid=" + str(_rp or 0) + " · " + " ".join(str(text).split())[:20],
                    _up,
                    "评论",
                )
            except Exception:
                pass
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
        # 仅值班轮：真实拿到 msg_key 后记录私信中的 BV 号，普通聊天不会标记。
        duty_day = os.environ.get("BILI_DUTY_RUN_DAY", "")
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", duty_day):
            bvids = sorted(set(re.findall(r"(?<![0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])", text)))
            if bvids:
                try:
                    with (Path(__file__).parent / "dm-deliveries.jsonl").open("a", encoding="utf-8") as f:
                        f.write(json.dumps({"day": duty_day, "bvids": bvids}, ensure_ascii=False) + "\n")
                except OSError as e:
                    print(f"私信已成功，但记录投递失败：{e}", file=sys.stderr)
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


# ========== 值班轮窄口 IO（2026-10-24 · issue #96 安全加固）==========
# ⭐ 值班轮现在跑在「最小权限 profile」上：**没有文件系统、没有 shell、没有 web**。
#    但它还得写日报 / 判重表 / 归档、还得能转写 —— 所以这几件事做成**固定路径的窄口工具**：
#    · 只写 <家>/out/<日期>.md、<家>/seen.md、<家>/digest/<年-月>.md
#    · **不接受任何路径参数**（想写别处也写不了）✓
#    · 输入里的竖线会被转义，标题带 | 也不会把表格弄坏
import datetime as _dt

DUTY_HOME = Path(os.environ.get("BILI_DUTY_HOME") or (Path.home() / ".dsh" / "bili-duty"))


def _duty_today() -> str:
    return _dt.datetime.now().strftime("%Y-%m-%d")


_DUTY_DATE_RE = re.compile(r"^(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$")


def _duty_norm_date(raw: str) -> str:
    """模型给的日期 → YYYY-MM-DD；认不出来就用今天（#133：以前 `10-23` 原样写进判重表，宿主解析不了）。
    没写年份按今年补，补出来比今天晚就算去年 —— 跟宿主 lib/state.mjs 的 seenDay 同一套规则。"""
    today = _dt.date.today()
    m = _DUTY_DATE_RE.match(str(raw or "").strip())
    if not m:
        return today.isoformat()
    y = int(m.group(1)) if m.group(1) else today.year
    try:
        d = _dt.date(y, int(m.group(2)), int(m.group(3)))
        if not m.group(1) and d > today:
            d = d.replace(year=y - 1)
    except ValueError:
        return today.isoformat()
    return d.isoformat()


def _cell(s: str, limit: int = 60) -> str:
    """表格单元格：去换行、转义竖线、截断。"""
    t = " ".join(str(s or "").split())
    return t.replace("|", "\\|")[:limit]


def _append(path: Path, text: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return str(path)


# ⭐ 2026-11-28：日报 / 归档 / 判重表三件套的公共小工具。
#    起因：每天收尾时模型要把同一批视频写两遍 —— 一遍进日报（~4,000 字符），一遍进 digest 归档（~2,000 字符），
#    digest 那一遍纯粹是格式转换（日期·BV·标题·UP·一句话·链接），白花约 1.5k 输出 token。
#    现在改成 duty_report_append 顺手从日报的 `### BV…` 段里抠出来写进 digest，模型不用再写第二遍。
def _digest_path() -> Path:
    return DUTY_HOME / "digest" / (_dt.datetime.now().strftime("%Y-%m") + ".md")


def _digest_seen(day: str = "") -> set:
    """本月归档里已有的 (日期, BV)；day 非空只看那一天。"""
    have = set()
    p = _digest_path()
    if not p.exists():
        return have
    try:
        for ln in p.read_text(encoding="utf-8", errors="replace").splitlines():
            md = re.match(r"\s*-\s*(\d{4}-\d{2}-\d{2})", ln)
            mb = re.search(r"·\s*(BV[0-9A-Za-z]{10})\s*·", ln)
            if md and mb and (not day or md.group(1) == day):
                have.add((md.group(1), mb.group(1)))
    except Exception:
        return have
    return have


_REPORT_HEAD_RE = re.compile(r"^#{2,4}\s*(BV[0-9A-Za-z]{10})")


def _digest_lines_from_report(body: str) -> list:
    """把日报里每个 `### BV…` 段压成一行归档行 → [(BV, 行)]。"""
    lines = str(body or "").replace("\r\n", "\n").split("\n")
    day = _duty_today()
    out, i = [], 0
    while i < len(lines):
        m = _REPORT_HEAD_RE.match(lines[i].strip())
        i += 1
        if not m:
            continue
        bv = m.group(1)
        block = []
        while i < len(lines) and not re.match(r"^#{1,4}\s", lines[i].strip()):
            block.append(lines[i])
            i += 1
        title = up = gear = one = ""
        para = []
        for ln in block:
            s = ln.strip()
            if not s:
                continue
            g = re.match(r"^\*\*档位\*\*\s*[：:]\s*(.+)", s)
            if g:
                gear = " ".join(g.group(1).split())[:8]
                continue
            if s.startswith("我的一句话"):
                one = re.sub(r"^我的一句话\s*[：:]\s*", "", s)
                continue
            if not title and "**" in s:
                parts = [x.strip() for x in re.split(r"\s*·\s*", s)]
                title = parts[0].strip("*").strip()
                if len(parts) > 1:
                    up = parts[1].strip()
                continue
            if not s.startswith("**"):
                para.append(s)
        if not title:
            continue
        take = " ".join((one or (para[0] if para else "")).split())
        if not one and take:
            take = re.split(r"(?<=。)", take)[0]
        take = take[:90].rstrip("，,、 ")
        out.append((bv, "- " + day + " · " + bv + " · " + title[:60] + " · " + up[:30]
                    + " · " + (gear or "挑中") + "：" + take
                    + " · https://www.bilibili.com/video/" + bv))
    return out


def _seen_existing() -> set:
    """判重表里已有的 (日期, BV, 状态) —— 重复行不再写（模型和自动记录撞车时挡住）。"""
    have = set()
    p = DUTY_HOME / "seen.md"
    if not p.exists():
        return have
    try:
        for ln in p.read_text(encoding="utf-8", errors="replace").splitlines():
            if not ln.strip().startswith("|") or "---" in ln:
                continue
            cols = [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", ln)]
            if len(cols) < 6:
                continue
            have.add((cols[1], cols[2], cols[5]))
    except Exception:
        return have
    return have


# ⭐ 2026-11-28：扫描台账（scan.md）。
#    问题：晚上那轮按 pubdate 搜，返回的大半是中午已经**扫过标题、当场判掉**的视频 ——
#    它们没进 seen.md（只有细看过的才记），于是晚上又原样读一遍（实测一轮 226 行 ≈ 17.6k 字符）。
#    这里把每次 search_batch 返回的 BV 记一笔，同一天内再搜到就直接剔掉，等于"扫过就不再扫"。
def _scan_path() -> Path:
    return DUTY_HOME / "scan.md"


def _scan_today(day: str = "") -> set:
    """今天（或指定日）已经扫过的 BV 集合。"""
    d = day or _duty_today()
    out = set()
    p = _scan_path()
    if not p.exists():
        return out
    try:
        for ln in p.read_text(encoding="utf-8", errors="replace").splitlines():
            parts = ln.split()
            if len(parts) >= 3 and parts[0] == d:
                out.add(parts[2])
    except Exception:
        return out
    return out


def _scan_record(bvids: list) -> None:
    """记下这一轮扫到的 BV；超过 3000 行就只留最近两天（自己截断，不留给用户清理）。"""
    p = _scan_path()
    now = _dt.datetime.now()
    stamp = now.strftime("%Y-%m-%d %H:%M")
    lines = [stamp + " " + bv for bv in bvids if bv]
    if not lines:
        return
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines) + "\n")
        if p.stat().st_size > 60000:
            keep_from = (now - _dt.timedelta(days=2)).strftime("%Y-%m-%d")
            old = p.read_text(encoding="utf-8", errors="replace").splitlines()
            kept = [ln for ln in old if ln[:10] >= keep_from]
            with open(p, "w", encoding="utf-8", newline="\n") as f:
                f.write("\n".join(kept) + "\n")
    except Exception:
        pass


def _seen_append_row(bvid: str, title: str, up: str, status: str, date: str = "") -> bool:
    """追加一行判重（重复则跳过）；返回是否真写了。"""
    bv = str(bvid or "").strip()
    if not bv:
        return False
    d = _duty_norm_date(date)
    st = str(status or "挑了").strip() or "挑了"
    if (d, bv, st) in _seen_existing():
        return False
    row = f"| {_cell(d, 10)} | {_cell(bv, 16)} | {_cell(title)} | {_cell(up, 30)} | {_cell(st, 8)} |\n"
    _append(DUTY_HOME / "seen.md", row)
    return True


@tool()
def duty_paths() -> str:
    """
    这一轮允许写的三个位置（绝对路径）—— 想写东西只能通过这些 duty_* 工具，不要找别的路。

    Returns:
        报告 / 判重表 / 归档 的绝对路径
    """
    out = {
        "home": str(DUTY_HOME),
        "report": str(DUTY_HOME / "out" / (_duty_today() + ".md")),
        "seen": str(DUTY_HOME / "seen.md"),
        "digest": str(DUTY_HOME / "digest" / (_dt.datetime.now().strftime("%Y-%m") + ".md")),
    }
    return json.dumps(out, ensure_ascii=False)


# ⭐ 2026-11-28：判重表也从日报里长出来 —— 收尾只剩一个调用。
#    以前收尾要模型再输出一遍 duty_seen_append_batch(rows)（实测 1,740 字符 ≈ 1.2k 输出 token），
#    可标题 / UP / 档位 / 跳过原因在日报段落里全都有；工具自己抠出来记进 seen.md 就行。
_REPORT_SKIP_RE = re.compile(r"^[-*]\s*跳过\s*[：:]\s*(BV[0-9A-Za-z]{10})\s*(.*)$")


def _seen_title_cache() -> dict:
    """搜索时顺手记下的 BV → [标题, UP, 播放, 时长]（2026-11-28 扩成 4 项：日报标题行也用它拼）。"""
    try:
        data = json.loads((DUTY_HOME / "search-cache.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# ⭐ 2026-11-28：缓存从 [标题, UP] 扩成 [标题, UP, 播放, 时长] —— 日报标题行靠它补，不再让模型写。
def _seen_cache_save(new: dict) -> None:
    """把这一轮搜到的 BV/[标题,UP,播放,时长] 并进缓存（最多留 800 条，老的先丢）。"""
    if not new:
        return
    try:
        cur = _seen_title_cache()
        cur.update(new)
        if len(cur) > 800:
            cur = dict(list(cur.items())[-800:])
        p = DUTY_HOME / "search-cache.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(cur, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def _report_seen_rows(body: str) -> list:
    """
    从日报正文抠出要记判重表的行 → [(bv, 标题, UP, 状态, 跳过原因)]。

    状态：跟着档位走（值得看 / 可以看）；跳过写成固定行 `- 跳过：BV… · 原因` 时记「跳过」。
    """
    lines = str(body or "").replace("\r\n", "\n").split("\n")
    cache = _seen_title_cache()
    order, out = [], {}
    i = 0
    while i < len(lines):
        m = _REPORT_HEAD_RE.match(lines[i].strip())
        if not m:
            i += 1
            continue
        bv = m.group(1)
        i += 1
        block = []
        while i < len(lines) and not re.match(r"^#{1,4}\s", lines[i].strip()):
            block.append(lines[i])
            i += 1
        title = up = gear = ""
        for ln in block:
            s = ln.strip()
            if not s:
                continue
            g = re.match(r"^\*\*档位\*\*\s*[：:]\s*(.+)", s)
            if g and not gear:
                gear = " ".join(g.group(1).split())[:8]
                continue
            if not title and "**" in s:
                parts = [x.strip() for x in re.split(r"\s*·\s*", s)]
                title = parts[0].strip("*").strip()
                if len(parts) > 1:
                    up = parts[1].strip()
                continue
        if bv and bv not in out:
            out[bv] = (bv, title, up, gear or "挑了", "")
            order.append(bv)
    for ln in lines:
        m = _REPORT_SKIP_RE.match(ln.strip())
        if not m or m.group(1) in out:
            continue
        bv = m.group(1)
        hit = cache.get(bv) or ["", ""]
        note = re.sub(r"^[·\-：:\s]+", "", m.group(2)).strip()
        out[bv] = (bv, str(hit[0] or ""), str(hit[1] or ""), "跳过", note[:60])
        order.append(bv)
    return [out[bv] for bv in order]


def _bvid_of_head(ln: str) -> str:
    """就是 ### BVxxxxxxxxxx 这一行时返回 BV 号，否则返回空串。"""
    s = ln.strip()
    if not s.startswith("###"):
        return ""
    rest = s[3:].strip()
    if len(rest) == 12 and rest.startswith("BV") and rest[2:].isalnum():
        return rest
    return ""


def _entry_head_line(bvid: str) -> str:
    """用搜索缓存拼一条「标题 · UP · 链接 · 播放 · 时长」（缓存里没有就返回空串）。"""
    try:
        v = _seen_title_cache().get(bvid) or []
        if not v or not v[0]:
            return ""
        title = " ".join(str(v[0]).split())
        up = " ".join(str(v[1]).split()) if len(v) > 1 and v[1] else ""
        play = v[2] if len(v) > 2 else None
        dur = v[3] if len(v) > 3 else ""
        line = "**" + title + "**"
        if up:
            line += " · " + up
        line += " · [链接](https://www.bilibili.com/video/" + bvid + ")"
        if play:
            line += " · 播放 " + _fmt_count(play)
        if dur:
            line += " · " + str(dur)
        return line
    except Exception:
        return ""


# ⭐ 2026-11-28 调优：日报每条的标题行由这里补（标题/UP/链接/播放/时长 从 search-cache.json 取）。
#    上一轮 9 条标题行合计 834 字符，模型不用再抄一遍；缓存里没有的 BV 原样放过，不硬编。
def _ensure_entry_heads(body: str) -> tuple:
    """给每个 ### BV… 段补标题行：模型只写档位/正文/一句话，标题/UP/链接/播放/时长由这里补。"""
    lines = str(body or "").splitlines()
    out, added = [], 0
    for idx, ln in enumerate(lines):
        out.append(ln)
        bv = _bvid_of_head(ln)
        if not bv:
            continue
        j = idx + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        nxt = lines[j] if j < len(lines) else ""
        if "bilibili.com/video/" in nxt:
            continue
        head = _entry_head_line(bv)
        if head:
            out.append(head)
            added += 1
    return chr(10).join(out), added


# ⭐ 2026-11-28 调优：收尾从「日报 + digest + 判重表」三个调用变**一个**。
#    写日报时顺手做三件事：① 按 ### BV 段归档进本月 digest（不再让模型写第二遍，约 2,000 字符/轮）
#    ② 每条按档位记进判重表（值得看/可以看/跳过）③ 缺标题行的段用搜索缓存补上（约 93 字符/条）。
@tool()
def duty_report_append(text: str, mirror_digest: bool = True) -> str:
    """
    往**今天的日报**末尾追加一段（文件不存在会自动建）。

    ⭐ 2026-11-28：写完会顺手把里面每个 `### BV…` 段压成一行归档进本月 digest（digest 已有的跳过）。
    所以**收尾时只调这一个工具就行，不要再单独写一遍 duty_digest_append** —— 那是把同样的内容
    第二次输出（每天约 2,000 字符 / 1.5k 输出 token），归档行格式固定，工具从日报里抠就够了。

    ⭐ 2026-11-28：同时把判重表也记上 —— 日报里每个 `### BV…` 段（档位当状态）、
    以及 `- 跳过：BV… · 一句原因` 这种行，会自动写成 seen.md 的行；所以**不用再调
    duty_seen_append_batch**（那又是一遍同类内容，实测 1,740 字符 ≈ 1.2k 输出 token）。

    Args:
        text: 要追加的内容（markdown 纯文本，条目用 `### BV号` + `**标题** · UP · 链接` + `**档位**：值得看` 的格式）
        mirror_digest: 默认 true = 顺带归档进 digest；false = 只写日报

    Returns:
        写到了哪个文件、顺带归档了几条
    """
    body = str(text or "").replace("\r\n", "\n").strip()
    if not body:
        return "没写：内容是空的"
    # 2026-11-28：标题行（标题 · UP · 链接 · 播放 · 时长）由工具从搜索缓存补，
    #    模型只写 BV 标题行 + 档位 + 正文 + 我的一句话 —— 每条省约 100 字符输出。
    head_added = 0
    try:
        body, head_added = _ensure_entry_heads(body)
    except Exception:
        head_added = 0
    p = DUTY_HOME / "out" / (_duty_today() + ".md")
    fresh = not p.exists()
    payload = body + "\n"
    if fresh:
        payload = "# 刷B站日报 " + _duty_today() + "\n\n" + payload
    msg = "已追加到 " + _append(p, payload)
    if head_added:
        msg += "（补了 " + str(head_added) + " 条标题行）"
    # ⭐ 2026-11-28：顺手把判重表记上 —— 模型收尾不用再单独输出一遍 rows
    srows = []
    try:
        srows = _report_seen_rows(body)
        wrote = 0
        for bv, title, up, status, _note in srows:
            if _seen_append_row(bv, title, up, status):
                wrote += 1
        if srows:
            msg += "（判重表记了 " + str(wrote) + " 行" + ("，重复的没记" if wrote < len(srows) else "") + "）"
    except Exception as e:
        msg += "（判重表没记上：" + str(e) + "）"
    if not mirror_digest:
        return msg
    try:
        today = _duty_today()
        have = _digest_seen(today)
        lines, seen_now = [], set()
        for bv, ln in _digest_lines_from_report(body):
            if (today, bv) in have or bv in seen_now:
                continue
            seen_now.add(bv)
            lines.append(ln)
        # ⭐ 2026-11-28：跳过的也归一行档（以前靠 duty_seen_append_batch 的 note）
        for bv, title, up, status, note in srows:
            if status != "跳过" or (today, bv) in have or bv in seen_now:
                continue
            seen_now.add(bv)
            lines.append("- " + today + " · " + bv + " · " + " ".join(title.split())[:60] + " · "
                         + " ".join(up.split())[:30] + " · 跳过：" + (note or "跳过")[:60]
                         + " · https://www.bilibili.com/video/" + bv)
        if not lines:
            return msg + "（digest 这几条已经归档过，没重复写）"
        _append(_digest_path(), "\n".join(lines) + "\n")
        return msg + "（顺带归档 " + str(len(lines)) + " 条到 digest）"
    except Exception as e:
        return msg + "（归档没写成：" + str(e) + "）"


@tool()
def duty_seen_append(bvid: str, title: str, up: str, status: str, date: str = "") -> str:
    """
    往判重表追加一行（「挑了」= 进过报告 / 「跳过」= 看过但没进 / 「评论」= 本轮 @ 过）。

    Args:
        bvid: BV 号
        title: 标题
        up: UP 主
        status: 挑了 / 跳过 / 评论
        date: 日期（YYYY-MM-DD，一般留空=今天）

    Returns:
        写到了哪个文件
    """
    bv = str(bvid or "").strip()
    if not bv:
        return "没写：bvid 是空的"
    d = _duty_norm_date(date)
    row = f"| {_cell(d, 10)} | {_cell(bv, 16)} | {_cell(title)} | {_cell(up, 30)} | {_cell(status, 8)} |\n"
    return "已追加到 " + _append(DUTY_HOME / "seen.md", row)


# ⭐ 2026-11-28 调优：**一般不用调**（日报里有的条目由 duty_report_append 自动记）。
#    留着只给「日报之外单独补记」的场合；按 (日期, BV, 状态) 去重，重复调用不会写两遍。
@tool()
def duty_seen_append_batch(rows: str) -> str:
    """
    一次把**整轮**的判重行写完（一条调用顶十几条 duty_seen_append，省模型往返）。

    ⚠️ 2026-11-28 起**一般不用调**：日报里有的条目由 duty_report_append 自动记进判重表，
    这里只留给「日报之外单独补记」的场合。

    ⭐ 2026-11-28：status=跳过 的行走带 `"note":"一句跳过理由"` 时，会**顺带把这条归档进本月 digest**
    （挑中的由 duty_report_append 从日报里自动归档）—— 所以收尾时不用再单独写一遍 duty_digest_append。

    Args:
        rows: JSON 数组字符串，每项 {"bvid": "BV…", "title": "…", "up": "…", "status": "挑了|跳过|评论", "note": "跳过理由（可选）", "date": "可选"}

    Returns:
        写了几行、写到了哪个文件；格式不对的条目会跳过并说明
    """
    guard = _guard("duty_seen_append_batch")
    if guard:
        return guard
    try:
        items = json.loads(rows) if isinstance(rows, str) else rows
    except Exception as e:
        return "没写：rows 不是合法 JSON（" + str(e) + "）"
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list):
        return "没写：rows 要传 JSON 数组（每项一个对象）"
    have = _seen_existing()
    lines, skipped, dup = [], [], 0
    digest_lines, digest_have = [], _digest_seen()
    for i, it in enumerate(items[:60], 1):
        if not isinstance(it, dict):
            skipped.append("第 " + str(i) + " 条不是对象")
            continue
        bv = str(it.get("bvid") or "").strip()
        if not bv:
            skipped.append("第 " + str(i) + " 条缺 bvid")
            continue
        d = _duty_norm_date(str(it.get("date") or ""))
        title = str(it.get("title") or "")
        up = str(it.get("up") or "")
        status = str(it.get("status") or "挑了")
        key = (d, bv, status.strip() or "挑了")
        # ⭐ 2026-11-28：bili_reply 成功后会自动记一行「评论」，模型再写一遍就会重复。
        #    重复的（日期+BV+状态都一样）直接跳过，不写第二行。
        if key in have:
            dup += 1
            continue
        have.add(key)
        lines.append(f"| {_cell(d, 10)} | {_cell(bv, 16)} | {_cell(title)} | {_cell(up, 30)} | {_cell(status, 8)} |\n")
        note = " ".join(str(it.get("note") or "").split())
        if note and str(status).strip() == "跳过" and (d, bv) not in digest_have:
            digest_have.add((d, bv))
            digest_lines.append("- " + d + " · " + bv + " · " + " ".join(title.split())[:60] + " · "
                               + " ".join(up.split())[:30] + " · 跳过：" + note[:60]
                               + " · https://www.bilibili.com/video/" + bv + "\n")
    if not lines:
        if dup:
            return "没写：" + str(dup) + " 行判重表里已经有了（不用重复写）"
        return "没写：" + ("；".join(skipped) if skipped else "rows 是空数组")
    path = _append(DUTY_HOME / "seen.md", "".join(lines))
    if digest_lines:
        try:
            _append(_digest_path(), "".join(digest_lines))
        except Exception:
            pass
    msg = "已一次追加 " + str(len(lines)) + " 行到 " + path
    if digest_lines:
        msg += "（顺带归档 " + str(len(digest_lines)) + " 条跳过的进 digest）"
    if dup:
        msg += "（已跳过 " + str(dup) + " 行重复的）"
    if len(items) > 60:
        msg += "（超过 60 条，多出来的没写）"
    if skipped:
        msg += "（跳过：" + "；".join(skipped) + "）"
    return msg


@tool()
def duty_seen_recent(limit: int = 40, bvid: str = "", compact: bool = True) -> str:
    """
    读判重表的最近若干行（只读，只读插件自己那份 seen.md）。

    Args:
        limit: 取最近多少个**视频**（默认 40，上限 200；同一条视频的多行会合并成一行，留最新状态）
        bvid: 只查某个 BV（留空=看全部）
        compact: 默认 true = 一条一行「日期 BV 状态 标题前 14 字」（判重够用，字符省 ~3/4）；
                 false = 原样表格行（日期 | BV | 标题 | UP | 状态）

    Returns:
        表格行；空 = 这份表还没内容
    """
    f = DUTY_HOME / "seen.md"
    if not f.exists():
        return "（判重表还不存在）"
    try:
        lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception as e:
        return "读不到判重表：" + str(e)
    rows = [ln for ln in lines if ln.strip().startswith("|") and "---" not in ln and not ln.strip().startswith("| 日期")]
    if bvid:
        bv = str(bvid).strip()
        rows = [ln for ln in rows if bv in ln]
    n = max(1, min(int(limit or 40), 200))
    # ⭐ 2026-11-27：按 BV 去重再截窗口。同一条视频通常有「挑了」和「评论」两行，
    #    按行截窗口等于把一半名额浪费在看过的视频上（实测 80 行只覆盖 60 个视频）。
    #    这里每个 BV 只保留它最后一次出现的行（最新状态），不同视频的先后顺序不变。
    kept = []
    seen_bv = set()
    for ln in reversed(rows):
        m = re.search(r"BV[0-9A-Za-z]{10}", ln)
        key = m.group(0) if m else ln
        if key in seen_bv:
            continue
        seen_bv.add(key)
        kept.append(ln)
    kept.reverse()
    tail = kept[-n:]
    if not tail:
        return "（最近没有记录）"
    head = ("共 " + str(len(rows)) + " 行 / " + str(len(kept)) + " 个视频，最近 "
            + str(len(tail)) + " 个视频")
    if not compact:
        return head + "：\n" + "\n".join(tail)
    # ⭐ 2026-11-28：判重只需要「这个 BV 看过没有 / 什么状态」，原样表格行带上长标题和 UP，
    #    40 行 ≈ 7.7k 字符，占一轮工具字符的 14%。压成一行一条后 ≈ 2k（-75%），
    #    标题只留前 14 字，够判断"这期是不是同一个话题"。
    agg = {}
    order = []
    for ln in rows:
        # _cell() 会把标题里的竖线转义成 \| ⇒ 按「未转义的竖线」切，再还原
        cols = [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", ln.strip().strip("|"))]
        while len(cols) < 5:
            cols.append("")
        d, bv, title, _up, status = cols[:5]
        cur = agg.get(bv)
        if cur is None:
            cur = {"date": d, "status": status, "title": ""}
            agg[bv] = cur
            order.append(bv)
        cur["date"], cur["status"] = d, status
        # 「评论」行把 title 写成了「评论记录 rpid=…」⇒ 别让它盖掉真正的标题
        if title and not cur["title"] and not title.startswith("评论记录"):
            cur["title"] = re.sub(r"\s+", " ", title)[:14]
    out = []
    for bv in order[-n:]:
        cur = agg[bv]
        d = cur["date"]
        out.append((d[5:] if len(d) >= 10 else d) + " " + bv + " " + (cur["status"] or "?")
                   + (" " + cur["title"] if cur["title"] else ""))
    return head + "（日期 BV 状态 标题前 14 字）：\n" + "\n".join(out)


@tool()
def duty_digest_append(text: str) -> str:
    """
    往**本月归档**末尾追加一段（「digest/<年-月>.md」，给"后来翻旧账"用的）。

    一般**不用**调它：duty_report_append 会自动把日报里的条目归档进 digest。
    这里只用于「日报之外、单独想往归档里记一条」的场合；同一天同一个 BV 已经有的会跳过。

    Args:
        text: 要追加的内容

    Returns:
        写到了哪个文件、跳过了几条
    """
    body = str(text or "").replace("\r\n", "\n").strip()
    if not body:
        return "没写：内容是空的"
    p = _digest_path()
    have = _digest_seen()
    keep, dup = [], 0
    for ln in body.split("\n"):
        s = ln.rstrip()
        md = re.match(r"\s*-\s*(\d{4}-\d{2}-\d{2})", s)
        mb = re.search(r"·\s*(BV[0-9A-Za-z]{10})\s*·", s)
        if md and mb and (md.group(1), mb.group(1)) in have:
            dup += 1
            continue
        keep.append(s)
    if not "".join(keep).strip():
        return "没写：这些条目本月归档里已经有了（日报追加时会自动归档，这里一般不用写）"
    msg = "已追加到 " + _append(p, "\n".join(keep).rstrip() + "\n")
    if dup:
        msg += "（跳过 " + str(dup) + " 条已归档的）"
    return msg


# ========== 转写：非阻塞 + 单条排队 + 可取回的结果 ==========
#
# ⭐⭐ 2026-10-25 修（群友报的真 bug，附了 MCP SDK 源码依据）：
#    原来的 `bili_transcribe` 是**同步 def**，里面 `subprocess.run(timeout=1800)`。
#    mcp 1.30.0 的 func_metadata.py:114 对同步函数是**直接在事件循环里调用**（不是丢线程池），
#    于是整条 stdio 会话被这一句占住 ⇒ 同一轮里其它工具（发私信 / 写判重表）全部 60s 超时，
#    一整轮拖成 20 分钟，最后私信没发出去 ✗
#
#    所以改成两条路：
#      · `bili_transcribe(bvid)`   —— 仍然是"要全文"，但**不再阻塞事件循环**（async + create_subprocess_exec）
#                                    并且用信号量限制"一次只有一条"，避免几路 whisper 互相拖死
#      · `bili_transcribe_start(bvid)` / `bili_transcribe_result(job_id)`
#                                  —— **推荐用法**：立刻返回 job_id，轮次继续干别的；
#                                    下一轮或收尾时再来取结果。慢活不该挂在一个工具调用的超时上。
_TRANSCRIBE_SEM = asyncio.Semaphore(1)
_TRANSCRIBE_JOBS = {}          # job_id -> {"state": running|done|error, "text": str, "bvid": str, "started": ts}
_TRANSCRIBE_TIMEOUT = 900      # 15 分钟硬顶（原来是 1800，太长）
_TRANSCRIBE_WAIT = 25         # 直接调用时最多等这么久（客户端单次调用常见 60s 超时）
_TRANSCRIBE_KEEP = 8           # 只留最近 8 个 job 的结果，避免内存里堆一堆长文本
_TRANSCRIBE_JOBS_DIR = DUTY_HOME / "tmp" / "jobs"   # job_id → bvid 的落盘映射（跨轮取结果要用）


def _pid_alive(pid: int) -> bool:
    """判断一个 pid 还活着。

    ⚠️ Windows 上不能用 os.kill(pid, 0) —— 那里只认 CTRL_C / CTRL_BREAK，
    传 0 会真的去 TerminateProcess（等于把别人的转写杀掉）。
    """
    try:
        pid = int(pid)
    except Exception:
        return False
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            import ctypes
            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return False
            code = ctypes.c_ulong()
            ok = k32.GetExitCodeProcess(h, ctypes.byref(code))
            k32.CloseHandle(h)
            return bool(ok) and code.value == 259     # STILL_ACTIVE
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _job_note(job_id: str, bv: str):
    """把 job_id → bvid 落盘。

    MCP 服务每轮临时挂载、内存 job 表活不过一轮，下一轮 bili_transcribe_result
    得靠这份映射找回 bvid，再去 tmp/<bv>.txt 取结果。
    """
    try:
        _TRANSCRIBE_JOBS_DIR.mkdir(parents=True, exist_ok=True)
        p = _TRANSCRIBE_JOBS_DIR / (job_id + ".json")
        p.write_text(json.dumps({"bvid": bv, "started": _dt.datetime.now().timestamp()}, ensure_ascii=False), encoding="utf-8")
        cutoff = _dt.datetime.now().timestamp() - 7 * 86400
        for f in _TRANSCRIBE_JOBS_DIR.glob("*.json"):
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
            except Exception:
                pass
    except Exception:
        pass


def _job_bvid(job_id: str) -> str:
    try:
        p = _TRANSCRIBE_JOBS_DIR / (job_id + ".json")
        if p.exists():
            return str(json.loads(p.read_text(encoding="utf-8")).get("bvid") or "")
    except Exception:
        pass
    return ""


def _transcribe_paths(bv: str):
    """返回 (python, script, out_path)；缺东西时返回 (None, 原因, None)"""
    py_candidates = [
        DUTY_HOME / ".venv-asr" / "Scripts" / "python.exe",
        DUTY_HOME / ".venv-asr" / "bin" / "python",
    ]
    py = next((str(p) for p in py_candidates if p.exists()), "")
    if not py:
        return None, "转写环境没装好（设置页里有「装转写依赖」）", None
    script = DUTY_HOME / "asr.py"
    if not script.exists():
        return None, "找不到 asr.py（家目录里没有转写脚本）", None
    out = DUTY_HOME / "tmp" / (bv + ".txt")
    out.parent.mkdir(parents=True, exist_ok=True)
    return py, script, out


def _transcribe_read(out) -> str:
    """把产物读成"给模型看的结果"（空的 / 只有署名 ⇒ 当作没有语音）"""
    try:
        if not out.exists():
            return "转写没产出文件 —— 这条按「读不到」处理，跳过它"
        text = out.read_text(encoding="utf-8", errors="replace").strip()
        if not text:
            return "（空）—— 这条没有语音，跳过它"
        if len(text) <= 40 and ("字幕by" in text or "字幕BY" in text):
            return "（只有署名「" + text[:40] + "」）—— 当没有语音处理，跳过"
        return text[:12000]
    except Exception as e:
        return "读转写结果失败：" + str(e)


async def _transcribe_run(bv: str) -> str:
    """真正跑转写（非阻塞）。信号量保证同一时间只有一条在跑。

    ⭐ 2026-11-20 修 #201：以前转写子进程跟着 MCP 进程一起被带走 ——
    MCP 服务每轮临时挂载、轮次结束就退出，job 表在内存、子进程没了，
    结果文件 tmp/<bv>.txt 根本没生成，报告里却写着“待转写，下一轮取”。
    现在两条腿：
      ① 子进程 **detach**（Windows DETACHED_PROCESS / POSIX start_new_session），
         轮次结束后继续跑完并写出 tmp/<bv>.txt；
      ② 起进程之前**先看磁盘**：命中产物就直接读，不再重复跑；
      ③ 跨进程用 tmp/<bv>.running（里面写 pid）去重，别让两个轮次各跑一份。
    """
    py, script, out = _transcribe_paths(bv)
    if not py:
        return str(script)      # script 位置放的是错误文案
    # ① 磁盘命中：上一轮（同进程或跨进程）已经写好了，直接读
    if out.exists():
        return _transcribe_read(out)
    running = out.parent / (bv + ".running")
    # ② 别的进程起的转写还活着 ⇒ 别再起一份（whisper 吃 CPU，多开互相拖死）
    if running.exists():
        try:
            other = int(running.read_text(encoding="utf-8").strip() or "0")
        except Exception:
            other = 0
        if other and _pid_alive(other):
            return "这条视频已经在转写了（另一个进程还活着）—— 下一轮再来取结果"
        try:
            running.unlink()
        except Exception:
            pass
    async with _TRANSCRIBE_SEM:
        if out.exists():
            return _transcribe_read(out)
        try:
            running.write_text(str(os.getpid()), encoding="utf-8")
        except Exception:
            pass
        log = out.parent / (bv + ".log")
        logf = None
        try:
            logf = open(log, "ab")
        except Exception:
            logf = None
        try:
            kwargs = {}
            if os.name == "nt":
                kwargs["creationflags"] = (subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS)
            else:
                kwargs["start_new_session"] = True
            # ⭐ 用同步 Popen，不用 asyncio.create_subprocess_exec：
            #    asyncio 的 subprocess transport 在事件循环关闭时会把自己的子进程收掉
            #    （实测父进程退出后子进程跑不到 3 秒）；Popen + DETACHED_PROCESS 才是真脱身。
            proc = subprocess.Popen(
                [py, str(script), bv, "-o", str(out)],
                stdin=subprocess.DEVNULL,
                # 输出重定向到日志文件：父进程（MCP）退出后管道不会跟着断，子进程能安心写完
                stdout=logf if logf else subprocess.DEVNULL,
                stderr=logf if logf else subprocess.DEVNULL,
                env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
                **kwargs,
            )
        except Exception as e:
            if logf:
                try:
                    logf.close()
                except Exception:
                    pass
            try:
                running.unlink()
            except Exception:
                pass
            return "转写启动失败：" + str(e)
        try:
            running.write_text(str(proc.pid), encoding="utf-8")
        except Exception:
            pass
        # ③ 轮询等它跑完（最多 15 分钟）：拿「结果文件出现」当完成信号，
        #    不依赖管道 —— 这样父进程提前退出也不会影响子进程。
        import time as _time
        deadline = _time.monotonic() + _TRANSCRIBE_TIMEOUT
        try:
            while _time.monotonic() < deadline:
                if out.exists():
                    return _transcribe_read(out)
                if proc.poll() is not None:
                    break
                await asyncio.sleep(0.5)
            else:
                try:
                    proc.kill()
                except Exception:
                    pass
                return f"转写超时（{_TRANSCRIBE_TIMEOUT // 60} 分钟）—— 这条按「读不到」处理，跳过它"
        finally:
            try:
                running.unlink()
            except Exception:
                pass
            if logf:
                try:
                    logf.close()
                except Exception:
                    pass
        if out.exists():
            return _transcribe_read(out)
        tail = ""
        try:
            if log.exists():
                tail = log.read_text(encoding="utf-8", errors="replace")[-400:]
        except Exception:
            pass
        return "转写没产出文件（exit " + str(proc.returncode) + "）：" + tail


def _job_prune():
    if len(_TRANSCRIBE_JOBS) <= _TRANSCRIBE_KEEP:
        return
    for k in list(_TRANSCRIBE_JOBS.keys())[: len(_TRANSCRIBE_JOBS) - _TRANSCRIBE_KEEP]:
        _TRANSCRIBE_JOBS.pop(k, None)


async def _job_run(job_id: str, bv: str):
    try:
        text = await _transcribe_run(bv)
        _TRANSCRIBE_JOBS[job_id] = {"state": "done", "text": text, "bvid": bv, "started": _TRANSCRIBE_JOBS.get(job_id, {}).get("started", 0)}
    except Exception as e:
        _TRANSCRIBE_JOBS[job_id] = {"state": "error", "text": "转写异常：" + str(e), "bvid": bv, "started": 0}


@tool()
async def bili_transcribe(bvid: str) -> str:
    """
    用本地 ASR 把一条**没有字幕**的视频转成文字（慢，几分钟）。

    ⚠️ 这个调用会**等到跑完**才返回（不再阻塞别的工具，但它自己会慢）。
    更好的用法是先 `bili_transcribe_start` 拿 job_id，这一轮先干别的，之后用 `bili_transcribe_result` 取。

    Args:
        bvid: BV 号

    Returns:
        转写出来的文字（截断到 12000 字）；空的 / 只有署名 ⇒ 当作这条没有语音
    """
    denied = _guard("bili_transcribe")
    if denied:
        return denied
    bv = str(bvid or "").strip()
    if not bv.startswith("BV"):
        return "参数不对：要给 BV 号"
    # ⭐ 2026-10-25 二次修（真机实测）：直接 await 整条转写 ⇒ 客户端 60s 超时，
    #    那一轮白等一次、还记了句"转写超时"✗
    #    ⇒ 现在只等 _TRANSCRIBE_WAIT 秒：跑完就回文本，没跑完就**把 job_id 交回去**，
    #      由模型下一轮用 bili_transcribe_result 取（比"超时"有用得多）
    # ⭐ 上一轮已经转好了 ⇒ 直接给，别重跑（#201）。
    #    先看磁盘、不先看环境：结果已经在，就不该因为 venv 探测失败把已有结果丢掉。
    _out0 = DUTY_HOME / "tmp" / (bv + ".txt")
    if _out0.exists():
        return _transcribe_read(_out0)
    py, why, out = _transcribe_paths(bv)
    if not py:
        return str(why)
    job_id = "tj" + _dt.datetime.now().strftime("%H%M%S") + "-" + bv[-4:]
    _job_note(job_id, bv)
    _TRANSCRIBE_JOBS[job_id] = {"state": "running", "text": "", "bvid": bv, "started": _dt.datetime.now().timestamp()}
    _job_prune()
    task = asyncio.create_task(_job_run(job_id, bv))
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=_TRANSCRIBE_WAIT)
    except asyncio.TimeoutError:
        return (f"转写还没跑完（超过 {_TRANSCRIBE_WAIT} 秒），已排进后台：job_id={job_id}。\n"
                "**这一轮别等它** —— 先把报告 / 判重表 / 归档 / 私信做完；"
                "下一轮或收尾前用 bili_transcribe_result(job_id) 取结果（还 running 就记「已排队，下一轮再判」）。")
    job = _TRANSCRIBE_JOBS.get(job_id) or {}
    if job.get("state") == "error":
        return str(job.get("text") or "转写失败")
    return str(job.get("text") or "转写没拿到内容")


@tool()
async def bili_transcribe_start(bvid: str) -> str:
    """
    开始一条转写任务，**立刻返回 job_id**（推荐用这个 —— 慢活不该占住这一轮）。

    Args:
        bvid: BV 号

    Returns:
        JSON：{"ok": true, "job_id": "…", "hint": "…"}
    """
    denied = _guard("bili_transcribe_start")
    if denied:
        return json.dumps({"ok": False, "error": denied}, ensure_ascii=False)
    bv = str(bvid or "").strip()
    if not bv.startswith("BV"):
        return json.dumps({"ok": False, "error": "参数不对：要给 BV 号"}, ensure_ascii=False)
    # ⭐ 已经转好了 ⇒ 直接回结果，不再起进程（#201）
    _out0 = DUTY_HOME / "tmp" / (bv + ".txt")
    if _out0.exists():
        return json.dumps({
            "ok": True, "state": "done", "bvid": bv, "text": _transcribe_read(_out0),
            "hint": "这条之前已经转过了，直接用这份结果；没有新起进程。",
        }, ensure_ascii=False)
    py, why, out = _transcribe_paths(bv)
    if not py:
        return json.dumps({"ok": False, "error": why}, ensure_ascii=False)
    job_id = "tj" + _dt.datetime.now().strftime("%H%M%S") + "-" + bv[-4:]
    _job_note(job_id, bv)
    _TRANSCRIBE_JOBS[job_id] = {"state": "running", "text": "", "bvid": bv, "started": _dt.datetime.now().timestamp()}
    _job_prune()
    asyncio.create_task(_job_run(job_id, bv))
    return json.dumps({
        "ok": True,
        "job_id": job_id,
        "hint": "已排队。这一轮**别等**：先把报告 / 判重表 / 私信做完；下一轮或收尾时用 bili_transcribe_result 取结果。",
    }, ensure_ascii=False)


@tool()
async def bili_transcribe_result(job_id: str) -> str:
    """
    取一条转写任务的结果（没有就返回 running）。

    Args:
        job_id: `bili_transcribe_start` 返回的那个 id

    Returns:
        JSON：{"state": "running|done|error", "text": "…"}
    """
    denied = _guard("bili_transcribe_result")
    if denied:
        return json.dumps({"ok": False, "error": denied}, ensure_ascii=False)
    jid = str(job_id or "").strip()
    job = _TRANSCRIBE_JOBS.get(jid)
    if not job:
        # ⭐ 内存里没有 ⇒ 上一轮那个进程早退了，但转写结果可能已经落盘（#201）
        bv = _job_bvid(jid)
        if bv:
            out = DUTY_HOME / "tmp" / (bv + ".txt")
            if out.exists():
                return json.dumps({"ok": True, "state": "done", "bvid": bv, "text": _transcribe_read(out)},
                                  ensure_ascii=False)
            running = DUTY_HOME / "tmp" / (bv + ".running")
            pid = 0
            try:
                if running.exists():
                    pid = int(running.read_text(encoding="utf-8").strip() or "0")
            except Exception:
                pid = 0
            if pid and _pid_alive(pid):
                return json.dumps({
                    "ok": True, "state": "running", "bvid": bv, "text": "",
                    "hint": "转写进程还活着（轮次结束后它自己继续跑），这一轮先干别的",
                }, ensure_ascii=False)
            return json.dumps({
                "ok": True, "state": "error", "bvid": bv, "text": "转写进程已经结束，但没产出结果文件 —— 这条按「读不到」跳过",
            }, ensure_ascii=False)
        return json.dumps({"ok": False, "state": "unknown", "error": "没有这个 job（可能已经过期，或者 id 打错了）"}, ensure_ascii=False)
    return json.dumps({
        "ok": True,
        "state": job["state"],
        "bvid": job["bvid"],
        "text": job.get("text", "") if job["state"] != "running" else "",
        "hint": "还在跑，这一轮先干别的" if job["state"] == "running" else "",
    }, ensure_ascii=False)

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


# ========== Tool: 首页推荐流（不填关键词时用它，替代固定关键词搜索） ==========
# ⭐ 为什么要它（2026-10-23 主人拍板）：
#    以前不填关键词就用内置那几组（DeepSeek Harness / DSH 插件 …）⇒ **所有装了插件的人刷的是同一批视频**
#    ⇒ 相关视频的评论区必然堆成一片"同款插件在互相报到" ✗
#    推荐流按各自账号画像推，天然散开 ✓ —— 这是结构性解法，比"每轮少发几条"靠谱得多。
#
# ⚠️ 它需要登录凭证（匿名也能拿到一部分，但带凭证才是"这个账号的推荐"），
#    所以这里用 load_credential()；拿不到就退成匿名（仍然能用，只是不那么"散"）。
@tool()
async def bili_recommend(ps: int = 20) -> str:
    """
    获取「首页推荐流」的视频（按当前登录账号的画像）

    Args:
        ps: 返回几条，默认 20，最多 40

    Returns:
        JSON 格式的视频列表，字段与 bili_search 对齐（bvid / title / author / play / danmaku / duration…）
    """
    await _throttle()
    denied = _guard("bili_recommend")
    if denied:
        return json.dumps({"ok": False, "error": denied}, ensure_ascii=False)

    cred = None
    try:
        cred = load_credential()
    except Exception:
        cred = None

    try:
        data = await homepage.get_videos(credential=cred)
    except Exception as e:  # noqa: BLE001 - 统一收成 ok:false，别把原始异常甩给模型
        return json.dumps({"ok": False, "error": f"取推荐流失败：{e}"}, ensure_ascii=False)

    items = []
    if isinstance(data, dict):
        items = data.get("item") or data.get("data") or []
    elif isinstance(data, list):
        items = data

    videos = []
    for it in items[: max(1, min(int(ps), 40))]:
        if not isinstance(it, dict):
            continue
        # 只留视频（推荐流里会混进直播 / 番剧 / 广告卡片）
        if it.get("goto") and it.get("goto") != "av":
            continue
        if not it.get("bvid"):
            continue
        owner = it.get("owner") or {}
        stat = it.get("stat") or {}
        dur = it.get("duration")
        videos.append({
            "bvid": it.get("bvid", ""),
            "title": str(it.get("title", "")).strip(),
            "author": owner.get("name", ""),
            "play": stat.get("view", 0),
            "danmaku": stat.get("danmaku", 0),
            "like": stat.get("like", 0),
            "duration": f"{int(dur) // 60}:{int(dur) % 60:02d}" if isinstance(dur, (int, float)) else str(dur or ""),
            "pubdate": it.get("pubdate", 0),
            "reason": (it.get("rcmd_reason") or {}).get("content", "") if isinstance(it.get("rcmd_reason"), dict) else "",
        })

    return json.dumps({
        "ok": True,
        "source": "recommend",
        "count": len(videos),
        "videos": videos,
    }, ensure_ascii=False)


# ========== 启动 ==========

if __name__ == "__main__":
    mcp.run(transport="stdio")