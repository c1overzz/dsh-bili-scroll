import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInstallManager } from '../lib/install-manager.mjs'

async function makeManager(overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bili-duty-install-'))
  const pluginDir = await mkdtemp(join(tmpdir(), 'bili-duty-plugin-'))
  await mkdir(join(pluginDir, 'vendor', 'bilibili-mcp'), { recursive: true })
  await writeFile(join(pluginDir, 'vendor', 'bilibili-mcp', 'requirements.txt'), 'qrcode\n', 'utf8')
  const config = { pythonPath: 'python', asrModel: 'small' }
  const logs = []
  const manager = createInstallManager({
    stateDir,
    pluginDir,
    getConfig: () => config,
    persistConfig: async (patch) => ({ host: { ok: true }, next: { ...config, ...patch } }),
    log: (line) => logs.push(line),
    ensureUv: async () => null,
    ...overrides,
  })
  return { manager, stateDir, config, logs }
}

test('paths and readiness use the injected platform and package layout', async () => {
  const { manager, stateDir } = await makeManager({ platform: 'linux' })
  assert.equal(manager.paths.venvPython, join(stateDir, '.venv', 'bin', 'python'))
  assert.equal(manager.paths.asrPython, join(stateDir, '.venv-asr', 'bin', 'python'))
  assert.deepEqual(manager.missingVenvDeps(), ['bilibili_api', 'mcp', 'qrcode'])
  assert.equal(manager.venvReadyNow(), false)

  await mkdir(join(stateDir, '.venv', 'bin'), { recursive: true })
  await writeFile(manager.paths.venvPython, '')
  await mkdir(join(stateDir, '.venv', 'lib', 'python3.12', 'site-packages'), { recursive: true })
  for (const pkg of ['bilibili_api', 'mcp', 'qrcode']) {
    await writeFile(join(stateDir, '.venv', 'lib', 'python3.12', 'site-packages', pkg), '')
  }
  assert.deepEqual(manager.missingVenvDeps(), [])
  assert.equal(manager.venvReadyNow(), true)
})

test('runInstall is asynchronous and rejects a concurrent request', async () => {
  const spawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 0))
    return child
  }
  const { manager } = await makeManager({ spawn })
  const first = manager.runInstall()
  assert.equal(first.started, true)
  assert.equal(manager.isInstalling(), true)
  const second = manager.runInstall()
  assert.equal(second.busy, true)
  assert.equal(second.log, manager.paths.installLogFile)
})

test('status exposes install logs and current flags', async () => {
  const { manager } = await makeManager()
  const status = manager.status()
  assert.equal(status.installLog, manager.paths.installLogFile)
  assert.equal(status.asrLog, manager.paths.asrLogFile)
  assert.equal(status.installing, false)
  assert.equal(status.asrInstalling, false)
  assert.equal(status.venvReady, false)
})

test('resolveUv prefers the system command and only downloads as a fallback', async () => {
  let probes = 0
  const system = await makeManager({
    spawn: () => {
      probes++
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', 0))
      return child
    },
    ensureUv: async () => { throw new Error('must not download when uv is on PATH') },
  })
  assert.equal(await system.manager.resolveUv(), 'uv')
  assert.equal(probes, 1)

  const fallback = await makeManager({
    spawn: () => {
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('error', new Error('not found')))
      return child
    },
    ensureUv: async () => '/tmp/bili-duty-uv',
  })
  assert.equal(await fallback.manager.resolveUv(), '/tmp/bili-duty-uv')
})

test('stop cancels an in-flight dependency command', async () => {
  let signal
  const commandRunner = {
    run(_command, args, options = {}) {
      if (args?.[0] === '--version') return Promise.resolve({ code: 1, error: new Error('missing'), stdout: '', stderr: '' })
      signal = options.signal
      return new Promise((resolve) => {
        const finish = () => resolve({ code: null, error: new Error('命令已取消'), stdout: '', stderr: '' })
        if (signal?.aborted) finish()
        else signal?.addEventListener?.('abort', finish, { once: true })
      })
    },
  }
  const { manager } = await makeManager({
    commandRunner,
    ensureUv: async () => '/tmp/bili-duty-uv',
  })
  const started = manager.runInstall()
  assert.equal(started.started, true)
  for (let i = 0; i < 20 && !signal; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(manager.stop(), true)
  assert.equal(signal.aborted, true)
  for (let i = 0; i < 20 && manager.isInstalling(); i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(manager.isInstalling(), false)
})
