// node --test test/
// 出厂 bili-duty 上钉了它没有的 provider：照用不换（b8f0b5a），但设置页 / bili_config / duty.log 要在跑之前说出来。
// 用桩 ctx 跑真实的 index.js（和 duty-rounds.test.mjs 同一个做法）；假 dsh 照宿主的样子：
// overlay 里的 provider 不是 DeepSeek 两条就打一行 NO_ADAPTER、退出码 1。数据全是合成的，不联网。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayKey } from '../lib/state.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-pin-'))
// 只在 import 期间换 DSH_HOME：别让 hostdeps 去翻这台机器真实的 ~/.dsh
const realDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'import-home')
const { apply } = await import('../index.js').finally(() => {
  if (realDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realDshHome
})

const fakeDsh = join(root, 'fake-dsh.mjs')
writeFileSync(fakeDsh, `
import { readFileSync } from 'node:fs'
const at = process.argv.indexOf('--patch')
const overlay = at > 0 ? readFileSync(process.argv[at + 1], 'utf8') : ''
const m = overlay.match(/provider: '([^']*)'/)
const provider = m ? m[1] : ''
if (provider && !['deepseek-account', 'deepseek-official'].includes(provider)) {
  process.stderr.write('dsh: NO_ADAPTER: no adapter registered for provider "' + provider + '"\\n')
  process.exit(1)
}
process.exit(0)
`)

const strayFetches = []
globalThis.fetch = async (url) => { strayFetches.push(String(url)); throw new Error('这个测试不该联网：' + url) }

const disposers = []
after(() => {
  for (const d of disposers) { try { d() } catch { /* 收摊 */ } }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  assert.deepEqual(strayFetches, [])
})

function startHost(cfg) {
  const home = mkdtempSync(join(root, 'home-'))
  const stateDir = join(home, 'bili-duty')
  mkdirSync(join(stateDir, 'out'), { recursive: true })
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    dshBin: fakeDsh, dmWatch: false, manualCooldownMin: 0, dmUid: 12345, pythonPath: join(root, 'no-such-python'), ...cfg,
  }))
  let handler = null
  const tools = new Map()
  apply({
    get: (k) => (k === 'dshHomePath' ? (...seg) => join(home, ...seg) : undefined),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    tools: { register: (t) => { tools.set(t?.name, t); return () => {} } },
    webServer: { register: (r) => { handler = r.handler; return () => {} } },
  }, {})
  const call = (method, path) => new Promise((resolve, reject) => {
    const req = { method, url: path, headers: {}, on: (ev, cb) => { if (ev === 'end') cb() } }
    handler(req, { writeHead: () => {}, end: (s) => resolve(JSON.parse(s)) }).catch(reject)
  })
  const logFile = join(stateDir, 'duty.log')
  const readLog = () => { try { return readFileSync(logFile, 'utf8') } catch { return '' } }
  return {
    stateDir,
    tools,
    readLog,
    status: () => call('GET', '/api/bili-duty/status'),
    async round() {
      const before = readLog().split('刷B站结束（').length
      const r = await call('POST', '/api/bili-duty/run')
      assert.equal(r.started, true, JSON.stringify(r))
      const deadline = Date.now() + 30_000
      while (readLog().split('刷B站结束（').length === before) {
        assert.ok(Date.now() < deadline, '这一轮 30 秒还没结束')
        await new Promise((f) => setTimeout(f, 20))
      }
    },
  }
}

const WARN = '多半没有适配器'

test('出厂 bili-duty + 钉了它没有的 provider：/status 和 bili_config 都带 likelyNoAdapter，开跑前 duty.log 先说一句，照用不换', async () => {
  const h = startHost({ modelProvider: 'custom-gw', modelName: 'gw-model' })
  const st = await h.status()
  assert.deepEqual(st.model, { provider: 'custom-gw', model: 'gw-model', source: 'plugin', likelyNoAdapter: true })

  const out = await h.tools.get('bili_config').execute({ patch: { modelProvider: 'custom-gw', modelName: 'gw-model' } })
  assert.equal(out.model?.likelyNoAdapter, true)

  await h.round()
  const log = h.readLog()
  const warnAt = log.indexOf(WARN)
  assert.ok(warnAt >= 0, '开跑前要先在 duty.log 里说一句')
  assert.ok(warnAt < log.indexOf('刷B站开跑'), '这句要在开跑之前')
  assert.match(log, /NO_ADAPTER: no adapter registered for provider "custom-gw"/, '照用不换：overlay 里还是钉的那个')
  assert.match(log, /刷B站结束（manual，code=1）/)
  // 占位报告的诊断不被新加的这句带偏：认出的还是宿主那行的 provider
  const report = readFileSync(join(h.stateDir, 'out', `${dayKey()}.md`), 'utf8')
  assert.match(report, /这一轮的模型提供方没注册驱动：custom-gw/)
})

test('钉 DeepSeek / 没钉：不带 likelyNoAdapter，duty.log 里也没有那句', async () => {
  for (const cfg of [{ modelProvider: 'deepseek-account', modelName: 'deepseek-flash' }, {}]) {
    const h = startHost(cfg)
    const st = await h.status()
    assert.equal(Boolean(st.model?.likelyNoAdapter), false, JSON.stringify(st.model))
    const out = await h.tools.get('bili_config').execute({})
    assert.equal(Boolean(out.model?.likelyNoAdapter), false)
    await h.round()
    const log = h.readLog()
    assert.ok(!log.includes(WARN), log)
    assert.match(log, /刷B站结束（manual，code=0）/)
    assert.ok(existsSync(join(h.stateDir, 'out', `${dayKey()}.md`)), '照旧补占位报告（假 dsh 没写报告）')
  }
})
