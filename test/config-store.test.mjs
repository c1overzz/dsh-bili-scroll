import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONFIG_DEFAULTS } from '../lib/config.mjs'
import { createConfigStore } from '../lib/config-store.mjs'

async function makeStore({ config = {}, describe, update, logs = [] } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bili-duty-config-'))
  const configFile = join(stateDir, 'config.json')
  await writeFile(configFile, JSON.stringify(config, null, 2), 'utf8')

  const store = createConfigStore({
    stateDir,
    settings: describe || update ? { describe, update } : null,
    hostConfig: { ...CONFIG_DEFAULTS, perDay: 2 },
    readJson: (file, fallback) => {
      try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
    },
    writeJson: (file, value) => writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'),
    log: (line) => logs.push(line),
  })
  return { stateDir, store, configFile, logs }
}

test('config store works without a DSH settings service', async () => {
  const { store, configFile } = await makeStore({ config: { perDay: 7 } })

  assert.equal(store.load().perDay, 7)
  const result = await store.persist({ perDay: 999, mentionName: 'Lee' }, store.load())

  assert.equal(result.clean.perDay, 50)
  assert.equal(result.next.perDay, 50)
  assert.equal(result.host.ok, false)
  assert.deepEqual(Object.keys(store.readOverride()).sort(), ['mentionName', 'perDay'])

  const saved = JSON.parse(await readFile(configFile, 'utf8'))
  assert.equal(saved.perDay, 50)
  assert.deepEqual(saved._set.sort(), ['mentionName', 'perDay'])
})

test('local values win over host user values after the plugin has saved them', async () => {
  const row = {
    ns: 'bili-scroll',
    revision: 4,
    value: { ...CONFIG_DEFAULTS, perDay: 3, mentionName: 'host-name' },
    user: { perDay: 3, mentionName: 'host-name' },
  }
  const { store } = await makeStore({
    config: { perDay: 8, _set: ['perDay'] },
    describe: () => [row],
  })

  const loaded = store.load()
  assert.equal(loaded.perDay, 8)
  assert.equal(loaded.mentionName, 'host-name')
})

test('host update failure keeps the local value and reports the mirror failure', async () => {
  const logs = []
  const row = {
    ns: 'bili-scroll',
    revision: 2,
    value: { ...CONFIG_DEFAULTS },
    user: {},
  }
  const { store } = await makeStore({
    describe: () => [row],
    update: async () => { throw new Error('profile reload requires the root Include entry') },
    logs,
  })

  const result = await store.persist({ autoComment: true }, store.load())
  assert.equal(result.next.autoComment, true)
  assert.equal(result.host.ok, false)
  assert.match(result.host.error, /root Include/)
  assert.match(logs.join('\n'), /以插件自己的值为准/)
  assert.equal(store.load().autoComment, true)
})

test('revision failures retry with a fresh settings description', async () => {
  let describeCalls = 0
  let updateCalls = 0
  const row = {
    ns: 'bili-scroll',
    revision: 1,
    value: { ...CONFIG_DEFAULTS },
    user: {},
  }
  const { store } = await makeStore({
    describe: () => {
      describeCalls++
      return [{ ...row, revision: describeCalls }]
    },
    update: async (_ns, patch, revision) => {
      updateCalls++
      if (updateCalls === 1) throw new Error('revision mismatch')
      row.user = { ...row.user, ...patch }
      row.value = { ...row.value, ...patch }
      row.revision = revision
    },
  })

  const result = await store.persist({ perDay: 9 }, store.load())
  assert.equal(result.host.ok, true)
  assert.equal(result.host.retried, true)
  assert.equal(updateCalls, 2)
  assert.ok(describeCalls >= 2)
})

test('successful update with stale readback is reported as a failed mirror', async () => {
  const row = {
    ns: 'bili-scroll',
    revision: 1,
    value: { ...CONFIG_DEFAULTS },
    user: {},
  }
  const { store } = await makeStore({
    describe: () => [{ ...row }],
    update: async () => {},
  })

  const result = await store.persist({ perDay: 9 }, store.load())
  assert.equal(result.host.ok, false)
  assert.match(result.host.error, /写入没生效/)
  assert.equal(store.load().perDay, 9)
})

test('successful host mirrors clear the unsynced override ledger', async () => {
  const row = {
    ns: 'bili-scroll',
    revision: 1,
    value: { ...CONFIG_DEFAULTS },
    user: {},
  }
  let updates = 0
  const { store } = await makeStore({
    describe: () => [{ ...row }],
    update: async (_ns, patch) => {
      updates++
      if (updates <= 2) throw new Error('host unavailable')
      row.user = { ...row.user, ...patch }
      row.value = { ...row.value, ...patch }
    },
  })

  await store.persist({ perDay: 8 }, store.load())
  assert.deepEqual(Object.keys(store.readOverride()), ['perDay'])

  const result = await store.persist({ perDay: 9 }, store.load())
  assert.equal(result.host.ok, true)
  assert.deepEqual(Object.keys(store.readOverride()), [])
})
