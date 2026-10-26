import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchWithTimeout, timeoutSignal } from '../lib/net.mjs'

test('timeoutSignal composes a parent cancellation with its own deadline', () => {
  const parent = new AbortController()
  const signal = timeoutSignal(parent.signal, 1_000)

  assert.equal(signal.aborted, false)
  parent.abort('host stopped')
  assert.equal(signal.aborted, true)
  assert.equal(signal.reason, 'host stopped')
})

test('timeoutSignal keeps an already-aborted parent signal intact', () => {
  const parent = new AbortController()
  parent.abort('already stopped')

  assert.equal(timeoutSignal(parent.signal, 1_000), parent.signal)
})

test('fetchWithTimeout forwards request options and aborts on timeout', async () => {
  let received
  const result = await fetchWithTimeout(async (_url, options) => {
    received = options
    await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
    return { ok: true }
  }, 'https://example.test/resource', { headers: { 'x-test': 'yes' } }, 10)

  assert.equal(result.ok, true)
  assert.deepEqual(received.headers, { 'x-test': 'yes' })
  assert.equal(received.signal.aborted, true)
  assert.equal(received.signal.reason?.name, 'TimeoutError')
})

test('fetchWithTimeout respects caller cancellation before the deadline', async () => {
  const parent = new AbortController()
  let received
  const pending = fetchWithTimeout(async (_url, options) => {
    received = options
    await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
    return { ok: false }
  }, 'https://example.test/resource', { signal: parent.signal }, 1_000)

  parent.abort('request superseded')
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(received.signal.aborted, true)
  assert.equal(received.signal.reason, 'request superseded')
})

test('fetchWithTimeout rejects a missing fetch implementation early', async () => {
  await assert.rejects(
    () => fetchWithTimeout(null, 'https://example.test/resource'),
    /requires fetchImpl\(\)/,
  )
})
