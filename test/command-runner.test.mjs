import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createCommandRunner } from '../lib/command-runner.mjs'

const child = ({ once = true } = {}) => {
  const value = new EventEmitter()
  value.stdout = new EventEmitter()
  value.stderr = new EventEmitter()
  if (!once) value.once = undefined
  value.killCount = 0
  value.kill = () => { value.killCount++ }
  return value
}

test('captures output and resolves a normal exit once', async () => {
  let current
  const runner = createCommandRunner({ spawn: () => {
    current = child()
    queueMicrotask(() => {
      current.stdout.emit('data', 'out')
      current.stderr.emit('data', 'err')
      current.emit('exit', 0, null)
      current.emit('error', new Error('late error'))
    })
    return current
  } })
  const result = await runner.run('demo', ['--ok'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'out')
  assert.equal(result.stderr, 'err')
  assert.equal(result.error, undefined)
})

test('converts synchronous spawn failures and error events into results', async () => {
  const thrown = createCommandRunner({ spawn: () => { throw new Error('missing') } })
  const first = await thrown.run('missing')
  assert.equal(first.code, null)
  assert.match(first.error.message, /missing/)

  const emitted = createCommandRunner({ spawn: () => {
    const value = child()
    queueMicrotask(() => value.emit('error', new Error('broken')))
    return value
  } })
  const second = await emitted.run('broken')
  assert.equal(second.code, 1)
  assert.match(second.error.message, /broken/)
})

test('times out and aborts without waiting for a later exit event', async () => {
  let current
  const runner = createCommandRunner({ spawn: () => {
    current = child()
    return current
  } })
  const result = await runner.run('slow', [], { timeoutMs: 10 })
  assert.equal(result.timedOut, true)
  assert.equal(result.code, null)
  assert.equal(current.killCount, 1)
  current.emit('exit', 0)
})

test('already-aborted signals do not spawn, and abort kills a running child', async () => {
  const already = new AbortController()
  already.abort()
  let spawned = false
  const runner = createCommandRunner({ spawn: () => { spawned = true; return child() } })
  const skipped = await runner.run('skip', [], { signal: already.signal })
  assert.equal(spawned, false)
  assert.match(skipped.error.message, /取消/)

  let current
  const active = createCommandRunner({ spawn: () => { current = child(); return current } })
  const controller = new AbortController()
  const pending = active.run('abort', [], { signal: controller.signal })
  controller.abort()
  const result = await pending
  assert.match(result.error.message, /取消/)
  assert.equal(current.killCount, 1)
})

test('supports event emitters without once and ignores sink failures', async () => {
  const runner = createCommandRunner({ spawn: () => {
    const value = child({ once: false })
    queueMicrotask(() => value.emit('exit', 3))
    return value
  } })
  const result = await runner.run('legacy', [], {
    onStdout: () => { throw new Error('sink') },
  })
  assert.equal(result.code, 3)
})
