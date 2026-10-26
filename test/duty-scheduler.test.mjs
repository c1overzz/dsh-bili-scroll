import test from 'node:test'
import assert from 'node:assert/strict'

import { createDutyScheduler } from '../lib/duty-scheduler.mjs'

function make(overrides = {}) {
  const calls = []
  const scheduler = createDutyScheduler({
    getConfig: () => ({ peakValley: true, noon: true, night: true, perDay: 5, reportLevel: 'full' }),
    windows: { noon: { id: 'noon' }, night: { id: 'night' } },
    inWindow: (now, window) => window.id === 'noon',
    dayKey: () => '2026-10-24',
    readState: () => ({ windows: {} }),
    bumpState: (patch) => calls.push(['bump', patch]),
    countPickedToday: () => 0,
    roundsToday: () => 0,
    runDuty: (why) => { calls.push(['run', why]); return { started: true, why } },
    refreshConfig: () => calls.push(['refresh']),
    log: (line) => calls.push(['log', line]),
    ...overrides,
  })
  return { scheduler, calls }
}

test('scheduler commits a window only after its round starts', () => {
  const { scheduler, calls } = make()
  const result = scheduler.tick()
  assert.equal(result.started, true)
  assert.equal(calls[0][0], 'refresh')
  assert.equal(calls[1][0], 'run')
  assert.equal(calls[1][1], 'window:noon')
  assert.equal(calls[2][0], 'bump')
  assert.deepEqual(calls[2][1].windows, { '2026-10-24:noon': true })
  assert.equal(calls[2][1].count, 1)
  assert.equal(calls[2][1].lastWhy, 'noon')
})

test('scheduler reserves a started window when state persistence fails', () => {
  let runs = 0
  let bumps = 0
  const { scheduler } = make({
    runDuty: () => { runs++; return { started: true } },
    bumpState: () => { bumps++; throw new Error('read-only home') },
  })

  const first = scheduler.tick()
  const second = scheduler.tick()
  assert.equal(first.started, true)
  assert.equal(first.statePersisted, false)
  assert.equal(second.reason, 'outside-window')
  assert.equal(runs, 1)
  assert.equal(bumps, 1)
})

test('scheduler does not consume a window when the round cannot start', () => {
  const { scheduler, calls } = make({
    runDuty: (why) => { calls.push(['run', why]); return { started: false, busy: true, error: '上一轮还没结束' } },
  })
  const result = scheduler.tick()
  assert.deepEqual(result, {
    started: false,
    why: 'window:noon',
    reason: 'busy',
    result: { started: false, busy: true, error: '上一轮还没结束' },
  })
  assert.equal(calls.some(([kind]) => kind === 'bump'), false)
})

test('scheduler respects disabled, quota and report-off gates', () => {
  const disabled = make({ getConfig: () => ({ peakValley: false }) })
  assert.deepEqual(disabled.scheduler.tick(), { started: false, reason: 'disabled' })

  const quota = make({ getConfig: () => ({ peakValley: true, perDay: 1 }), countPickedToday: () => 1 })
  assert.deepEqual(quota.scheduler.tick(), { started: false, reason: 'quota' })

  const reportOff = make({
    getConfig: () => ({ peakValley: true, perDay: 5, reportLevel: 'off' }),
    roundsToday: () => 1,
  })
  assert.deepEqual(reportOff.scheduler.tick(), { started: false, reason: 'report-off-round-limit' })
})

test('scheduler catches callback failures instead of leaking to the host', () => {
  const logs = []
  const { scheduler } = make({
    readState: () => { throw new Error('broken state') },
    log: (line) => logs.push(line),
  })
  const result = scheduler.tick()
  assert.equal(result.reason, 'error')
  assert.match(logs[0], /broken state/)
})

test('scheduler warms a nickname recipient before an automatic private round', async () => {
  let resolveWarmup
  let runs = 0
  let resolvedUid = 0
  const { scheduler } = make({
    getConfig: () => ({ peakValley: true, noon: true, night: true, perDay: 5, reportLevel: 'full', dmMode: 'only', dmUid: 0, mentionName: '我' }),
    getDmUid: () => resolvedUid,
    warmUid: () => new Promise((resolve) => {
      resolveWarmup = (value) => { resolvedUid = value; resolve(value) }
    }),
    runDuty: () => { runs++; return { started: true } },
  })

  assert.equal(scheduler.tick().reason, 'warming-recipient')
  assert.equal(runs, 0)
  resolveWarmup(42)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scheduler.tick().started, true)
})

test('scheduler proceeds fail-closed after an unsuccessful recipient warmup', async () => {
  let resolveWarmup
  let runs = 0
  const { scheduler } = make({
    getConfig: () => ({ peakValley: true, noon: true, night: true, perDay: 5, reportLevel: 'full', dmMode: 'only', dmUid: 0, mentionName: '查不到的人' }),
    getDmUid: () => 0,
    warmUid: () => new Promise((resolve) => { resolveWarmup = resolve }),
    runDuty: () => { runs++; return { started: true } },
  })

  assert.equal(scheduler.tick().reason, 'warming-recipient')
  resolveWarmup(0)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scheduler.tick().started, true)
  assert.equal(runs, 1)
})

test('scheduler also warms the private side of a both-mode round', async () => {
  let resolved = 0
  const { scheduler } = make({
    getConfig: () => ({ peakValley: true, noon: true, night: true, perDay: 5, reportLevel: 'full', dmMode: 'both', dmUid: 0, mentionName: '我' }),
    getDmUid: () => resolved,
    warmUid: async () => { resolved = 7; return resolved },
  })
  assert.equal(scheduler.tick().reason, 'warming-recipient')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scheduler.tick().started, true)
})

