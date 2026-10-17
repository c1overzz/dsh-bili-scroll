/**
 * window-smoke.mjs —— 自定义时段那套工具的单测
 * ============================================================================
 * 为什么单独测：时段算错**不会报错**，只会在某个奇怪的时刻多跑一轮或者干脆不跑 ——
 * 这种错只能靠把边界一个个摆出来验，靠"跑一天看看"是发现不了的。
 *
 * 跑法：`node window-smoke.mjs`
 * ============================================================================
 */
import {
  minutesOf, hhmm, inWindow, parseWindow, windowText, normWindows,
  overlapOf, analyzeWindows, effectiveWindows, windowBlocks, blockAt, nextRunAt, dayKey,
} from './lib/state.mjs'

const checks = []
const ok = (name, cond, extra) => checks.push([name, Boolean(cond), extra])
const eq = (name, got, want) => checks.push([name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，想要 ${JSON.stringify(want)}`])

/** 造一个本地时刻（年份随便，只要月/日/时/分对得上） */
const T = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0)

/* ── 'HH:MM' 解析 ─────────────────────────────────────────────────────────── */
eq('00:00 → 0', minutesOf('00:00'), 0)
eq('23:59 → 1439', minutesOf('23:59'), 1439)
eq('9:05 → 545（不补零也认）', minutesOf('9:05'), 545)
eq('25:00 不是时间', minutesOf('25:00'), null)
eq('12:99 不是时间', minutesOf('12:99'), null)
eq('空 / undefined 不是时间', [minutesOf(''), minutesOf(undefined), minutesOf(null)], [null, null, null])
eq('分钟数绕回：1440 → 00:00', hhmm(1440), '00:00')
eq('-30 → 23:30', hhmm(-30), '23:30')

/* ── "HH:MM-HH:MM" ───────────────────────────────────────────────────────────────── */
eq('普通时段', parseWindow('12:00-14:00'), { start: '12:00', end: '14:00' })
eq('跨零点时段', parseWindow('18:00-09:00'), { start: '18:00', end: '09:00' })
eq('分隔符与空格混着来也认', parseWindow(' 23:30 ～ 02:15 '), { start: '23:30', end: '02:15' })
eq('碎片不是时段', parseWindow('12:00'), null)
eq('越界不是时段', parseWindow('25:00-26:00'), null)
eq('全角冒号不认（宁可当无效）', parseWindow('12：00-14:00'), null)
eq('回写文本', windowText({ start: '09:00', end: '10:30' }), '09:00-10:30')

eq('规范化：丢掉看不懂的、保留顺序',
  normWindows(['12:00-14:00', '', '瞎写的', '18:00-09:00', '14:00-12:00']),
  [{ start: '12:00', end: '14:00' }, { start: '18:00', end: '09:00' }, { start: '14:00', end: '12:00' }])

/* ── 在不在时段里 ─────────────────────────────────────────────────────────── */
const noon = { start: '12:00', end: '14:00' }
const night = { start: '18:00', end: '09:00' }
ok('12:30 在中午时段里', inWindow(T(2026, 10, 18, 12, 30), noon))
ok('14:00 已经出了中午时段（左闭右开）', !inWindow(T(2026, 10, 18, 14, 0), noon))
ok('11:59 还没进', !inWindow(T(2026, 10, 18, 11, 59), noon))
ok('02:00 在跨零点的夜间时段里', inWindow(T(2026, 10, 18, 2, 0), night))
ok('15:00 不在夜间时段里', !inWindow(T(2026, 10, 18, 15, 0), night))
ok('09:00 出了夜间时段', !inWindow(T(2026, 10, 18, 9, 0), night))
ok('起止相同 = 全天', inWindow(T(2026, 10, 18, 7, 7), { start: '05:00', end: '05:00' }))
ok('时段瞎写 → 一律不在里面（不是崩，也不是全中）', !inWindow(T(2026, 10, 18, 12, 0), { start: 'x', end: 'y' }))

/* ── 重叠检测 ─────────────────────────────────────────────────────────────── */
ok('12-14 与 13-15 重叠', overlapOf({ start: '12:00', end: '14:00' }, { start: '13:00', end: '15:00' }))
ok('12-14 与 14-16 不重叠（首尾相接不算）', !overlapOf({ start: '12:00', end: '14:00' }, { start: '14:00', end: '16:00' }))
ok('夜间跨零点与凌晨 01-02 重叠', overlapOf(night, { start: '01:00', end: '02:00' }))
ok('夜间跨零点与 23-23:30 重叠', overlapOf(night, { start: '23:00', end: '23:30' }))
ok('夜间跨零点与 15-16 不重叠', !overlapOf(night, { start: '15:00', end: '16:00' }))
ok('全天与任何时段都重叠', overlapOf({ start: '05:00', end: '05:00' }, { start: '23:00', end: '01:00' }))

{
  const a = analyzeWindows(['12:00-14:00', '18:00-09:00'])
  eq('两条互不重叠 → 没告警', a.issues.length, 0)
  const b = analyzeWindows(['12:00-14:00', '13:00-15:00'])
  eq('重叠 → 恰好一条告警', b.issues.map((x) => x.kind), ['overlap'])
  const c = analyzeWindows(['12:00-14:00', '12:00-14:00'])
  eq('重复 → 报 dup 而不是 overlap（更准确的那个）', c.issues.map((x) => x.kind), ['dup'])
  const d = analyzeWindows(['00:00-00:00'])
  eq('整天 → 报 allday', d.issues.map((x) => x.kind), ['allday'])
  ok('告警里带得出是人话（含时段编号）', /时段 1.*时段 2/.test(b.issues[0].text), b.issues[0].text)
}

/* ── 生效的时段表 ─────────────────────────────────────────────────────────── */
eq('没配自定义 → 用内置两组',
  effectiveWindows({}).map((w) => w.key), ['noon', 'night'])
eq('内置的关掉一个 → 只剩一个',
  effectiveWindows({ night: false }).map((w) => w.key), ['noon'])
eq('两个都关 → 一个都没有（那就永远不自动跑）',
  effectiveWindows({ noon: false, night: false }), [])
eq('配了自定义 → 内置整个让位（哪怕 noon 还开着）',
  effectiveWindows({ windows: ['07:00-08:00'], noon: true, night: true }).map((w) => w.key), ['w1'])
eq('自定义的编号与文案',
  effectiveWindows({ windows: ['07:00-08:00', '20:00-21:30'] }).map((w) => [w.key, w.label, w.start, w.end]),
  [['w1', '时段 1', '07:00', '08:00'], ['w2', '时段 2', '20:00', '21:30']])
eq('自定义全是不合法的 → 等于没配，退回内置',
  effectiveWindows({ windows: ['瞎写', '99:99-00:00'] }).map((w) => w.key), ['noon', 'night'])

/* ── 覆盖块：一段什么时候算"跑过了" ──────────────────────────────────────── */
{
  const night = windowBlocks(['18:00-09:00'])
  eq('傍晚 18:30 → 这一段从 18:00 开始，记在今天',
    blockAt(T(2026, 10, 18, 18, 30), night).key, '2026-10-18:b1:18:00')
  eq('⭐ 次日凌晨 00:30 → 同一条 key（算昨天傍晚开始的那一场）',
    blockAt(T(2026, 10, 19, 0, 30), night).key, '2026-10-18:b1:18:00')
  eq('次日 08:59 → 还是那一场',
    blockAt(T(2026, 10, 19, 8, 59), night).key, '2026-10-18:b1:18:00')
  eq('次日 12:00 → 已经不在里面了', blockAt(T(2026, 10, 19, 12, 0), night), null)

  const noon = windowBlocks(['12:00-14:00'])
  eq('不跨零点的照旧按当天',
    blockAt(T(2026, 10, 19, 13, 0), noon).key, '2026-10-19:b1:12:00')

  const all = windowBlocks(['00:00-00:00'])
  eq('全天：一天一场，key 落在 00:00',
    blockAt(T(2026, 10, 19, 3, 0), all).key, '2026-10-19:b1:00:00')
  eq('全天：换个时刻还是同一条 key（不是每分钟一场）',
    blockAt(T(2026, 10, 19, 22, 0), all).key, '2026-10-19:b1:00:00')

  const ov = windowBlocks(['12:00-14:00', '13:00-15:00'])
  eq('⚠️ 重叠的两条 → 并成一个覆盖块', ov.length, 1)
  eq('⭐ 12:30 与 14:30 是同一条 key（同一场，不会一小时刷两轮）',
    [blockAt(T(2026, 10, 18, 12, 30), ov).key, blockAt(T(2026, 10, 18, 14, 30), ov).key],
    ['2026-10-18:b1:12:00', '2026-10-18:b1:12:00'])

  eq('⭐ 首尾相接的（14:00 接 14:00）**不并** —— 那是两场',
    windowBlocks(['08:00-09:00', '09:00-10:00']).length, 2)
  eq('不相干的两条当然也不并', windowBlocks(['08:00-09:00', '20:00-21:00']).length, 2)
  eq('三条链式重叠 → 仍并成一块',
    windowBlocks(['08:00-10:00', '09:30-11:00', '10:30-12:00']).length, 1)
  eq('按 label 说得出人话（报告 / 上次为什么跑 要用）',
    blockAt(T(2026, 10, 18, 13, 0), windowBlocks(effectiveWindows({ windows: ['12:00-14:00'] }))).labels,
    ['时段 1'])
  eq('内置那两组也走同一套（夜里那场带自己的名字）',
    blockAt(T(2026, 10, 18, 19, 0), windowBlocks(effectiveWindows({}))).labels,
    ['晚上/夜间谷时'])
}
eq('dayKey 用本地日期', dayKey(T(2026, 1, 2, 23, 59)), '2026-01-02')

/* ── 下次什么时候跑 ───────────────────────────────────────────────────────── */
{
  const near = (d) => d && `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const ws = ['12:00-14:00', '18:00-09:00']
  eq('10:00 → 今天 12:00',
    near(nextRunAt(T(2026, 10, 18, 10, 0), ws)), '10-18 12:00')
  eq('12:30 已经在里面 → 下一分钟就能跑',
    near(nextRunAt(T(2026, 10, 18, 12, 30), ws)), '10-18 12:31')
  eq('15:00 中午过了、夜里还没到 → 今天 18:00',
    near(nextRunAt(T(2026, 10, 18, 15, 0), ws)), '10-18 18:00')
  eq('凌晨 02:00 已经在夜里那一场里 → 下一分钟',
    near(nextRunAt(T(2026, 10, 18, 2, 0), ws)), '10-18 02:01')
  eq('09:30（夜里那场刚结束）→ 今天 12:00',
    near(nextRunAt(T(2026, 10, 18, 9, 30), ws)), '10-18 12:00')
  eq('⭐ 已经在里面、但这一场已经跑过了 → 不会说"下一分钟"，而是下一场 18:00',
    near(nextRunAt(T(2026, 10, 18, 12, 30), ws, ['2026-10-18:b1:12:00'])), '10-18 18:00')
  eq('今天全过完了 → 明天 12:00',
    near(nextRunAt(T(2026, 10, 18, 22, 30), ['12:00-14:00'])), '10-19 12:00')
  eq('跑过的那一场不会再报（今天只剩夜里那场）',
    near(nextRunAt(T(2026, 10, 18, 12, 30), ws, ['2026-10-18:b1:12:00', '2026-10-18:b2:18:00'])), '10-19 12:00')
  eq('没有时段 → null', nextRunAt(T(2026, 10, 18, 10, 0), []), null)
}

/* ── ⭐ 模拟一整天：调度器到底会跑几轮 ───────────────────────────────────────
 * 这是功能①真正的验收点。上面那些单点判断都对，也仍可能"多跑一轮" ——
 * 重叠的两条、跨零点的那条，都是**只在时间推进中**才暴露出来的毛病。
 * 这里按 index.js 里 tick() 的同样规则复刻一遍（那边改了要同步改这里）。
 * ⚠️ 起点特意选在没有时段命中的时刻，否则"一开始就在某一场里"会先补跑一次。
 */
function simulate(winTexts, startDay, days, cap = 99) {
  const blocks = windowBlocks(effectiveWindows({ windows: winTexts }))
  const st = new Set()
  const fires = []
  for (let t = 0; t < days * 1440; t++) {
    if (fires.length >= cap) break
    const now = new Date(startDay.getTime() + t * 60000)
    const at = blockAt(now, blocks)
    if (!at || st.has(at.key)) continue
    st.add(at.key)
    fires.push(`${now.getMonth() + 1}-${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`)
  }
  return fires
}
const D10 = T(2026, 10, 18, 10, 0)          // 10:00，谁都还没命中
const D07 = T(2026, 10, 18, 7, 0)           // 07:00

eq('单条 12:00-14:00 → 一天正好一轮，落在 12:00',
  simulate(['12:00-14:00'], D10, 1), ['10-18 12:00'])
eq('⭐ 重叠的两条（12-14 与 13-15）→ **一天只有一轮**',
  simulate(['12:00-14:00', '13:00-15:00'], D10, 1), ['10-18 12:00'])
eq('三条互相重叠 → 还是一轮',
  simulate(['12:00-14:00', '12:30-13:30', '13:00-15:00'], D10, 1), ['10-18 12:00'])
eq('⭐ 跨零点 18:00-09:00 → 两天两轮，凌晨那次不再补一轮',
  simulate(['18:00-09:00'], D10, 2), ['10-18 18:00', '10-19 18:00'])
eq('⭐ 跨零点 + 跟它重叠的凌晨时段 → 仍是一天一轮',
  simulate(['18:00-09:00', '01:00-02:00'], D10, 2), ['10-18 18:00', '10-19 18:00'])
eq('两条不重叠 → 一天两轮，按时间顺序',
  simulate(['08:00-09:00', '20:00-21:00'], D07, 1), ['10-18 08:00', '10-18 20:00'])
eq('⭐ 首尾相接的两条 → 照旧算两场（没把它们并掉）',
  simulate(['08:00-09:00', '09:00-10:00'], D07, 1), ['10-18 08:00', '10-18 09:00'])
// 模拟从 10-18 10:00 起跑满 24 小时 ⇒ 会跨过午夜，所以次日 00:00 再跑一场正是"一个自然日一场" ✓
eq('全天时段 → 一个自然日一场（不是每分钟一轮，也不是一整天只跑一次）',
  simulate(['00:00-00:00'], D10, 1), ['10-18 10:00', '10-19 00:00'])
eq('⭐ 每日上限拦住后面那场：cap=1 时只剩一轮',
  simulate(['08:00-09:00', '20:00-21:00'], D07, 1, 1), ['10-18 08:00'])
eq('内置那两组（没配自定义）两天的落点就是 12:00 / 18:00',
  simulate([], D10, 2), ['10-18 12:00', '10-18 18:00', '10-19 12:00', '10-19 18:00'])

/* ── 报账 ─────────────────────────────────────────────────────────────────── */
let bad = 0
for (const [name, pass, extra] of checks) {
  if (pass) { if (process.env.VERBOSE) console.log(`  ✓ ${name}`) }
  else { bad++; console.log(`  ✗ ${name}${extra ? '  —— ' + extra : ''}`) }
}
console.log(bad === 0
  ? `✅ 时段工具 全部通过（${checks.length} 项）`
  : `❌ 时段工具 ${bad}/${checks.length} 项没过`)
process.exit(bad === 0 ? 0 : 1)