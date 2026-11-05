// node --test test/
// 真 import index.js、在假 ctx 上跑 apply()（跟 selfcheck.mjs 同一个做法），再走设置页的 HTTP 路由。
// 家目录在临时目录里，数据全是合成的；这里的路径都到不了真的 dsh 和 python，也不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'bili-host-'))
process.env.DSH_HOME = home
const { apply } = await import('../index.js')
const { dayKey } = await import('../lib/state.mjs')
test.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

const NO_PYTHON = join(home, 'no-such-python')

let seq = 0
const startHost = (t, { config = {}, state = {} } = {}) => {
  const root = join(home, `host-${++seq}`)
  const stateDir = join(root, 'bili-duty')
  mkdirSync(stateDir, { recursive: true })
  const fakeDsh = join(root, 'fake-dsh.js')
  writeFileSync(fakeDsh, '', 'utf8')
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ dshBin: fakeDsh, pythonPath: NO_PYTHON, ...config }), 'utf8')
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state), 'utf8')
  let route = null
  const disposers = []
  apply({
    get: (k) => (k === 'dshHomePath' ? (...seg) => join(root, ...seg) : undefined),
    tools: { register: () => {} },
    webServer: { register: (r) => { route = r; return () => {} } },
    effect: (fn) => { disposers.push(fn()) },
  }, {})
  t.after(() => { for (const d of disposers) if (typeof d === 'function') d() })
  const post = (path) => new Promise((resolve, reject) => {
    const res = { writeHead() {}, end: (body) => resolve(JSON.parse(body)) }
    route.handler({ method: 'POST', url: path, headers: {} }, res).catch(reject)
  })
  return { stateDir, post }
}

/* ─────────── 围栏里的 BV 不算挑中（占位报告把 duty.log 尾部贴在围栏里） ─────────── */

const stubReport = [
  '# 刷B站 —— 这一轮没写出报告',
  '',
  '```',
  '一行日志',
  '### BV1zzzzzzzzz',
  '又一行日志',
  '```',
  '',
].join('\n')

const favToday = (t, report) => {
  const host = startHost(t, { config: { favFolderId: 12345 } })
  writeFileSync(join(host.stateDir, 'bili_credential.json'), '{}', 'utf8')
  mkdirSync(join(host.stateDir, 'out'), { recursive: true })
  writeFileSync(join(host.stateDir, 'out', `${dayKey()}.md`), report, 'utf8')
  return host.post('/api/bili-duty/fav-today')
}

test('收藏：占位报告围栏里的 BV 不收', async (t) => {
  const r = await favToday(t, stubReport)
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.match(r.error, /没有挑中的视频/)
})

test('收藏：围栏外挑中的照收，围栏里的不带上', async (t) => {
  // 这里没有真 python：每一条都落进 failures，正好看得见它拿到了哪几条
  const r = await favToday(t, ['### BV1aaaaaaaaa', '值得看', '', stubReport].join('\n'))
  assert.equal(r.total, 1, JSON.stringify(r))
  assert.match(r.failures[0], /^BV1aaaaaaaaa: /)
})

/* ─────────── 这一轮没跑起来，跨宿主运行锁就得放开 ─────────── */

const lockOf = (host) => JSON.parse(readFileSync(join(host.stateDir, 'run-lock.json'), 'utf8'))

test('手动轮被冷却拒绝：不留运行锁', async (t) => {
  const host = startHost(t, { config: { manualCooldownMin: 3 }, state: { lastManualAt: Date.now() - 1000 } })
  const r = await host.post('/api/bili-duty/run')
  assert.equal(r.started, false)
  assert.match(r.error, /手动轮刚跑过/)
  assert.notEqual(lockOf(host).pid, process.pid)
})

test('开跑时同步抛错（外层 catch）：不留运行锁', async (t) => {
  // 参数里带 NUL ⇒ spawn 直接同步抛 ERR_INVALID_ARG_VALUE，子进程根本起不来
  const host = startHost(t, { config: { personaPrompt: 'a\u0000b' } })
  const r = await host.post('/api/bili-duty/run')
  assert.equal(r.started, false)
  assert.match(readFileSync(join(host.stateDir, 'duty.log'), 'utf8'), /刷B站开跑失败/)
  assert.notEqual(lockOf(host).pid, process.pid)
})

test('另一个宿主真在跑：让路，也不动它的锁', async (t) => {
  const host = startHost(t)
  const theirs = { pid: process.ppid, ts: Date.now(), why: 'window:noon' }
  writeFileSync(join(host.stateDir, 'run-lock.json'), JSON.stringify(theirs), 'utf8')
  const r = await host.post('/api/bili-duty/run')
  assert.equal(r.busy, true)
  assert.deepEqual(lockOf(host), theirs)
})
