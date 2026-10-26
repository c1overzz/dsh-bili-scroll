import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDshResolver } from '../lib/dsh-resolver.mjs'

test('resolver prefers an explicit existing dshBin and caches the lookup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-duty-resolver-'))
  const explicit = join(root, 'bin.js')
  await writeFile(explicit, '')
  let existsCalls = 0
  const resolver = createDshResolver({
    getConfig: () => ({ dshBin: explicit }),
    execPath: '/node',
    exists: (file) => { existsCalls++; return file === explicit },
    now: () => 10,
  })
  assert.deepEqual(resolver.resolveDsh(), { command: '/node', args: [explicit], shell: false })
  resolver.resolveDsh()
  assert.equal(existsCalls, 1)
})

test('resolver invalidates its cache when dshBin changes', () => {
  let current = '/first/bin.js'
  let probes = 0
  const resolver = createDshResolver({
    getConfig: () => ({ dshBin: current }),
    exists: (file) => { probes++; return file === current },
    execPath: '/node',
  })
  assert.equal(resolver.dshCliCached(), current)
  current = '/second/bin.js'
  assert.equal(resolver.dshCliCached(), current)
  assert.equal(probes, 2)
})

test('resolver finds a Windows PATH executable and reports missing dsh clearly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-duty-resolver-path-'))
  const exe = join(root, 'dsh.cmd')
  await writeFile(exe, '')
  const found = createDshResolver({
    env: { PATH: root },
    platform: 'win32',
    exists: (file) => file === exe,
    resolveModule: null,
  })
  const result = found.resolveDsh()
  assert.equal(result.command, exe)
  assert.equal(result.fallback, true)

  const missingLogs = []
  const missing = createDshResolver({
    env: { PATH: '' },
    platform: 'linux',
    exists: () => false,
    resolveModule: null,
    log: (line) => missingLogs.push(line),
  })
  assert.equal(missing.resolveDsh().missing, true)
  assert.match(missingLogs.join('\n'), /找不到 dsh/)
})

test('resolver scans Electron resources with a bounded directory walk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-duty-resolver-resource-'))
  const bin = join(root, 'nested', 'node_modules', 'dsh', 'lib', 'bin.js')
  await mkdir(join(root, 'nested', 'node_modules', 'dsh', 'lib'), { recursive: true })
  await writeFile(bin, '')
  const resolver = createDshResolver({
    resourcesPath: root,
    execPath: join(root, 'app'),
    env: { PATH: '' },
    resolveModule: null,
  })
  assert.equal(resolver.findDshCli(), bin)
})
