import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRunLock } from '../lib/run-lock.mjs'

async function lockFile() {
  const dir = await mkdtemp(join(tmpdir(), 'bili-duty-lock-'))
  return join(dir, 'run-lock.json')
}

test('run lock admits one host at a time and releases only its own entry', async () => {
  const file = await lockFile()
  const first = createRunLock({ file, pid: 101, token: 'first', isPidAlive: () => true })
  const second = createRunLock({ file, pid: 202, token: 'second', isPidAlive: () => true })

  assert.equal(first.acquire('manual').acquired, true)
  assert.deepEqual(second.acquire('scheduled'), { acquired: false, busy: true })
  assert.equal(first.release(), true)
  assert.equal(second.acquire('scheduled').acquired, true)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).token, 'second')
  assert.equal(second.release(), true)
})

test('run lock replaces expired owners and fails open on unwritable storage', async () => {
  const file = await lockFile()
  await writeFile(file, JSON.stringify({ pid: 101, ts: 100, token: 'stale' }), 'utf8')
  const lock = createRunLock({
    file,
    pid: 202,
    token: 'fresh',
    now: () => 10_000,
    ttlMs: 1000,
    isPidAlive: (pid) => pid === 202,
  })
  assert.equal(lock.acquire().acquired, true)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).token, 'fresh')
  lock.release()

  const logs = []
  const failOpen = createRunLock({ file: join(file, 'missing', 'lock.json'), log: (line) => logs.push(line) })
  assert.deepEqual(failOpen.acquire(), { acquired: true, failOpen: true })
  assert.equal(failOpen.release(), false)
  assert.match(logs.join('\n'), /读写失败（这一轮照跑）/)
})

test('two contenders cannot both reap the same expired lock', async () => {
  const file = await lockFile()
  await writeFile(file, JSON.stringify({ pid: 101, ts: 100, token: 'stale' }), 'utf8')
  const contenders = ['a', 'b'].map((token) => createRunLock({
    file,
    pid: token === 'a' ? 201 : 202,
    token,
    now: () => 10_000,
    ttlMs: 1000,
    isPidAlive: (pid) => pid === 201 || pid === 202,
  }))
  const results = contenders.map((lock) => lock.acquire())
  assert.equal(results.filter((result) => result.acquired).length, 1)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).token, results[0].acquired ? 'a' : 'b')
  for (const lock of contenders) lock.release()
})

test('run lock heartbeat keeps a long-running round lease fresh', async () => {
  const file = await lockFile()
  let at = Date.now()
  let heartbeat = null
  let cleared = false
  const first = createRunLock({
    file,
    pid: 101,
    token: 'long-round',
    now: () => at,
    ttlMs: 1000,
    heartbeatMs: 10,
    isPidAlive: () => true,
    setIntervalFn: (fn) => { heartbeat = fn; return { unref() {} } },
    clearIntervalFn: () => { cleared = true },
  })
  assert.equal(first.acquire().acquired, true)
  at += 2000
  heartbeat()
  const second = createRunLock({
    file,
    pid: 202,
    token: 'other-host',
    now: () => at,
    ttlMs: 1000,
    isPidAlive: () => true,
  })
  assert.deepEqual(second.acquire(), { acquired: false, busy: true })
  first.release()
  assert.equal(cleared, true)
})

test('run lock treats permission-denied PID probes as a live owner', async () => {
  const file = await lockFile()
  await writeFile(file, JSON.stringify({ pid: 101, ts: Date.now(), token: 'protected' }), 'utf8')
  const lock = createRunLock({
    file,
    pid: 202,
    token: 'other',
    isPidAlive: () => { const error = new Error('permission denied'); error.code = 'EPERM'; throw error },
  })
  assert.deepEqual(lock.acquire(), { acquired: false, busy: true })
})

test('run lock preserves a fresh owner when its PID probe cannot determine liveness', async () => {
  const file = await lockFile()
  await writeFile(file, JSON.stringify({ pid: 101, ts: Date.now(), token: 'unknown' }), 'utf8')
  const lock = createRunLock({
    file,
    pid: 202,
    token: 'other',
    isPidAlive: () => { throw new Error('probe unavailable') },
  })
  assert.deepEqual(lock.acquire(), { acquired: false, busy: true })
})

test('run lock reaps an owner whose PID probe explicitly reports ESRCH', async () => {
  const file = await lockFile()
  await writeFile(file, JSON.stringify({ pid: 101, ts: Date.now(), token: 'gone' }), 'utf8')
  const lock = createRunLock({
    file,
    pid: 202,
    token: 'other',
    isPidAlive: () => { const error = new Error('no such process'); error.code = 'ESRCH'; throw error },
  })
  assert.equal(lock.acquire().acquired, true)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).token, 'other')
  lock.release()
})
