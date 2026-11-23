// node --test test/
// sameOriginOk 这一道「本机同源」兜底闸门：反代 / 域名 / 隧道部署下不能把设置页自己拦死
// （issue #158 / #178 / #180 / #181：面板显示「读不到插件配置（已经试了 N 次）」，其实是 /api/bili-duty/* 全 403）。
// 做法跟 fence-and-run-lock.test.mjs 一样：真 import index.js、在假 ctx 上跑 apply()，再走设置页的 HTTP 路由；
// 家目录在临时目录里，不联网、不碰真的 dsh 和 python。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'bili-origin-'))
const savedDshHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const { apply } = await import('../index.js')
if (savedDshHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedDshHome
test.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

const NO_PYTHON = join(home, 'no-such-python')

let seq = 0
// fence = null 表示宿主没给 connection 服务（栅栏不可用）；给一个 { requestRejection } 表示栅栏在岗
const startHost = (t, { fence = null } = {}) => {
  const root = join(home, `host-${++seq}`)
  const stateDir = join(root, 'bili-duty')
  mkdirSync(stateDir, { recursive: true })
  const fakeDsh = join(root, 'fake-dsh.js')
  writeFileSync(fakeDsh, '', 'utf8')
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ dshBin: fakeDsh, pythonPath: NO_PYTHON }), 'utf8')
  writeFileSync(join(stateDir, 'state.json'), '{}', 'utf8')
  let route = null
  const disposers = []
  apply({
    get: (k) => {
      if (k === 'dshHomePath') return (...seg) => join(root, ...seg)
      if (k === 'connection') return fence
      return undefined
    },
    tools: { register: () => {} },
    webServer: { register: (r) => { route = r; return () => {} } },
    effect: (fn) => { disposers.push(fn()) },
  }, {})
  t.after(() => { for (const d of disposers) if (typeof d === 'function') d() })
  const getStatus = (headers) => new Promise((resolve, reject) => {
    const res = { writeHead() {}, end: (body) => resolve(JSON.parse(body)) }
    route.handler({ method: 'GET', url: '/api/bili-duty/status', headers }, res).catch(reject)
  })
  return { getStatus }
}

// 栅栏在岗：cookie/token 已验过 ⇒ requestRejection 返回 undefined（放行）
const liveFence = { requestRejection: () => undefined }

const DOMAIN = 'dsh.example.com'

/* ─────────── 反代 / 域名访问：Host 是域名，同源请求必须放行 ─────────── */

test('Host 是域名 + Origin 同源 ⇒ 放行（原先这里直接 403）', async (t) => {
  const h = startHost(t)
  const r = await h.getStatus({ host: DOMAIN, origin: `https://${DOMAIN}` })
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('Host 是域名 + Referer 同源（Origin 被反代吃掉）⇒ 放行', async (t) => {
  const h = startHost(t)
  const r = await h.getStatus({ host: DOMAIN, referer: `https://${DOMAIN}/settings/bili` })
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('Host 是域名 + 只有 Origin 带默认端口 ⟺ Host 带端口不一致 ⇒ 仍按同源放行', async (t) => {
  const h = startHost(t)
  // https 默认 443：Origin 不带端口时按 443 比，Host 也只有域名 ⇒ 同源
  const r = await h.getStatus({ host: DOMAIN, origin: `https://${DOMAIN}:443` })
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('Host 是域名、没有 Origin / Referer（脚本直调）⇒ 放行', async (t) => {
  const h = startHost(t)
  const r = await h.getStatus({ host: DOMAIN })
  assert.equal(r.ok, true, JSON.stringify(r))
})

/* ─────────── 真跨站：仍然要拒 ─────────── */

test('跨站 Origin ⇒ 403 只接受本机同源请求', async (t) => {
  const h = startHost(t)
  const r = await h.getStatus({ host: DOMAIN, origin: 'https://evil.example' })
  assert.equal(r.ok, false)
  assert.equal(r.error, '只接受本机同源请求')
})

test('跨站 Referer ⇒ 403 只接受本机同源请求', async (t) => {
  const h = startHost(t)
  const r = await h.getStatus({ host: DOMAIN, referer: 'https://evil.example/x' })
  assert.equal(r.ok, false)
  assert.equal(r.error, '只接受本机同源请求')
})

test('本机另一个端口的页面 ⇒ 403（2.0.5 起端口也要比）', async (t) => {
  const h = startHost(t)
  const r = await h.getStatus({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:5173' })
  assert.equal(r.ok, false)
  assert.equal(r.error, '只接受本机同源请求')
})

/* ─────────── 反代把 Host 改写成回环（fnOS 网关）：栅栏在岗就放行 ─────────── */

test('Host 被改写成回环 + Referer 是局域网地址，栅栏不在岗 ⇒ 403', async (t) => {
  const h = startHost(t)
  const r = await h.getStatus({ host: '127.0.0.1:3080', referer: 'http://192.168.1.254:8976/app/fn-deepseek-harness/' })
  assert.equal(r.ok, false)
  assert.equal(r.error, '只接受本机同源请求')
})

test('Host 被改写成回环 + Referer 是局域网地址，栅栏在岗（cookie/token 已验）⇒ 放行', async (t) => {
  const h = startHost(t, { fence: liveFence })
  const r = await h.getStatus({ host: '127.0.0.1:3080', referer: 'http://192.168.1.254:8976/app/fn-deepseek-harness/' })
  assert.equal(r.ok, true, JSON.stringify(r))
})
