import test from 'node:test'
import assert from 'node:assert/strict'

import { createRoundFinalizer } from '../lib/round-finalizer.mjs'

function make(overrides = {}) {
  const calls = []
  const reports = overrides.reports || {
    stubReportIfMissing: (...args) => calls.push(['stub', ...args]),
  }
  const favorites = overrides.favorites || {
    favToday: async (...args) => calls.push(['fav', ...args]),
  }
  const finalizer = createRoundFinalizer({
    reports,
    favorites,
    getConfig: () => ({ favFolderId: 9, perDay: 5 }),
    dayKey: () => '2026-10-24',
    readState: () => ({ day: '2026-10-24', picked: 1 }),
    countPickedToday: () => 2,
    bumpState: (patch) => calls.push(['bump', patch]),
    rotateLog: () => calls.push(['rotate']),
    runVerify: async (...args) => calls.push(['verify', ...args]),
    schedule: (fn) => { calls.push(['schedule']); return { unref() {} } },
    reportLogFile: '/tmp/bili-duty/duty.log',
    log: (line) => calls.push(['log', line]),
    ...overrides,
  })
  return { finalizer, calls }
}

test('finalizer performs bookkeeping, favorites and delayed verification', async () => {
  const { finalizer, calls } = make()
  const result = finalizer.finalize({ code: 0, why: 'manual' })
  assert.deepEqual(result, { ok: true, why: 'manual' })
  assert.deepEqual(calls.slice(0, 6), [
    ['stub', 0, '/tmp/bili-duty/duty.log'],
    ['fav', 'auto'],
    ['rotate'],
    ['bump', { picked: 2 }],
    ['log', '今天挑到 2 条（上限 5 条）'],
    ['schedule'],
  ])
  assert.match(calls.at(-1)[1], /收尾完成（manual）/)
})

test('finalizer does not favorite failed rounds', () => {
  const { finalizer, calls } = make()
  finalizer.finalize({ code: 1, why: 'window:noon' })
  assert.equal(calls.some(([kind]) => kind === 'fav'), false)
  assert.equal(calls.some(([kind]) => kind === 'stub'), true)
})

test('stopping finalizer cancels delayed verification', async () => {
  const calls = []
  let scheduled
  const { finalizer } = make({
    schedule: (fn) => { scheduled = fn; return { unref() {} } },
    clearSchedule: () => calls.push(['clear']),
    runVerify: async () => calls.push(['verify']),
  })
  finalizer.finalize({ code: 0, why: 'manual' })
  assert.equal(finalizer.isPending(), true)
  assert.equal(finalizer.stop(), true)
  scheduled()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [['clear']])
  assert.equal(finalizer.isPending(), false)
})

test('stopping during bookkeeping does not create a stale verification timer', () => {
  let finalizer
  let scheduled = 0
  const calls = []
  finalizer = createRoundFinalizer({
    reports: {
      stubReportIfMissing: () => { finalizer.stop() },
    },
    favorites: { favToday: async () => {} },
    getConfig: () => ({ favFolderId: 0 }),
    dayKey: () => '2026-10-24',
    schedule: () => { scheduled++; return { unref() {} } },
    clearSchedule: () => calls.push('clear'),
  })

  const result = finalizer.finalize({ code: 1, why: 'dispose-race' })
  assert.deepEqual(result, { ok: true, why: 'dispose-race', stopped: true })
  assert.equal(scheduled, 0)
  assert.equal(finalizer.isPending(), false)
  assert.deepEqual(calls, [])
})

