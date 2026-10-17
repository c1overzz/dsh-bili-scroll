/**
 * route-smoke.mjs —— 把宿主端那几条 HTTP 路由**真调一遍**
 * ============================================================================
 * 为什么要有：`selfcheck.mjs` 只跑到"apply() 没抛错"，它把 `webServer.register`
 * 桩成了空函数 —— 路由里写错一个字段、少 return 一个分支，自检是**看不见的** ✗。
 * 这里把注册进去的 handler 抓下来，喂假 req/res 真跑，用**真报告**当夹具。
 *
 * 用法：node --import ./tools/register.mjs route-smoke.mjs
 * 夹具：把线上 out/*.md 拷进沙箱的数据目录（只读线上，不往真数据目录写任何东西）
 */
import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 有真数据目录就拿真报告当夹具（最有说服力）；没有就用合成夹具，别让外人一跑就挂
const REAL_HOME = process.env.BILI_DUTY_HOME || '/vol1/@apphome/fn-deepseek-harness/bili-duty'
const SANDBOX = join(tmpdir(), 'dsh-bili-duty-routecheck')

let fails = 0
const ok = (name, pass, extra) => {
  console.log((pass ? '  ✅ ' : '  ❌ ') + name + (pass || extra === undefined ? '' : '  → ' + extra))
  if (!pass) fails++
}

/* ── 备沙箱：真报告 + 假的进度流 / 日志 ────────────────────────── */
rmSync(SANDBOX, { recursive: true, force: true })
// ⚠️ 插件拿到的数据目录是 dshHomePath('bili-duty') ⇒ 夹具必须放在 <沙箱>/bili-duty 底下
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
} catch { /* 没有真数据目录（换台机器跑）*/ }

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

/* ⑤ 时段：/status 给的必须是**生效的那张表**，且带得回"下次什么时候跑" */
ok('/status 的 windows 是数组（生效的时段表，不再是内置字典）', Array.isArray(st.json?.windows))
ok('/status 保留了内置文案（设置页要显示）', Boolean(st.json?.builtinWindows?.noon?.label))
ok('/status 有 nextRunAt 字段', 'nextRunAt' in (st.json || {}))
ok('/status 带得回重叠告警字段', Array.isArray(st.json?.windowIssues))

/* ⑥ ⭐ 自定义时段：存得下、被规范化、重叠当场告警（设置页不靠 5 秒轮询） */
const c1 = await call('POST', '/api/bili-duty/config', { windows: ['12:00-14:00', '13:00-15:00'] })
ok('保存自定义时段 200', c1.code === 200, 'code=' + c1.code)
ok('存进去的是规范化的字符串数组',
  JSON.stringify(c1.json?.config?.windows) === JSON.stringify(['12:00-14:00', '13:00-15:00']),
  JSON.stringify(c1.json?.config?.windows))
ok('⭐ 应答里直接带重叠告警（不用等轮询）',
  Array.isArray(c1.json?.windowIssues) && c1.json.windowIssues.length === 1 && c1.json.windowIssues[0].kind === 'overlap',
  JSON.stringify(c1.json?.windowIssues))
ok('应答里带回了下次什么时候跑', typeof c1.json?.nextRunAt === 'string')
ok('生效的时段表跟着变了',
  Array.isArray(c1.json?.effectiveWindows) && c1.json.effectiveWindows.length === 2)

/* ⑦ 看不懂的输入不能被原样吃进去 */
const c2 = await call('POST', '/api/bili-duty/config',
  { windows: ['瞎写', '25:00-26:00', ' 09:00 ~ 10:30 '] })
ok('认不出的时段被丢掉、认得出的压成标准写法',
  JSON.stringify(c2.json?.config?.windows) === JSON.stringify(['09:00-10:30']),
  JSON.stringify(c2.json?.config?.windows))
const c2b = await call('POST', '/api/bili-duty/config', { windows: ['09:00-10:30', '09:00～10:30'] })
ok('⭐ 写成一个样的两条**不偷偷合并**（行留着、靠告警说清）',
  (c2b.json?.config?.windows || []).length === 2, JSON.stringify(c2b.json?.config?.windows))
ok('并且确实报了 dup',
  (c2b.json?.windowIssues || []).some((x) => x.kind === 'dup'),
  JSON.stringify(c2b.json?.windowIssues))
const c2c = await call('POST', '/api/bili-duty/config', { windows: ['瞎写', '25:00-26:00', ''] })
ok('全不可用 ⇒ 等于没配 ⇒ 退回内置那两组',
  (c2c.json?.effectiveWindows || []).map((w) => w.key).join() === 'noon,night',
  JSON.stringify((c2c.json?.effectiveWindows || []).map((w) => w.key)))

/* ⑧ 名单类字段的清洗（用户粘进来的东西什么形状都有） */
const c3 = await call('POST', '/api/bili-duty/config',
  { dmUids: [' 10967510 ', '@123456', '10967510', '000'] })
ok('UID 名单：去空格 / 去 @ 前缀、去重、丢掉 0',
  JSON.stringify(c3.json?.config?.dmUids) === JSON.stringify(['10967510', '123456']),
  JSON.stringify(c3.json?.config?.dmUids))
const c4 = await call('POST', '/api/bili-duty/config', { windows: [], noSubtitlePick: true })
ok('清空时段能回到内置',
  (c4.json?.effectiveWindows || []).map((w) => w.key).join() === 'noon,night')
ok('「拿不到字幕的也看看」存得下', c4.json?.config?.noSubtitlePick === true)

/* ⑨ ⭐ 提示词会跟着设置变 —— "设置到底生效没有"最直接的证据 */
await call('POST', '/api/bili-duty/config', { noSubtitlePick: true })
const prOn = (await call('GET', '/api/bili-duty/debug')).json?.prompt || ''
ok('/debug 摊得出这一轮收到的提示词（原文）', prOn.length > 200, 'chars=' + prOn.length)
ok('⭐ 开着「没字幕也看看」时，口径真写进了提示词', /拿不到字幕/.test(prOn))
ok('并且说清了"不分析内容"、要标注',
  /不要去分析视频内容/.test(prOn) && /没看内容，只凭标题/.test(prOn))
await call('POST', '/api/bili-duty/config', { noSubtitlePick: false })
const prOff = (await call('GET', '/api/bili-duty/debug')).json?.prompt || ''
ok('关着时口径变回"照老规矩跳过"', !/拿不到字幕/.test(prOff) && /照老规矩跳过/.test(prOff))
ok('提示词里也带上了条数额度这类现算的值', /每天最多挑几条|条数上限/.test(prOn))

/* ⑩ 平台：这台机器是什么环境，得如实报出来（设置页据此决定按钮怎么摆） */
const pf = st.json?.platform || {}
ok('/status 带回了平台信息', typeof pf.os === 'string' && typeof pf.desktop === 'boolean', JSON.stringify(pf))
ok('os 就是真的 process.platform', pf.os === process.platform, pf.os)
ok('desktop 是"有没有能打开文件夹的程序"（不是写死的）', typeof pf.desktop === 'boolean')
ok('dsh 能定位到一个真命令（跨平台找法）', /dsh|bin\.js/.test(String(pf.dsh || '')), String(pf.dsh || ''))
// ⭐ 回归：Linux 上很多发行版**没有 `python`**（只有 `python3`）。以前这里会照抄设置里那个
//    字符串，于是"明明能用"也显示成 'python' —— 现在必须报**真找得到的那个** ✓
const pathHas = (n) => String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
  .some((d) => d && existsSync(join(d, n)))
if (process.platform !== 'win32' && pathHas('python3') && !pathHas('python')) {
  ok('⭐ 这台机器只有 python3 时，python 就不会死报 "python"', pf.python !== 'python', pf.python)
  ok('而是报出 python3（设置页看得见、也真能用）', /python3/.test(String(pf.python || '')), pf.python)
}

/* ⑪ ⭐ 打开文件夹：Linux 上不再是那句"只做了 Windows"的拒绝 */
const op = await call('POST', '/api/bili-duty/open', { what: 'out' })
ok('/open 返回 200 且是 JSON', op.code === 200 && op.json && typeof op.json === 'object', 'code=' + op.code)
ok('⭐ 不再回"这个按钮目前只做了 Windows"', !/只做了 Windows/.test(JSON.stringify(op.json || {})))
ok('答不出"打开"时也把路径带回来了（设置页据此换成翻目录）',
  op.json?.ok === true || typeof op.json?.dir === 'string', JSON.stringify(op.json))
if (op.json?.ok !== true) {
  ok('并且说清了是不是"没有桌面"这件事实', typeof op.json?.noDesktop === 'boolean')
  ok('还给了下一步怎么办（而不是一句"打不开"就完了）', typeof op.json?.hint === 'string' && op.json.hint.length > 5)
}

/* ⑫ 目录浏览：没有桌面的机器上这才是真能做到的做法 ✓ */
const fl = await call('GET', '/api/bili-duty/files?what=out')
ok('/files 列出了目录', fl.code === 200 && fl.json?.ok === true && Array.isArray(fl.json.entries), 'code=' + fl.code)
ok('列出来的就是沙箱里那几份报告', days.length === 0 || fl.json.entries.some((e) => /\.md$/.test(e.name)))
ok('每项都带 size / mtime（设置页要显示）',
  fl.json.entries.every((e) => typeof e.size === 'number' && typeof e.mtime === 'number'))
ok('what 不认识时退回 out（不乱跑）',
  (await call('GET', '/api/bili-duty/files?what=../../etc')).json?.dir === fl.json?.dir)

/* ⑬ 读文件 / 下载 */
const day0 = days[0] || '2026-10-17'
const f1 = await call('GET', '/api/bili-duty/file?what=out&name=' + day0 + '.md')
ok('/file 读得到某一份报告', f1.code === 200 && f1.json?.ok === true && String(f1.json.text).length > 0)
ok('读回来的名字对得上', f1.json?.name === day0 + '.md')

const trav = [
  '../../../../etc/passwd', '..%2f..%2fetc%2fpasswd', '/etc/passwd', 'sub/../../x', 'a\\b',
]
let blocked = 0
for (const bad of trav) {
  const r = await call('GET', '/api/bili-duty/file?what=out&name=' + encodeURIComponent(bad))
  if (r.code === 400 || (r.json && r.json.ok !== true)) blocked++
}
ok('⭐ 路径穿越全被挡掉（这是个能读任意文件的口子）', blocked === trav.length, blocked + '/' + trav.length)
const subTrav = await call('GET', '/api/bili-duty/files?what=out&sub=' + encodeURIComponent('../..'))
ok('sub 参数也挡穿越（没跨出白名单根）', subTrav.json?.dir === fl.json?.dir || subTrav.json?.ok === false)

const d1 = await call('GET', '/api/bili-duty/download?what=out&name=' + day0 + '.md')
ok('/download 200', d1.code === 200)
ok('带了附件头（浏览器会存文件）', /attachment/.test(String(d1.headers['content-disposition'] || '')))
ok('中文文件名走 filename*（不然会被丢掉）',
  /filename\*=UTF-8''/.test(String(d1.headers['content-disposition'] || '')))
ok('非法文件名的下载被拒', (await call('GET', '/api/bili-duty/download?what=out&name=..%2f..%2fx')).code === 400)

/* ⑭ 收拾干净 —— 沙箱里的配置别留给下一次跑 */
await call('POST', '/api/bili-duty/config', { windows: [], noSubtitlePick: false, dmUids: [], dmUid: 0 })

/* ⑤ 未知路径要 404，不能挂 */
const nf = await call('GET', '/api/bili-duty/不存在的东西')
ok('未知路径返回 404', nf.code === 404, 'code=' + nf.code)

console.log(fails ? `\n❌ ${fails} 项没过` : '\n✅ 全部通过')
rmSync(SANDBOX, { recursive: true, force: true })
process.exit(fails ? 1 : 0)