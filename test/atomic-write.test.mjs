import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeJsonAtomic } from '../lib/atomic-write.mjs'

test('writeJsonAtomic leaves a complete document and no temp file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bili-duty-atomic-'))
  const file = join(dir, 'state.json')
  writeJsonAtomic(file, { day: '2026-10-25', picked: 3 })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { day: '2026-10-25', picked: 3 })
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(dir), ['state.json'])
})

test('writeJsonAtomic removes a temporary file when rename fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bili-duty-atomic-fail-'))
  const file = join(dir, 'state.json')
  assert.throws(() => writeJsonAtomic(file, { ok: true }, {
    rename() { throw new Error('disk full') },
  }), /disk full/)
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(dir), [])
})

test('writeJsonAtomic falls back to replacing an existing target on Windows-style rename errors', async () => {
  const calls = []
  writeJsonAtomic('/tmp/state.json', { ok: true }, {
    makeDir() {},
    writeFile(file) { calls.push(['write', file]) },
    rename(file, target) {
      calls.push(['rename', file, target])
      if (calls.filter(([kind]) => kind === 'rename').length === 1) {
        const error = new Error('exists')
        error.code = 'EEXIST'
        throw error
      }
    },
    remove(file) { calls.push(['remove', file]) },
  })
  assert.equal(calls.filter(([kind]) => kind === 'rename').length, 2)
  assert.equal(calls.some(([kind]) => kind === 'remove'), true)
})
