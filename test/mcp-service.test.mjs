import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMcpService } from '../lib/mcp-service.mjs'

async function make() {
  const stateDir = await mkdtemp(join(tmpdir(), 'bili-duty-mcp-'))
  await writeFile(join(stateDir, 'mcp_server.py'), '# test\n', 'utf8')
  const config = { pythonPath: 'python-a' }
  const clients = []
  class FakeClient {
    constructor(options) { this.options = options; this.running = true; this.stopped = false; clients.push(this) }
    stop() { this.stopped = true; this.running = false }
    async call(name, args) { return { name, args, command: this.options.command } }
    async callRaw(name, args) { return { json: await this.call(name, args), images: [] } }
  }
  const service = createMcpService({
    stateDir,
    getConfig: () => config,
    McpClient: FakeClient,
    refreshConfig: () => {},
    uvEnv: () => ({ PYTHONUTF8: '1' }),
  })
  return { service, config, clients, stateDir }
}

test('mcp service reuses a client until pythonPath changes', async () => {
  const { service, config, clients } = await make()
  assert.deepEqual(await service.call('search', { q: 'x' }), { name: 'search', args: { q: 'x' }, command: 'python-a' })
  assert.equal(clients.length, 1)
  await service.callRaw('cover', { bvid: 'BV1' })
  assert.equal(clients.length, 1)
  config.pythonPath = 'python-b'
  await service.call('search', {})
  assert.equal(clients.length, 2)
  assert.equal(clients[0].stopped, true)
  assert.equal(clients[1].options.command, 'python-b')
})

test('mcp service reports a missing home script clearly', async () => {
  const { service, stateDir } = await make()
  const { rm } = await import('node:fs/promises')
  await rm(join(stateDir, 'mcp_server.py'))
  await assert.rejects(() => service.ensure(), /家里没有 mcp_server\.py/)
})

test('mcp service reuses a client during concurrent first calls', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bili-duty-mcp-race-'))
  await writeFile(join(stateDir, 'mcp_server.py'), '# test\n', 'utf8')
  const config = { pythonPath: 'python-a' }
  const clients = []
  class LazyClient {
    constructor(options) {
      this.options = options
      this.running = false
      clients.push(this)
    }
    async call(name, args) {
      this.running = true
      await new Promise((resolve) => setImmediate(resolve))
      return { name, args }
    }
    async callRaw(name, args) { return { json: await this.call(name, args), images: [] } }
    stop() { this.running = false }
  }
  const service = createMcpService({
    stateDir,
    getConfig: () => config,
    McpClient: LazyClient,
    refreshConfig: () => {},
  })

  const [first, second] = await Promise.all([
    service.call('first', {}),
    service.call('second', {}),
  ])
  assert.deepEqual(first, { name: 'first', args: {} })
  assert.deepEqual(second, { name: 'second', args: {} })
  assert.equal(clients.length, 1)
})

