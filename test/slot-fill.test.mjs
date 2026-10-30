/**
 * test/slot-fill.test.mjs —— 「用户给几条就排几个点」。
 *
 * ⭐ 2026-10-30（用户："我给了多少条，你就在我给的时间里跑完"）：
 *   上一版按 `总时长 / 条数` 算间隔，碰上"中午 12–14 + 夜间 18–09"这种中间有空档的
 *   情况必然排不满：12 小时 ÷ 20 条 = 36 分钟间隔，但真正能用的只有 8 小时，
 *   于是只排得出 12 个点。用户填 20，实际只跑 12 次。
 *
 *   现在按「可用分钟列表的下标」均分，不管窗口连不连续都能排满。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = readFileSync(resolve(HERE, '..', 'index.js'), 'utf8')

// 把 index.js 里那段算法抠出来跑（避免重复实现走样）
function loadSpreadSlots() {
  const start = INDEX.indexOf('const spreadSlots = (mins, n) => {')
  assert.ok(start > 0, '没找到 spreadSlots')
  // 找到函数结尾（下一个同缩进的 `}` 后跟 `\n  const ensureSlotPlan`）
  const end = INDEX.indexOf('const ensureSlotPlan', start)
  assert.ok(end > start, '没找到函数结尾')
  const src = INDEX.slice(start, end).trim().replace(/,\s*$/, '')
  // eslint-disable-next-line no-new-func
  return new Function(src + '\nreturn spreadSlots')()
}

const spreadSlots = loadSpreadSlots()

const mk = (fromH, toH) => {
  const out = []
  const s = new Date(2026, 9, 30, fromH, 0, 0).getTime()
  const e = new Date(2026, 9, 30, toH, 59, 0).getTime()
  for (let t = s; t <= e; t += 60000) out.push(t)
  return out
}
const noon = mk(12, 13)
const both = noon.concat(mk(18, 23))

test('只开中午：要 5 条就排 5 个点', () => {
  const r = spreadSlots(noon, 5)
  assert.equal(r.times.length, 5)
  assert.equal(r.wanted, 5)
})

test('中午+夜间：要 20 条也能排满 20 个（这是之前排不满的那个场景）', () => {
  const r = spreadSlots(both, 20)
  assert.equal(r.times.length, 20, '排不满 —— 算法又退回按时间轴算间隔了')
})

test('只开中午要 20 条：仍然排满（不替用户砍数量）', () => {
  const r = spreadSlots(noon, 20)
  assert.equal(r.times.length, 20)
})

test('点不会重复、且都在可用分钟里', () => {
  const r = spreadSlots(both, 20)
  assert.equal(new Set(r.times).size, r.times.length, '有重复时间点')
  for (const t of r.times) assert.ok(both.includes(t), '排出了不在可用分钟里的点')
})

test('排出来是升序的（tick 靠这个顺序消费）', () => {
  const r = spreadSlots(both, 10)
  for (let i = 1; i < r.times.length; i++) assert.ok(r.times[i] > r.times[i - 1])
})

test('要的条数超过可用分钟数时，最多排到"每分钟一个"', () => {
  const tiny = mk(12, 12).slice(0, 5)     // 只有 5 分钟可用
  const r = spreadSlots(tiny, 50)
  assert.equal(r.times.length, 5, '不该排出比可用分钟更多的点')
})

test('没有可用时间时返回空，不抛错', () => {
  const r = spreadSlots([], 5)
  assert.deepEqual(r.times, [])
})

test('avgGapMin 反映真实密度（用来触发"太密"警告）', () => {
  const r5 = spreadSlots(noon, 5)          // 2 小时 5 条 ≈ 27 分钟
  const r20 = spreadSlots(noon, 20)        // 2 小时 20 条 ≈ 6 分钟
  assert.ok(r5.avgGapMin > r20.avgGapMin, '条数越多，平均间隔应该越小')
  assert.ok(r5.avgGapMin >= 20, '5 条/2 小时 的间隔不该低于 20 分钟，实际 ' + r5.avgGapMin)
  // 真把 20 条压进 30 分钟里，就会低于 5 分钟警告线
  const tight = mk(12, 12).slice(0, 30)
  const rt = spreadSlots(tight, 20)
  assert.ok(rt.avgGapMin < 5, '30 分钟排 20 条应该判为太密，实际 ' + rt.avgGapMin)
  assert.ok(/DENSE_WARN_GAP/.test(INDEX), '没有太密警告的阈值常量')
})

/* ⭐ 2026-10-30（用户拍板选 A）：**太密只警告、不拦。**
 *   所以这里钉死两件事：
 *     ① ensureSlotPlan 里"太密"那段只有 log，没有 return / throw（不能悄悄少排）
 *     ② 排点函数本身对"条数 > 窗口能舒服容纳的量"也不设上限（除了可用分钟数）
 *   哪天有人想改成"拒绝"，必须同时改这个测试 —— 那是一次产品决策，不该被顺手改掉。
 */
test('太密只警告、不拦：ensureSlotPlan 里那段不许 return', () => {
  const start = INDEX.indexOf('DENSE_WARN_GAP) {')
  assert.ok(start > 0, '没找到太密判断')
  const block = INDEX.slice(start, start + 400)
  const braceEnd = block.indexOf('}')
  const body = block.slice(block.indexOf('{') + 1, braceEnd)
  assert.equal(/\breturn\b/.test(body), false, '太密那段出现了 return —— 变成"拦"了')
  assert.equal(/\bthrow\b/.test(body), false, '太密那段出现了 throw')
  assert.ok(/log\(/.test(body), '太密那段应该 log 一句')
})

test('只开中午要 20 条：一条不少地排满（A 方案的核心承诺）', () => {
  const r = spreadSlots(noon, 20)
  assert.equal(r.times.length, 20, '被"太密"拦掉了，应该照排')
  assert.ok(r.avgGapMin < 10, '这个场景本来就该被判为密集')
})
