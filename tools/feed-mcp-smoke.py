#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""荐片 · 新增 6 个 MCP 工具的冒烟验证（Python 侧，不依赖 node）。

它做四件事（1–3 是任务书里的三条验收，4 是为了不要凭证也能验字段映射）：
  1. `python -m py_compile vendor/bilibili-mcp/mcp_server.py`；
  2. 起一个 **真·stdio MCP** 子进程，env 里 `BILI_MCP_TOOLS` = 6 个新工具，
     走 `initialize` → `notifications/initialized` → `tools/list`，断言：
       · 6 个新工具一个不少、参数名与合同一致；
       · 名单外的工具（bili_upload_video / bili_reply / bili_search …）**连名字都不出现**；
  3. 在没有凭证的情况下调 `bili_history`：断言返回明确错误（isError + 含“未登录”），
     且服务进程**没崩**（错误之后还能正常 `tools/list`）；
  4. 离线字段映射：monkeypatch 掉网络层（用的是真接口实测到的响应形状），断言
     bili_history 的分页/截止/progress、rcmd/related 的字段、toview 的两级兜底、
     followings 的「先取自己 mid」、up_videos 的 length→秒，以及失败时 `error` 字段非空。

用法（用临时 venv 的 python 跑，别装进插件目录）：
    <tmp>\\venv\\Scripts\\python.exe tools/feed-mcp-smoke.py
可选参数：
    --python   <path>   起 MCP 子进程用的解释器，默认当前解释器
    --server   <path>   mcp_server.py 路径，默认 vendor/bilibili-mcp/mcp_server.py
    --no-cred-check     跳过第 3 条（机器上万一真配了凭证时用）
    --skip-offline      跳过第 4 条

退出码：0 = 全通过；1 = 有断言失败（失败原因打印在 stdout）。
"""

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
import py_compile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SERVER = ROOT / "vendor" / "bilibili-mcp" / "mcp_server.py"

# 合同 §9 的 6 个工具 + 它们的参数名（一个都不能多/少）
NEW_TOOLS = {
    "bili_history": {"days", "max_items"},
    "bili_rcmd_feed": {"ps"},
    "bili_related": {"bvid", "num"},
    "bili_toview": set(),
    "bili_followings": {"ps", "pn"},
    "bili_up_videos": {"mid", "ps"},
}
# 白名单下这些「危险/无关」工具必须不出现（名字都不给）
MUST_NOT_APPEAR = ["bili_upload_video", "bili_upload_video_multi", "bili_reply", "bili_crawl",
                   "bili_login", "bili_search", "bili_comments", "bili_subtitle"]

FAILS = []


def check(cond, label, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}{('  -> ' + detail) if detail else ''}")
        FAILS.append(label)


class StdioMcp:
    """一行一条 JSON-RPC 的最小 stdio 客户端（和 lib/mcp.mjs 同一套协议）。"""

    def __init__(self, cmd, cwd, env):
        self.proc = subprocess.Popen(
            cmd, cwd=str(cwd), env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        self.q = queue.Queue()
        self.stderr_lines = []
        self.next_id = 1
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue  # 有些库会往 stdout 打日志，忽略非 JSON 行
            self.q.put(msg)

    def _read_stderr(self):
        for line in self.proc.stderr:
            self.stderr_lines.append(line.rstrip())
            del self.stderr_lines[:-40]

    def send(self, obj):
        self.proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def notify(self, method, params=None):
        self.send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def request(self, method, params=None, timeout=40):
        rid = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline = time.time() + timeout
        while True:
            remain = deadline - time.time()
            if remain <= 0:
                raise TimeoutError(f"MCP {method} 超时（{timeout}s）; stderr tail: {self.stderr_tail()}")
            try:
                msg = self.q.get(timeout=remain)
            except queue.Empty:
                raise TimeoutError(f"MCP {method} 超时（{timeout}s）; stderr tail: {self.stderr_tail()}")
            if msg.get("id") != rid:
                continue  # 不是我们这条（初始化通知之类）
            if "error" in msg:
                raise RuntimeError(f"MCP {method} 返回 error: {msg['error']}")
            return msg.get("result") or {}

    def stderr_tail(self, n=6):
        return " | ".join(self.stderr_lines[-n:])

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass


def verify_compile(server: Path):
    print("[1/4] py_compile")
    try:
        py_compile.compile(str(server), doraise=True)
        check(True, f"py_compile {server.relative_to(ROOT)}")
    except py_compile.PyCompileError as e:
        check(False, "py_compile", str(e))


def verify_list_tools(python_exe: str, server: Path):
    print("[2/4] stdio MCP：initialize + tools/list（BILI_MCP_TOOLS = 6 个新工具）")
    env = dict(os.environ)
    env["BILI_MCP_TOOLS"] = ",".join(NEW_TOOLS.keys())
    env["PYTHONIOENCODING"] = "utf-8"
    client = StdioMcp([python_exe, str(server)], cwd=ROOT, env=env)
    try:
        client.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "feed-mcp-smoke", "version": "0.0.1"},
        })
        client.notify("notifications/initialized", {})
        result = client.request("tools/list", {})
        tools = result.get("tools") or []
        names = [t.get("name") for t in tools]

        missing = [n for n in NEW_TOOLS if n not in names]
        check(not missing, "6 个新工具都注册了", f"缺 {missing}")
        unexpected = [n for n in names if n not in NEW_TOOLS]
        check(not unexpected, "名单外的工具都没注册", f"多出 {unexpected}")
        leaked = [n for n in MUST_NOT_APPEAR if n in names]
        check(not leaked, "危险/无关工具名字不出现（如 bili_upload_video / bili_reply）", f"漏出 {leaked}")

        by_name = {t.get("name"): t for t in tools}
        for name, want in NEW_TOOLS.items():
            if name not in by_name:
                continue
            props = set((by_name[name].get("inputSchema") or {}).get("properties") or {})
            check(props == want, f"{name} 参数名与合同一致", f"期望 {sorted(want)}，实际 {sorted(props)}")
        print(f"  （tools/list 实际返回 {len(names)} 个：{', '.join(names)}）")
    finally:
        client.close()


def verify_no_credential(python_exe: str, server: Path):
    print("[3/4] 无凭证调用 bili_history：应返回明确错误且进程不崩")
    env = dict(os.environ)
    env["BILI_MCP_TOOLS"] = "bili_history"
    env["PYTHONIOENCODING"] = "utf-8"
    client = StdioMcp([python_exe, str(server)], cwd=ROOT, env=env)
    try:
        client.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "feed-mcp-smoke", "version": "0.0.1"},
        })
        client.notify("notifications/initialized", {})
        result = client.request("tools/call", {
            "name": "bili_history", "arguments": {"days": 7, "max_items": 5},
        }, timeout=60)
        text = "".join(c.get("text", "") for c in (result.get("content") or []))
        check(bool(result.get("isError")), "返回 isError=true（不是静默空列表）", text[:200])
        check("未登录" in text, "错误信息写明「未登录」", text[:200])
        # 错误之后还能正常 list ⇒ 服务进程没崩
        again = client.request("tools/list", {})
        check(bool(again.get("tools")), "报错后服务仍然可用（tools/list 照常）")
        print(f"  （错误文本：{text.strip()[:160]}）")
    finally:
        client.close()


def verify_offline_mapping(server: Path):
    """第 4 条：把网络层换掉（monkeypatch），离线验字段映射 / 兜底 / error 字段。

    fixture 用的是 2026-10 在 bilibili-api 17.4.2 上**实测**到的响应形状
    （rcmd 的 data.item、related 的 data 数组、space 投稿的 list.vlist.length 等）；
    历史 / 稍后再看 / 关注需要登录，形状来自接口文档 + 上游 SDK 的字段用法。
    """
    print("[4/4] 离线字段映射（monkeypatch 真响应形状，不联网、不要凭证）")
    import asyncio
    import importlib.util

    spec = importlib.util.spec_from_file_location("dsh_bili_mcp_feed_under_test", str(server))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    now = int(time.time())
    mod.get_cred = lambda: object()   # 离线阶段不验登录，只验映射
    calls = []

    # ---- bili_history：分页 + view_at 截止 + progress 原值 + cover 归一 ----
    async def fake_history(page_num=1, per_page_item=100, credential=None):
        calls.append(("history", page_num))
        if page_num == 1:
            return {"cursor": {}, "list": [
                {"title": "T1", "author_name": "UP1", "cover": "//i0.hdslb.com/a.jpg", "duration": 600,
                 "progress": 500, "view_at": now - 3600, "history": {"bvid": "BV1"}},
                {"title": "T2", "author_name": "UP2", "cover": "https://i0.hdslb.com/b.jpg", "duration": 300,
                 "progress": -1, "view_at": now - 7200, "history": {"bvid": "BV2"}},
                {"title": "直播（没有 bvid）", "view_at": now - 60, "history": {}},
            ]}
        if page_num == 2:
            return {"list": [{"title": "old", "duration": 100, "progress": 0,
                              "view_at": now - 40 * 86400, "history": {"bvid": "BVold"}}]}
        return {"list": []}

    mod.user.get_self_history = fake_history
    data = json.loads(asyncio.run(mod.bili_history(days=30, max_items=10)))
    check(data["count"] == 2 and [i["bvid"] for i in data["items"]] == ["BV1", "BV2"],
          "history：只收带 bvid 的条目、按 view_at 截止到 days 天前", str(data)[:200])
    check(data["items"][0]["cover"] == "https://i0.hdslb.com/a.jpg", "history：// 封面归一成 https")
    check(data["items"][1]["progress"] == -1, "history：progress=-1 原样保留")
    check(data["fetched_at"] > 0 and data["days"] == 30 and "error" not in data,
          "history：fetched_at/days 正确、成功时不带 error")
    check(calls == [("history", 1), ("history", 2)], "history：翻到第 2 页才截止（页间有限速）", str(calls))

    calls.clear()
    data = json.loads(asyncio.run(mod.bili_history(days=30, max_items=1)))
    check(data["count"] == 1 and calls == [("history", 1)], "history：max_items 截断后不再多拉页")

    # ---- bili_rcmd_feed：字段映射 + 无 desc 时的空串 + 错误进 error ----
    async def fake_rcmd(credential=None):
        return {"item": [
            {"bvid": "BVa", "title": "ta", "pic": "//i0.hdslb.com/x.jpg", "duration": 123,
             "pubdate": 1700000000, "owner": {"name": "upa"}, "stat": {"view": 99}},
            {"bvid": "", "title": "广告/直播槽位"},
        ]}

    mod.homepage.get_videos = fake_rcmd
    data = json.loads(asyncio.run(mod.bili_rcmd_feed(ps=30)))
    item = data["items"][0]
    check(data["count"] == 1 and item["bvid"] == "BVa", "rcmd：过滤掉没有 bvid 的槽位")
    check(item["author"] == "upa" and item["play"] == 99 and item["pubdate"] == 1700000000
          and item["cover"] == "https://i0.hdslb.com/x.jpg",
          "rcmd：author/play/pubdate/cover 映射", str(item))
    check(item["description"] == "", "rcmd：接口没给 desc 时 description 给空串")

    async def boom(credential=None):
        raise RuntimeError("blocked -412")

    mod.homepage.get_videos = boom
    data = json.loads(asyncio.run(mod.bili_rcmd_feed()))
    check(data["count"] == 0 and data["items"] == [] and "blocked -412" in data.get("error", ""),
          "rcmd：风控/网络错误写进 error 字段（不伪装成空列表）", str(data)[:160])

    # ---- bili_related：回带源 bvid + 按 num 截断 ----
    class FakeVideo:
        def __init__(self, bvid=None, credential=None):
            self.bvid = bvid

        async def get_related(self):
            return [
                {"bvid": "BVr1", "title": "tr", "pic": "https://i0.hdslb.com/r.jpg", "duration": 45,
                 "pubdate": 1700000001, "owner": {"name": "upr"}, "stat": {"view": 5}, "desc": "desc"},
                {"bvid": "BVr2", "title": "tr2"},
            ]

    mod.video.Video = FakeVideo
    data = json.loads(asyncio.run(mod.bili_related("BVsrc", num=1)))
    check(data["bvid"] == "BVsrc" and data["count"] == 1 and data["items"][0]["bvid"] == "BVr1",
          "related：回带源 bvid、按 num 截断")
    check(data["items"][0]["description"] == "desc" and data["items"][0]["pubdate"] == 1700000001,
          "related：description/pubdate 映射")

    # ---- bili_toview：① 导航接口直接带条目；② 只给入口时兜底；③ 两路都失败 -> error ----
    async def nav_with_videos(credential):
        return {"toview": {"count": 1, "list": [
            {"bvid": "BVt1", "title": "tt", "pic": "//i0.hdslb.com/t.jpg", "duration": 61,
             "owner": {"name": "upt"}, "stat": {"view": 12}}]},
            "count": 1, "list": [{"id": 0, "title": "稍后再看", "media_count": 1}]}

    async def toview_must_not_call(credential):
        raise AssertionError("① 已经拿到条目，不该走兜底")

    mod.homepage.get_favorite_list_and_toview = nav_with_videos
    mod.user.get_toview_list = toview_must_not_call
    data = json.loads(asyncio.run(mod.bili_toview()))
    check(data["count"] == 1 and data["items"][0]["bvid"] == "BVt1" and "error" not in data,
          "toview：从导航接口的 toview 段取到条目")
    check(set(data["items"][0]) == {"bvid", "title", "author", "cover", "duration", "play"},
          "toview：字段与合同一致", str(list(data["items"][0])))

    async def nav_entry_only(credential):
        return {"count": 1, "list": [{"id": 0, "title": "稍后再看", "media_count": 2}]}

    async def toview_list(credential):
        return {"count": 1, "list": [
            {"bvid": "BVt2", "title": "t2", "pic": "https://i0.hdslb.com/t2.jpg", "duration": 120,
             "owner": {"name": "up2"}, "stat": {"view": 34}, "progress": 33}]}

    mod.homepage.get_favorite_list_and_toview = nav_entry_only
    mod.user.get_toview_list = toview_list
    data = json.loads(asyncio.run(mod.bili_toview()))
    check(data["count"] == 1 and data["items"][0]["bvid"] == "BVt2" and "error" not in data,
          "toview：导航接口只给入口时自动兜底到「稍后再看列表」")

    async def boom2(credential):
        raise RuntimeError("risk -412")

    mod.homepage.get_favorite_list_and_toview = boom2
    mod.user.get_toview_list = boom2
    data = json.loads(asyncio.run(mod.bili_toview()))
    check(data["count"] == 0 and data["items"] == [] and "risk -412" in data.get("error", ""),
          "toview：两路都失败时 error 字段非空")

    # ---- bili_followings：先 get_self_info 取自己 mid，再拉关注列表 ----
    async def fake_self_info(credential):
        return {"mid": 42, "name": "me"}

    seen_uids = []

    class FakeUserFollowings:
        def __init__(self, uid, credential=None):
            seen_uids.append(uid)

        async def get_followings(self, pn=1, ps=100, attention=False, order=None):
            return {"list": [{"mid": 1001, "uname": "A", "sign": "s1"},
                             {"mid": 1002, "uname": "B", "sign": ""}], "total": 2}

    mod.user.get_self_info = fake_self_info
    mod.user.User = FakeUserFollowings
    data = json.loads(asyncio.run(mod.bili_followings(ps=50, pn=1)))
    check(data["count"] == 2 and data["items"][0] == {"mid": 1001, "uname": "A", "sign": "s1"},
          "followings：返回 {count, items:[{mid,uname,sign}]}", str(data)[:160])
    check(seen_uids == [42], "followings：先取自己 mid（42）再拉关注列表", str(seen_uids))

    # ---- bili_up_videos：length("12:34") -> 秒；created/pubdate 都有值 ----
    class FakeUserVideos:
        def __init__(self, uid, credential=None):
            self.uid = uid

        async def get_videos(self, pn=1, ps=30, order=None, **kw):
            return {"list": {"vlist": [
                {"bvid": "BVu1", "title": "tu", "pic": "//i0.hdslb.com/u.jpg", "length": "12:34",
                 "created": 1700000002, "author": "upx"}]}}

    mod.user.User = FakeUserVideos
    data = json.loads(asyncio.run(mod.bili_up_videos(mid=42, ps=10)))
    it = data["items"][0]
    check(it["bvid"] == "BVu1" and it["duration"] == 754, "up_videos：length 字符串转成秒", str(it))
    check(it["created"] == 1700000002 and it["pubdate"] == 1700000002,
          "up_videos：created/pubdate 都有值（pubdate 用 created 兜底）")
    check(set(it) == {"bvid", "title", "cover", "duration", "created", "pubdate"},
          "up_videos：字段与合同一致")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--python", default=sys.executable, help="起 MCP 子进程的解释器")
    ap.add_argument("--server", default=str(DEFAULT_SERVER))
    ap.add_argument("--no-cred-check", action="store_true")
    ap.add_argument("--skip-offline", action="store_true")
    args = ap.parse_args()

    server = Path(args.server).resolve()
    if not server.is_file():
        print(f"找不到 mcp_server.py: {server}")
        return 1

    verify_compile(server)
    try:
        verify_list_tools(args.python, server)
    except Exception as e:
        check(False, "stdio tools/list 流程", f"{type(e).__name__}: {e}")

    # 只有在确实没凭证时才测「未登录」；本仓库 vendor 目录里没有 bili_credential.json 就是没凭证
    cred_file = server.parent / "bili_credential.json"
    if args.no_cred_check or cred_file.exists():
        print("[3/4] 跳过：有凭证或 --no-cred-check")
    else:
        try:
            verify_no_credential(args.python, server)
        except Exception as e:
            check(False, "无凭证调用流程", f"{type(e).__name__}: {e}")

    if args.skip_offline:
        print("[4/4] 跳过：--skip-offline")
    else:
        try:
            verify_offline_mapping(server)
        except Exception as e:
            check(False, "离线字段映射流程", f"{type(e).__name__}: {e}")

    print()
    if FAILS:
        print(f"FAILED（{len(FAILS)} 项）：" + "; ".join(FAILS))
        return 1
    print("ALL PASS（4/4）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
