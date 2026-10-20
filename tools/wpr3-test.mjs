/**
 * wpr3-test.mjs —— WPR3（人格与关注什么）的自检
 *   node tools/wpr3-test.mjs
 * 不碰真家目录：全部在 os.tmpdir 下开一个临时 home。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mod = await import('../index.js')
const HOME = join(tmpdir(), 'wpr3-' + Date.now())
mkdirSync(HOME, { recursive: true })

let n = 0, bad = 0
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.error('  ✗ ' + msg) } else console.log('  ✓ ' + msg) }

/* ── 1. 人格名清洗 ── */
ok(mod.personaFileName('../../本鱼?.md') === '本鱼.md', '路径分隔符 / 问号被清掉')
ok(mod.personaFileName('   ') === '', '空名字 → 空串')
ok(mod.personaFileName('.hidden') === 'hidden', '开头的点被去掉（别生成隐藏文件）')

/* ── 2. 存 / 列 / 读 ── */
const dir = mod.personaDirOf(HOME)
mkdirSync(dir, { recursive: true })
const body = '# 本鱼\n' + '我说话带点抽象。'.repeat(40)
writeFileSync(join(dir, '本鱼.md'), body, 'utf8')
const list = mod.listPersonas(HOME)
ok(list.length === 1 && list[0].name === '本鱼', '列表只认 personas/*.md')
ok(list[0].chars === body.length, '列表带字数（' + list[0].chars + '）')
ok(mod.readPersona(HOME, '本鱼') === body, '正文读回一致')
ok(mod.readPersona(HOME, '不存在') === '', '没有的人格返回空串')

/* ── 3. 覆盖前的"短太多"拦截 ── */
ok(mod.personaShrink(body, '短') === true, '短一大截要拦（长 300+ → 1 个字符）')
ok(mod.personaShrink(body, body + '加一句') === false, '变长不拦')
ok(mod.personaShrink('', '随便') === false, '原来就是空的，不拦')

/* ── 4. 设置页：关键词改成逐词输入（源码口径） ── */
const cli = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const count = (re) => (cli.match(re) || []).length
ok(count(/const commitKws = /g) === 1, 'commitKws 定义了一次')
ok(count(/const onKwAt = /g) === 1, 'onKwAt 定义了一次')
ok(count(/const onKwAdd = /g) === 1, 'onKwAdd 定义了一次')
ok(count(/const onKwDrop = /g) === 1, 'onKwDrop 定义了一次')
ok(!/onSaveText/.test(cli), '旧的整块保存 onSaveText 已删干净')
ok(!/一行一个关键词；留空用内置那几组/.test(cli), '关键词 textarea 的占位提示已去掉')

/* ── 5. 人格正文进提示词 ── */
ok(/personaBlock/.test(readFileSync(new URL('../index.js', import.meta.url), 'utf8')), 'promptFor 里有人格卡块')

/* ── 6. HTTP 接口真跑一遍（列 / 存 / 拦 / 覆盖确认 / 删）── */
const http = await import('node:http')
let route = null
mod.apply({
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(HOME, ...seg) : undefined),
  logger: { info() {}, warn() {} },
  tools: { register: (t) => t },
  webServer: { register: (h) => { route = h.handler; return { dispose() {} } } },
  effect: (fn) => { try { return fn() } catch { return undefined } },
  settings: { register: () => ({}) },
  slots: { inject() {}, register: () => ({}) },
}, {})
ok(typeof route === 'function', 'webServer 挂上了 /api/bili-duty 的 handler')

const srv = http.createServer((req, res) => route(req, res))
await new Promise((s) => srv.listen(0, '127.0.0.1', s))
const base = 'http://127.0.0.1:' + srv.address().port + '/api/bili-duty'
const call = async (m, p, b) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
  let body = {}
  try { body = await r.json() } catch { /* 空响应 */ }
  return { status: r.status, body }
}

let r = await call('GET', '/personas')
ok(r.body.ok === true && Array.isArray(r.body.list) && r.body.list.length === 0, 'GET /personas 空库')

const long = '# 本鱼\n' + '抽象一点。'.repeat(60)
r = await call('POST', '/personas', { name: '本鱼', text: long })
ok(r.body.ok === true && r.body.current === '本鱼', 'POST 存一份人格并选中')

r = await call('GET', '/personas')
ok(r.body.text === long && (r.body.list || []).length === 1, 'GET 能把正文读回来')

r = await call('POST', '/personas', { name: '本鱼', text: '短' })
ok(r.body.ok === false && r.body.needConfirm === true, '短太多的覆盖被要求二次确认')

r = await call('POST', '/personas', { name: '本鱼', text: '短', confirm: true })
ok(r.body.ok === true, '带 confirm 才真覆盖')

r = await call('POST', '/personas', { name: '', text: 'x' })
ok(r.status === 400, '没名字 → 400')

r = await call('DELETE', '/personas', { name: '本鱼' })
ok(r.body.ok === true && (r.body.list || []).length === 0, 'DELETE 删掉并回列表')
srv.close()

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${n - bad}/${n} 通过`)
process.exit(bad ? 1 : 0)
