/**
 * lib/state.mjs —— 插件的"家"与配置
 * ============================================================================
 * 规矩（抄 whale_craft）：**配置、凭证、报告、日志都放插件自己的家** ——
 * `$DSH_HOME/bili-duty/`，**绝不写进插件包目录**（装进 node_modules 后可能只读、升级也会被覆盖）。
 *
 * 还有一件小事但很要紧：vendored 的 `mcp_server.py` 里，凭证路径是
 * `Path(__file__).parent / "bili_credential.json"` —— 所以**运行时要把脚本拷到数据目录里再跑**，
 * 这样凭证才会落在家的目录，而不是插件包里。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 谷时窗口（北京时间）—— 想改就改这一处。
 * ⭐ 官方口径（2026-09-10 起的新定价）：**高峰 = 工作日 9:00–12:00 与 14:00–18:00，其余全是谷时**
 *    ⇒ 12:00–14:00（夹在两个高峰之间）✓、18:00 之后的一整晚 ✓、以及**整个周末** ✓ 都便宜。
 * ⚠️ 我们原来写的 00:30–08:30 是 DeepSeek **早年**的错峰优惠时段，**已经过时** ✗
 *    —— 2026-10-14 使用者在"陌生人验收"里问「晚上峰谷真的是12点半才开始的吗」才查出来 ✓。
 */
export const WINDOWS = {
  noon: { label: '中午谷时', start: '12:00', end: '14:00' },
  night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
}

/**
 * ⭐ 2026-10-14 真机上踩到的坑（dsh 只留一句 `warning: 1 entry did not activate` + 堆栈）：
 *    `ctx.get('dshHomePath')` 返回的是**函数**，不是字符串！
 *    形状：`dshHomePath(...segments) => join(resolveDshHome(), ...segments)`（whale_craft 就是这么用的）。
 *    我一开始当字符串用（`String(p)`），路径就成了「函数源码 + \bili-duty」⇒ mkdir ENOENT ⇒ apply 抛错 ⇒ 插件不激活。
 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('bili-duty')                       // ← 函数形态：把目录名传进去
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'bili-duty')
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/** 首次运行：把 vendored 的 MCP 脚本和值班章程拷进家里（脚本变了就覆盖，章程不覆盖用户改过的） */
export function ensureHomeFiles(pluginDir, stateDir, log = () => {}) {
  const copies = [
    [join(pluginDir, 'vendor', 'bilibili-mcp', 'mcp_server.py'), join(stateDir, 'mcp_server.py'), true],
    [join(pluginDir, 'prompts', 'duty.md'), join(stateDir, 'duty.md'), false],
    [join(pluginDir, 'lib', 'asr.py'), join(stateDir, 'asr.py'), true],
  ]
  for (const [from, to, overwrite] of copies) {
    try {
      if (!existsSync(from)) { log(`缺文件：${from}`); continue }
      if (!overwrite && existsSync(to)) continue
      if (overwrite && existsSync(to) && readFileSync(from, 'utf8') === readFileSync(to, 'utf8')) continue
      copyFileSync(from, to)
      log(`已铺好：${to}`)
    } catch (e) { log(`铺 ${to} 失败：${e?.message ?? e}`) }
  }
}

/** 'HH:MM' → 当天的分钟数（0..1439）；不合法返回 null */
export function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1]); const mi = Number(m[2])
  if (h > 23 || mi > 59) return null          // ⚠️ 光靠正则不够：25:99 也长得像时间
  return h * 60 + mi
}

/** 分钟数 → 'HH:MM'（1440 之类越界值会绕回来） */
export function hhmm(min) {
  const m = ((Number(min) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 现在在不在这个窗口里（支持跨零点，比如 23:00–02:00；起止相同 = 全天） */
export function inWindow(now, win) {
  const start = minutesOf(win?.start); const end = minutesOf(win?.end)
  if (start === null || end === null) return false
  if (start === end) return true
  const cur = now.getHours() * 60 + now.getMinutes()
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/* ────────────────────────────────────────────────────────────────────────────
 * 自定义时段（2026-10-18 加）
 *
 * 存法：`config.json` 里是**字符串数组** —— `["12:00-14:00","18:00-09:00"]`。
 * 为什么不在数组里套对象：那份 schema 会被 `ctx.settings.register` 拿去做 DSH 自带设置页的
 * 表单，`z.array(z.object(...))` 的支持面我们没验过；**字符串数组是确定安全的** ✓，
 * 而且人直接打开 config.json 也一眼能读懂。
 * ──────────────────────────────────────────────────────────────────────────── */

/** "HH:MM-HH:MM" → {start,end}；看不懂返回 null。分隔符 - ~ ～ – — 都认 */
export function parseWindow(s) {
  const m = /^(\d{1,2}:\d{2})\s*[-~～–—]\s*(\d{1,2}:\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const start = minutesOf(m[1]); const end = minutesOf(m[2])
  if (start === null || end === null) return null
  return { start: hhmm(start), end: hhmm(end) }
}

/** {start,end} → "HH:MM-HH:MM" */
export const windowText = (w) => `${w.start}-${w.end}`

/** 把人填的时段表规范化：丢掉空的 / 看不懂的，保留顺序；上限 12 条 */
export function normWindows(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const w = typeof raw === 'string' ? parseWindow(raw) : parseWindow(windowText(raw || {}))
    if (w) out.push(w)
    if (out.length >= 12) break
  }
  return out
}

/** 一个时段盖在"一天 0..1440 分钟"上的区间（跨零点 → 两段） */
function spans(w) {
  const s = minutesOf(w.start); const e = minutesOf(w.end)
  if (s === null || e === null) return []
  if (s === e) return [[0, 1440]]              // 起止相同 = 全天
  return s < e ? [[s, e]] : [[s, 1440], [0, e]]
}

/** 两个时段有没有重叠 */
export function overlapOf(a, b) {
  for (const [as, ae] of spans(a)) {
    for (const [bs, be] of spans(b)) {
      if (as < be && bs < ae) return true
    }
  }
  return false
}

/**
 * 时段体检：重复 / 重叠 / 整天。**只用来给设置页显示告警，不阻断保存** ——
 * 重叠不会跑坏：调度器会把"此刻命中的每一条"一起记为已跑，所以只会少跑、不会多跑 ✓。
 */
export function analyzeWindows(list) {
  const ws = normWindows(list)
  const issues = []
  const seen = new Map()
  ws.forEach((w, i) => {
    const t = windowText(w)
    if (seen.has(t)) issues.push({ kind: 'dup', i, j: seen.get(t), text: `时段 ${i + 1} 与 时段 ${seen.get(t) + 1} 完全相同` })
    else seen.set(t, i)
    if (w.start === w.end) issues.push({ kind: 'allday', i, text: `时段 ${i + 1} 起止相同 ⇒ 当作全天` })
  })
  for (let i = 0; i < ws.length; i++) {
    for (let j = i + 1; j < ws.length; j++) {
      // ⚠️ 完全相同的两条已经在上面报过 dup 了 —— 别再补一句"重叠"，
      //    同一个毛病说两遍只会让人以为是两个问题
      if (windowText(ws[i]) === windowText(ws[j])) continue
      if (overlapOf(ws[i], ws[j])) {
        issues.push({
          kind: 'overlap', i, j,
          text: `时段 ${i + 1}（${windowText(ws[i])}）与 时段 ${j + 1}（${windowText(ws[j])}）重叠`,
        })
      }
    }
  }
  return { windows: ws, issues }
}

/**
 * 真正生效的时段表。内容里的 `windows` **非空就以它为准**（内置的中午/夜间就此让位）；
 * 空的就退回内置那两组，再看 `noon` / `night` 两个老开关。
 * @returns {Array<{key:string,label:string,start:string,end:string}>}
 */
export function effectiveWindows(cfg) {
  const custom = normWindows(cfg?.windows)
  if (custom.length) return custom.map((w, i) => ({ key: `w${i + 1}`, label: `时段 ${i + 1}`, ...w }))
  return ['noon', 'night']
    .filter((k) => cfg?.[k] !== false)
    .map((k) => ({ key: k, label: WINDOWS[k].label, start: WINDOWS[k].start, end: WINDOWS[k].end }))
}

/* ────────────────────────────────────────────────────────────────────────────
 * "这一段什么时候算跑过" —— 调度器唯一的判据，也是最容易做错的地方。
 *
 * 🔴 为什么不能按单条时段记：使用者填了 `12:00-14:00` 和 `13:00-15:00`（重叠）时，
 *    12:00 只有第一条命中 ⇒ 只记第一条；到 13:00 第二条刚命中、又"没跑过" ⇒ **一小时后又刷一轮** ✗。
 *    跨零点同病：`18:00-09:00` 记成"当天"，到了次日 00:30 日期变了 ⇒ 凌晨再刷一轮 ✗。
 *
 * ⇒ 正确的判据是**覆盖块**（block）：把互相重叠的时段并成一段（首尾相接不算重叠，那是两场），
 *    一次只记"**这一段连续覆盖是什么时候开始的**"。
 *    12-14 ∪ 13-15 = 一段 12:00→15:00 ⇒ 只有 12:00 那一轮 ✓
 *    18:00-09:00 跨过零点仍是同一段 ⇒ 00:30 那会儿算作**昨天傍晚**开始的那一场 ✓
 * ──────────────────────────────────────────────────────────────────────────── */

/** 规范化但**保留 label**（告警与报告里要能说人话，不能只剩个 "18:00-09:00"） */
function normKeep(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const isObj = raw && typeof raw === 'object'
    const w = parseWindow(isObj ? windowText(raw) : raw)
    if (!w) continue
    out.push({ ...w, label: isObj && raw.label ? String(raw.label) : windowText(w) })
    if (out.length >= 12) break
  }
  return out
}

/**
 * 把时段并成"覆盖块"。互相重叠的归一块（并查集传递闭包），**首尾相接（14:00 接 14:00）不并** ——
 * 那本来就是两场，使用者写两条相邻的时段多半就是想跑两次 ✓。
 * @returns {Array<{key:string, cov:boolean[], labels:string[]}>}
 */
export function windowBlocks(list) {
  const ws = normKeep(list)
  if (!ws.length) return []
  const parent = ws.map((_, i) => i)
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  for (let i = 0; i < ws.length; i++) {
    for (let j = i + 1; j < ws.length; j++) {
      if (overlapOf(ws[i], ws[j])) parent[find(i)] = find(j)
    }
  }
  const groups = new Map()
  ws.forEach((w, i) => {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(w)
  })
  return [...groups.values()].map((g, n) => {
    const cov = new Array(1440).fill(false)
    for (const w of g) for (const [a, b] of spans(w)) for (let i = a; i < b; i++) cov[i] = true
    return { key: `b${n + 1}`, cov, labels: g.map((w) => w.label) }
  })
}

/**
 * 此刻落在哪个覆盖块里，以及**这一段是从什么时候开始的**（决定它算哪一场）。
 * @returns {{ key:string, startMin:number, labels:string[] }|null}
 */
export function blockAt(now, blocks) {
  const cur = now.getHours() * 60 + now.getMinutes()
  for (const b of blocks || []) {
    if (!b.cov?.[cur]) continue
    // 往前一直走到覆盖断掉为止 —— 跨零点会绕回 1439，这就是"跨零点算同一段"的实现
    let back = 0
    while (back < 1440) {
      const prev = (cur - back - 1 + 1440) % 1440
      if (!b.cov[prev]) break
      back++
    }
    const full = back >= 1440                                   // 全天覆盖：一段 = 一个自然日
    const startMin = full ? 0 : (cur - back + 1440) % 1440
    const wrapped = !full && back > cur                         // 回过头跨过了零点 ⇒ 起点在昨天
    const base = wrapped ? new Date(now.getTime() - 86400000) : now
    return { key: `${dayKey(base)}:${b.key}:${hhmm(startMin)}`, startMin, labels: b.labels }
  }
  return null
}

/**
 * 下一次（严格晚于 now）会真的跑起来的时刻 —— 给设置页显示"下次什么时候跑"。
 * 直接按分钟往后扫（最多 8 天）：一天 1440 次、8 天一万多次，**便宜而且显然不会算错**，
 * 比再推导一套"下次落点"的解析式靠谱得多 ✓。
 * @param done 已经跑过的场次 key（Set 或数组）—— ⚠️ 不带这个的话，"此刻正处在一个已经跑过的时段里"
 *             会被误报成"下一分钟就跑"
 */
export function nextRunAt(now, list, done) {
  const blocks = windowBlocks(list)
  if (!blocks.length) return null
  const seen = done instanceof Set ? done : new Set(Array.isArray(done) ? done : [])
  for (let t = 1; t <= 8 * 1440; t++) {
    const d = new Date(now.getTime() + t * 60000)
    const at = blockAt(d, blocks)
    if (at && !seen.has(at.key)) return d
  }
  return null
}
