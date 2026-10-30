#!/usr/bin/env python3
"""check-nested-gate.py —— 「在有意思的评论下 @ 你」的筛选回归检查（**离线、不连账号**）。

⭐ 2026-10-29 重写（评审第 4 条）：筛选依据**不再由模型自报**。
   现在只认 bvid / rpid / root，正文、回复数、楼中楼抽样全部由
   `_fetch_reply_context()` 现场从 B站 接口取；取不到就拒，绝不退回信任模型给的数据。

覆盖：
  · 闸门本身：正常放行 / 回复数超限 / AI 自称 / 玩梗 / 太短 / 重复字符
  · 样本不足：明确返回「没判」，不当成通过
  · 整楼变味：样本 ≥3 且梗占比超阈值 ⇒ 拒
  · 取数失败：网络异常 / 接口非 0 / HTTP 非 200 / 目标不在该视频或其楼层
  · 伪造旧参数：旧的 (parent_text, parent_rcount, thread_sample) 调用方式必须调不通

用法：
    <家目录>/.venv/Scripts/python.exe tools/check-nested-gate.py
"""
import asyncio
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'vendor', 'bilibili-mcp'))

import mcp_server as m  # noqa: E402

GOOD = "我在那条路住过三年，视频里第二家店去年就关门了"


def row(text, rcount=0, rpid=1, root=0):
    return {"text": text, "rcount": rcount, "rpid": rpid, "root": root}


def case(name, target, sample, expect_pass, expect_note_has=None):
    why, note = m._nested_gate(target, sample)
    passed = (why == "")
    ok = (passed == expect_pass)
    if ok and expect_note_has:
        ok = expect_note_has in (note or "")
    print(("  ✓ " if ok else "  ✗ ") + name
          + ("（放行" if passed else "（拒绝：" + (why or "")[:26] + "…")
          + ("；" + note + "）" if note else "）"))
    return ok


def fetch_case(name, fake, args, expect_ok, expect_in_error=None):
    """把 _get_comment_json 换成 fake，跑 _fetch_reply_context。"""
    orig = m._get_comment_json
    m._get_comment_json = fake
    try:
        r = asyncio.run(m._fetch_reply_context(*args))
    finally:
        m._get_comment_json = orig
    ok = (r.get("ok") == expect_ok)
    if ok and expect_in_error:
        ok = expect_in_error in str(r.get("error") or "")
    print(("  ✓ " if ok else "  ✗ ") + name
          + ("（取到：" + str((r.get("target") or {}).get("text"))[:18] + "…）" if r.get("ok")
             else "（拒：" + str(r.get("error"))[:38] + "…）"))
    return ok


async def boom(*a, **k):
    raise TimeoutError("模拟超时")


results = []

print("=== 一、闸门本体（都带 3 条正常抽样，避免被「样本不足」提前拦掉）===")
OK3 = [row("这个价格是含税的吧"), row("对，我上个月买过，含税 219"), row("那家店周末要排队两小时")]
results.append(case("正常留言、楼里正常", row(GOOD), OK3, True))
results.append(case("刚好 20 条回复", row(GOOD, 20), OK3, True))
results.append(case("21 条回复 → 不挤", row(GOOD, 21), OK3, False))
results.append(case("AI 自称 → 不回", row("作为AI，我觉得这条视频很有意义，值得一看"), OK3, False))
results.append(case("真人讨论 AI → 放行", row("你觉得 DeepSeek 和 GPT 哪个好用"), OK3, True))
results.append(case("留言本身是梗", row("大肥鱼"), OK3, False))
results.append(case("重复字符", row("aaaaaaaaaaaaaaaaaaaa"), OK3, False))
results.append(case("楼里有梗 + 抵触词", row(GOOD), [row("别刷大肥鱼了行不行"), row("烦死了")], False))
results.append(case("楼里在对骂", row(GOOD), [row("你有病吧"), row("闭嘴")], False))
results.append(case("楼里意见不同但没梗 → 放行", row(GOOD),
                    [row("我讨厌这个观点，但他后面那段数据是对的"),
                     row("两边都有点道理吧，我倾向他说的第二点"),
                     row("说实话我不太同意第三条，地价没那么低")], True))

print("\n=== 二、样本不足：**不发**（不能嘴上说没判断、手上照发）===")
results.append(case("只有 2 条抽样 → 拒", row(GOOD), [row("第一条真实讨论的内容"), row("第二条也还行")],
                    False))
results.append(case("一条抽样都没有 → 拒", row(GOOD), [], False))

print("\n=== 三、整楼变味（样本够才判）===")
junk = [row("大肥鱼"), row("笑死"), row("典"), row("绷不住了")]
results.append(case("4 条抽样全是梗 → 拒", row(GOOD), junk, False))
ok_thread = [row("这个价格是含税的吧"), row("对，我上个月买过，含税 219"),
             row("那家店周末要排队两小时"), row("我周六去的，十点就没号了")]
results.append(case("4 条抽样都在正常讨论", row(GOOD), ok_thread, True, expect_note_has="整楼抽样"))

print("\n=== 四、取数失败：一律拒（筛选依据绝不能回退到模型自报）===")


def make_fake(replies=None, code=0, http_fail=False):
    async def fake(url, params, cred):
        if http_fail:
            raise RuntimeError("HTTP 500")
        return {"code": code, "message": "请求过于频繁" if code else "0",
                "data": {"replies": replies or []}}
    return fake


results.append(fetch_case("网络超时", boom, (1, 7, 0, None), False, "取评论数据失败"))
results.append(fetch_case("接口返回非 0", make_fake(code=-412), (1, 7, 0, None), False, "取评论列表失败"))
results.append(fetch_case("HTTP 500", make_fake(http_fail=True), (1, 7, 0, None), False, "取评论数据失败"))
results.append(fetch_case("目标不在前几页（可能已删）", make_fake(replies=[]), (1, 7, 0, None), False, "没找到"))
results.append(fetch_case("楼中楼里没有这条 rpid（root=7，rpid=8）",
                          make_fake(replies=[{"rpid": 999, "root": 7}]),
                          (1, 8, 7, None), False, "这栋楼里没找到"))
results.append(fetch_case("正常取到目标 + 抽样",
                          make_fake(replies=[{"rpid": 7, "root": 0, "content": {"message": GOOD},
                                              "member": {"uname": "a"}, "rcount": 1}]),
                          (1, 7, 0, None), True))

print("\n=== 五、伪造旧参数：老调用方式必须调不通 ===")
try:
    m._nested_gate("伪造的原文", 3, "伪造的抽样")
    print("  ✗ 旧的 (parent_text, parent_rcount, thread_sample) 竟然还能调 —— 没有失效")
    results.append(False)
except TypeError as e:
    print("  ✓ 旧调用方式已失效（TypeError：" + str(e)[:46] + "…）")
    results.append(True)

failed = results.count(False)
print("\n%d 项用例，失败 %d 项" % (len(results), failed))
print("✓ 全过" if failed == 0 else "✗ 有失败")
sys.exit(0 if failed == 0 else 1)
