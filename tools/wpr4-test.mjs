/**
 * wpr4-test.mjs —— WPR4（跑一轮与日报）的自检
 *   node tools/wpr4-test.mjs
 * 不碰真家目录：报告写在 os.tmpdir 下的临时 home。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { parseReport, summarize, isStub } = await import('../lib/report.mjs')
const mod = await import('../index.js')

let n = 0, bad = 0
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.error('  ✗ ' + msg) } else console.log('  ✓ ' + msg) }

const FIXTURE = [
  '# 今天的日报（2026-10-19）',
  '',
  '今天挑了两条。',
  '',
  '### BV1aa411c7de',
  '标题：水豚为什么这么抽象 | UP：某UP | https://www.bilibili.com/video/BV1aa411c7de | 播放 12.3万',
  '为什么值得：整活密度高，评论区能抄梗。',
  '我的一句话：这条适合发贴吧。',
  '',
  '### BV1bb411c7de',
  '标题：猫meme合集 | UP：另一个UP | https://www.bilibili.com/video/BV1bb411c7de',
  '为什么值得：素材能拆。',
  '',
  '## 评论与 @',
  '- 回复 @某人：已发（rpid 321161448160）',
  '',
  '## 私信投递',
  '- 发给 123456：msg_key 7698061831052070400',
  '- 发给 654321：msg_key 7698061831330662122',
  '',
  '## 评论复核（宿主自动跑的，不是那一轮自己说的）',
  '- `BV1aa411c7de` rpid **321161448160** —— 公开可见（赞 2） · 依据：顶层评论第一页',
  '- `BV1bb411c7de` rpid **321161448161** —— 没查到 · 依据：楼中楼第二页',
  '',
  '因无字幕跳过 0 条',
].join('\n')

/* ── 1. 解析 ── */
const p = parseReport(FIXTURE)
ok(p.picked.length === 2, '认出 2 条挑中的（### BV 开头）')
ok(p.picked[0].bv === 'BV1aa411c7de', '第一条 BV 号对')
ok(p.picked[0].title.includes('水豚'), '第一条标题抠出来了')
ok(p.picked[0].url.includes('BV1aa411c7de'), '第一条链接抠出来了')
ok(p.comments.length === 1, '评论区 1 条')
ok(p.dm.length === 2, '私信 2 条')
ok(p.verify.length === 2, '复核 2 条')
ok(p.stub === false, '正常报告不算占位')
ok(summarize(p).includes('挑中 2 条') && summarize(p).includes('评论 1 条'), '汇总句：' + summarize(p))
ok(isStub('<!-- bili-duty: stub -->\n这一轮没能正常跑完'), '占位报告认得出来')

/* ── 2. 设置页 / 接口 ── */
const HOME = join(tmpdir(), 'wpr4-' + Date.now())
mkdirSync(join(HOME, 'out'), { recursive: true })
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
ok(typeof route === 'function', 'handler 挂上了')

const st = await new Promise((resolve) => {
  const req = { method: 'GET', url: '/api/bili-duty/status', headers: {} }
  const res = { setHeader() {}, end: (s) => resolve(JSON.parse(s)), writeHead() {}, statusCode: 200 }
  route(req, res)
})
ok(st.ok === true && st.running === false, 'status：没在跑时 running=false')
ok('lastRound' in st, 'status 带 lastRound 字段')

writeFileSync(join(HOME, 'out', st.today + '.md'), FIXTURE, 'utf8')
// ⭐ 插件真正的数据目录是 <dshHome>/bili-duty（status.home 会给），报告在它的 out/ 下
mkdirSync(join(st.home, 'out'), { recursive: true })
writeFileSync(join(st.home, 'out', st.today + '.md'), FIXTURE, 'utf8')
const rep = await new Promise((resolve) => {
  const req = { method: 'GET', url: '/api/bili-duty/report', headers: {} }
  const res = { setHeader() {}, end: (s) => resolve(JSON.parse(s)), writeHead() {}, statusCode: 200 }
  route(req, res)
})
ok(rep.exists === true, '报告文件读到了')
ok(rep.parsed && rep.parsed.picked.length === 2, '/report 把 parsed 一起返回了')
ok(String(rep.summary).includes('挑中 2 条'), '/report 带汇总：' + rep.summary)

/* ── 3. 源码口径 ── */
const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const cli = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
ok(/runningSince/.test(idx) && /lastRound/.test(idx), 'index 记了 runningSince / lastRound')
ok(/running: Boolean\(runningSince\)/.test(idx), 'status 暴露 running')
ok(/上一轮还在跑/.test(idx), '重复点「跑一轮」会被拦')
ok(/正在跑/.test(cli), '设置页显示「正在跑」')
ok(/report\.parsed/.test(cli), '设置页用 parsed 渲染报告')

srvCloseIfAny()
function srvCloseIfAny() { /* 没起服务器 */ }
rmSync(HOME, { recursive: true, force: true })
console.log(`\n${n - bad}/${n} 通过`)
process.exit(bad ? 1 : 0)
