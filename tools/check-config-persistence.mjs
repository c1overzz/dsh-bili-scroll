// Run with: node tools/check-config-persistence.mjs (no network or real credentials).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const root = mkdtempSync(join(tmpdir(), 'bili-config-check-'))
const home = join(root, 'bili-duty')
mkdirSync(home)
const file = join(home, 'config.json')
writeFileSync(file, JSON.stringify({ peakValley: false, dmWatch: true, dmMode: 'off' }))
const hostUser = { perDay: 5, mentionName: '', replyToComments: false, overlayMcp: true }
const hostWrites = []
let dispose = () => {}

function mount() {
  const tools = new Map()
  const cleanups = []
  let handler
  apply({
    get: (key) => key === 'dshHomePath' ? (...parts) => join(root, ...parts) : undefined,
    logger: { info() {} },
    tools: { register: (tool) => tools.set(tool.name, tool) },
    settings: {
      describe: () => [{ ns: 'bili-scroll', revision: 1, value: hostUser, user: hostUser }],
      update: async (_ns, patch) => { hostWrites.push(patch); Object.assign(hostUser, patch) },
    },
    webServer: { register: (route) => { handler = route.handler; return () => {} } },
    effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
  }, {})
  dispose = () => { for (const cleanup of cleanups) cleanup() }
  async function request(method, path, body) {
    const req = new EventEmitter()
    req.method = method
    req.url = '/api/bili-duty' + path
    let status, result
    const pending = handler(req, {
      writeHead: (code) => { status = code },
      end: (text) => { result = JSON.parse(text) },
    })
    if (body !== undefined) { req.emit('data', JSON.stringify(body)); req.emit('end') }
    await pending
    assert.equal(status, 200)
    assert.equal(result.ok, true)
    return result
  }
  return { request, configure: (patch) => tools.get('bili_config').execute({ patch }) }
}

try {
  let app = mount()
  // These are the three bodies actually sent by the settings UI.
  assert.equal((await app.request('POST', '/config', { dmWatch: false })).config.dmWatch, false)
  await app.request('POST', '/config', { keywords: ['DSH'], personaPrompt: 'Keep it concise.' })
  await app.request('POST', '/config', { favFolderId: 123 })
  const expected = { dmWatch: false, personaPrompt: 'Keep it concise.', favFolderId: 123 }
  const check = (config) => {
    for (const [key, value] of Object.entries(expected)) assert.equal(config[key], value, key)
    assert.deepEqual(config.keywords, ['DSH'])
  }
  check((await app.request('GET', '/status')).config)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  check(saved)
  for (const key of Object.keys(expected)) assert.ok(saved._set.includes(key))
  // Host defaults must not resurrect a disabled switch after reload.
  dispose()
  Object.assign(hostUser, { dmWatch: true, personaPrompt: '', favFolderId: 0 })
  app = mount()
  check((await app.request('GET', '/status')).config)
  // Both public mutation paths share filtering and normalization.
  for (const save of [
    (patch) => app.request('POST', '/config', patch),
    (patch) => app.configure(patch),
  ]) {
    const result = await save({ dmWatch: 'false', personaPrompt: {}, dmMode: 'invalid', dmUid: -1, unknown: true })
    check(result.config)
    assert.equal(result.config.dmMode, 'off')
    assert.equal(result.config.dmUid, 0)
    assert.equal(Object.hasOwn(hostWrites.at(-1), 'unknown'), false)
    assert.equal(Object.hasOwn(hostWrites.at(-1), 'keywords'), false)
    assert.equal(hostWrites.at(-1).dmWatch, false)
    assert.equal(hostWrites.at(-1).personaPrompt, expected.personaPrompt)
  }
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')), 'unknown'), false)
  console.log('✓ Settings persist through HTTP, polling and reload; tool writes use the same normalization.')
} finally {
  dispose()
  rmSync(root, { recursive: true, force: true })
}
