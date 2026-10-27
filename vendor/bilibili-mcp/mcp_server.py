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
#      ⑦ **输入延迟**：`_typing_wait()` / `_type_wait()` —— 发评论 / 发私信之前按
#         「字数 / 速度(随机) + 随机抖动」等一会儿（2.4.0；上游也没有）
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


# ⭐ 2.4.0 输入延迟：**"发"之前先按人打字的速度等一会儿**
#   背景：2.3.0 的 `_throttle()` 只管**读**（搜索 / 推荐流 / 字幕 / 评论）。
#   两个**写**操作（`bili_reply` 评论、`bili_send_message` 私信）此前**一点延迟都没有** ——
#   读完字幕紧接着就把评论提交上去，节奏上等于"手指比脑子快"，全流程里最像机器的一处。
#   口径：`等待 = 字数 / 速度(字/秒，范围内取 random) + 随机抖动`
#     · 速度默认 **1.2~3.5 字/秒**（= 72~210 字/分钟，中文输入法下正常人打字）
#     · 抖动默认 **0.5~2.0 秒**（按下发送前那一下犹豫 / 挪鼠标）
#     · 上限默认 **90 秒**（再长就成卡死了；宿主那条 MCP 调用是 180 秒超时）
#   只影响**写**；读还是走 `_throttle()`。整件事关掉：`BILI_TYPE_OFF=1`。
def _env_float(name: str, default: float) -> float:
    """读一个浮点环境变量；没写 / 写坏了都退回默认值（绝不因为一个环境变量炸掉发评论）"""
    try:
        return float(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default


_TYPE_OFF = os.environ.get("BILI_TYPE_OFF", "") in ("1", "true", "yes")
_TYPE_CPS_MIN = _env_float("BILI_TYPE_CPS_MIN", 1.2)
_TYPE_CPS_MAX = _env_float("BILI_TYPE_CPS_MAX", 3.5)
_TYPE_JITTER_MIN = _env_float("BILI_TYPE_JITTER_MIN", 0.5)
_TYPE_JITTER_MAX = _env_float("BILI_TYPE_JITTER_MAX", 2.0)
_TYPE_MAX_WAIT = _env_float("BILI_TYPE_MAX_WAIT", 90.0)


def _typing_wait(text: str, cps_min=None, cps_max=None, jitter_min=None,
                 jitter_max=None, cap=None, rng=None) -> float:
    """这一条"打"下来该等多久（秒）。纯函数：不睡、不联网；`rng` 可注入 ⇒ 好测。

    `字数 / 速度 + 抖动`：字数按**字符**数（中文一个字算一个，emoji 也算一个），
    速度取 `[cps_min, cps_max]` 里的一个随机值 —— 打字快慢本来就有波动，固定值反而像机器。
    """
    r = rng if rng is not None else random
    cps_lo, cps_hi = sorted((_TYPE_CPS_MIN if cps_min is None else cps_min,
                             _TYPE_CPS_MAX if cps_max is None else cps_max))
    jit_lo, jit_hi = sorted((_TYPE_JITTER_MIN if jitter_min is None else jitter_min,
                             _TYPE_JITTER_MAX if jitter_max is None else jitter_max))
    ceiling = _TYPE_MAX_WAIT if cap is None else cap

    chars = len(text or "")
    if chars <= 0:
        return 0.0
    if cps_hi <= 0:                     # 速度填成 0 / 负数 ⇒ 别除零，按 1 字/秒算
        cps_lo = cps_hi = 1.0
    cps = r.uniform(max(cps_lo, 0.01), cps_hi)
    wait = chars / cps + r.uniform(max(jit_lo, 0.0), max(jit_hi, 0.0))
    if ceiling > 0:
        wait = min(wait, ceiling)
    return max(wait, 0.0)


async def _type_wait(text: str) -> float:
    """按人打字的速度等一会儿再发。返回实际等了多久（秒）；关着 / 空文本 ⇒ 0。"""
    if _TYPE_OFF:
        return 0.0
    wait = _typing_wait(text)
    if wait <= 0:
        return 0.0
    # 打到 stderr（宿主的 duty.log 会收），以后排查"怎么慢了几十秒"能直接对上
    print(f"[bili-mcp] 输入延迟 {wait:.1f}s（{len(text or '')} 字）", file=sys.stderr)
    try:
        await asyncio.sleep(wait)
    except Exception:
        return 0.0                      # 被取消 / 事件循环关了 ⇒ 别拦着发送
    return wait

# ========== 初始化 ==========

CRED_FILE = Path(__file__).parent / "bili_credential.json"

mcp = FastMCP("bilibili-mcp")

# ⭐ 工具白名单（2026-10-17 审查里的 H3）：宿主通过 overlay 的 env 下发 BILI_MCP_TOOLS（逗号分隔）。
#    · 不给这个变量 ⇒ **全放**（手工跑、或老配置，行为一点不变 ✓）
#    · 给了 ⇒ 只注册名单里的；不在名单里的工具**连名字都不会出现在 list_tools 里**，
#      模型那边等于根本不存在 —— 这才是真的闸门（光靠提示词说"别用"不算）✓
_ALLOWED = {t.strip() for t in os.environ.get("BILI_MCP_TOOLS", "").split(",") if t.strip()}


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

    ⚠️ 提交前会按**字数**模拟一段打字延迟（几百毫秒到一分多钟，见 `_typing_wait`）——
       那是故意的、也是它该有的样子，**不要因此重试**（重试只会把同样的字再打一遍）。
    """
    _deny = _guard("bili_reply")
    if _deny: return _deny
    # ⭐ 语感闸门：撞八股 / 撞自己以前的 / 撞这条视频的热评 ⇒ 不发，把改法告诉模型
    _style = await _style_reason(text, bvid, get_cred())
    if _style:
        return json.dumps({"ok": False, "sent": False, "blocked_by": "style", "error": _style}, ensure_ascii=False)
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = info["aid"]

    # ⭐ 2.4.0：先把该读的读完，再"打字" —— 顺序跟人一样（看完视频 → 在输入框里敲 → 发）
    typed = await _type_wait(text)

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
        if typed > 0:                   # 回执里带上"打了多久"，日志/复核对得上时间
            out["typing_wait_s"] = round(typed, 1)
        _ledger_append(text, bvid, result.get("rpid") if isinstance(result, dict) else None)
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

    ⚠️ 跟评论一样：提交前按**字数**模拟打字延迟（见 `_typing_wait`），
       **不要因为"慢了"就重发**（重发就是把同一句话再说一遍）。
    """
    _deny = _guard("bili_send_message")
    if _deny: return _deny
    cred = get_cred()

    if not text or not text.strip():
        return json.dumps({"success": False, "error": "text 不能为空"}, ensure_ascii=False)

    # ⭐ 2.4.0：私信也是"打字打出来的"，同样按字数等一会儿（口径见 _typing_wait）
    typed = await _type_wait(text.strip())

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
        out = {
            "success": True,
            "message": f"私信已投递（回执 {str(msg_key)[:12]}…）",
            "data": data,
        }
        if typed > 0:                   # 跟评论那边一样：把"打了多久"带回去
            out["typing_wait_s"] = round(typed, 1)
        return json.dumps(out, ensure_ascii=False)
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


@tool()
def duty_report_append(text: str) -> str:
    """
    往**今天的日报**末尾追加一段（文件不存在会自动建）。

    Args:
        text: 要追加的内容（markdown 纯文本）

    Returns:
        写到了哪个文件
    """
    body = str(text or "").replace("\r\n", "\n").strip()
    if not body:
        return "没写：内容是空的"
    p = DUTY_HOME / "out" / (_duty_today() + ".md")
    fresh = not p.exists()
    payload = body + "\n"
    if fresh:
        payload = "# 刷B站日报 " + _duty_today() + "\n\n" + payload
    return "已追加到 " + _append(p, payload)


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


@tool()
def duty_seen_recent(limit: int = 40, bvid: str = "") -> str:
    """
    读判重表的最近若干行（只读，只读插件自己那份 seen.md）。

    Args:
        limit: 取最近多少行（默认 40，上限 200）
        bvid: 只查某个 BV（留空=看全部）

    Returns:
        表格行（日期 | BV | 标题 | UP | 状态）；空 = 这份表还没内容
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
    tail = rows[-n:]
    if not tail:
        return "（最近没有记录）"
    return "共 " + str(len(rows)) + " 行，最近 " + str(len(tail)) + " 行：\n" + "\n".join(tail)


@tool()
def duty_digest_append(text: str) -> str:
    """
    往**本月归档**末尾追加一段（「digest/<年-月>.md」，给"后来翻旧账"用的）。

    Args:
        text: 要追加的内容

    Returns:
        写到了哪个文件
    """
    body = str(text or "").replace("\r\n", "\n").strip()
    if not body:
        return "没写：内容是空的"
    p = DUTY_HOME / "digest" / (_dt.datetime.now().strftime("%Y-%m") + ".md")
    return "已追加到 " + _append(p, body + "\n")


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
    """真正跑转写（非阻塞）。信号量保证同一时间只有一条在跑。"""
    py, script, out = _transcribe_paths(bv)
    if not py:
        return str(script)      # script 位置放的是错误文案
    async with _TRANSCRIBE_SEM:
        try:
            proc = await asyncio.create_subprocess_exec(
                py, str(script), bv, "-o", str(out),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
            )
        except Exception as e:
            return "转写启动失败：" + str(e)
        try:
            _, err = await asyncio.wait_for(proc.communicate(), timeout=_TRANSCRIBE_TIMEOUT)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            return f"转写超时（{_TRANSCRIBE_TIMEOUT // 60} 分钟）—— 这条按「读不到」处理，跳过它"
        if not out.exists():
            tail = (err or b"")[-400:].decode("utf-8", "replace")
            return "转写没产出文件（exit " + str(proc.returncode) + "）：" + tail
    return _transcribe_read(out)


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
    py, why, _out = _transcribe_paths(bv)
    if not py:
        return str(why)
    job_id = "tj" + _dt.datetime.now().strftime("%H%M%S") + "-" + bv[-4:]
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
    py, why, _out = _transcribe_paths(bv)
    if not py:
        return json.dumps({"ok": False, "error": why}, ensure_ascii=False)
    job_id = "tj" + _dt.datetime.now().strftime("%H%M%S") + "-" + bv[-4:]
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