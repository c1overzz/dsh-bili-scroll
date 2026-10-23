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
#      ⑥ 评论配图（2026-10-23 加，默认关）：`_prepare_comment_pictures` / `_pick_meme` 从本机
#         dsh-meme 表情包库或「额外配图目录」取图，交给 bilibili-api 原生 `picture=Picture` 上传；
#         子评论（rpid≠0）B站 不收图 ⇒ 直接降级纯文本。详见文件里「评论配图」一节。
import asyncio
import json
import base64
import os
import random
import re
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path
from mcp.server.fastmcp import FastMCP

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


# ========== 登录会话（进程级缓存） ==========

_login_session: QrCodeLogin | None = None


def get_cred() -> Credential:
    """获取凭证，未登录时引导用户调用 bili_login"""
    cred = load_credential()
    if not cred:
        raise Exception("未登录B站！请先调用 bili_login 工具获取登录二维码，让用户扫码登录。")
    return cred


# ========== 评论配图（2026-10-23 加，默认关） ==========
# B站 评论区可以带图（**只有顶层评论**；子评论带图会被拒 -400「子评论不能带图」）。
# 本插件只做两件事：
#   ① 从本机 dsh-meme 表情包库（或设置页填的「额外配图目录」）里挑图 —— 图源只读、不下载；
#   ② 交给 bilibili-api 原生的 `pic=Picture` 上传（内部走 /x/dynamic/feed/draw/upload_bfs），
#      不自己拼接口、不碰 WBI/csrf。
# ⚠️ 上传会把图片发到 B站 图床 —— 所以默认关；宿主通过 env 下发开关与目录。
_PICTURES_ENABLED = os.environ.get("BILI_COMMENT_PICTURES") == "1"
_PICTURE_DIR_EXTRA = (os.environ.get("BILI_COMMENT_PICTURE_DIR") or "").strip()
_PICTURE_MAX = 9
_PICTURE_MAX_BYTES = 20 * 1024 * 1024
_PICTURE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

_MEME_MOODS = {
    "happy": ("happy", "like", "meow", "givemoney", "color"),
    "angry": ("angry", "fool", "baka"),
    "sad": ("sad", "sigh"),
    "shy": ("shy",),
    "confused": ("confused", "surprised", "see"),
    "daily": ("daily", "sleep", "morning", "work", "cpu", "reply"),
}


def _home_dir() -> Path:
    v = (os.environ.get("USERPROFILE") or os.environ.get("HOME") or "").strip()
    return Path(v) if v else Path.home()


def _dsh_home_dir() -> Path:
    v = (os.environ.get("DSH_HOME") or "").strip()
    return Path(v) if v else _home_dir() / ".dsh"


def _meme_home_dir() -> Path:
    v = (os.environ.get("DSH_MEME_HOME") or "").strip()
    return Path(v) if v else _home_dir()


def _meme_settings() -> dict:
    """dsh-meme 的设置文件（读不到就当空 —— 配图只是可选功能）。"""
    try:
        with open(_meme_home_dir() / ".dsh" / "dsh-expression.json", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _meme_candidate_dirs() -> list[Path]:
    """可能放着表情包库的目录：用户包 + 各 DSH profile 里 dsh-meme 自带的内置包。"""
    dirs: list[Path] = [_meme_home_dir() / ".dsh" / "meme-packs"]
    packs_dir = str(_meme_settings().get("packsDir") or "").strip()
    if packs_dir:
        dirs.append(Path(packs_dir))
    profile = (os.environ.get("DSH_PROFILE_DIR") or "").strip()
    if profile:
        dirs.append(Path(profile) / "node_modules" / "dsh-meme" / "memes")
    profiles = _dsh_home_dir() / "profiles"
    try:
        for p in sorted(profiles.iterdir()):
            if p.is_dir():
                dirs.append(p / "node_modules" / "dsh-meme" / "memes")
    except OSError:
        pass
    return dirs


def _looks_like_pack(d: Path) -> bool:
    return d.is_dir() and ((d / "index.db").is_file() or (d / "memes").is_dir())


def _meme_pack_roots() -> list[Path]:
    """按 dsh-meme 的规矩找图库包：同 id 先出现者优先，enabledPacks 非空时过滤。"""
    enabled = [str(x).strip() for x in (_meme_settings().get("enabledPacks") or []) if str(x).strip()]
    found: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for base in _meme_candidate_dirs():
        candidates: list[Path] = []
        if _looks_like_pack(base):
            candidates.append(base)
        try:
            candidates.extend([c for c in base.iterdir() if c.is_dir()])
        except OSError:
            pass
        for d in candidates:
            if not _looks_like_pack(d) or d.name in seen:
                continue
            if enabled and d.name not in enabled:
                continue
            seen.add(d.name)
            found.append((d.name, d))
    if not found:
        # enabledPacks 与现有包对不上时退回全量（跟 dsh-meme 一样：宁可多给，别一个都挑不到）
        for base in _meme_candidate_dirs():
            try:
                for c in base.iterdir():
                    if c.is_dir() and _looks_like_pack(c) and c.name not in seen:
                        seen.add(c.name)
                        found.append((c.name, c))
            except OSError:
                pass
    return [p for _, p in found]


def _meme_rows() -> list[dict]:
    """读所有包的索引（SQLite 只读）；没索引/读坏了就退回扫目录。"""
    rows: list[dict] = []
    for pack in _meme_pack_roots():
        db = pack / "index.db"
        if db.is_file():
            try:
                conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=1)
                try:
                    cur = conn.execute(
                        "SELECT path, tag, file_name, caption, COALESCE(keywords,'') AS keywords FROM memes")
                    for path, tag, fname, caption, keywords in cur.fetchall():
                        rows.append({"pack": pack.name, "root": pack, "path": str(path),
                                     "tag": str(tag or ""), "file_name": str(fname or ""),
                                     "caption": str(caption or ""), "keywords": str(keywords or "")})
                finally:
                    conn.close()
                continue
            except sqlite3.Error:
                pass
        memes_dir = pack / "memes"
        if memes_dir.is_dir():
            for p in sorted(memes_dir.rglob("*")):
                if not p.is_file() or p.suffix.lower() not in _PICTURE_EXT:
                    continue
                rows.append({"pack": pack.name, "root": pack,
                             "path": p.relative_to(pack).as_posix(),
                             "tag": p.parent.name, "file_name": p.name,
                             "caption": p.stem, "keywords": ""})
    return rows


def _meme_abs(root: Path, stored: str) -> Path | None:
    """把索引里的相对路径变成绝对路径（防 ../ 逃逸）。"""
    try:
        base = root.resolve()
        p = (root / stored).resolve()
        if p == base or base not in p.parents:
            return None
        return p if p.is_file() else None
    except OSError:
        return None


def _meme_tokens(text: str) -> list[str]:
    return [t for t in re.split(r"[\s,，、;；/|]+", str(text).lower()) if t]


def _pick_meme(query: str, mood: str = "") -> Path:
    """按关键词/情绪从表情包库里挑一张，返回绝对路径；挑不到抛人话异常。"""
    rows = _meme_rows()
    if not rows:
        raise Exception("本机没找到 dsh-meme 表情包库（装 dsh-meme 或设置页填「额外配图目录」）")
    tags = _MEME_MOODS.get(mood.lower()) if mood else None
    pool = [r for r in rows
            if not tags or r["tag"].lower() == mood.lower() or r["tag"].lower().startswith(tuple(tags))]
    if not pool:
        pool = rows
    tokens = _meme_tokens(query)
    if tokens:
        scored = []
        for r in pool:
            hay = f"{r['tag']} {r['caption']} {r['keywords']} {r['file_name']}".lower()
            hit = sum(1 for t in tokens if t in hay)
            if hit:
                scored.append((hit, r))
        if not scored:
            # 两字组合兜底（跟 dsh-meme 的 biGrams 一个思路）
            grams = {query[i:i + 2] for i in range(len(query) - 1)}
            for r in pool:
                hay = f"{r['tag']} {r['caption']} {r['keywords']} {r['file_name']}".lower()
                hit = sum(1 for g in grams if g in hay)
                if hit:
                    scored.append((hit, r))
        if scored:
            best = max(h for h, _ in scored)
            pool = [r for h, r in scored if h == best]
        else:
            raise Exception(f"没有匹配「{query}」的图（可以换个词，比如 开心/无语/摸鱼/睡觉）")
    random.shuffle(pool)
    for r in pool:
        abs_path = _meme_abs(r["root"], r["path"])
        if abs_path is not None:
            return abs_path
    raise Exception(f"没有匹配「{query or mood}」的图（可以换个词，比如 开心/无语/摸鱼/睡觉）")


class _UniqueTempPicture(Picture):
    """每张图一个独立临时文件 —— bilibili-api 默认会复用共享的 test.png，并发上传会串图。"""

    def __init__(self, path: str):
        super().__init__()
        self.__unique_path = path

    def _to_biliapifile(self):
        from bilibili_api.utils.network import BiliAPIFile
        return BiliAPIFile(path=self.__unique_path, mime_type="image/png")


def _allowed_picture_roots() -> list[Path]:
    """允许作为配图的目录：表情包库 + 设置页填的「额外配图目录」。"""
    roots: list[Path] = []
    for d in _meme_pack_roots():
        try:
            roots.append(d.resolve())
        except OSError:
            pass
    if _PICTURE_DIR_EXTRA:
        try:
            roots.append(Path(_PICTURE_DIR_EXTRA).expanduser().resolve())
        except OSError:
            pass
    return roots


def _prepare_comment_pictures(paths: list[str]) -> tuple[list[Picture], Path | None]:
    """校验路径 + 统一转成 PNG（EXIF 摆正 / 缩到 768 / GIF 取首帧），返回 Picture 列表与临时目录。"""
    try:
        from PIL import Image, ImageOps
    except ImportError:
        raise Exception("缺 Pillow（重新跑一次插件依赖安装即可，它随 qrcode[pil] 一起装）")
    allowed = _allowed_picture_roots()
    tmp_dir = Path(tempfile.mkdtemp(prefix="bili-comment-pics-"))
    pics: list[Picture] = []
    for i, raw in enumerate(paths[:_PICTURE_MAX]):
        p = Path(os.path.expanduser(str(raw).strip())).resolve()
        if not p.is_file():
            raise Exception(f"图片不存在：{p}")
        try:
            if p.stat().st_size > _PICTURE_MAX_BYTES:
                raise Exception(f"图片太大（>20MB）：{p}")
        except OSError as e:
            raise Exception(f"图片读不了：{p}（{e}）")
        if not any(p == root or root in p.parents for root in allowed):
            raise Exception(f"图片不在允许的图源里：{p}（只允许表情包库或设置页「额外配图目录」里的图）")
        out = tmp_dir / f"pic-{i}.png"
        try:
            with Image.open(p) as im:
                try:
                    im.seek(0)
                except (EOFError, ValueError, AttributeError):
                    pass
                im = ImageOps.exif_transpose(im)
                im = im.convert("RGBA")
                im.thumbnail((768, 768))
                im.save(out, "PNG", optimize=True)
        except Exception as e:
            raise Exception(f"图片转 PNG 失败：{p}（{e}）")
        pics.append(_UniqueTempPicture(str(out)))
    return pics, tmp_dir


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
async def bili_reply(bvid: str, text: str, rpid: int = 0, root: int = 0,
                     pictures: list[str] | None = None, meme: str = "", meme_tag: str = "") -> str:
    """
    在B站视频下发表评论或回复某条评论

    Args:
        bvid: 视频BV号
        text: 评论/回复的文本内容
        rpid: 要回复的目标评论ID（0表示发表新评论）
        root: 楼层根评论ID（回复一级评论时不用填，回复楼中楼时填根评论ID）
        pictures: 配图的本机图片绝对路径（只能来自表情包库或插件设置里的「额外配图目录」；最多 9 张）
        meme: 从本机 dsh-meme 表情包库按关键词挑一张图（如 无语 / 摸鱼）
        meme_tag: 表情包情绪桶（happy/angry/sad/shy/confused/daily），可与 meme 合用

    Returns:
        发表结果（评论配图只在**顶层评论**上生效；子评论 B站 不收图，会按纯文本发）
    """
    _deny = _guard("bili_reply")
    if _deny: return _deny
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = info["aid"]

    # ⭐ 评论配图（2026-10-23 加，默认关）：只有**顶层评论**能带图 —— B站 子评论带图会被拒
    #    （实测 -400「子评论不能带图」）；关着/子评论时按纯文本发，并在回执里说明跳过原因。
    pic_paths = [str(p).strip() for p in (pictures or []) if str(p).strip()]
    if meme.strip():
        try:
            pic_paths.insert(0, str(_pick_meme(meme.strip(), meme_tag.strip())))
        except Exception as e:
            return json.dumps({"success": False, "stage": "prepare", "retry_safe": True,
                               "error": f"表情包没找到：{e}", "hint": "换个关键词，或改用 pictures 传本机图片路径"},
                              ensure_ascii=False)
    pics: list[Picture] = []
    pic_tmp = None
    pic_skipped = ""
    if pic_paths:
        if rpid != 0:
            pic_skipped = "bilibili_child_reply_no_images"
            pic_paths = []
        elif not _PICTURES_ENABLED:
            pic_skipped = "comment_pictures_disabled"
            pic_paths = []
        elif len(pic_paths) > _PICTURE_MAX:
            return json.dumps({"success": False, "stage": "prepare", "retry_safe": True,
                               "error": f"一条评论最多带 {_PICTURE_MAX} 张图（收到 {len(pic_paths)} 张）"},
                              ensure_ascii=False)

    try:
        if pic_paths:
            try:
                pics, pic_tmp = _prepare_comment_pictures(pic_paths)
            except Exception as e:
                return json.dumps({"success": False, "stage": "prepare", "retry_safe": True,
                                   "error": f"评论配图准备失败：{e}"}, ensure_ascii=False)
        if rpid == 0:
            # 发表新评论
            result = await comment.send_comment(
                text=text,
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                credential=cred,
                pic=pics or None,
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
        out = {"success": True, "message": "评论发送成功" + (f"（带 {len(pics)} 张图）" if pics else "")}
        out["pictures"] = len(pics)
        if pic_skipped:
            out["pictures_skipped_reason"] = pic_skipped
        if isinstance(result, dict):
            for key in ("rpid", "rpid_str", "root", "parent"):
                val = result.get(key)
                if isinstance(val, (int, str)) and str(val).strip() and str(val) != "0":
                    out[key] = val
        return json.dumps(out, ensure_ascii=False)
    except Exception as e:
        # stage=send：请求可能已经到 B站 那边了 —— 重试前必须先复核评论，别直接重发
        return json.dumps({"success": False, "stage": "send", "retry_safe": False,
                           "error": str(e),
                           "hint": "发送阶段失败，结果可能未知：先 bili_comments 复核这条评论在不在，别直接重发"},
                          ensure_ascii=False)
    finally:
        if pic_tmp:
            shutil.rmtree(pic_tmp, ignore_errors=True)


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


# ========== 启动 ==========

if __name__ == "__main__":
    mcp.run(transport="stdio")