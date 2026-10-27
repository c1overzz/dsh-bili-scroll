"""输入延迟（`_typing_wait` / `_type_wait`）的回归检查（不联网、不真睡）。

跑法（用插件自己的 venv，里面已经有 mcp / bilibili_api）：
    <家目录>/.venv/Scripts/python.exe tools/check-typing.py

钉住的口径（2.4.0）：**等待 = 字数 / 速度(字/秒，范围内取 random) + 随机抖动**
  · 字数按字符数（中文一个字算一个）
  · 速度在 [cps_min, cps_max] 里随机取 ⇒ 快慢有波动，固定值反而像机器
  · 有上限（默认 90 秒），再长就成卡死了
  · 空文本 / 关掉（BILI_TYPE_OFF）⇒ 一点都不等
"""

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vendor" / "bilibili-mcp"))

try:                        # Windows 控制台默认 GBK，输出中文/符号会炸
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import mcp_server as S  # noqa: E402

fail = []


def check(name, got, want):
    if got != want:
        fail.append(f"{name}: got {got!r} want {want!r}")


def check_true(name, cond, detail=""):
    if not cond:
        fail.append(f"{name}: {detail or '应为真'}")


class FakeRng:
    """把两个 uniform() 的结果钉死：第一个当速度，第二个当抖动。"""

    def __init__(self, cps, jitter):
        self.calls = []
        self.values = [cps, jitter]

    def uniform(self, a, b):
        self.calls.append((a, b))
        return self.values.pop(0)


def wait_for(text, cps, jitter, **kw):
    return S._typing_wait(text, cps_min=10.0, cps_max=10.0,
                          jitter_min=jitter, jitter_max=jitter, rng=FakeRng(cps, jitter), **kw)


# ── 空文本：一个字都没打，就不该等 ──────────────────────────
check("空文本不等", S._typing_wait("", rng=FakeRng(2.0, 1.0)), 0.0)
check("None 也不等", S._typing_wait(None, rng=FakeRng(2.0, 1.0)), 0.0)

# ── 算式：字数 / 速度 + 抖动 ───────────────────────────────
# 40 字 ÷ 2 字/秒 = 20 秒，+ 1.5 秒抖动 = 21.5
check("40 字 ÷ 2 字/秒 + 1.5s",
      round(S._typing_wait("x" * 40, cps_min=2.0, cps_max=2.0,
                           jitter_min=1.5, jitter_max=1.5, rng=FakeRng(2.0, 1.5)), 6),
      21.5)
# 中文按**字**数算，不是按字节：10 个汉字 ÷ 5 = 2 秒，+ 0.5 = 2.5
cn = "这十个汉字要慢慢点打"
check("这串汉字确实是 10 个", len(cn), 10)
check("中文 10 字 ÷ 5 字/秒 + 0.5s",
      round(S._typing_wait(cn, cps_min=5.0, cps_max=5.0,
                           jitter_min=0.5, jitter_max=0.5, rng=FakeRng(5.0, 0.5)), 6),
      2.5)

# ── 速度确实是从区间里取的（两个 uniform 参数顺序对得上）──────
rng = FakeRng(1.5, 0.5)
S._typing_wait("abc", cps_min=1.0, cps_max=3.0, jitter_min=0.2, jitter_max=2.0, rng=rng)
check("速度区间 = [1,3]", rng.calls[0], (1.0, 3.0))
check("抖动区间 = [0.2,2]", rng.calls[1], (0.2, 2.0))

# ── 两端边界：每次都得落在 human 区间内 ────────────────────
for text in ("短", "x" * 40, "长" * 100):
    for _ in range(50):
        w = S._typing_wait(text, cps_min=1.2, cps_max=3.5,
                           jitter_min=0.5, jitter_max=2.0, cap=0)
        lo = len(text) / 3.5 + 0.5
        hi = len(text) / 1.2 + 2.0
        check_true(f"{len(text)} 字落在 [{lo:.2f},{hi:.2f}] 秒内", lo <= w <= hi, f"got {w:.2f}")

# ── 越长越慢（同一份 rng 结果时）──────────────────────────
def same_rng():
    return FakeRng(2.0, 1.0)


check_true("字数多 ⇒ 等更久",
           S._typing_wait("x" * 40, rng=same_rng()) > S._typing_wait("x" * 10, rng=same_rng()))

# ── 上限：再长的评论也不会卡在那里 ──────────────────────────
check("默认上限 90 秒",
      S._typing_wait("长" * 5000, cps_min=1.0, cps_max=1.0,
                     jitter_min=0.0, jitter_max=0.0, rng=FakeRng(1.0, 0.0)),
      S._TYPE_MAX_WAIT)
check("显式上限 5 秒",
      round(S._typing_wait("长" * 5000, cps_min=1.0, cps_max=1.0,
                           jitter_min=0.0, jitter_max=0.0, cap=5.0,
                           rng=FakeRng(1.0, 0.0)), 6),
      5.0)
check("cap=0 ⇒ 不限",
      round(S._typing_wait("x" * 100, cps_min=1.0, cps_max=1.0,
                           jitter_min=0.0, jitter_max=0.0, cap=0,
                           rng=FakeRng(1.0, 0.0)), 6),
      100.0)

# ── 填坏了也别炸（速度 0 / 抖动负数 ⇒ 不能除零、不能等负数）──
check_true("速度 0 不除零",
           S._typing_wait("abc", cps_min=0.0, cps_max=0.0,
                          jitter_min=0.0, jitter_max=0.0, rng=FakeRng(1.0, 0.0)) > 0)
check_true("抖动负数 ⇒ 不等负的",
           S._typing_wait("abc", cps_min=5.0, cps_max=5.0,
                          jitter_min=-3.0, jitter_max=-1.0, rng=FakeRng(5.0, -1.0)) >= 0)

# ── _env_float：坏值退回默认，别让一个环境变量炸掉发评论 ───
check("_env_float 默认", S._env_float("BILI_THIS_VAR_DOES_NOT_EXIST", 1.5), 1.5)
import os  # noqa: E402

os.environ["BILI_TYPE_TEST_VAR"] = "2.5"
check("_env_float 读到值", S._env_float("BILI_TYPE_TEST_VAR", 1.5), 2.5)
os.environ["BILI_TYPE_TEST_VAR"] = "不是数字"
check("_env_float 坏值退回默认", S._env_float("BILI_TYPE_TEST_VAR", 1.5), 1.5)
del os.environ["BILI_TYPE_TEST_VAR"]

# ── 默认档位本身要像人：1.2~3.5 字/秒 = 72~210 字/分钟 ─────
check_true("默认速度下限 1.2 字/秒", 1.2 <= S._TYPE_CPS_MIN < S._TYPE_CPS_MAX <= 3.5,
           f"{S._TYPE_CPS_MIN}~{S._TYPE_CPS_MAX}")
check_true("默认上限 ≤ 宿主 180 秒超时", 0 < S._TYPE_MAX_WAIT <= 150, str(S._TYPE_MAX_WAIT))

# ── _type_wait：真的会睡、关掉就一点不睡（用 0.05 秒的上限跑，别真等 90 秒）──
import asyncio  # noqa: E402
import time     # noqa: E402

_SLEEP_BACKUP = (S._TYPE_OFF, S._TYPE_CPS_MIN, S._TYPE_CPS_MAX,
                 S._TYPE_JITTER_MIN, S._TYPE_JITTER_MAX, S._TYPE_MAX_WAIT)
try:
    S._TYPE_OFF, S._TYPE_CPS_MIN, S._TYPE_CPS_MAX = False, 1.0, 1.0
    S._TYPE_JITTER_MIN, S._TYPE_JITTER_MAX, S._TYPE_MAX_WAIT = 0.0, 0.0, 0.05
    t0 = time.monotonic()
    slept = asyncio.run(S._type_wait("长" * 100))     # 100 字 ÷ 1 = 100s ⇒ 被上限压到 0.05s
    elapsed = time.monotonic() - t0
    check_true("_type_wait 返回上限值", abs(slept - 0.05) < 1e-6, f"got {slept}")
    check_true("_type_wait 真的睡了", elapsed >= 0.04, f"elapsed {elapsed:.3f}s")

    S._TYPE_OFF = True
    t0 = time.monotonic()
    check("关掉 ⇒ 返回 0", asyncio.run(S._type_wait("长" * 100)), 0.0)
    check_true("关掉 ⇒ 不睡", time.monotonic() - t0 < 0.01)
finally:
    (S._TYPE_OFF, S._TYPE_CPS_MIN, S._TYPE_CPS_MAX,
     S._TYPE_JITTER_MIN, S._TYPE_JITTER_MAX, S._TYPE_MAX_WAIT) = _SLEEP_BACKUP

if fail:
    print("✗ 输入延迟检查失败：")
    for f in fail:
        print("  ·", f)
    sys.exit(1)
print("✓ 输入延迟检查全过（字数 / 速度 + 抖动、上限、坏值兜底）")
