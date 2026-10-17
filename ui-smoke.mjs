/**
 * 设置页 / 报告页 / 调试页 渲染冒烟测试
 * ============================================================================
 * 为什么要有：client.js 不是 ESM（是 window.__ModuleLoader__ 自注册脚本），
 * 光 `node --check` 只能查语法，查不出「渲染时引用了一个没定义的变量」这类错。
 * 这里塞一层极简 React 垫片（useState/useEffect/useCallback/useMemo/useRef），
 * 把 Panel **真跑一遍**，再把整棵树拍平成文字 —— 文案对不对、有没有 undefined / NaN，
 * 一眼就能看出来 ✓
 *
 * ⭐ 2026-10-17：加了「报告 / 调试」两个标签页之后，垫片得能**按组件分别记 hooks** ——
 *   原来是一个全局数组，子组件一渲染就把父组件的槽位串了 ✗。
 *   现在按「渲染路径」分开存（同一个位置跨轮复用），行为就跟真 React 差不多了 ✓
 *
 * 用法：
 *   node ui-smoke.mjs <client.js 路径>
 *   TAB=report node ui-smoke.mjs …      # 渲染完点「报告」标签再看一遍
 *   TAB=debug  node ui-smoke.mjs …
 *   REPORT_MD=/path/to/2026-10-17.md …  # 用真的报告做夹具（推荐，解析器也一起验了）
 *   VERBOSE=1 …                         # 把整棵树打出来
 */
import fs from 'node:fs'
import { parseReport } from './lib/report.mjs'

const FILE = process.argv[2]
const src = fs.readFileSync(FILE, 'utf8')

let factory = null
new Function('window', src)({ __ModuleLoader__: { load: (m) => { factory = m.factory } } })

/* ── 状态夹具（照真实 /status 的形状）────────────────────────────── */
const STATUS = {
  ok: true, ranToday: 5, venvReady: true, installing: false, loggedIn: true, version: '0.1.4',
  lastRunAt: '2026-10-17T02:00:00.000Z', installFailed: false, installTail: 'tail...', installing2: false,
  asrReady: false, asrModelReady: false, asrInstalling: false, asrTail: '',
  home: '/vol1/@apphome/fn-deepseek-harness/bili-duty',
  report: '/vol1/@apphome/fn-deepseek-harness/bili-duty/out/2026-10-17.md',
  windows: { noon: { label: '中午谷时', start: '12:00', end: '14:00' }, night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' } },
  config: {
    keywords: ['音乐'], workspace: '/tmp/ws', reportLevel: 'full', perDay: 10, commentPerRound: 1,
    replyPerRound: 1, mentionNames: ['某人', '另一个人'], mentionName: '', dmMode: 'only', dmUid: 12345678,
    aiReply: true, aiKeywords: [], autoComment: process.env.AC !== '0', transcribe: process.env.TR === '1', peakValley: true, noon: true,
    night: true, replyToComments: process.env.RC === '1',
  },
}
if (process.env.DM) STATUS.config.dmMode = process.env.DM

/* ── 报告夹具：优先拿真的 markdown 过一遍解析器（连解析一起验）────── */
const REPORT_MD = process.env.REPORT_MD
let REPORT
if (REPORT_MD && fs.existsSync(REPORT_MD)) {
  const text = fs.readFileSync(REPORT_MD, 'utf8')
  const day = (REPORT_MD.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '2026-10-17'
  REPORT = { ok: true, day, exists: true, file: REPORT_MD, text, parsed: parseReport(text, { day, file: REPORT_MD }), days: [day, '2026-10-16'] }
  console.log(`（报告夹具用真文件：${REPORT_MD} → ${REPORT.parsed.stats.rounds} 轮 / 收 ${REPORT.parsed.stats.picks} 条）`)
} else {
  REPORT = {
    ok: true, day: '2026-10-17', exists: true, file: '/tmp/out/2026-10-17.md', days: ['2026-10-17'],
    text: '# 刷B站日报 · 2026-10-17（01:16）\n\n## 一、收（1 条）\n\n### 1. 测试条目\n- UP：某人 ｜ 播放：1,234 ｜ https://www.bilibili.com/video/BV1DkJ869EEn\n- 为什么值得：因为它在测。\n- 一句话：测完了。\n',
    parsed: null,
  }
  REPORT.parsed = parseReport(REPORT.text, { day: REPORT.day, file: REPORT.file })
}

/* ── 调试夹具：含一条报错，确保红色那条路径也渲染到 ─────────────── */
const DEBUG = {
  ok: true, running: true, why: 'manual', startedAt: Date.now() - 83000, elapsedMs: 83000,
  lastExit: { code: 0, at: Date.now() - 900000, why: 'noon' }, today: '2026-10-17',
  progress: [
    { at: '15:40:00', tool: '__round__', phase: 'start', label: '开始跑一轮（manual）' },
    { at: '15:40:01', tool: 'bili_search', phase: 'start', label: '搜索B站视频', args: { keyword: '音乐', num: '10' } },
    { at: '15:40:03', tool: 'bili_search', phase: 'ok', ms: 2100, note: '{"count": 10}' },
    { at: '15:40:04', tool: 'bili_subtitle', phase: 'start', args: { bvid: 'BV1DkJ869EEn' } },
    { at: '15:40:06', tool: 'bili_subtitle', phase: 'ok', ms: 1800, note: '拿到字幕' },
    { at: '15:40:07', tool: 'bili_reply', phase: 'error', ms: 320, error: 'code 21007：内容过长' },
    { at: '15:40:09', tool: 'bili_note_picks', phase: 'start', args: { count: '3' } },
    { at: '15:40:09', tool: 'bili_note_picks', phase: 'ok', ms: 2, note: '{"todayTotal": 12}' },
  ],
  keyLines: [
    { text: '15:40:00 刷B站开跑（manual）：node /usr/bin/dsh …', bad: false },
    { text: '15:40:07 code 21007：内容过长', bad: true },
  ],
  logTail: '……原始日志尾巴……', logFile: '/tmp/duty.log', progressFile: '/tmp/progress.jsonl',
  stats: { rounds: 12, picks: 41, seen: 68, skipped: 101, comments: 7, dm: 6, verified: 7, checked: 77 },
}

globalThis.fetch = async (url) => {
  const u = String(url)
  // DEBUG404=1：模拟"宿主端还是旧的"（/debug 返回 404 JSON），看界面会不会白屏
  if (process.env.DEBUG404 && u.includes('/debug')) return { json: async () => ({ ok: false, error: 'HTTP 404' }) }
  const body = u.includes('/status') ? STATUS
    : u.includes('/report') ? REPORT
      : u.includes('/debug') ? DEBUG
        : { ok: true, config: STATUS.config }
  return { json: async () => body }
}
globalThis.document = { createElement: () => ({ setAttribute() {}, remove() {}, set textContent(v) {}, get textContent() { return '' } }), head: { appendChild() {} } }
try { Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true }) } catch { /* 渲染用不到 */ }
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.open = () => null
const realTimeout = globalThis.setTimeout

/* ── React 垫片（hooks 按「渲染路径」分开记，子组件不串）──────────── */
const h = (t, p, ...c) => {
  const kids = c.flat(9).filter((x) => x !== null && x !== undefined && x !== false)
  return { t, p: { ...(p || {}), children: kids.length === 1 ? kids[0] : kids }, c: kids }
}

const compHooks = new Map()
let cur = null
let pos = 0
let dirty = false

function withHooks(path, fn) {
  if (!compHooks.has(path)) compHooks.set(path, [])
  const ph = cur, pp = pos
  cur = compHooks.get(path)
  pos = 0
  try { return fn() } finally { cur = ph; pos = pp }
}
const depsChanged = (prev, deps) => !prev || !deps || !prev.deps || deps.length !== prev.deps.length
  || deps.some((d, k) => !Object.is(d, prev.deps[k]))

const useState = (init) => {
  const i = pos++
  const arr = cur                     // ⚠️ 抓住"这一刻"的数组：set 多半在 await 之后才被调用，
  if (arr.length <= i) arr[i] = typeof init === 'function' ? init() : init
  const set = (v) => {                //    那时 withHooks 早把 cur 换回上层了，用 cur 会炸 ✗
    const nv = typeof v === 'function' ? v(arr[i]) : v
    if (!Object.is(nv, arr[i])) { arr[i] = nv; dirty = true }
  }
  return [arr[i], set]
}
const useEffect = (fn, deps) => {
  const i = pos++
  if (depsChanged(cur[i], deps)) { cur[i] = { deps }; fn() }
}
const useCallback = (fn, deps) => {
  const i = pos++
  if (depsChanged(cur[i], deps)) cur[i] = { deps, fn }
  return cur[i].fn
}
const useMemo = (fn, deps) => {
  const i = pos++
  if (depsChanged(cur[i], deps)) cur[i] = { deps, v: fn() }
  return cur[i].v
}
const useRef = (init) => {
  const i = pos++
  if (!cur[i]) cur[i] = { current: init }
  return cur[i]
}

const React = { createElement: h, useState, useEffect, useCallback, useMemo, useRef }
const plugin = factory((n) => { if (n === 'react') return React; throw new Error('未预期的 require: ' + n) })

let Registered = null
const slots = { inject: (name, fn) => fn(), register: (meta, comp) => { Registered = comp } }
plugin.apply({ get: () => slots, effect: () => {} })
if (!Registered) { console.error('❌ 没注册进 settings.section'); process.exit(1) }
const Panel = Registered().t

/* ── 反复渲染直到稳定（让 useEffect 里的 setState 落地）─────────── */
let tree = null

/** 把函数组件递归展开成真实元素树（hooks 按路径记住，跨轮复用）。
 *  ⚠️ 必须**整棵树**一起展开：只调 Panel() 的话，子组件的 useEffect 永远不会跑，
 *     于是报告页/调试页停在「还没加载」那一帧 ✗ */
function expand(node, path) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((n) => expand(n, path))
  if (typeof node.t === 'function') {
    const name = node.t.name || 'anon'
    const p2 = path + '/' + name
    let r
    try { r = withHooks(p2, () => node.t(node.p || {})) }
    catch (e) { return { t: '__ERR__', p: { msg: name + ' 渲染炸了: ' + e.message }, c: [] } }
    return expand(r, p2)
  }
  return { t: node.t, p: node.p, c: (node.c || []).map((n) => expand(n, path)) }
}

async function settle() {
  for (let round = 0; round < 40; round++) {
    dirty = false
    tree = expand(withHooks('root', () => Panel()), 'root')
    await new Promise((r) => realTimeout(r, 0))
    if (!dirty) break
  }
  return tree
}
await settle()

/* ── 可选：切到别的标签页再渲染（报告 / 调试只在那时才挂载）──────── */
const WANT_TAB = process.env.TAB || ''
function findBy(node, pred) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const r = findBy(n, pred); if (r) return r } return null }
  if (pred(node)) return node
  for (const c of node.c || []) { const r = findBy(c, pred); if (r) return r }
  return null
}
if (WANT_TAB) {
  const LABEL = { settings: '设置', report: '报告', debug: '调试' }[WANT_TAB] || WANT_TAB
  const btn = findBy(tree, (n) => n.p && n.p['data-bd-tab'] !== undefined && n.c.includes(LABEL))
  if (!btn) { console.error(`❌ 没找到「${LABEL}」这个标签按钮`); process.exit(1) }
  btn.p.onClick()
  await settle()
  console.log(`（已切到「${WANT_TAB}」标签）`)
}

/* ── 拍平成文字 ─────────────────────────────────────────────────── */
const out = []
function walk(node, depth) {
  if (typeof node === 'string' || typeof node === 'number') { out.push({ depth, kind: 'text', v: String(node) }); return }
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((n) => walk(n, depth)); return }
  if (node.t === '__ERR__') { out.push({ depth, kind: 'ERR', v: node.p.msg }); return }
  const tag = node.t
  const props = node.p || {}
  const attrs = []
  for (const k of ['data-bd-label', 'data-bd-note', 'data-bd-h', 'data-bd-badge', 'data-bd-msg', 'data-bd-tab',
    'data-bd-stat', 'data-bd-chip', 'data-bd-pill', 'data-bd-card', 'data-bd-sec-head', 'data-bd-ev']) {
    if (props[k] !== undefined) attrs.push(k.replace('data-bd-', ''))
  }
  if (tag === 'a') attrs.push('href')
  if (tag === 'select' || tag === 'textarea' || tag === 'input') attrs.push(tag + (props.value !== undefined ? ':' + props.value : ''))
  out.push({ depth, kind: 'el', v: tag + (attrs.length ? ' [' + attrs.join(' ') + ']' : ''), props })
  ;(node.c || []).forEach((c) => walk(c, depth + 1))
}
walk(tree, 0)

let bad = 0
for (const line of out) {
  const pad = '  '.repeat(line.depth)
  if (process.env.VERBOSE && (line.kind === 'text' || line.kind === 'el' || line.kind === 'comp')) console.log(pad + line.v)
  if (line.kind === 'ERR') { console.log(pad + '❌ ' + line.v); bad++ }
}
const flat = out.map((l) => l.v).join('\n')
const texts = out.filter((l) => l.kind === 'text').map((l) => l.v).join('\n')

console.log('\n──────── 断言 ────────')
const checks = [
  ['无渲染错误', bad === 0],
  ['没有 undefined / NaN 漏到界面上', !/undefined|NaN/.test(flat)],
  ['没有残留的「默认关；」', !/默认[关开]；/.test(flat)],
  ['没有已删掉的保存按钮', !/^\s*保存$/m.test(flat)],
  ['三个标签页都在', /设置/.test(texts) && /报告/.test(texts) && /调试/.test(texts)],
  ['窄屏有适配（手机）', /@media \(max-width:640px\)/.test(src)],
  ['宽屏没被卡在 640px', /max-width:1080px/.test(src)],
  ['统计块会自己折行（窄屏不溢出）', /grid-template-columns:repeat\(auto-fill,minmax\(120px,1fr\)\)/.test(src)],
]
if (!WANT_TAB) checks.push(['有「只私信」选项', /只私信/.test(flat)])
if (WANT_TAB === 'report') {
  checks.push(
    ['报告页没白屏', /轮次|还没有报告/.test(texts)],
    ['有当日概览统计', REPORT.parsed ? new RegExp('收了').test(texts) : true],
    ['有轮次选择器', !REPORT.parsed?.rounds?.length || out.some((l) => l.kind === 'el' && /chip/.test(l.v))],
    ['收了的那条渲染成了卡片', !REPORT.parsed?.stats?.picks || out.some((l) => l.kind === 'el' && /card/.test(l.v))],
    ['能切回原文', /看原文|看结构化/.test(texts)],
  )
}
if (WANT_TAB === 'debug' && process.env.DEBUG404) {
  checks.push(
    ['接口 404 时没白屏', /404|读调试信息/.test(texts)],
    ['并且给了"重启一下"的人话提示', /重启/.test(texts)],
  )
}
if (WANT_TAB === 'debug' && !process.env.DEBUG404) {
  checks.push(
    ['调试页没白屏', /实时进度|关键日志/.test(texts)],
    ['显示正在跑', /正在跑/.test(texts)],
    ['报错那条被标出来了', out.some((l) => l.kind === 'el' && l.props?.['data-bad'] !== undefined && l.props['data-bd-ev'] !== undefined)],
    ['工具名翻成了中文', /发评论|取字幕|搜视频/.test(texts)],
    ['有时长显示', /秒|ms/.test(texts)],
  )
}
for (const [name, pass] of checks) { console.log((pass ? '  ✅ ' : '  ❌ ') + name); if (!pass) bad++ }
console.log(bad ? `\n❌ ${bad} 项没过` : '\n✅ 全部通过')
process.exit(bad ? 1 : 0)