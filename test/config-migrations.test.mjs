import test from 'node:test'
import assert from 'node:assert/strict'

import { createConfigMigrations } from '../lib/config-migrations.mjs'

test('migration updates only the old interval defaults and writes a marker', async () => {
  const writes = []
  const patches = []
  const migration = createConfigMigrations({
    stateDir: '/tmp/bili-duty',
    readJson: (file, fallback) => file.endsWith('config.json') ? { dmWatchMinutes: 5, dmReplyPerDay: 3 } : fallback,
    markerExists: () => false,
    writeMarker: (...args) => writes.push(args),
    persistConfig: async (patch) => { patches.push(patch) },
    now: () => 123,
  })
  assert.equal(migration.migrate200(), true)
  await Promise.resolve()
  assert.deepEqual(patches, [{ dmWatchMinutes: 1, dmReplyPerDay: 0 }])
  assert.deepEqual(writes, [['/tmp/bili-duty/.mig-2.0.0', '123']])
})

test('migration preserves explicit values and does not rerun', () => {
  let persisted = false
  const migration = createConfigMigrations({
    stateDir: '/tmp/bili-duty',
    readJson: () => ({ dmWatchMinutes: 1, dmReplyPerDay: 0 }),
    markerExists: () => true,
    writeMarker: () => {},
    persistConfig: async () => { persisted = true },
  })
  assert.equal(migration.migrate200(), false)
  assert.equal(persisted, false)
})
