#!/usr/bin/env python3
"""check-real-comments.py —— 用**真实 B站 数据**验「取评论 + 闸门」这条读路径。

要不要账号：**不要**。`/x/v2/reply` 和 `/x/v2/reply/reply` 都是公开接口，
不登录也能读（写接口才需要登录，那是另一回事）。

这个脚本验的是：
  1. 真打评论列表，拿到真实 aid / rpid / rcount / 正文
  2. 真跑 `_fetch_reply_context()` → 正文、回复数、同楼抽样是不是真从接口来的
  3. 真跑 `_nested_gate()` → 对真实数据会不会给出合理结论（**既会拒也会放**）
  4. 真打楼中楼接口，验 `root != rpid` 那条分支

用法：
    <家目录>/.venv/Scripts/python.exe tools/check-real-comments.py

⚠️ 需要联网。失败（断网 / 限流 / 热门里没合适的样本）会明确说明，不会假装通过。
"""
import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'vendor', 'bilibili-mcp'))

import mcp_server as m  # noqa: E402

UA = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
    "Referer": "https://www.bilibili.com/",
}
POPULAR = "https://api.bilibili.com/x/web-interface/popular"


async def get(url, params):
    import aiohttp
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as s:
        async with s.get(url, params=params, headers=UA) as r:
            return json.loads((await r.read()).decode("utf-8"))


async def main():
    fails = []

    print("=== 1) 取一个真实热门视频 ===")
    pop = await get(POPULAR, {"ps": 6, "pn": 1})
    vids = (pop.get("data") or {}).get("list") or []
    if not vids:
        print("  ✗ popular 没返回视频（code=%s）—— 可能被限流，过一会儿再试" % pop.get("code"))
        return 1
    v = vids[0]
    aid, bvid = int(v["aid"]), v["bvid"]
    print("  %s  aid=%s  《%s》" % (bvid, aid, (v.get("title") or "")[:26]))

    print("\n=== 2) 真打评论列表 ===")
    j = await get(m._COMMENT_LIST_API, {"oid": aid, "type": 1, "pn": 1, "ps": 20, "sort": 2})
    print("  code=%s" % j.get("code"))
    rows = [m._reply_row(r) for r in ((j.get("data") or {}).get("replies") or [])]
    print("  一级评论 %d 条" % len(rows))
    if not rows:
        print("  ✗ 没拿到评论，后面验不了")
        return 1

    # 挑回复最多的（用来验「>20 条就拒」）
    top = max(rows, key=lambda r: r["rcount"])
    print("\n=== 3) 一级评论：真取数 + 真跑闸门 ===")
    print("  rpid=%s  rcount=%s  正文=%r" % (top["rpid"], top["rcount"], top["text"][:30]))
    ctx = await m._fetch_reply_context(aid, top["rpid"], 0, None)
    if not ctx.get("ok"):
        print("  ✗ 取数失败：%s" % ctx.get("error"))
        fails.append("一级评论取数")
    else:
        t = ctx["target"]
        sample = ctx.get("sample") or []
        ok_fields = bool(t.get("text")) and t.get("rpid") == top["rpid"] and int(t.get("rcount") or 0) >= 0
        print("  取回：正文 %d 字 · rcount=%s · 抽样 %d 条" % (len(t["text"]), t["rcount"], len(sample)))
        print("  字段核对: %s" % ("✓" if ok_fields else "✗"))
        if not ok_fields:
            fails.append("一级评论字段")
        why, note = m._nested_gate(t, sample)
        print("  闸门: %s %s" % ("放行" if not why else "拒绝", (why or note or "")[:60]))
        if t.get("rcount", 0) > m._NESTED_MAX_RCOUNT and not why:
            print("  ✗ 回复数超限却没拒")
            fails.append("超限未拒")

    # 找一个"应该放行"的样本
    print("\n=== 4) 找一个会放行的真实样本（证明不是一律拒绝）===")
    passed = None
    for vv in vids:
        a = int(vv["aid"])
        for pn in (1, 2):
            jj = await get(m._COMMENT_LIST_API, {"oid": a, "type": 1, "pn": pn, "ps": 20, "sort": 2})
            for r in [m._reply_row(x) for x in ((jj.get("data") or {}).get("replies") or [])]:
                if not (3 <= r["rcount"] <= m._NESTED_MAX_RCOUNT):
                    continue
                if len(m.re.sub(r"_|[^\w]+", "", r["text"])) < 15:
                    continue
                c = await m._fetch_reply_context(a, r["rpid"], 0, None)
                if not c.get("ok"):
                    continue
                w, n = m._nested_gate(c["target"], c.get("sample") or [])
                if not w:
                    passed = (a, r, len(c.get("sample") or []), n)
                    break
            if passed:
                break
        if passed:
            break
    if passed:
        a, r, ns, n = passed
        print("  ✓ 放行样本：aid=%s rpid=%s rcount=%s 抽样 %d 条" % (a, r["rpid"], r["rcount"], ns))
        print("    正文 %r" % r["text"][:40])
        if n:
            print("    说明: %s" % n)
    else:
        print("  ⚠️ 这一轮热门里没找到符合条件（3~20 条回复且正文够长）的样本 —— 不算失败，只是没抽到")

    # 楼中楼分支
    print("\n=== 5) 楼中楼：真打 /x/v2/reply/reply，验 root 分支 ===")
    sub = await get(m._COMMENT_REPLY_API,
                    {"oid": aid, "type": 1, "root": top["rpid"], "pn": 1, "ps": 20})
    subs = [m._reply_row(r) for r in ((sub.get("data") or {}).get("replies") or [])]
    print("  code=%s，子回复 %d 条" % (sub.get("code"), len(subs)))
    if subs:
        child = subs[0]
        print("  rpid=%s root=%s 正文=%r" % (child["rpid"], child["root"], child["text"][:24]))
        c2 = await m._fetch_reply_context(aid, child["rpid"], top["rpid"], None)
        if c2.get("ok"):
            print("  ✓ root 分支取到目标，同楼抽样 %d 条" % len(c2.get("sample") or []))
        else:
            print("  ✗ root 分支失败：%s" % c2.get("error"))
            fails.append("楼中楼分支")
    else:
        print("  ⚠️ 这栋楼没有子回复，跳过")

    print("\n%s" % ("✓ 真实数据全部通过" if not fails else "✗ 失败项：" + "、".join(fails)))
    return 0 if not fails else 1


try:
    sys.exit(asyncio.run(main()))
except Exception as e:  # noqa: BLE001
    print("✗ 跑挂了（多半是断网/限流）：%s: %s" % (type(e).__name__, e))
    sys.exit(1)
