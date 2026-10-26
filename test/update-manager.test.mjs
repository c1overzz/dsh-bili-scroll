import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { compareVersions, createUpdateManager } from '../lib/update-manager.mjs'

const response = (payload, ok = true) => ({
  ok,
  async json() { return payload },
})

test('compareVersions keeps stable releases newer than prereleases', () => {
  assert.equal(compareVersions('1.2.0', '1.2.0-rc.1') > 0, true)
  assert.equal(compareVersions('v2.0.0', '1.9.9') > 0, true)
  assert.equal(compareVersions('1.2.0-rc.2', '1.2.0-rc.1'), 0)
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0)
})

test('check chooses the newer source and caches both lookups', async () => {
  let now = 1000
  let calls = 0
  const fetchImpl = async (url) => {
    calls++
    if (url.includes('registry.npmjs.org')) return response({ version: '2.0.0' })
    return response({ content: Buffer.from(JSON.stringify({ version: '2.1.0' })).toString('base64') })
  }
  const manager = createUpdateManager({
    getCurrentVersion: () => '1.0.0',
    resolveDsh: () => ({ missing: true, hint: 'no dsh' }),
    spawnTo: async () => 0,
    fetchImpl,
    now: () => now,
  })
  const first = await manager.check()
  assert.deepEqual({ latest: first.latest, source: first.source, hasNew: first.hasNew }, {
    latest: '2.1.0', source: 'github', hasNew: true,
  })
  assert.equal(calls, 2)
  now += 100
  const second = await manager.check()
  assert.equal(second.latest, '2.1.0')
  assert.equal(calls, 2)
})

test('runUpgrade starts once and uses the release tarball for GitHub updates', async () => {
  const logs = []
  const commands = []
  let release = false
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const manager = createUpdateManager({
    getCurrentVersion: () => '1.0.0',
    profileArg: 'desktop',
    resolveDsh: () => ({ command: process.execPath, args: [], shell: false }),
    spawnTo: async (command, args) => {
      commands.push([command, args])
      return new Promise((resolve) => setTimeout(() => resolve(0), 10))
    },
    appendLog: (line) => logs.push(line),
    fetchImpl: async (url) => {
      if (url.includes('/releases/latest')) {
        release = true
        return response({ tag_name: 'v2.0.0' })
      }
      if (url.includes('/contents/package.json')) {
        return response({ content: Buffer.from(JSON.stringify({ version: '2.1.0' })).toString('base64') })
      }
      return response({ version: '2.0.0' })
    },
  })
  await manager.check()
  const first = manager.runUpgrade()
  assert.equal(first.started, true)
  assert.equal(manager.runUpgrade().busy, true)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(release, true)
  assert.equal(commands.length, 1)
  assert.deepEqual(commands[0][1].slice(-4), ['--profile', 'desktop', 'add', 'https://github.com/c1overzz/dsh-bili-scroll/releases/download/v2.0.0/dsh-bili-scroll-2.0.0.tgz'])
  assert.match(logs.join(''), /升级完成/)
})

test('stop cancels an in-flight upgrade without reporting success', async () => {
  let signal
  const logs = []
  const manager = createUpdateManager({
    getCurrentVersion: () => '1.0.0',
    resolveDsh: () => ({ command: 'dsh', args: [], shell: false }),
    commandRunner: {
      run(_command, _args, options = {}) {
        signal = options.signal
        return new Promise((resolve) => {
          const finish = () => resolve({ code: null, error: new Error('命令已取消') })
          if (signal.aborted) finish()
          else signal.addEventListener('abort', finish, { once: true })
        })
      },
    },
    appendLog: (line) => logs.push(line),
  })
  assert.equal(manager.runUpgrade().started, true)
  for (let i = 0; i < 20 && !signal; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(manager.stop(), true)
  for (let i = 0; i < 20 && manager.isUpgrading(); i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(manager.isUpgrading(), false)
  assert.equal(logs.some((line) => /升级完成/.test(line)), false)
  assert.equal(logs.some((line) => /升级已取消/.test(line)), true)
})
