#!/usr/bin/env python3
"""check-mention.py —— 「@ 空格」归一化的回归检查（**不联网、不连账号**）。

为什么要有它：`@ 昵称` 这种写法 B站 不认 —— 评论会发出去、接口也返回成功，
但对方收不到通知，而且**没有任何报错**，属于"看起来没问题、其实白发了"的那类坑。
模型写中文时习惯在 @ 后面加一个空格，所以发送前统一压一遍。

用法：
    <家目录>/.venv/Scripts/python.exe tools/check-mention.py
（要和 tools/check-vision.py 一样的 venv，因为要 import 那个 vendored 脚本）
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'vendor', 'bilibili-mcp'))

from mcp_server import _normalize_mention  # noqa: E402

CASES = [
    ("@ No3799 这条不错", "@No3799 这条不错", "@ 后面一个空格"),
    ("@   No3799 多个空格", "@No3799 多个空格", "@ 后面多个空格"),
    ("@\tNo3799 制表符", "@No3799 制表符", "@ 后面是制表符"),
    ("@\nNo3799 换行", "@No3799 换行", "@ 后面是换行"),
    ("@No3799 已经紧贴", "@No3799 已经紧贴", "本来就对 → 一个字不动"),
    ("这条没有 @ 符号", "这条没有 @符号", "正文里提到 @ 也会被压紧（顺带的，无害）"),
    ("", "", "空串 → 空串"),
    (None, "", "None → 空串"),
    ("邮箱 a@b.com 不该被拆", "邮箱 a@b.com 不该被拆", "@ 后面没有空白 → 不动"),
    ("@   ", "@", "只有 @ 和空格"),
]

fail = 0
for src, want, why in CASES:
    got = _normalize_mention(src)
    ok = got == want
    if not ok:
        fail += 1
    print(('  ✓ ' if ok else '  ✗ ') + repr(src) + ' → ' + repr(got) + '   (' + why + ')')

print('\n✓ 输入法空格检查全过' if fail == 0 else '\n✗ 有 ' + str(fail) + ' 项不符')
sys.exit(0 if fail == 0 else 1)
