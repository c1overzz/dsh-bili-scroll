import test from 'node:test'
import assert from 'node:assert/strict'

import { createHostRuntime } from '../lib/host-runtime.mjs'

test('resolves host services through get, direct properties, and root fallback', () => {
  const direct = { id: 'direct' }
  const root = { id: 'root' }
  const ctx = {
    direct,
    root: { fallback: root },
    get(name) { if (name === 'direct') return direct; throw new Error('not injected') },
  }
  const host = createHostRuntime({ ctx })
  assert.equal(host.get('direct'), direct)
  assert.equal(host.get('missing'), null)
  assert.equal(host.get('fallback'), root)
})

test('registers HTTP routes and wraps cleanup in host effects', () => {
  const effects = []
  const routes = []
  const logs = []
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => routes.pop() } },
    effect(setup, label) { effects.push({ setup, label }); return setup() },
  }
  const host = createHostRuntime({ ctx, log: (line) => logs.push(line) })
  const handler = () => {}
  host.registerWebServer({ path: '/api/test', handler, label: 'route' })
  assert.equal(routes[0].path, '/api/test')
  assert.equal(routes[0].handler, handler)
  let cleaned = false
  host.dispose(() => { cleaned = true }, 'cleanup')
  effects.at(-1).setup()()
  assert.equal(cleaned, true)
  assert.equal(logs.length, 0)
})

test('connection lookup is cached and cleanup errors are contained', () => {
  let reads = 0
  const logs = []
  const connection = { requestRejection() {} }
  const effects = []
  const ctx = {
    get(name) { reads++; return name === 'connection' ? connection : null },
    effect(setup) { effects.push(setup); return setup() },
  }
  const host = createHostRuntime({ ctx, log: (line) => logs.push(line) })
  assert.equal(host.getConnection(), connection)
  assert.equal(host.getConnection(), connection)
  assert.equal(reads, 1)
  host.dispose(() => { throw new Error('close failed') }, 'cleanup')
  effects.at(-1)()()
  assert.match(logs.at(-1), /close failed/)
})

test('registers tools through the host capability adapter', () => {
  const registered = []
  const host = createHostRuntime({
    ctx: { tools: { register(spec) { registered.push(spec); return spec } } },
  })
  const spec = { name: 'bili_test' }
  assert.equal(host.registerTool(spec), spec)
  assert.deepEqual(registered, [spec])
})
