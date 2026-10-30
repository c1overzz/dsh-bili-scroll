/**
 * test/switches-behavior.test.mjs —— 「关掉就真的不跑」。
 *
 * 用户的原话：「不要我没开这个时间段跑他还跑了」。
 *
 * ⚠️ 这里**不测** upcomingOffPeakMinutes（它依赖"现在几点"和本地日期，测试里很难构造得干净），
 *    而是测它**内部真正做判断的那个函数** —— inWindow + tick 里的 anyWindow 语义。
 *    这两处才是"开关有没有用"的判据；排点只是它们的消费者。
 *
 * inWindow 直接从 lib/state.mjs 导入（**跟宿主同源**），不自己抄一份 ——
 * 抄一份最容易出的错就是时区重复换算（我第一版就栽在这：本地构造时刻 + 再加 8 小时 ⇒ 结论全反）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inWindow, WINDOWS } from '../lib/state.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const INDEX = readFileSync(resolve(ROOT, 'index.js'), 'utf8')

/** 构造「北京某个时刻」的绝对时间：按 UTC 写死，再回退 8 小时 */
const bjAt = (h, m = 0, day = 30) => new Date(Date.UTC(2026, 9, day, h, m, 0) - 8 * 3600 * 1000)

/** tick 里的窗口判据（跟宿主同源的那句 some(...)） */
const anyWindow = (t, cfg) => ['noon', 'night'].some((k) => cfg[k] && inWindow(t, WINDOWS[k]))

/** 去掉注释行之后的宿主源码 —— 注释里提到某个键名不算"读它"（排查记录会写 `cfg.asrInstalled` 这种名字） */
const codeLines = () => INDEX.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

/** 取 tick 函数体（按行直到同缩进的闭合括号） */
function tickBody() {
  const lines = INDEX.split('\n')
  const start = lines.findIndex((l) => l.includes('const tick = async'))
  assert.ok(start >= 0, '没找到 tick')
  const out = []
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i])
    depth += (lines[i].match(/\{/g) || []).length
    depth -= (lines[i].match(/\}/g) || []).length
    if (i > start && depth <= 0) break
  }
  return out.join('\n')
}

test('两个窗口都关 ⇒ 任何时刻都不在允许窗口里（"没开还跑"的反面）', () => {
  for (const h of [0, 6, 9, 12, 13, 14, 17, 18, 20, 23]) {
    assert.equal(anyWindow(bjAt(h), { noon: false, night: false }), false, '北京 ' + h + ' 点被判成在窗口里')
  }
})

test('只开中午 ⇒ 只有 12:00–13:59 算窗口内', () => {
  const cfg = { noon: true, night: false }
  assert.equal(anyWindow(bjAt(11, 59), cfg), false, '11:59 不该在窗口里')
  assert.equal(anyWindow(bjAt(12, 0), cfg), true, '12:00 应该在')
  assert.equal(anyWindow(bjAt(13, 59), cfg), true, '13:59 应该在')
  assert.equal(anyWindow(bjAt(14, 0), cfg), false, '14:00 已经出了中午窗口')
  assert.equal(anyWindow(bjAt(18, 0), cfg), false, '只开中午，18 点不该在窗口里')
  assert.equal(anyWindow(bjAt(20, 0), cfg), false, '只开中午，20 点不该在窗口里')
})

test('只开夜间 ⇒ 只有 18:00 之后和 09:00 之前算窗口内', () => {
  const cfg = { noon: false, night: true }
  assert.equal(anyWindow(bjAt(12, 0), cfg), false, '只开夜间，12 点不该在窗口里')
  assert.equal(anyWindow(bjAt(17, 59), cfg), false, '17:59 还不算夜间')
  assert.equal(anyWindow(bjAt(18, 0), cfg), true, '18:00 应该进夜间窗口')
  assert.equal(anyWindow(bjAt(23, 59), cfg), true)
  assert.equal(anyWindow(bjAt(0, 30), cfg), true, '跨零点的凌晨仍算夜间')
  assert.equal(anyWindow(bjAt(8, 59), cfg), true)
  assert.equal(anyWindow(bjAt(9, 0), cfg), false, '09:00 出了夜间窗口')
})

test('峰时（工作日 9–12 / 14–18）在"两个都开"时也永远不在窗口内', () => {
  const cfg = { noon: true, night: true }
  for (const [h, m] of [[9, 0], [10, 30], [11, 59], [14, 0], [15, 30], [17, 59]]) {
    assert.equal(anyWindow(bjAt(h, m), cfg), false, '峰时 ' + h + ':' + m + ' 被判成在窗口里')
  }
})

test('周末全天算谷时（两个都开时）', () => {
  const cfg = { noon: true, night: true }
  // 2026-10-31 是周六
  for (const h of [9, 11, 15, 17]) {
    assert.equal(anyWindow(bjAt(h, 0, 31), cfg), true, '周六 ' + h + ' 点应该算谷时')
  }
})

test('tick 里：peakValley 总开关关着就直接 return', () => {
  const body = tickBody()
  const guard = body.indexOf('if (!cfg.peakValley) return')
  assert.ok(guard > 0, 'tick 里没有 peakValley 总开关判断')
  const spreadIdx = body.indexOf('if (cfg.spread)')
  assert.ok(spreadIdx > 0 && guard < spreadIdx, 'peakValley 判断必须排在分时逻辑之前')
})

test('tick 里：额度用满就不再跑，且闸门在启动之前', () => {
  const body = tickBody()
  const lines = body.split('\n')
  const isCode = (l) => !/^\s*(\/\/|\*|\/\*)/.test(l)
  const gateLine = lines.findIndex((l) => isCode(l) && /autoPickedToday\(now\) >= Number\(cfg\.perDay/.test(l))
  const callLine = lines.findIndex((l) => isCode(l) && /await runDutyConfirmed\(/.test(l))
  assert.ok(gateLine >= 0, '没有 perDay 额度闸门')
  assert.ok(callLine >= 0, '没找到启动调用')
  assert.ok(gateLine < callLine, '额度闸门必须排在启动之前')
})

test('tick 里：分时分支由 cfg.spread 控制，且启动前要核窗口', () => {
  const body = tickBody()
  assert.ok(/if \(cfg\.spread\) \{/.test(body), '分时分支不受 cfg.spread 控制')
  assert.ok(/anyWindow/.test(body), '分时分支没有窗口检查')
  assert.ok(/if \(!inWindow\(now, WINDOWS\[k\]\)\) continue/.test(body), '普通分支没有窗口检查')
})

/* ─────────── 下面两条治的是「开关写了但根本读不到」───────────
 * 2026-10-30 查出来的真 bug：白名单里写的是 `cfg.asrInstalled`，
 * 而这个键 schema 和 DEFAULTS 里都没有 ⇒ 恒为 undefined ⇒ `!== false` 恒真
 * ⇒ 「本地转写」关着，三只转写工具照样下发。这种键必须一条都不许有。
 */

test('白名单里的转写工具认的是真开关 transcribe，不是幽灵键', () => {
  const code = codeLines()
  assert.equal(/cfg\.asrInstalled/.test(code), false,
    'index.js 的代码里又出现了 cfg.asrInstalled —— 这个键不存在，永远 undefined，等于开关失效')
  const line = code.split('\n').find((l) => l.includes("'bili_transcribe_start'"))
  assert.ok(line, '没找到下发转写工具的那一行')
  assert.match(line, /if \(cfg\.transcribe\)/, '转写工具必须由 cfg.transcribe 控制')
})

test('宿主读过的每个 cfg.<键> 都真在 schema / DEFAULTS 里（没有幽灵键）', () => {
  const src = codeLines()
  const schemaKeys = new Set([...src.matchAll(/^\s{2}([A-Za-z_][\w]*):\s*z\./gm)].map((m) => m[1]))
  const defM = src.match(/const DEFAULTS\s*=\s*\{([\s\S]*?)\n\s*\}/)
  assert.ok(defM, '没找到 DEFAULTS')
  const defaultKeys = new Set([...defM[1].matchAll(/([A-Za-z_][\w]*)\s*:/g)].map((m) => m[1]))
  const read = new Set([...src.matchAll(/\bcfg\.([A-Za-z_][\w]*)/g)].map((m) => m[1]))
  const phantom = [...read].filter((k) => !schemaKeys.has(k) && !defaultKeys.has(k))
  assert.deepEqual(phantom, [], '这些键代码里在读，但 schema/默认值里没有 ⇒ 永远是 undefined：' + phantom.join(', '))
})
