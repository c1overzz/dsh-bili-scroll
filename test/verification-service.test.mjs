import test from 'node:test'
import assert from 'node:assert/strict'

import { createVerificationService } from '../lib/verification-service.mjs'

test('verification service serializes checks and mirrors results to reports', async () => {
  let release
  const logs = []
  const service = createVerificationService({
    stateDir: '/tmp/bili-duty',
    verifyRecent: async (_stateDir, { log }) => {
      log('checking')
      await new Promise((resolve) => { release = resolve })
      return { checked: ['BV1'], skipped: [], text: 'ok' }
    },
    appendVerifyToReport: () => '/tmp/bili-duty/out/today.md',
    log: (line) => logs.push(line),
  })
  const pending = service.runVerify('manual')
  assert.equal(service.isVerifying(), true)
  assert.deepEqual(await service.runVerify('again'), { ok: false, error: '上一次复核还没跑完，等它完事' })
  release()
  const result = await pending
  assert.equal(result.report, '/tmp/bili-duty/out/today.md')
  assert.equal(service.isVerifying(), false)
  assert.match(logs.join('\n'), /checking/)
})

test('verification service aborts an in-flight check during host disposal', async () => {
  let signal
  let release
  const service = createVerificationService({
    stateDir: '/tmp/bili-duty',
    verifyRecent: async (_stateDir, options) => {
      signal = options.signal
      await new Promise((resolve) => { release = resolve })
      if (signal.aborted) throw new Error('评论复核已取消')
      return { checked: [], skipped: 0, text: '' }
    },
    appendVerifyToReport: () => null,
  })
  const pending = service.runVerify('round')
  for (let i = 0; i < 20 && !signal; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(service.stop(), true)
  release()
  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /取消/)
  assert.equal(service.isVerifying(), false)
})
