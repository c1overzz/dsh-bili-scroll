/**
 * route-smoke.mjs —— 把宿主端那几条 HTTP 路由**真调一遍**
 * ============================================================================
 * 为什么要有：`selfcheck.mjs` 只跑到"apply() 没抛错"，它把 `webServer.register`
 * 桩成了空函数 —— 路由里写错一个字段、少 return 一个分支，自检是**看不见的** ✗。
 * 这里把注册进去的 handler 抓下来，喂假 req/res 真跑，用**真报告**当夹具。
 *
 * 用法：node --import ./tools/register.mjs route-smoke.mjs
 * 夹具：把线上 out/*.md 拷进沙箱家目录（只读线上，不往真家目录写任何东西）
 */
import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 有真家目录就拿真报告当夹具（最有说服力）；没有就用合成夹具，别让外人一跑就挂
const REAL_HOME = process.env.BILI_DUTY_HOME || '/vol1/@apphome/fn-deepseek-harness/bili-duty'
const SANDBOX = join(tmpdir(), 'dsh-bili-duty-routecheck')

let fails = 0
const ok = (name, pass, extra) => {
  console.log((pass ? '  ✅ ' : '  ❌ ') + name + (pass || extra === undefined ? '' : '  → ' + extra))
  if (!pass) fails++
}

/* ── 备沙箱：真报告 + 假的进度流 / 日志 ────────────────────────── */
rmSync(SANDBOX, { recursive: true, force: true })
// ⚠️ 插件拿到的家目录是 dshHomePath('bili-duty') ⇒ 夹具必须放在 <沙箱>/bili-duty 底下
const HOME = join(SANDBOX, 'bili-duty')
mkdirSync(join(HOME, 'out'), { recursive: true })

const days = []
try {
  for (const f of readdirSync(join(REAL_HOME, 'out'))) {
    if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) {
      copyFileSync(join(REAL_HOME, 'out', f), join(HOME, 'out', f))
      days.push(f.slice(0, -3))
    }
  }
} catch { /* 没有真家目录（换台机器跑）*/ }

if (days.length) {
  console.log(`（夹具：${days.length} 天的真报告 —— ${days.sort().reverse().join('、')}）`)
} else {
  console.log('（没找到真报告，用合成夹具）')
  // ⚠️ 日期得用**今天 / 昨天**：`/report` 不带参数时默认看今天，写死一个过去的日期会假失败
  const fmtDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const FAKE_DAYS = [fmtDay(new Date()), fmtDay(new Date(Date.now() - 86400_000))]
  const SYN = (n) => `# 刷B站日报 · ${FAKE_DAYS[n - 1]}（01:1${n}）

## 一、收（1 条）

### 1. 合成条目 ${n}
- UP：某某 ｜ 播放：1,234 ｜ https://www.bilibili.com/video/BV1DkJ869EEn
- 为什么值得：它就是为了测解析才存在的。
- 一句话：测完了。

## 二、看过未收
- **BV1Qops6SEuE** 一条没收录的（某人）—— 理由随便写写。

## 三、因无字幕跳过 1 条
1. BV1nvJm6WEtN —— 没字幕的那条（某某）

## 四、评论（本轮 1 条）
- 目标：**BV1DkJ869EEn**《合成条目 ${n}》
- 形式：**顶层**
- 结果：发送成功

## 五、总结
薄薄两行就够了。

# 刷B站日报 · ${FAKE_DAYS[n - 1]}（第二轮 · 02:26）

## 一、收（1 条）

### 1. 第二轮也收了一条
- UP：另一个人 ｜ 播放：8,888 ｜ https://www.bilibili.com/video/BV1Qops6SEuE
- 为什么值得：多一轮才测得出"轮次切换"。
- 一句话：就这样。

## 二、评论复核
- \`BV1Qops6SEuE\` rpid **317205827169** —— 公开可见（赞 0） · 依据：顶层·最新一页
`
  for (const n of [1, 2]) {
    writeFileSync(join(HOME, 'out', `${FAKE_DAYS[n - 1]}.md`), SYN(n), 'utf8')
    days.push(FAKE_DAYS[n - 1])
  }
  days.sort().reverse()
}

writeFileSync(join(HOME, 'progress.jsonl'), [
  JSON.stringify({ ts: 1, at: '15:40:00', tool: '__round__', phase: 'start', label: '开始跑一轮（manual）' }),
  JSON.stringify({ ts: 2, at: '15:40:01', tool: 'bili_search', phase: 'start', args: { keyword: '音乐' } }),
  JSON.stringify({ ts: 3, at: '15:40:03', tool: 'bili_search', phase: 'ok', ms: 2100 }),
  JSON.stringify({ ts: 4, at: '15:40:07', tool: 'bili_reply', phase: 'error', ms: 320, error: 'code 21007：内容过长' }),
  '这行是坏的，故意留着——解析要能跳过',
  JSON.stringify({ ts: 5, at: '15:40:09', tool: 'bili_note_picks', phase: 'ok', ms: 2, note: '{"todayTotal":12}' }),
].join('\n') + '\n', 'utf8')

writeFileSync(join(HOME, 'duty.log'),
  '无关的一行\n15:40:00 刷B站开跑（manual）：node /usr/bin/dsh …\n又一行无关的\n15:40:07 错误代码：-650，信息：用户等级太低。\n15:41:00 刷B站结束（manual，code=0）\n', 'utf8')

/* ── 假 ctx：把路由抓下来 ───────────────────────────────────────── */
let mod
try { mod = await import('./index.js') } catch (e) {
  console.error('✗ import index.js 失败：' + e?.message); process.exit(1)
}

const routes = []
const fakeCtx = {
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(SANDBOX, ...seg) : undefined),
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (t) => t },
  webServer: { register: (r) => { routes.push(r); return { dispose() {} } } },
  effect: (fn) => { try { return fn() } catch { return undefined } },
  settings: { register: () => ({}) },
  slots: { inject: () => {}, register: () => ({}) },
}
try { mod.apply(fakeCtx, {}) } catch (e) {
  console.error('✗ apply() 抛错：' + (e?.stack ?? e)); process.exit(1)
}

const route = routes.find((r) => r.path === '/api/bili-duty')
if (!route) { console.error('❌ 没注册 /api/bili-duty 路由'); process.exit(1) }
console.log('（路由已抓到：' + route.kind + ' ' + route.path + '）\n')

/** 真调一次路由 */
async function call(method, url, body) {
  const captured = { code: 0, headers: {}, body: '' }
  const res = {
    writeHead: (c, h) => { captured.code = c; Object.assign(captured.headers, h || {}) },
    end: (s) => { captured.body = s ?? '' },
    setHeader: (k, v) => { captured.headers[k] = v },
  }
  const req = { method, url, on: () => {}, destroy: () => {} }
  if (body !== undefined) {
    req.on = (ev, cb) => { if (ev === 'data') cb(JSON.stringify(body)); if (ev === 'end') cb() }
  }
  await route.handler(req, res)
  let json = null
  try { json = JSON.parse(captured.body) } catch { /* 不是 JSON */ }
  return { ...captured, json }
}

console.log('──────── 断言 ────────')

/* ① /status */
const st = await call('GET', '/api/bili-duty/status')
ok('/status 返回 JSON 且 ok', st.code === 200 && st.json?.ok === true, 'code=' + st.code)
ok('/status 有报告路径', typeof st.json?.report === 'string')

/* ② /report —— 结构化解析 */
const rp = await call('GET', '/api/bili-duty/report')
const p = rp.json?.parsed
ok('/report 200', rp.code === 200)
ok('/report 回了解析结果', Boolean(p), 'parsed=' + (p ? '有' : 'null'))
ok('/report 带日期列表', Array.isArray(rp.json?.days) && rp.json.days.length === days.length, JSON.stringify(rp.json?.days))
ok('/report 原有字段没丢', typeof rp.json?.text === 'string' && typeof rp.json?.file === 'string' && rp.json?.exists === true)
if (p) {
  const s = p.stats
  console.log(`     （解析出来：${s.rounds} 轮 / 收 ${s.picks} 条 / 看过未收 ${s.seen} / 跳过 ${s.skipped} / 评论 ${s.comments} / 私信 ${s.dm} / 复核 ${s.verified}·${s.checked}）`)
  ok('解析出多轮', s.rounds >= 2, 'rounds=' + s.rounds)
  ok('每轮都有分节', p.rounds.every((r) => r.sections.length > 0))
  ok('分节类型都是认得出的', p.rounds.every((r) => r.sections.every((x) => x.kind)))
  ok('收了的条目抽到了 BV 号', p.rounds.some((r) => r.sections.some((x) => x.kind === 'picked' && x.items.some((i) => /^BV/.test(i.bv || '')))))
  ok('看起来没把正文解析丢', p.rounds.every((r) => r.sections.every((x) => typeof x.raw === 'string')))
}

/* ③ /report?day= 换一天 */
if (days.length > 1) {
  const rp2 = await call('GET', '/api/bili-duty/report?day=' + days[1])
  ok('/report?day= 能换日期', rp2.code === 200 && rp2.json?.day === days[1], 'day=' + rp2.json?.day)
  ok('换日期后解析的是那一天', rp2.json?.parsed?.day === days[1])
}

/* ④ /debug */
const db = await call('GET', '/api/bili-duty/debug')
const d = db.json
ok('/debug 200 且 ok', db.code === 200 && d?.ok === true)
ok('/debug 有 running / startedAt / why', typeof d?.running === 'boolean' && 'startedAt' in d && typeof d?.why === 'string')
ok('/debug 进度流读到了', Array.isArray(d?.progress) && d.progress.length === 5, 'len=' + d?.progress?.length)
ok('/debug 跳过了坏行', d?.progress?.every((x) => typeof x === 'object' && x.tool))
ok('/debug 报错事件带 error', d?.progress?.some((x) => x.phase === 'error' && /21007/.test(x.error || '')))
ok('/debug 关键日志挑出来了', Array.isArray(d?.keyLines) && d.keyLines.length >= 3, 'len=' + d?.keyLines?.length)
ok('/debug 无关日志没被带进来', d?.keyLines?.every((x) => !/^无关的一行$/.test(x.text) && !/^又一行无关的$/.test(x.text)))
ok('/debug 报错那行被标 bad', d?.keyLines?.some((x) => x.bad === true))
ok('/debug 日志尾不为空', typeof d?.logTail === 'string' && d.logTail.length > 0)
ok('/debug 带上了当天的报告统计', Boolean(d?.stats))

/* ⑤ 未知路径要 404，不能挂 */
const nf = await call('GET', '/api/bili-duty/不存在的东西')
ok('未知路径返回 404', nf.code === 404, 'code=' + nf.code)

console.log(fails ? `\n❌ ${fails} 项没过` : '\n✅ 全部通过')
rmSync(SANDBOX, { recursive: true, force: true })
process.exit(fails ? 1 : 0)