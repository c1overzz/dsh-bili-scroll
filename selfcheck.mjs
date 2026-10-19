/**
 * selfcheck.mjs —— 插件的"预检"：**两个半端都在本地真跑一遍**，不靠"重启一次才知道错哪"
 *
 * 为什么要有它（2026-10-14 连栽两次，都是重启后翻 `.dsh-web.err.log` 才发现）：
 *   ① `config` 的值是对象 ⇒ 定时器里 TypeError ⇒ **把整个 dsh 带走**；
 *   ② `parameters.patch` 是 `{ type:'object' }` ⇒ `defineTool` 抛 JsonSchemaError ⇒ **插件整条不激活**。
 *
 * 用法：`node --import ./tools/register.mjs selfcheck.mjs`（解析钩子见 tools/host-resolver.mjs）
 * 退出码：0 = 两个半端都正常；1 = 有问题（宿主里就会 "entry did not activate" / 设置页空白）
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX_HOME = join(tmpdir(), 'dsh-bili-scroll-selfcheck')
const fail = (msg, e) => {
  console.error(`\n✗ ${msg}`)
  if (e) console.error(`  ${e?.name}: ${e?.message}`)
  const frame = String(e?.stack ?? '').split('\n').slice(1, 4).join('\n')
  if (frame) console.error(frame)
  process.exit(1)
}

/* ────────────── ① host 半端：假 ctx 上真跑 apply() ────────────── */

let mod
try {
  mod = await import('./index.js')
} catch (e) {
  fail('连 import index.js 都失败（依赖没解析？检查 tools/host-resolver.mjs）', e)
}

const registered = []
const fakeCtx = {
  // ⭐ 宿主给的是**函数**（`dshHomePath(...segments)`），这里照样给函数 —— 别用字符串
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(SANDBOX_HOME, ...seg) : undefined),
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (t) => { registered.push(t?.name ?? String(t)); return t } },
  webServer: { register: () => ({ dispose() {} }) },
  effect: (fn) => { try { return fn() } catch { return undefined } },
  settings: { register: () => ({}) },
  slots: { inject: () => {}, register: () => ({}) },
}

try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉就留着 */ }
mkdirSync(SANDBOX_HOME, { recursive: true })

try {
  mod.apply(fakeCtx, {})
} catch (e) {
  fail('host 半端 apply() 抛错了 —— 宿主里就是那句 `warning: 1 entry did not activate`', e)
}
console.log(`✓ host 半端 OK：name=${mod.name}  inject=${JSON.stringify(mod.inject)}  工具 ${registered.length} 个`)
for (const n of registered) console.log(`    - ${n}`)

/* ── 修复①：建 venv 必须钉 Python 3.10–3.13（uv 默认拿最新 CPython，3.14+ 没有 wheel）── */
const venvSpec = await mod.venvPythonSpec(SANDBOX_HOME)
if (!venvSpec) fail('venvPythonSpec 返回空 —— 建环境时又会退回"最新 CPython"（issue #15）')
const fakeVenv = join(SANDBOX_HOME, 'fake-venv')
mkdirSync(fakeVenv, { recursive: true })
writeFileSync(join(fakeVenv, 'pyvenv.cfg'), 'home = C:\\Python313\r\nversion = 3.13.7\r\n')
if (mod.pyVerOfVenv(fakeVenv) !== 313) fail('pyVerOfVenv 读不出 pyvenv.cfg 的版本号（重建判据会失效）')
console.log(`✓ 修复① venv Python spec = ${venvSpec}（pyvenv.cfg 版本识别 OK）`)

/* ── 修复②：loadCfg 以 config.json 打底，不再被"全默认"盖回去 ── */
const merged = mod.mergeCfg(
  { perDay: 7, pythonPath: 'C:/py312/python.exe' },
  { user: {}, value: {} },
  { host: { perDay: 5, pythonPath: 'python' }, defaults: { perDay: 5, pythonPath: 'python' }, hostWins: ['pythonPath'] },
)
if (merged.perDay !== 7) fail('loadCfg 把 config.json 里的 perDay 盖成了默认值（issue #22）')
if (merged.pythonPath !== 'C:/py312/python.exe') fail('loadCfg 让设置页上的旧 pythonPath 压过了装好的 venv')
const forced = mod.mergeCfg({ perDay: 7 }, { user: { perDay: 3 }, value: {} }, { defaults: { perDay: 5 } })
if (forced.perDay !== 3) fail('loadCfg 没听用户在设置页显式设过的值')
// 数组不能按 !== 比：宿主那份空数组不能把 config.json 里的关键词/名单盖成 []
const arrKeep = mod.mergeCfg({ keywords: ['x'] }, null, { host: { keywords: [] }, defaults: { keywords: [] } })
if (JSON.stringify(arrKeep.keywords) !== '["x"]') fail('loadCfg 把 config.json 里的关键词盖成了空数组')
console.log('✓ 修复② loadCfg 合并规则 OK（config.json 打底 + 用户层覆盖 + pythonPath 特例）')

/* ── 修复③：私信模式必须把 bili_send_message 放进白名单（issue #25 / #16）── */
const dmTools = mod.mcpToolList({ dmMode: 'only', dmUid: 12345 })
if (!dmTools.includes('bili_send_message')) fail('私信开着却没给 bili_send_message —— 模型手里没有这只工具')
const offTools = mod.mcpToolList({ dmMode: 'off', dmUid: 12345 })
if (offTools.includes('bili_send_message')) fail('私信关着也给了 bili_send_message（白名单太松）')
console.log('✓ 修复③ MCP 白名单 OK：' + dmTools.join(' / '))

/* ────────────── ② client 半端：假 window.__ModuleLoader__ 上真跑 factory() ────────────── */

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
let loaded = null
const prevWindow = globalThis.window
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
try {
  await import(`./client.js?selfcheck=${Date.now()}`)
} catch (e) {
  globalThis.window = prevWindow
  fail('client.js 一 import 就抛错（浏览器里会是一片空白）', e)
}
globalThis.window = prevWindow

if (!loaded) fail('client.js 没有调用 window.__ModuleLoader__.load({...}) —— 那它不会被挂上')
if (loaded.id !== pkg.name) fail(`client.js 的 id（${loaded.id}）必须等于 package.json 的 name（${pkg.name}）`)
if (typeof loaded.factory !== 'function') fail('client.js 的 load({...}) 里没有 factory 函数')

const fakeReact = {
  createElement: (...a) => ({ tag: a[0], props: a[1] }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  Fragment: 'Fragment',
}
let clientMod
try {
  clientMod = loaded.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`client.js require 了没预料到的包：${name}`)
  })
} catch (e) {
  fail('client.js 的 factory(require) 抛错', e)
}
if (typeof clientMod?.apply !== 'function') fail('client.js 的 factory 必须返回带 apply() 的对象')

// 真调一次 apply（假 DOM + 假 slots），把拼错的名字、漏掉的 ctx 方法都逼出来
const slotsReg = []
const styleNodes = []
const prevDoc = globalThis.document
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { appendChild: (n) => styleNodes.push(n) },
}
try {
  clientMod.apply({
    effect: (fn) => { try { return fn() } catch { return undefined } },
    slots: {
      inject: (name, fn) => { fn() },
      register: (opts, Component) => { slotsReg.push({ ...opts, hasComponent: typeof Component === 'function' }); return {} },
    },
  })
} catch (e) {
  globalThis.document = prevDoc
  fail('client.js 的 apply(ctx) 抛错', e)
}
globalThis.document = prevDoc

if (!slotsReg.length) fail('client.js 的 apply 没有往任何 slot 注册组件')
if (!styleNodes.length) fail('client.js 的 apply 没有把样式挂上（页面会没样子）')
console.log(`✓ client 半端 OK：id=${loaded.id}  注入=${JSON.stringify(clientMod.inject)}`)
for (const s of slotsReg) console.log(`    slot ${s.name}  id=${s.id}  order=${s.order}  组件=${s.hasComponent ? '有' : '无 ✗'}`)

try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 留着也无所谓 */ }
console.log(`\n（预检不碰真家目录：host 用 ${SANDBOX_HOME}）`)
