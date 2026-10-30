/**
 * test/slot-irregular.test.mjs —— 「不要有规律的间隔」。
 *
 * ⭐ 2026-10-30（用户："不要有规律的间隔"）：
 *   之前是「可用分钟等分成 N 段、每段随机取一分钟」——每段一样长，间隔天然都差不多
 *   （实测 19/20/15/43 分钟，倍差 2.9），看着还是规律。
 *
 *   现在用**指数分布权重**切分：大多数间隔偏短、偶尔一个很长，倍差能到几十倍。
 *   这里钉住的不是"具体排在哪几分钟"，而是**分布的统计特征** —— 否则测试会太脆。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = readFileSync(resolve(HERE, '..', 'index.js'), 'utf8')

function loadSpreadSlots() {
  const start = INDEX.indexOf('const spreadSlots = (mins, n) => {')
  assert.ok(start > 0, '没找到 spreadSlots')
  const end = INDEX.indexOf('const ensureSlotPlan', start)
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
const both = mk(12, 13).concat(mk(18, 23))
const gapsOf = (times) => times.slice(1).map((t, i) => (t - times[i]) / 60000)

/** 多跑几轮取中位数，避免单次随机导致 flaky */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

test('间隔不规律：最长的间隔远大于最短的（倍差中位数 > 5）', () => {
  const ratios = []
  for (let i = 0; i < 30; i++) {
    const g = gapsOf(spreadSlots(both, 10).times)
    const mn = Math.min(...g), mx = Math.max(...g)
    if (mn > 0) ratios.push(mx / mn)
  }
  const med = median(ratios)
  assert.ok(med > 5, '倍差中位数只有 ' + med.toFixed(1) + '，看起来还是等分的')
})

test('间隔不规律：同一配置连跑两次，间隔序列不同', () => {
  const a = gapsOf(spreadSlots(both, 10).times).join(',')
  const b = gapsOf(spreadSlots(both, 10).times).join(',')
  assert.notEqual(a, b, '两次排出完全一样的间隔 —— 说明有固定模式')
})

test('间隔不规律：至少有一轮里出现「很短」和「很长」并存的组合', () => {
  // 真人节奏：有时连着看、有时隔很久。只要有一轮出现就该有。
  let seen = 0
  for (let i = 0; i < 30; i++) {
    const g = gapsOf(spreadSlots(both, 10).times)
    if (Math.min(...g) <= 10 && Math.max(...g) >= 120) seen++
  }
  assert.ok(seen > 0, '30 轮里一次都没出现「10 分钟内 + 2 小时以上」的并存组合')
})

test('起点不是固定的：30 轮里第一个点不止一个取值', () => {
  const firsts = new Set()
  for (let i = 0; i < 30; i++) firsts.add(spreadSlots(both, 10).times[0])
  assert.ok(firsts.size > 1, '每轮都从同一个时刻开始 —— 太规律了')
})

test('不会排到同一分钟（tick 按顺序消费，重复会连开两轮）', () => {
  for (let i = 0; i < 20; i++) {
    const t = spreadSlots(both, 20).times
    assert.equal(new Set(t).size, t.length, '出现了重复时间点')
  }
})

test('仍然严格升序', () => {
  for (let i = 0; i < 20; i++) {
    const t = spreadSlots(both, 20).times
    for (let j = 1; j < t.length; j++) assert.ok(t[j] > t[j - 1])
  }
})

test('条数不变：要几条还是几条', () => {
  for (const n of [1, 3, 5, 10, 20]) {
    assert.equal(spreadSlots(both, n).times.length, n, n + ' 条没排满')
  }
})
