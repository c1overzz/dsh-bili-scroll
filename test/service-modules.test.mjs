import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFavoriteService } from '../lib/favorite-service.mjs'
import { createCoverService, isAllowedCoverUrl } from '../lib/cover-service.mjs'
import { createDiagnostics } from '../lib/diagnostics.mjs'

test('favorite service lists folders and serializes picked videos through favops', async () => {
  const commands = []
  const spawn = (command, args) => {
    commands.push([command, args])
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    process.nextTick(() => {
      child.stdout.emit('data', JSON.stringify({ ok: true, folders: [{ id: 7 }] }) + '\n')
      child.emit('exit', 0)
    })
    return child
  }
  const service = createFavoriteService({
    stateDir: '/tmp/bili-duty',
    outDir: '/tmp/bili-duty/out',
    getConfig: () => ({ pythonPath: 'python' }),
    spawn,
  })
  const result = await service.listFolders()
  assert.deepEqual(result, { ok: true, folders: [{ id: 7 }] })
  assert.deepEqual(commands[0], ['python', ['/tmp/bili-duty/favops.py', 'folders']])
})

test('favorite service stops the current command and does not continue to the next video', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bili-duty-fav-stop-'))
  await writeFile(join(stateDir, 'favops.py'), '# test\n', 'utf8')
  const commands = []
  let release
  const spawn = (_command, args) => {
    commands.push(args)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { release?.(); child.emit('exit', 1) }
    release = () => {
      child.stdout.emit('data', JSON.stringify({ ok: true }) + '\n')
      child.emit('exit', 0)
    }
    return child
  }
  const service = createFavoriteService({
    stateDir,
    outDir: join(stateDir, 'out'),
    getConfig: () => ({ pythonPath: 'python', favFolderId: 7 }),
    hasCredential: () => true,
    pickIdsFromReport: () => ['BV1111111111', 'BV2222222222'],
    spawn,
  })
  const pending = service.favToday('manual')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(service.stop(), true)
  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /取消/)
  assert.equal(commands.length, 1)
})

test('cover service validates BV ids and proxies metadata plus image bytes', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.includes('/view?bvid=')) return {
      ok: true,
        async json() { return { data: { pic: 'https://i0.hdslb.com/cover.jpg' } } },
    }
    return {
      ok: true,
      headers: { get() { return 'image/png' } },
      async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer },
    }
  }
  const service = createCoverService({ fetchImpl })
  assert.equal(await service.coverFor('bad'), null)
  const cover = await service.coverFor('BV1aa1aa1aa1')
  assert.equal(cover.type, 'image/png')
  assert.deepEqual([...cover.buf], [1, 2, 3])
  assert.equal(calls.length, 2)
})

test('cover service does not become an open proxy for metadata-supplied URLs', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return {
      ok: true,
      async json() { return { data: { pic: 'https://attacker.example/collect.gif' } } },
    }
  }
  const service = createCoverService({ fetchImpl })
  assert.equal(isAllowedCoverUrl('https://i0.hdslb.com/bfs/archive/cover.jpg'), true)
  assert.equal(isAllowedCoverUrl('http://i0.hdslb.com/bfs/archive/cover.jpg'), false)
  assert.equal(isAllowedCoverUrl('https://attacker.example/collect.gif'), false)
  assert.equal(await service.coverFor('BV1aa1aa1aa1'), null)
  assert.equal(calls.length, 1)
})

test('diagnostics checkUp reports missing environment without touching the network', async () => {
  let calls = 0
  const diagnostics = createDiagnostics({
    stateDir: '/tmp/bili-duty',
    outDir: '/tmp/bili-duty/out',
    getConfig: () => ({ dmMode: 'off' }),
    dutyRunner: {
      resolveDsh: () => ({ missing: true, hint: 'no dsh' }),
      effectiveProfile: () => 'bili-duty',
      getProfileState: () => 'ok',
    },
    venvReadyNow: () => false,
    fetchImpl: async () => { calls++; throw new Error('should not run') },
  })
  const result = await diagnostics.checkUp()
  assert.equal(result.ok, false)
  assert.match(result.error, /环境还没装好/)
  assert.equal(calls, 0)
})
