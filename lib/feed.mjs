/**
 * lib/feed.mjs —— 「荐片」模式的数据层（全纯函数优先，方便单测）
 * ============================================================================
 * 职责：
 *   ① 家目录 feed/ 的路径与预建（沙箱规则：headless 那一轮只能写"启动前已存在"的目录）
 *   ② 浏览历史 → history.json / history-brief.md / signals.json
 *   ③ 画像模板、batch 校验、已推列表、反馈、状态的读写
 *   ④ 提示词拼装（纯函数，输入全给参数，方便测试）
 *
 * 约定：所有时间戳字段用「秒」（与 B站 view_at 一致），只有 createdAt/lastRunAt 用 ISO 字符串。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey } from './state.mjs'

/** batch 最多几条（章程与校验共用） */
export const FEED_MAX_ITEMS = 10
/** 家目录下荐片子目录名 */
export const FEED_DIRNAME = 'feed'

/** 家目录里 feed/ 的全部固定路径 */
export function feedPaths(stateDir) {
  const dir = join(stateDir, FEED_DIRNAME)
  return {
    dir,
    history: join(dir, 'history.json'),
    brief: join(dir, 'history-brief.md'),
    signals: join(dir, 'signals.json'),
    profile: join(dir, 'profile.md'),
    recommended: join(dir, 'recommended.jsonl'),
    feedback: join(dir, 'feedback.jsonl'),
    batches: join(dir, 'batches'),
    state: join(dir, 'state.json'),
    pushLog: join(dir, 'push.log'),
    charter: join(stateDir, 'feed.md'),
  }
}

/** 预建所有目录（宿主启动时调一次；幂等） */
export function ensureFeedDirs(stateDir) {
  const p = feedPaths(stateDir)
  mkdirSync(p.dir, { recursive: true })
  mkdirSync(p.batches, { recursive: true })
  return p
}

/** 画像模板（profile.md 不存在时给 panel / 章程用） */
export function defaultProfile() {
  return [
    '# 我的 B站 兴趣画像',
    '<!-- 由大肥鱼自动维护；你可以直接改，下一轮会读你的版本 -->',
    '',
    '## 核心兴趣（长期）',
    '- （还没有足够数据，先留空）',
    '',
    '## 最近在关注（7 天内）',
    '- （等第一轮跑完会自动填）',
    '',
    '## 喜欢的 UP 主',
    '- ',
    '',
    '## 明确不想看',
    '- ',
    '',
    '## 证据与观察',
    '- ',
    '',
    '## 更新日志',
    '- ',
    '',
  ].join('\n')
}

/** 'HH:MM' 归一化（容忍 9:5 这种随手写）；不合法返回 null */
function normTime(v) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v ?? '').trim())
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/**
 * 解析 feedTimes（数组或逗号/空格分隔字符串）→ 去重、升序、最多 3 个。
 * 一个合法值都没有时退回默认 ["21:00"]（合同：1–3 个）。
 */
export function parseFeedTimes(input) {
  let arr = []
  if (Array.isArray(input)) arr = input
  else if (typeof input === 'string') arr = input.split(/[,，\s]+/)
  const out = []
  for (const raw of arr) {
    const t = normTime(raw)
    if (t && !out.includes(t)) out.push(t)
  }
  out.sort()
  return out.length ? out.slice(0, 3) : ['21:00']
}

/** 本地时间 batchId：YYYYMMDD-HHmm */
export function batchIdOf(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
}

/** 读 JSONL（坏行跳过），limit 取最后 N 条 */
export function readJsonl(file, limit = 0) {
  const out = []
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim()
      if (!s) continue
      try { out.push(JSON.parse(s)) } catch { /* 坏行跳过 */ }
    }
  } catch { /* 文件不存在 */ }
  return limit > 0 ? out.slice(-limit) : out
}

/** 追加一行 JSONL */
export function appendJsonl(file, obj) {
  appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
}

/** 已推列表（最近 limit 条） */
export function loadRecommended(stateDir, limit = 500) {
  return readJsonl(feedPaths(stateDir).recommended, limit)
}

/** 反馈（最近 limit 条） */
export function loadFeedback(stateDir, limit = 500) {
  return readJsonl(feedPaths(stateDir).feedback, limit)
}

/** 读 feed/state.json（默认形状） */
export function readFeedState(stateDir) {
  try {
    const v = JSON.parse(readFileSync(feedPaths(stateDir).state, 'utf8'))
    if (v && typeof v === 'object') {
      return { day: '', runs: {}, lastBatchId: '', lastRunAt: '', lastAttemptAt: '', lastError: '', ...v }
    }
  } catch { /* 没有就用默认 */ }
  return { day: '', runs: {}, lastBatchId: '', lastRunAt: '', lastAttemptAt: '', lastError: '' }
}

/** 写 feed/state.json */
export function writeFeedState(stateDir, state) {
  const p = feedPaths(stateDir)
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.state, JSON.stringify(state, null, 2), 'utf8')
}

/**
 * 标记「今天这个时间点已经跑过」（纯函数，便于单测）
 * @param {object} state 旧 state
 * @param {string} day   YYYY-MM-DD
 * @param {string} time  HH:MM
 */
export function markFeedRan(state, day, time) {
  const runs = (state && state.day === day && state.runs && typeof state.runs === 'object') ? { ...state.runs } : {}
  const arr = Array.isArray(runs[day]) ? [...runs[day]] : []
  if (!arr.includes(time)) arr.push(time)
  return { ...(state || {}), day, runs: { ...runs, [day]: arr } }
}

/** 秒 → mm:ss / h:mm:ss */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const ss = s % 60
  const p = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`
}

/** 相对时间（给 brief 读） */
function relativeTime(viewAt, now) {
  const t = Number(viewAt) || 0
  if (!t) return '时间未知'
  const diff = Math.max(0, now.getTime() / 1000 - t)
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} 分钟前`
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`
  return `${Math.round(diff / 86400)} 天前`
}

/** B站视频链接 */
export function videoUrl(bvid) {
  return `https://www.bilibili.com/video/${String(bvid || '').replace(/[^0-9A-Za-z]/g, '')}`
}

/** 历史条目归一化（MCP 用 snake_case，这里统一成 camelCase） */
export function normalizeHistoryItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const bvid = String(raw.bvid || '').trim()
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return null
  const duration = Math.max(0, Number(raw.duration) || 0)
  const progress = raw.progress === undefined || raw.progress === null ? -1 : Number(raw.progress)
  const viewAt = Number(raw.view_at ?? raw.viewAt) || 0
  return {
    bvid,
    title: String(raw.title || '').slice(0, 300),
    author: String(raw.author || '').slice(0, 120),
    cover: String(raw.cover || '').slice(0, 500),
    duration,
    progress: Number.isFinite(progress) ? progress : -1,
    viewAt,
    // 完播率：progress<=0 表示没记录/没看 ⇒ 0
    completion: duration > 0 && progress > 0 ? Math.min(1, progress / duration) : 0,
  }
}

/**
 * 计算机器信号（不解读语义，只做统计；语义归纳交给 Agent）
 * @param {Array} items normalizeHistoryItem 之后的条目
 * @param {Date} now
 */
export function computeSignals(items, now = new Date()) {
  const list = items.filter(Boolean)
  const byAuthorMap = new Map()
  const nowSec = now.getTime() / 1000
  for (const it of list) {
    if (!it.author) continue
    const cur = byAuthorMap.get(it.author) || { author: it.author, count: 0, sumCompletion: 0, totalDuration: 0 }
    cur.count += 1
    cur.sumCompletion += it.completion
    cur.totalDuration += it.duration
    byAuthorMap.set(it.author, cur)
  }
  const byAuthor = [...byAuthorMap.values()]
    .filter((a) => a.count >= 2)
    .map((a) => ({ author: a.author, count: a.count, avgCompletion: Number((a.sumCompletion / a.count).toFixed(3)), totalDuration: a.totalDuration }))
    .sort((a, b) => b.totalDuration - a.totalDuration)
    .slice(0, 30)

  const topCompleted = list
    .filter((it) => it.completion >= 0.8 && it.duration >= 60)
    .sort((a, b) => b.viewAt - a.viewAt)
    .slice(0, 15)
    .map((it) => ({ bvid: it.bvid, title: it.title, author: it.author, completion: Number(it.completion.toFixed(3)), viewAt: it.viewAt }))

  const lowestCompleted = list
    .filter((it) => it.duration >= 120 && it.completion <= 0.15)
    .sort((a, b) => b.viewAt - a.viewAt)
    .slice(0, 10)
    .map((it) => ({ bvid: it.bvid, title: it.title, author: it.author, completion: Number(it.completion.toFixed(3)), viewAt: it.viewAt }))

  const byViewAtDesc = [...list].sort((a, b) => b.viewAt - a.viewAt)
  return {
    fetchedAt: Math.floor(nowSec),
    counts: { total: list.length, last7d: list.filter((it) => nowSec - it.viewAt <= 7 * 86400).length, last30d: list.filter((it) => nowSec - it.viewAt <= 30 * 86400).length },
    byAuthor,
    topCompleted,
    lowestCompleted,
    recentBvids: byViewAtDesc.slice(0, 120).map((it) => it.bvid),
    recentAuthors: [...new Set(byViewAtDesc.slice(0, 60).map((it) => it.author).filter(Boolean))].slice(0, 20),
  }
}

/**
 * 给 Agent 读的浏览摘要（≤120 行）
 * @param {object} history {items, count, days, fetchedAt}
 * @param {object} signals computeSignals 的结果
 * @param {Date} now
 */
export function renderHistoryBrief(history, signals, now = new Date()) {
  const items = (history.items || []).slice()
  const byBvid = new Map(items.map((it) => [it.bvid, it]))
  const lines = []
  lines.push(`# 最近 ${history.days} 天浏览摘要（共 ${history.count} 条）`)
  lines.push('')
  lines.push('> 这是宿主按你的 B站 观看历史做的**原始统计**，不是 AI 总结。完播率 = 看到的位置 / 视频时长。')
  lines.push('')
  const top = (signals.topCompleted || [])
  lines.push('## 完播率最高的 15 条（≥80%，按最近排序）')
  if (!top.length) lines.push('- （无）')
  for (const it of top) {
    const full = byBvid.get(it.bvid) || {}
    lines.push(`- [${it.bvid}] ${it.title} · ${it.author || '?'} · ${fmtDuration(full.duration)} · 完播 ${Math.round(it.completion * 100)}% · ${relativeTime(it.viewAt, now)} · ${videoUrl(it.bvid)}`)
  }
  lines.push('')
  lines.push('## 最近 20 条（时间序）')
  const recent = [...items].sort((a, b) => b.viewAt - a.viewAt).slice(0, 20)
  if (!recent.length) lines.push('- （无）')
  for (const it of recent) {
    lines.push(`- [${it.bvid}] ${it.title} · ${it.author || '?'} · ${fmtDuration(it.duration)} · 完播 ${Math.round(it.completion * 100)}% · ${relativeTime(it.viewAt, now)}`)
  }
  lines.push('')
  lines.push('## 完播率最低的 10 条（≤15%，可能是标题党 / 不感兴趣信号）')
  const low = signals.lowestCompleted || []
  if (!low.length) lines.push('- （无）')
  for (const it of low) {
    lines.push(`- [${it.bvid}] ${it.title} · ${it.author || '?'} · 完播 ${Math.round(it.completion * 100)}% · ${relativeTime(it.viewAt, now)}`)
  }
  lines.push('')
  lines.push('## 按 UP 主统计（≥2 条，按总时长排序）')
  const authors = (signals.byAuthor || []).slice(0, 15)
  if (!authors.length) lines.push('- （无）')
  for (const a of authors) {
    lines.push(`- ${a.author} · ${a.count} 条 · 平均完播 ${Math.round(a.avgCompletion * 100)}% · 总计 ${Math.round(a.totalDuration / 60)} 分钟`)
  }
  lines.push('')
  lines.push('## 最近 7 天 vs 30 天（新增关注线索）')
  lines.push(`- 最近 7 天 ${signals.counts?.last7d ?? 0} 条 / 最近 30 天 ${signals.counts?.last30d ?? 0} 条（共 ${signals.counts?.total ?? items.length} 条）`)
  if (Array.isArray(signals.recentAuthors) && signals.recentAuthors.length) {
    lines.push(`- 最近 60 条里出现的 UP：${signals.recentAuthors.slice(0, 12).join('、')}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 历史 → 三个文件（history.json / signals.json / history-brief.md）
 * @returns {{history:object, signals:object, brief:string}}
 */
export function writeHistory(stateDir, rawItems, { days = 30, fetchedAt = Math.floor(Date.now() / 1000), now = new Date() } = {}) {
  const p = feedPaths(stateDir)
  mkdirSync(p.dir, { recursive: true })
  const seen = new Set()
  const items = []
  for (const raw of rawItems || []) {
    const it = normalizeHistoryItem(raw)
    if (!it || seen.has(it.bvid)) continue
    seen.add(it.bvid)
    items.push(it)
  }
  items.sort((a, b) => b.viewAt - a.viewAt)
  const history = { fetchedAt, days, count: items.length, items }
  const signals = computeSignals(items, now)
  const brief = renderHistoryBrief(history, signals, now)
  writeFileSync(p.history, JSON.stringify(history), 'utf8')
  writeFileSync(p.signals, JSON.stringify(signals, null, 2), 'utf8')
  writeFileSync(p.brief, brief, 'utf8')
  return { history, signals, brief }
}

/**
 * 校验 Agent 产出的 batch（合同见 02-需求定稿 §3.5）
 * @returns {{ok:boolean, batch?:object, error?:string}}
 */
export function validateBatch(raw, { batchId, maxItems = FEED_MAX_ITEMS } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '不是一个 JSON 对象' }
  const id = String(raw.id || '').trim()
  if (!batchId) return { ok: false, error: '内部错误：缺 batchId' }
  if (id !== batchId) return { ok: false, error: `batch id 不符（期望 ${batchId}，实际 ${id || '空'}）` }
  const items = Array.isArray(raw.items) ? raw.items : null
  if (!items) return { ok: false, error: 'items 不是数组' }
  if (items.length < 1) return { ok: false, error: 'items 是空的（宁缺毋滥，但不能 0 条）' }
  if (items.length > maxItems) return { ok: false, error: `items 超过上限 ${maxItems} 条` }
  const seen = new Set()
  const norm = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const at = `items[${i}]`
    if (!it || typeof it !== 'object') return { ok: false, error: `${at} 不是对象` }
    const bvid = String(it.bvid || '').trim()
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return { ok: false, error: `${at}.bvid 不合法` }
    if (seen.has(bvid)) return { ok: false, error: `${at}.bvid 重复（${bvid}）` }
    seen.add(bvid)
    const title = String(it.title || '').trim()
    const summary = String(it.summary || '').trim()
    const why = String(it.why || '').trim()
    if (!title) return { ok: false, error: `${at}.title 为空` }
    if (summary.length < 2) return { ok: false, error: `${at}.summary 为空` }
    if (why.length < 2) return { ok: false, error: `${at}.why 为空` }
    const url = String(it.url || videoUrl(bvid)).trim()
    if (!/^https:\/\/www\.bilibili\.com\/video\/BV[0-9A-Za-z]{10}/.test(url)) return { ok: false, error: `${at}.url 不合法（应指向 B站视频）` }
    const highlights = Array.isArray(it.highlights) ? it.highlights.map((x) => String(x).trim()).filter(Boolean).slice(0, 5) : []
    const stats = (it.stats && typeof it.stats === 'object') ? {
      view: Number(it.stats.view) || 0,
      like: Number(it.stats.like) || 0,
      reply: Number(it.stats.reply) || 0,
    } : { view: 0, like: 0, reply: 0 }
    const score = Math.max(0, Math.min(Number(it.score) || 0.5, 1))
    norm.push({
      bvid,
      title: title.slice(0, 300),
      author: String(it.author || '').slice(0, 120),
      cover: String(it.cover || '').slice(0, 500),
      duration: Math.max(0, Number(it.duration) || 0),
      pubdate: Number(it.pubdate) || 0,
      url,
      stats,
      score,
      summary: summary.slice(0, 2000),
      why: why.slice(0, 1000),
      highlights,
    })
  }
  return {
    ok: true,
    batch: {
      id,
      createdAt: String(raw.createdAt || new Date().toISOString()),
      depth: String(raw.depth || 'medium'),
      profileUpdated: Boolean(raw.profileUpdated),
      meta: (raw.meta && typeof raw.meta === 'object') ? raw.meta : {},
      items: norm,
    },
  }
}

/** 读 batch 文件（不存在返回 null） */
export function readBatchFile(stateDir, batchId) {
  if (!batchId) return null
  try {
    const text = readFileSync(join(feedPaths(stateDir).batches, `${batchId}.json`), 'utf8')
    return JSON.parse(text)
  } catch { return null }
}

/** 本批追加进 recommended.jsonl */
export function appendRecommended(stateDir, batch) {
  const p = feedPaths(stateDir)
  mkdirSync(p.dir, { recursive: true })
  const ts = Date.now()
  for (const it of batch.items || []) {
    appendJsonl(p.recommended, { ts, batchId: batch.id, bvid: it.bvid, title: it.title, author: it.author, score: it.score })
  }
}

/** 追加反馈 */
export function appendFeedback(stateDir, { bvid, action, batchId }) {
  const p = feedPaths(stateDir)
  mkdirSync(p.dir, { recursive: true })
  appendJsonl(p.feedback, { ts: Date.now(), bvid: String(bvid || ''), action: String(action || ''), batchId: String(batchId || '') })
}

/**
 * 拼「荐片」这一轮的提示词（纯函数）
 * @param {object} opts
 */
export function buildFeedPrompt({
  ownerDoc = '',
  stateDir,
  charter,
  batchId = '',
  batchFile,
  perBatch = 4,
  depth = 'medium',
  historyDays = 30,
  avoid = [],
  profileNote = '',
  now = new Date(),
  tools = [],
} = {}) {
  const p = feedPaths(stateDir)
  const timeText = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return [
    '你是这个账号的「荐片」助手。',
    '下面是使用者的设定（如果有）—— **按它来**，别用你默认那套人格。',
    ownerDoc || '⭐ 这一轮**没有**拿到使用者的设定（他没填「工作区」，或那个目录里没有 `AGENTS.md`）⇒ **按中性说话**：别扮演任何人、也别自己编一套设定 ✓。',
    '',
    '=== 这一轮 ===',
    `现在时间：${timeText}`,
    '这是「荐片」模式，**不是刷B站日报**：这一轮**不公开发言、不发评论、不发私信**，只产出推荐。',
    `先读章程：${charter}`,
    '然后严格按章程完成一轮荐片。',
    '',
    '=== 路径（一律用这些绝对路径，别自己拼） ===',
    `家目录：${stateDir}`,
    `兴趣画像：${p.profile}`,
    `历史摘要：${p.brief}`,
    `历史原始数据：${p.history}`,
    `机器信号：${p.signals}`,
    `用户反馈：${p.feedback}`,
    `已推列表（去重用）：${p.recommended}`,
    `**本批输出文件（只写这一个文件）**：${batchFile}`,
    '',
    '=== 这一轮的参数 ===',
    `本轮 batchId：${batchId}`,
    `本批最多：${perBatch} 条（宁缺毋滥；不够就少写，但至少 1 条）`,
    `深度档：${depth}（light=不读字幕 / medium=只给入选者读字幕 / deep=前 8–10 条都读）`,
    `历史窗口：${historyDays} 天`,
    `不想看的关键词：${Array.isArray(avoid) && avoid.length ? avoid.join('、') : '（无）'}`,
    `使用者手填「最近在关注」：${String(profileNote || '').trim() || '（无）'}`,
    '',
    '=== 工具 ===',
    `这一轮只给你这些工具（白名单，名单外的不存在）：${tools.join('、')}`,
    '成本纪律：同一个工具失败两次就跳过；不要反复权衡同一条；看够了就下结论；不要写调试脚本。',
    '',
    '完成后用一句话汇报你这一批推了什么（只写进你自己的收尾，不要写进 batch 文件之外的地方）。',
  ].join('\n')
}
