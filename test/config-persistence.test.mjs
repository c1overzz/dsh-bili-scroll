import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

function fixture(t, { user: initial = {}, saved = {}, available = true } = {}) {
  const prefix = join(process.env.DSH_TEST_TMP || tmpdir(), 'bili-settings-')
  const home = mkdtempSync(prefix)
  const state = join(home, 'bili-duty')
  mkdirSync(state)
  writeFileSync(join(state, 'config.json'), JSON.stringify(saved))
  t.after(() => {
    assert.ok(resolve(home).startsWith(resolve(prefix)))
    rmSync(home, { recursive: true, force: true })
  })
  const defaults = { perDay: 5, mentionName: '', replyToComments: false, overlayMcp: true,
    keywords: [], workspace: '', peakValley: false, dmMode: 'off', dmUid: 0, pythonPath: 'python' }
  let user = { ...initial }, revision = 0, active = available, handler
  let clock = 10000
  t.mock.method(Date, 'now', () => clock)
  const snapshot = () => ({ ...defaults, ...user })
  const ctx = {
    get: () => (...parts) => join(home, ...parts),
    logger: { info() {} },
    tools: { register: tool => tool },
    settings: {
      describe: () => active ? [{ ns: 'bili-scroll', value: snapshot(), user: { ...user }, revision }] : [],
      update: async (_ns, patch, expected) => {
        assert.equal(expected, revision)
        user = { ...user, ...patch }
        revision++
      },
    },
    webServer: { register: route => { handler = route.handler; return { dispose() {} } } },
    // Never schedule browsing, spawn MCP, or publish messages in these tests.
    effect: (fn, label = '') => label.includes('/api/bili-duty') ? fn() : undefined,
  }
  const mount = () => {
    const start = snapshot()
    // Like a loader configuration, this object can be frozen and replaced
    // after a settings write. The original apply() argument is not authoritative.
    const refs = Object.freeze(Object.fromEntries(Object.entries(start).map(([k, value]) => [k, { get: () => value }])))
    apply(ctx, refs)
  }
  mount()
  return {
    mount,
    setAvailable(value) { active = value },
    nativeEdit(patch) { user = { ...user, ...patch }; revision++ },
    expireCache() { clock += 3100 },
    readFile: () => JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')),
    async request(method, body) {
      const req = Object.assign(new EventEmitter(), { method, url: '/api/bili-duty/config' })
      let result
      const pending = handler(req, {
        writeHead: code => assert.equal(code, 200),
        end: text => { result = JSON.parse(text) },
      })
      if (method === 'POST') { req.emit('data', JSON.stringify(body)); req.emit('end') }
      await pending
      return result
    },
  }
}

test('reads native saved values instead of volatile objects or stale apply snapshots', async t => {
  const desired = { keywords: ['AI', 'example'], workspace: 'example-workspace', peakValley: true, dmMode: 'only', dmUid: 42 }
  const f = fixture(t, { user: desired })
  let result = await f.request('GET')
  for (const [key, value] of Object.entries(desired)) assert.deepEqual(result.config[key], value)
  f.nativeEdit({ keywords: ['changed natively'], workspace: '' })
  f.expireCache()
  result = await f.request('GET')
  assert.deepEqual(result.config.keywords, ['changed natively'])
  assert.equal(result.config.workspace, '')
})

test('save, immediate reread, another edit, cache expiry and reload retain values', async t => {
  const f = fixture(t, { user: { keywords: ['old'], workspace: 'old', perDay: 3 } })
  const desired = { keywords: ['AI', 'example'], workspace: 'example-workspace', dmMode: 'only', dmUid: 42 }
  assert.equal((await f.request('POST', desired)).host.ok, true)
  assert.deepEqual((await f.request('GET')).config.keywords, desired.keywords)
  assert.equal((await f.request('POST', { perDay: 7 })).host.ok, true)
  f.expireCache()
  for (const config of [(await f.request('GET')).config, f.readFile()]) {
    for (const [key, value] of Object.entries(desired)) assert.deepEqual(config[key], value)
    assert.equal(config.perDay, 7)
  }
  f.mount()
  assert.deepEqual((await f.request('GET')).config.keywords, desired.keywords)
  assert.equal((await f.request('POST', { keywords: [], workspace: '' })).host.ok, true)
  assert.deepEqual((await f.request('GET')).config.keywords, [])
  assert.equal((await f.request('GET')).config.workspace, '')
})

test('a missing startup form is not cached once the plugin becomes active', async t => {
  const f = fixture(t, { available: false })
  f.setAvailable(true)
  const result = await f.request('POST', { keywords: ['first edit'] })
  assert.equal(result.host.ok, true)
  assert.deepEqual((await f.request('GET')).config.keywords, ['first edit'])
})

test('without a native settings form, local settings still survive reload', async t => {
  const f = fixture(t, { available: false })
  const result = await f.request('POST', { keywords: ['local only'], workspace: 'local-workspace' })
  assert.equal(result.host.ok, false)
  f.mount()
  assert.deepEqual((await f.request('GET')).config.keywords, ['local only'])
  assert.equal((await f.request('GET')).config.workspace, 'local-workspace')
})

test('keeps the installed Python path and existing read-side limits', async t => {
  const f = fixture(t, { user: { pythonPath: 'python', perDay: 100 }, saved: { pythonPath: 'venv-python' } })
  const result = await f.request('GET')
  assert.equal(result.config.pythonPath, 'venv-python')
  assert.equal(result.config.perDay, 50)
})
