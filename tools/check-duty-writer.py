#!/usr/bin/env python3
"""值班轮窄接口的回归检查（不联网、不依赖 mcp / bilibili_api 真包）。

用法：
    python tools/check-duty-writer.py

做法：把 mcp / bilibili_api 换成最小替身，加载 vendor/bilibili-mcp/mcp_server.py，
然后直接调 write_report / append_seen / append_comment / read_seen，
把落盘目录指到临时目录里，逐条验校验规则。
"""
import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "vendor" / "bilibili-mcp" / "mcp_server.py"


def _stub(name: str):
    m = types.ModuleType(name)
    sys.modules[name] = m
    return m


def _install_stubs():
    class _Anything:
        def __getattr__(self, key):
            return _Anything()

        def __call__(self, *a, **k):
            return _Anything()

    class FastMCP:
        def __init__(self, *a, **k):
            pass

        def tool(self, *a, **k):
            def deco(fn):
                return fn
            return deco

    for name in ("bilibili_api", "bilibili_api.video_uploader", "bilibili_api.utils",
                 "bilibili_api.utils.picture", "bilibili_api.login_v2"):
        _stub(name)

    api = sys.modules["bilibili_api"]
    for attr in ("video", "search", "comment", "dynamic", "opus",
                 "hot", "rank", "user", "session", "favorite_list"):
        setattr(api, attr, _Anything())

    class QrCodeLogin:
        pass

    class Credential:
        def __init__(self, *a, **k):
            pass

    api.Credential = Credential
    for attr in ("VideoUploader", "VideoUploaderPage", "VideoMeta", "Lines"):
        setattr(sys.modules["bilibili_api.video_uploader"], attr, type(attr, (), {}))
    sys.modules["bilibili_api.utils.picture"].Picture = _Anything()
    sys.modules["bilibili_api.login_v2"].QrCodeLogin = QrCodeLogin
    sys.modules["bilibili_api.login_v2"].QrCodeLoginEvents = QrCodeLogin

    for name in ("mcp", "mcp.server", "mcp.server.fastmcp", "mcp.types"):
        _stub(name)
    sys.modules["mcp.server.fastmcp"].FastMCP = FastMCP
    sys.modules["mcp.types"].ImageContent = _Anything()
    sys.modules["mcp.types"].TextContent = _Anything()


def _load():
    _install_stubs()
    spec = importlib.util.spec_from_file_location("bili_mcp_duty", SERVER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    mod = _load()
    tmp = Path(tempfile.mkdtemp(prefix="duty-writer-"))
    mod._REPORT_DIR = tmp / "out"
    mod._SEEN_FILE = tmp / "seen.md"
    mod._DIGEST_DIR = tmp / "digest"

    fails = []

    def check(cond, label, extra=""):
        if cond:
            print(f"  ok  {label}")
        else:
            fails.append(label)
            print(f"  FAIL {label}{(' — ' + str(extra)) if extra else ''}")

    def call(fn, *a, **k):
        out = asyncio.run(fn(*a, **k))
        return json.loads(out)

    print("[write_report]")
    check(call(mod.write_report, "2026-10-24", "").get("ok") is False, "空报告被拒")
    check(call(mod.write_report, "2026-10-24", "x" * (70 * 1024)).get("ok") is False, "超过 64KB 被拒")
    check(call(mod.write_report, "2026-10-24", "读到 /root/.dsh/heart/notebook.md 的内容").get("ok") is False,
          "私有路径被拒")
    check(call(mod.write_report, "2026-10-24", "### 今天不错\n随便写点").get("ok") is False, "非 BV 的 ### 标题被拒")
    check(call(mod.write_report, "2026/10/24", "### BV1abc123456\n好的").get("ok") is False, "日期格式不对被拒")
    r1 = call(mod.write_report, "2026-10-24", "### BV1abc123456\n这条值得看")
    check(r1.get("ok") is True and Path(r1["file"]).exists(), "正常报告落盘", r1)
    r2 = call(mod.write_report, "2026-10-24", "### BV1def654321\n又一条")
    text = Path(r2["file"]).read_text(encoding="utf-8")
    check(r2.get("ok") is True and text.count("### BV") == 2, "第二次默认追加、不覆盖", text[:80])

    print("[append_seen]")
    ok_row = "| 2026-10-24 | BV1abc123456 | 某标题 | 某UP | 挑中 · 值得看 |"
    bad_row = "| 2026-10-24 | 不是BV | 某标题 | 某UP | 挑中 |"
    check(call(mod.append_seen, "2026-10-24", [bad_row]).get("ok") is False, "第二列不是 BV 被拒")
    check(call(mod.append_seen, "2026-10-24", ["随便一行"]).get("ok") is False, "不是表格行被拒")
    check(call(mod.append_seen, "2026-10-24", [ok_row.replace("某标题", "/sdcard/x")]).get("ok") is False,
          "私有路径被拒")
    rs = call(mod.append_seen, "2026-10-24", [ok_row])
    check(rs.get("ok") is True and mod._SEEN_FILE.exists() and Path(rs["digest"]).exists(), "判重表与归档都写了", rs)

    print("[append_comment]")
    check(call(mod.append_comment, "BV1abc123456", "abc").get("ok") is False, "rpid 不是数字被拒")
    check(call(mod.append_comment, "nope", "123").get("ok") is False, "BV 格式不对被拒")
    rc = call(mod.append_comment, "BV1abc123456", "317831597441", "", "2026-10-24 18:20", "说到点子上了")
    check(rc.get("ok") is True, "评论记录写入", rc)
    seen_text = mod._SEEN_FILE.read_text(encoding="utf-8")
    check("| BV1abc123456 | 317831597441 |" in seen_text, "评论记录进了「评论记录」表")

    print("[私信收件人]")
    mod._DM_UIDS = {123456}
    denied = call(mod.bili_send_message, 999, "hi")
    check(denied.get("success") is False and "拒绝" in denied.get("error", ""), "不在名单里的收件人被拒", denied)
    mod._DM_UIDS = set()

    print("[read_seen]")
    rout = call(mod.read_seen, 30)
    check(rout.get("ok") is True, "读得到", rout)
    check("评论记录" in rout["text"] and "317831597441" in rout["text"], "带评论记录表")
    check("### BV" not in rout["text"], "不会把报告混进来")

    print(f"\n{'全部通过' if not fails else str(len(fails)) + ' 项失败'}")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
