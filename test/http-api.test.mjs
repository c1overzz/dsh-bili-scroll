import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createHttpApi, readBody, sendJson } from '../lib/http-api.mjs'

const request = ({ method = 'GET', url = '/api/bili-duty/status', body = '', headers = {} } = {}) => {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3030', ...headers }
  req.destroyed = false
  req.destroy = () => { req.destroyed = true }
  process.nextTick(() => {
    if (body !== '') req.emit('data', body)
    req.emit('end')
  })
  return req
}

const response = () => ({
  statusCode: 200,
  headers: {},
  body: '',
  writeHead(code, headers) { this.statusCode = code; this.headers = headers },
  end(value = '') { this.body = String(value) },
})

const dispatch = async (api, options) => {
  const res = response()
  await api.dispatch(request(options), res)
  return { res, json: res.body ? JSON.parse(res.body) : null }
}

test('sendJson and readBody handle normal and malformed payloads', async () => {
  const res = response()
  sendJson(res, 202, { ok: true })
  assert.equal(res.statusCode, 202)
  assert.deepEqual(JSON.parse(res.body), { ok: true })

  const parsed = await readBody(request({ method: 'POST', body: '{"x":1}' }))
  assert.deepEqual(parsed, { x: 1 })
  const malformed = await readBody(request({ method: 'POST', body: '{' }))
  assert.deepEqual(malformed, {})
})

test('readBody settles and destroys oversized requests', async () => {
  const req = request({ method: 'POST', body: '1234567890' })
  const parsed = await readBody(req, 4)
  assert.deepEqual(parsed, {})
  assert.equal(req.destroyed, true)
})

test('dispatch enforces same-origin and the DSH trust fence', async () => {
  const api = createHttpApi({
    ctx: null,
    stateDir: '/tmp/bili-duty',
    outDir: '/tmp/bili-duty/out',
    getConfig: () => ({}),
    persistConfig: async () => ({ clean: {}, host: { ok: true } }),
    getStatus: () => ({ ok: true }),
  })
  const external = await dispatch(api, { headers: { host: '127.0.0.1:3030', origin: 'http://evil.example' } })
  assert.equal(external.res.statusCode, 403)
  assert.equal(external.json.ok, false)

  const fenced = createHttpApi({
    ctx: null,
    stateDir: '/tmp/bili-duty',
    outDir: '/tmp/bili-duty/out',
    getConfig: () => ({}),
    persistConfig: async () => ({ clean: {}, host: { ok: true } }),
    getStatus: () => ({ ok: true }),
    getConnection: () => ({ requestRejection: () => 401 }),
  })
  const rejected = await dispatch(fenced, {})
  assert.equal(rejected.res.statusCode, 401)
})

test('config and update routes use injected callbacks and preserve empty values', async () => {
  const calls = []
  const api = createHttpApi({
    ctx: null,
    stateDir: '/tmp/bili-duty',
    outDir: '/tmp/bili-duty/out',
    getConfig: () => ({ mentionName: 'Alice', perDay: 3 }),
    readSavedConfig: () => ({ mentionName: 'Alice' }),
    persistConfig: async (patch) => { calls.push(patch); return { clean: patch, host: { ok: true } } },
    getStatus: () => ({ ok: true }),
    checkUpdate: async () => ({ ok: true, latest: '2.2.0' }),
    upgrade: () => ({ ok: true, started: true }),
  })
  const config = await dispatch(api, { method: 'POST', url: '/api/bili-duty/config', body: JSON.stringify({ mentionName: '' }) })
  assert.deepEqual(calls[0], {})
  assert.equal(config.json.ok, true)
  const update = await dispatch(api, { url: '/api/bili-duty/update' })
  assert.equal(update.json.latest, '2.2.0')
  const upgrade = await dispatch(api, { method: 'POST', url: '/api/bili-duty/upgrade' })
  assert.equal(upgrade.json.started, true)
})

test('login poll saves a successful credential through the host callback', async () => {
  let saved = null
  const api = createHttpApi({
    ctx: null,
    stateDir: '/tmp/bili-duty',
    outDir: '/tmp/bili-duty/out',
    getConfig: () => ({ pythonPath: 'python' }),
    persistConfig: async () => ({ clean: {}, host: { ok: true } }),
    getStatus: () => ({ ok: true }),
    loginPoll: async () => ({ state: 'ok', credential: { sessdata: 'secret' } }),
    saveCredential: (credential) => { saved = credential; return '/tmp/bili-duty/bili_credential.json' },
  })
  const result = await dispatch(api, { method: 'POST', url: '/api/bili-duty/login/poll', body: JSON.stringify({ key: 'k' }) })
  assert.deepEqual(saved, { sessdata: 'secret' })
  assert.equal(result.json.state, 'ok')
})

test('open route passes Windows URLs directly to Explorer', async () => {
  const calls = []
  const api = createHttpApi({
    ctx: null,
    stateDir: 'C:\\Users\\me\\.dsh\\bili-duty',
    outDir: 'C:\\Users\\me\\.dsh\\bili-duty\\out',
    platform: 'win32',
    systemRoot: 'C:\\Windows',
    spawn: (command, args) => {
      calls.push({ command, args })
      const child = new EventEmitter()
      process.nextTick(() => child.emit('error', new Error('test child')))
      return child
    },
    getConfig: () => ({}),
    persistConfig: async () => ({ clean: {}, host: { ok: true } }),
    getStatus: () => ({ ok: true }),
  })
  const result = await dispatch(api, {
    method: 'POST',
    url: '/api/bili-duty/open',
    body: JSON.stringify({ what: 'url', u: 'https://example.test/a?x=1&y=2' }),
  })
  assert.equal(result.json.ok, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].command, /(?:^|[\\/])explorer\.exe$/i)
  assert.deepEqual(calls[0].args, ['https://example.test/a?x=1&y=2'])
})
