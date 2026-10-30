#!/usr/bin/env python3
"""check-comment-fetch.py —— 「取评论数据」这条路径的**真实**回归检查。

⭐ 为什么要有它（评审第 1 条）：`_get_comment_json()` 用了 `aiohttp`，但项目里
   只有几个函数内部局部 import 过它 —— 模块顶层没有。于是那个函数**一调用就
   NameError**，而且因为之前的测试全在 mock `_get_comment_json` 本身，
   根本没跑到这行，谁也没发现。

   这个检查**故意不打桩**：直接调用真函数去打一个必然失败的地址，
   断言它抛的是网络/连接错误（说明 aiohttp 真的绑上了），而不是 NameError。

用法：
    <家目录>/.venv/Scripts/python.exe tools/check-comment-fetch.py
"""
import asyncio
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'vendor', 'bilibili-mcp'))

import mcp_server as m  # noqa: E402

fails = []


def ok(name, cond, detail=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + (('  → ' + detail) if detail else ''))
    if not cond:
        fails.append(name)


print('=== ① aiohttp 在模块顶层可用吗 ===')
ok('模块里能拿到 aiohttp', hasattr(m, 'aiohttp'),
   '有' if hasattr(m, 'aiohttp') else '没有 —— 一调用就 NameError')
ok('能拿到 aiohttp.ClientTimeout', hasattr(getattr(m, 'aiohttp', None), 'ClientTimeout'))

print('\n=== ② 真调用 _get_comment_json（打一个连不上的地址）===')
err = None
try:
    asyncio.run(m._get_comment_json('http://127.0.0.1:9/none', {}, None))
except BaseException as e:      # noqa: BLE001 —— 就是要看它抛什么
    err = e
ok('确实抛了异常（没有静默成功）', err is not None)
ok('不是 NameError（说明 aiohttp 真的绑上了）', not isinstance(err, NameError),
   type(err).__name__ if err else '')
ok('是网络类错误', isinstance(err, (OSError, asyncio.TimeoutError, Exception)) and not isinstance(err, NameError),
   (str(err) or '')[:60])

print('\n=== ③ 真调用 _fetch_reply_context：失败必须收敛成 ok:False ===')
r = asyncio.run(m._fetch_reply_context(1, 2, 0, None))
ok('返回 ok:False（取不到就不发，不抛到上层）', r.get('ok') is False)
ok('带了可读的失败原因', bool(r.get('error')), str(r.get('error'))[:60])
ok('原因里不是 NameError', 'NameError' not in str(r.get('error')), str(r.get('error'))[:60])

print('\n%s' % ('✓ 全过' if not fails else '✗ 失败 %d 项：%s' % (len(fails), ', '.join(fails))))
sys.exit(0 if not fails else 1)
