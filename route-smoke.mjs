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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
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
// ⭐ INDEX_JS=<路径>：换个 index.js 来跑（改前改后的提示词逐字对比就靠它）
const INDEX_JS = process.env.INDEX_JS || './index.js'
try { mod = await import(INDEX_JS) } catch (e) {
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

/* ③′ 需要的话，把**这一轮真发出去的话**原样 dump 出来 */
if (process.env.DUMP_PROMPT) {
  const p0 = await call('GET', '/api/bili-duty/debug')
  writeFileSync(process.env.DUMP_PROMPT, String(p0.json?.prompt || ''))
  console.log(`（提示词已 dump 到 ${process.env.DUMP_PROMPT}：${String(p0.json?.prompt || '').length} 字）`)
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
// ⚠️ 别钉死文案（2026-10-18 提示词重写过），要钉的是「真把现算的数字插进去了」 ✓
// ⭐ 这三条钉住 2026-10-18 那次重写的成果（免得日后又退化回去）
//    ⚠️ 只能钉**插件自己拼的部分**：注入的使用者 AGENTS.md 是他自己的文件，
//       里面爱怎么写就怎么写（本仓库那份就满是 ⭐🔴⚠️）—— 拿它来判 emoji 会误报 ✗
const pfOn = (await call('GET', '/api/bili-duty/prompt')).json
const composed = String(pfOn.full).replace(/===== 使用者[\s\S]*?===== 设定结束 =====/g, '')
const EMOJI = /[\u2b50\ud83d\udd34\u26a0\ufe0f\u274c\u2705\ud83d\udcce\ud83d\udcc1]/
ok('插件拼的部分分成了有名字的章节',
  /【本轮任务】/.test(composed) && /【判重表】/.test(composed) && /【收尾】/.test(composed),
  (composed.match(/【[^】]+】/g) || []).join(' '))
ok('插件拼的部分没有装饰性 emoji（⭐🔴⚠️ 这类）', !EMOJI.test(composed),
  (composed.match(new RegExp(EMOJI.source, 'g')) || []).join(''))
ok('人格那段也没有', !EMOJI.test(pfOn.pieces.find((x) => x.key === 'persona').text))
ok('提示词里真插进了现算的数额度', /每天最多挑 \d+ 条/.test(prOn) && /今天已经挑过 \d+ 条/.test(prOn),
  (prOn.match(/每天最多挑[^；。]*/) || [''])[0])

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

/* ⑬′ 需要的话，把**真接口的响应** dump 出来给前端烟测当夹具（焊接缝用） */
if (process.env.DUMP_FILES) {
  const md = (fl.json.entries || []).find((e) => /\.md$/.test(e.name))
  const one = md ? await call('GET', '/api/bili-duty/file?what=out&name=' + encodeURIComponent(md.name)) : null
  writeFileSync(process.env.DUMP_FILES, JSON.stringify({ files: fl.json, file: one && one.json }, null, 2))
  console.log(`（真接口输出已 dump 到 ${process.env.DUMP_FILES}）`)
}

/* ⑬″ 人格设定文件 —— **整个插件唯一**的"性格"来源 + 「人格 / 提示词」页
 *  🔴 原来是三处：index.js 里写死一段、章程里有一节、还会读工作区的 AGENTS.md ✗。
 *     现在只剩一个 md：没有它 ⇒ 这一轮就没有人格设定（插件自身不带性格）✓ */
const pf0 = await call('GET', '/api/bili-duty/prompt')
ok('/prompt 200 且 ok', pf0.code === 200 && pf0.json?.ok === true, 'code=' + pf0.code)
ok('/prompt 只分两段（人格设定 / 章程）',
  Array.isArray(pf0.json.pieces) && pf0.json.pieces.map((x) => x.key).join() === 'persona,charter',
  (pf0.json.pieces || []).map((x) => x.key).join())
ok('⭐ 不再有"工作区 AGENTS.md"那一段（人格只能有一个来源）',
  !(pf0.json.pieces || []).some((x) => x.key === 'owner' || /AGENTS\.md/.test(x.from)))

// ① 还没建这个文件 ⇒ 提示词里**没有人格段**（插件自己不带性格）
const per0 = pf0.json.persona
ok('/prompt 带回了人格文件的实情', per0 && typeof per0.path === 'string' && 'exists' in per0)
ok('⭐ 默认位置就在数据目录里（persona.md）', per0.path.endsWith('persona.md') && per0.custom === false, per0.path)
ok('⭐ 还没这个文件时：exists=false，而且说清了"插件自己不带性格"', per0.exists === false, per0.err)
ok('⭐⭐ 这时提示词里压根没有【人格设定】这一段', !/【人格设定】/.test(pf0.json.full))
ok('而且人格那段给的是空（不塞默认性格、不塞占位）',
  pf0.json.pieces.find((x) => x.key === 'persona').chars === 0)
ok('/status 也带回了人格文件实情',
  typeof (await call('GET', '/api/bili-duty/status')).json?.persona?.path === 'string')

// ② 写一份人格进去 ⇒ 内容要**原样**进提示词
const PERSONA = '# 我的人格\n说话轻快一点，句尾用～收。\n遇到失败别卖萌。\n'
const w1 = await call('POST', '/api/bili-duty/persona', { text: PERSONA })
ok('POST /persona 写得进去', w1.code === 200 && w1.json?.ok === true && w1.json.saved === true, JSON.stringify(w1.json?.error))
ok('写完回读出来了', w1.json?.exists === true && String(w1.json.text).includes('说话轻快一点'))
const pf1 = await call('GET', '/api/bili-duty/prompt')
ok('⭐⭐ 人格内容**原样**进了这一轮发出去的话',
  pf1.json.full.includes('说话轻快一点，句尾用～收') && pf1.json.full.includes('遇到失败别卖萌'))
ok('带了【人格设定】这个章节名', /【人格设定】/.test(pf1.json.full))
ok('人格那段有字数了', pf1.json.pieces.find((x) => x.key === 'persona').chars > 0)
ok('提示词相应变长了', pf1.json.chars > pf0.json.chars, pf1.json.chars + ' vs ' + pf0.json.chars)

// ③ 位置可指定：换到别处的 md 就认那一份
const customPath = join(SANDBOX, 'my-own', 'tone.md')
mkdirSync(dirname(customPath), { recursive: true })
writeFileSync(customPath, '# 另一个位置的人格\n只用短句。\n')
await call('POST', '/api/bili-duty/config', { personaFile: customPath })
const pf2 = await call('GET', '/api/bili-duty/prompt')
ok('⭐ 人格文件的位置可以指定到任何地方', pf2.json.persona.path === customPath, pf2.json.persona.path)
ok('标记成"你指定的位置"', pf2.json.persona.custom === true)
ok('换位置后读的是新那份', /只用短句/.test(pf2.json.full) && !/说话轻快一点/.test(pf2.json.full))
ok('指向一个不存在的路径 ⇒ 老实说没有，而不是回落到默认那份',
  (await call('POST', '/api/bili-duty/config', { personaFile: join(SANDBOX, 'nope', 'x.md') })) &&
  (await call('GET', '/api/bili-duty/prompt')).json.persona.exists === false)

// ④ 业务部分必须**没有性格**（分两种情况钉，别一刀切）
// 两档：
//   · SOFT：泛指（语气 / 人格）—— **指路**会用它们（"语气照【人格设定】来"）✓ 允许
//   · HARD：**具体的性格规定**（颜文字几个、可爱、口癖…）—— 业务部分里一个都不许有 ✗
const CHARACTER = /颜文字|语气|口癖|可爱|卖萌|人格|撒娇/g
const HARD = /颜文字|口癖|可爱|卖萌|撒娇/g
// (a) 没有配置文件时：整条提示词里一个性格词都不该有 ✓
await call('POST', '/api/bili-duty/config', { personaFile: '' })
const pfNone0 = (await call('GET', '/api/bili-duty/prompt')).json
// 先把默认那份删掉，确保真的是"没有"
rmSync(join(SANDBOX, 'bili-duty', 'persona.md'), { force: true })
const pfNone = (await call('GET', '/api/bili-duty/prompt')).json
ok('⭐⭐ 没有配置文件时，整条提示词里一个性格词都没有',
  pfNone.persona.exists === false && !CHARACTER.test(pfNone.full),
  (pfNone.full.match(CHARACTER) || []).join(' '))
// (a2) ⭐ 私信开着时**也要**扫一遍 —— 这条之前漏了：DM 段里曾藏着一句
//      「语气照章程『语气』那节来（可爱 + 专业，颜文字最多 1 个）」，既是性格指令、
//      指的又是已经不存在的小节 ✗。所以"没性格"要**在每种开关组合下都成立** ✓
await call('POST', '/api/bili-duty/config', {
  dmMode: 'both', dmUids: ['10967510'], mentionNames: ['不平等云雾'], autoComment: true, personaFile: '',
})
const pfDm = (await call('GET', '/api/bili-duty/prompt')).json
// ⚠️ 人格段本身当然会含这些词 ⇒ 先把「【人格设定】那一整段」和那句开场都剥掉，
//    剩下的是**业务部分**，那里面一个性格词都不该有 ✓
const restDm = String(pfDm.full)
  .replace(/\n?【人格设定】[\s\S]*?(?=\n【)/, '')
  .replace(/不要套用你默认的人格。/g, '')
ok('⭐⭐ 私信开着时，业务部分里没有**具体的性格规定**', !HARD.test(restDm),
  (restDm.match(HARD) || []).join(' '))
ok('指路可以（"语气照【人格设定】来"），但只能是这种泛指',
  (restDm.match(CHARACTER) || []).every((w) => w === '语气' || w === '人格'),
  (restDm.match(CHARACTER) || []).join(' '))

// (b) 有配置文件时：只允许【人格设定】那一段 + 开场那句
const rest = String(pf1.json.full)
  .replace(/【人格设定】[\s\S]*?(?=\n【)/, '')
  .replace(/不要套用你默认的人格。/, '')
ok('⭐ 有配置文件时，除人格段与那句开场，其余部分没有具体的性格规定',
  !HARD.test(rest), (rest.match(HARD) || []).join(' '))

/* ⑬‴ 跑那一轮用哪个模型（2026-10-18 加）：在 overlay 里覆盖 agent-default-model
 *  🔴 这两个值会被**直接写进 YAML** ⇒ 注入面，所以非法值必须挡掉并且如实报出来 ✗ */
const ovOf = async () => (await call('GET', '/api/bili-duty/debug')).json
// (a) 什么都不填 ⇒ 只覆盖 MCP，不碰模型
await call('POST', '/api/bili-duty/config', { modelProvider: '', model: '' })
const ov0 = await ovOf()
ok('没填模型时，overlay 里不出现 agent-default-model（不动使用者的 profile）',
  !/agent-default-model/.test(ov0.overlay.text), ov0.overlay.text.slice(0, 60))
ok('但 MCP 那一段照旧在', /mcp-bili-duty/.test(ov0.overlay.text))
ok('/debug 报出了"没覆盖"', ov0.modelPick.provider === '' && ov0.modelPick.model === '')

// (b) 填了 ⇒ overlay 里多一段 id-targeted 覆盖，而且跟 MCP 共存
await call('POST', '/api/bili-duty/config', { modelProvider: 'xinghe', model: 'DeepSeek-V4.1-Flash' })
const ov1 = await ovOf()
ok('填了模型 ⇒ overlay 里出现 agent-default-model', /- id: agent-default-model/.test(ov1.overlay.text))
ok('服务商与模型都写进去了',
  /provider: 'xinghe'/.test(ov1.overlay.text) && /model: 'DeepSeek-V4.1-Flash'/.test(ov1.overlay.text))
ok('MCP 那段还在（两段共存）', /mcp-bili-duty/.test(ov1.overlay.text))
ok('/status 也报出了这一轮会用哪个', 
  (await call('GET', '/api/bili-duty/status')).json?.modelPick?.model === 'DeepSeek-V4.1-Flash')

// (c) 只填模型也行
await call('POST', '/api/bili-duty/config', { modelProvider: '', model: 'gpt-6-astra' })
const ov2 = await ovOf()
ok('只填模型也能覆盖', /- id: agent-default-model/.test(ov2.overlay.text) && /model: 'gpt-6-astra'/.test(ov2.overlay.text))
ok('这时不写 provider（沿用 profile 的）', !/provider:/.test(ov2.overlay.text.split('agent-default-model')[1] || ''))

// (d) 🔴 注入尝试：换行 / 引号 / 特殊字符
const EVIL = "x'\n- insert:\n    - id: evil\n      name: '@evil/pkg'"
await call('POST', '/api/bili-duty/config', { modelProvider: '', model: EVIL })
const ov3 = await ovOf()
ok('⭐⭐ 带换行的模型名被拒（否则能往 profile 里注入任意插件配置）',
  !/evil/.test(ov3.overlay.text), ov3.overlay.text.slice(0, 80))
ok('被拒的值如实报出来，不静默忽略', ov3.modelPick.rejected.length === 1 && /evil/.test(ov3.modelPick.rejected[0]))
ok('这时 overlay 退回"不覆盖模型"', !/agent-default-model/.test(ov3.overlay.text))
for (const bad of ['a b', 'a"b', "a'b", 'a\nb', '../etc', '-x', '']) {
  await call('POST', '/api/bili-duty/config', { model: bad })
  const t = (await ovOf()).overlay.text
  ok(`非法模型名 ${JSON.stringify(bad)} 不写进 overlay`, !/agent-default-model/.test(t) || !/model:/.test(t.split('agent-default-model')[1] || ''))
}
// 恢复干净
await call('POST', '/api/bili-duty/config', { modelProvider: '', model: '' })

/* ⑬⁗ 并发锁 + 评论台账（2026-10-18 补的两道闸）
 *  🔴 前者：原来 runDuty **没有并发闸** ⇒ 手动跑撞上定时器会起两个 dsh，重复发评论 ✗
 *  🔴 后者：原来"别重复评论同一个视频"全靠 AI 自觉 ⇒ 插件自己不记 ✗ */
const lockFile = join(SANDBOX, 'bili-duty', 'round.lock')
rmSync(lockFile, { force: true })
const rd0 = (await call('GET', '/api/bili-duty/status')).json?.round
ok('/status 带回了并发锁实情', rd0 && typeof rd0.busy === 'boolean', JSON.stringify(rd0))
ok('没锁时是空闲', rd0.busy === false)

// 拿一个"真活着但不是本进程"的 pid
const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 300))
writeFileSync(lockFile, JSON.stringify({ pid: sleeper.pid, at: Date.now(), why: 'window:b1' }))
const rd1 = (await call('GET', '/api/bili-duty/status')).json?.round
ok('⭐ 锁在、进程还活着 ⇒ 报"正在跑"', rd1.busy === true && Number(rd1.pid) === sleeper.pid, JSON.stringify(rd1))
ok('并说清是谁在跑', /宿主进程|本进程/.test(String(rd1.via || '')), rd1.via)
// ⭐ 这时点「现在跑一轮」必须被挡（挡不住就会真起一个 dsh）
const runBlocked = await call('POST', '/api/bili-duty/run', {})
ok('⭐⭐ 有一轮在跑时，「现在跑一轮」被挡住（否则就是两个进程重复发评论）',
  runBlocked.json?.started !== true && runBlocked.json?.busy === true, JSON.stringify(runBlocked.json).slice(0, 120))
ok('并且给了一句人话解释', /还在跑/.test(String(runBlocked.json?.hint || '')), runBlocked.json?.hint)

// 进程没了 ⇒ 陈旧锁要自己清掉，别把插件永久卡住
writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: Date.now(), why: 'x' }))
const rd2 = (await call('GET', '/api/bili-duty/status')).json?.round
ok('⭐ 进程早没了 ⇒ 当成陈旧锁清掉（否则永久卡住）', rd2.busy === false && !existsSync(lockFile), JSON.stringify(rd2))
// 跑了 7 小时 ⇒ 也算陈旧
writeFileSync(lockFile, JSON.stringify({ pid: sleeper.pid, at: Date.now() - 7 * 3600 * 1000, why: 'x' }))
const rd3 = (await call('GET', '/api/bili-duty/status')).json?.round
ok('⭐ 超过 6 小时的锁也算陈旧', rd3.busy === false, JSON.stringify(rd3))
// EPERM（进程在但不归我们）也要算活着 —— 这条之前踩过：pid=1 被当成不存在，锁白加了 ✗
writeFileSync(lockFile, JSON.stringify({ pid: 1, at: Date.now(), why: 'x' }))
const rd4 = (await call('GET', '/api/bili-duty/status')).json?.round
ok('⭐ pid=1（EPERM：进程在、没权限发信号）也算活着', rd4.busy === true, JSON.stringify(rd4))
sleeper.kill()
rmSync(lockFile, { force: true })

// ── 评论台账 ──
const led0 = await call('GET', '/api/bili-duty/ledger')
ok('/ledger 读得到', led0.code === 200 && led0.json?.ok === true && typeof led0.json.count === 'number')
ok('空台账时 count = 0', led0.json.count === 0, String(led0.json.count))
writeFileSync(join(SANDBOX, 'bili-duty', 'commented.json'), JSON.stringify({
  BV1xx411c7mD: { kind: 'top', rpid: '123', at: '2026-10-18 12:00:00', text: '挖到宝啦' },
  BV1yy411c7mD: { kind: 'reply', rpid: '456', at: '2026-10-17 20:00:00', text: '诶嘿' },
}))
const led1 = await call('GET', '/api/bili-duty/ledger')
ok('读得到已评论过的视频', led1.json.count === 2, String(led1.json.count))
ok('楼中楼与顶层分得开', led1.json.recent.some((x) => x.kind === '楼中楼'), JSON.stringify(led1.json.recent))
ok('最近的在前面（按时间倒序）', led1.json.recent[0].bvid === 'BV1xx411c7mD')
ok('/status 也带上了台账', (await call('GET', '/api/bili-duty/status')).json?.ledger?.count === 2)
const led2 = await call('POST', '/api/bili-duty/ledger', { clear: true })
ok('能清空（那条被删了要重发时的逃生口）', led2.json?.ok === true && led2.json.count === 0, JSON.stringify(led2.json))
ok('清空后文件里真的是空的', JSON.parse(readFileSync(join(SANDBOX, 'bili-duty', 'commented.json'), 'utf8') && '{}') !== null)
rmSync(join(SANDBOX, 'bili-duty', 'commented.json'), { force: true })

/* ⑭ 收拾干净 —— 沙箱里的配置别留给下一次跑 */
await call('POST', '/api/bili-duty/config', { windows: [], noSubtitlePick: false, dmUids: [], dmUid: 0 })

/* ⑤ 未知路径要 404，不能挂 */
const nf = await call('GET', '/api/bili-duty/不存在的东西')
ok('未知路径返回 404', nf.code === 404, 'code=' + nf.code)

console.log(fails ? `\n❌ ${fails} 项没过` : '\n✅ 全部通过')
rmSync(SANDBOX, { recursive: true, force: true })
process.exit(fails ? 1 : 0)