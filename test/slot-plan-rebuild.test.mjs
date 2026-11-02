/**
 * test/slot-plan-rebuild.test.mjs —— 「改了开关/条数，当天的计划会重排吗」。
 *
 * 用户的原话：「不要我没开这个时间段跑他还跑了」。
 * 反面同样要治：**我开了，它却还是按没开时排的计划跑 0 个点**。
 *
 * 这里 import 的是 lib/slot-plan.mjs —— 宿主用的就是这一份，不是仿制品。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { planSignature, planReusable, carryRanSlots } from '../lib/slot-plan.mjs'

const T = (hh, mm = 0) => Date.UTC(2026, 9, 30, hh, mm, 0)

test('指纹跟着条数和窗口开关变', () => {
  const a = planSignature({ perDay: 5, noon: true, night: false })
  const b = planSignature({ perDay: 10, noon: true, night: false })
  const c = planSignature({ perDay: 5, noon: true, night: true })
  assert.notEqual(a, b, '条数变了，指纹应该变')
  assert.notEqual(a, c, '夜间打开了，指纹应该变')
  assert.equal(a, planSignature({ perDay: 5, noon: true, night: false }), '同配置指纹应该稳定')
})

test('指纹里的条数被钳到 1–50（跟排点用的口径一致）', () => {
  assert.equal(planSignature({ perDay: 0 }), '1|00', 'perDay=0 排点时按 1 算')
  assert.equal(planSignature({ perDay: 999 }), '50|00', 'perDay=999 排点时按 50 算')
  assert.equal(planSignature({ perDay: -3 }), '1|00')
  // 0 和 1 在排点口径上是同一个（都按 1 条），所以指纹相同是对的
  assert.equal(planSignature({ perDay: 0 }), planSignature({ perDay: 1 }))
})

test('两个窗口都关时排出的空计划，开了窗口之后不能再用', () => {
  const emptyPlan = { day: '2026-10-30', times: [], done: [], wanted: 5, sig: planSignature({ perDay: 5, noon: false, night: false }) }
  // 用户把夜间打开 —— 这时候旧计划必须作废
  const nowSig = planSignature({ perDay: 5, noon: false, night: true })
  assert.equal(planReusable(emptyPlan, '2026-10-30', nowSig), false,
    '空计划在打开窗口后还被复用 ⇒ 当天一个点都不会跑')
})

test('条数改了也要重排', () => {
  const plan = { day: '2026-10-30', times: [T(19)], done: [false], wanted: 5, sig: planSignature({ perDay: 5, noon: true, night: true }) }
  const nowSig = planSignature({ perDay: 10, noon: true, night: true })
  assert.equal(planReusable(plan, '2026-10-30', nowSig), false, '条数 5→10 应该重排')
  assert.equal(planReusable(plan, '2026-10-30', planSignature({ perDay: 5, noon: true, night: true })), true, '配置没变就该复用')
})

test('跨天一定重排（哪怕配置一模一样）', () => {
  const plan = { day: '2026-10-29', times: [T(19)], done: [true], wanted: 5, sig: planSignature({ perDay: 5, noon: true, night: true }) }
  assert.equal(planReusable(plan, '2026-10-30', plan.sig), false, '昨天的计划不能拿到今天用')
})

test('老计划没有 sig 字段 ⇒ 当作旧口径，重排一次', () => {
  const legacy = { day: '2026-10-30', times: [T(19)], done: [false], wanted: 5 }
  assert.equal(planReusable(legacy, '2026-10-30', planSignature({ perDay: 5, noon: true, night: true })), false,
    '没有 sig 的旧计划必须重排一次（否则新加的判据对它永远不生效）')
})

test('坏数据一律当"不能用"（不炸、也不误用）', () => {
  const sig = planSignature({ perDay: 5, noon: true, night: true })
  assert.equal(planReusable(null, '2026-10-30', sig), false)
  assert.equal(planReusable({}, '2026-10-30', sig), false)
  assert.equal(planReusable({ day: '2026-10-30', times: [1, 2], done: [false] }, '2026-10-30', sig), false, 'times/done 长度不一致')
  assert.equal(planReusable({ day: '2026-10-30', times: 'x', done: [] }, '2026-10-30', sig), false)
})

test('重排时：今天跑过的点不重跑（早于最后跑过的时刻都算已做）', () => {
  const old = {
    day: '2026-10-30',
    times: [T(13), T(15)],       // 13:00 跑过、15:00 没跑（假设都被标了）
    done: [true, true],
    wanted: 5,
  }
  const newTimes = [T(12), T(14), T(16), T(18)]   // 重排出来的新时刻
  const { done, ranTimes } = carryRanSlots(newTimes, old, '2026-10-30')
  assert.deepEqual(ranTimes, [T(13), T(15)])
  // 最后跑过的是 15:00 ⇒ 12:00 / 14:00 都算过去了；16:00 / 18:00 还没到
  assert.deepEqual(done, [true, true, false, false])
})

test('重排时：一个点都没跑过 ⇒ 全部待跑', () => {
  const old = { day: '2026-10-30', times: [T(13)], done: [false], wanted: 5 }
  const newTimes = [T(12), T(14)]
  const { done, ranTimes } = carryRanSlots(newTimes, old, '2026-10-30')
  assert.deepEqual(ranTimes, [])
  assert.deepEqual(done, [false, false])
})

test('重排时：昨天的"跑过"不能带到今天', () => {
  const old = { day: '2026-10-29', times: [T(13)], done: [true], wanted: 5 }
  const newTimes = [T(12), T(20)]
  const { done, ranTimes } = carryRanSlots(newTimes, old, '2026-10-30')
  assert.deepEqual(ranTimes, [], '昨天的记录不该被当成今天的')
  assert.deepEqual(done, [false, false])
})

test('重排时：旧计划是空数组也不炸', () => {
  const { done, ranTimes } = carryRanSlots([T(20)], { day: '2026-10-30', times: [], done: [] }, '2026-10-30')
  assert.deepEqual(ranTimes, [])
  assert.deepEqual(done, [false])
})
