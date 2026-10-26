import test from 'node:test'
import assert from 'node:assert/strict'

import { createToolRegistry } from '../lib/tool-registry.mjs'

function makeRegistry(overrides = {}) {
  const registered = []
  const calls = []
  const config = {
    autoComment: false,
    mentionName: '',
    dmMode: 'off',
    ...overrides.config,
  }
  const ctx = {
    tools: { register: (spec) => { registered.push(spec); return spec } },
    get: overrides.get || (() => undefined),
  }
  const registry = createToolRegistry({
    registerTool: ctx.tools.register,
    getHost: ctx.get,
    defineTool: (spec) => spec,
    stateDir: '/tmp/bili-duty',
    outDir: '/tmp/bili-duty/out',
    getConfig: () => config,
    refreshConfig: overrides.refreshConfig || (() => {}),
    persistConfig: async (patch) => ({ host: patch, next: { ...config, ...patch } }),
    hasCredential: () => false,
    call: async (name, args) => { calls.push({ kind: 'call', name, args }); return overrides.callResult ?? { ok: true } },
    callRaw: async (name, args) => {
      calls.push({ kind: 'callRaw', name, args })
      return overrides.callRawResult ?? { json: { ok: true }, images: [] }
    },
    dutyRunner: {
      dshCliCached: () => '',
      runDuty: () => ({ started: true }),
    },
    installManager: {
      runInstall: () => ({ started: true }),
      venvReadyNow: () => false,
    },
    reports: {
      readState: () => ({}),
      countPickedToday: () => 0,
    },
    windows: { noon: { label: '中午', start: '12:00', end: '14:00' } },
    dayKey: () => '2026-10-24',
    inWindow: () => false,
    loginStart: async () => ({ key: 'key', url: 'url' }),
    loginPoll: async () => ({ state: 'waiting' }),
    saveCredential: () => '/tmp/bili-duty/bili_credential.json',
    renderQrPng: async () => '',
    log: () => {},
  })
  return { registry, registered, calls, config }
}

function byName(registered, name) {
  const spec = registered.find((item) => item.name === name)
  assert.ok(spec, `missing tool ${name}`)
  return spec
}

test('tool registry exposes the complete thirteen-tool contract', () => {
  const { registry, registered } = makeRegistry()
  const expected = [
    'bili_whoami', 'bili_search', 'bili_subtitle', 'bili_comments',
    'bili_cover', 'bili_frames', 'bili_reply', 'bili_status', 'bili_run',
    'bili_login_start', 'bili_login_poll', 'bili_setup', 'bili_config',
  ]
  assert.deepEqual(registry.names, expected)
  assert.deepEqual(registered.map((item) => item.name), expected)
})

test('search clamps count and stringifies the keyword', async () => {
  const { registered, calls } = makeRegistry()
  await byName(registered, 'bili_search').execute({ keyword: 123, num: 999, order: 'click' })
  assert.deepEqual(calls.at(-1), {
    kind: 'call',
    name: 'bili_search',
    args: { keyword: '123', num: 50, order: 'click' },
  })
})

test('dm-only blocks public replies unless force is explicit', async () => {
  const { registered, calls } = makeRegistry({ config: { dmMode: 'only', autoComment: true, mentionName: '本人' } })
  const reply = byName(registered, 'bili_reply')
  const blocked = await reply.execute({ bvid: 'BV1x', text: 'hello' })
  assert.equal(blocked.blocked, true)
  assert.equal(calls.length, 0)
  await reply.execute({ bvid: 'BV1x', text: 'hello', force: true })
  assert.equal(calls.at(-1).name, 'bili_reply')
})

test('safeJson degrades circular MCP results to a string', async () => {
  const circular = {}
  circular.self = circular
  const { registered } = makeRegistry({ callResult: circular })
  const result = await byName(registered, 'bili_search').execute({ keyword: 'x' })
  assert.equal(typeof result, 'string')
  assert.ok(result.length > 0)
})

test('image tools degrade cleanly when host image services are unavailable', async () => {
  const { registered } = makeRegistry({
    callRawResult: { json: { ok: true }, images: [{ data: 'AA==', mimeType: 'image/png' }] },
  })
  const result = await byName(registered, 'bili_cover').execute({ bvid: 'BV1x' })
  assert.equal(result.ok, true)
  assert.equal(result.image_attached, false)
  assert.equal(result.image_skip_reason, 'attachments')
})

