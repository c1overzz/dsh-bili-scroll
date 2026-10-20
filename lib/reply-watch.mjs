import { parseSeen } from './verify.mjs'

const BACKFILL_MS = 24 * 60 * 60 * 1000
const id = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0
const keyOf = (bv, root) => `${bv}|${root}`

// 监听独立解析完整行：root 只认表格列/明确字段，不能把正文中的 parent、UID 当 root。
export function parseWatchRows(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const bv = /BV[0-9A-Za-z]{10}/.exec(line)?.[0]
    if (!bv) continue
    const cells = line.split('|').map((s) => s.trim().replace(/^[`*_]+|[`*_]+$/g, '').trim())
    const col = cells.indexOf(bv)
    const table = col >= 0 && /^\d{9,}$/.test(cells[col + 1] || '')
    const rpid = table ? id(cells[col + 1]) : id(/\brpid\s*[:=：]?\s*(\d{9,})/i.exec(line)?.[1]
      || new RegExp(`${bv}[\\s·:：=|-]+(\\d{9,})`).exec(line)?.[1])
    if (!rpid) continue
    const root = table ? (/^\d{9,}$/.test(cells[col + 2] || '') ? id(cells[col + 2]) : 0)
      : id(/\broot\s*[:=：]?\s*(\d{9,})/i.exec(line)?.[1])
    rows.push({ bv, rpid, root, line,
      deleted: /[（(\[]\s*(?:已删除|已撤回|已删|deleted)(?=[\s，,）)\]0-9]|$)/i.test(line)
        || cells.some((s) => /^(?:已删除|已撤回|deleted)(?:\s+\d{4}-\d{2}-\d{2}.*)?$/i.test(s))
        || /(?:状态|status)\s*[:=：]\s*(?:已删除|已撤回|deleted)(?=[\s|，,）)\]]|$)/i.test(line),
      parent: id(/\bparent\s*=\s*(\d{9,})/i.exec(line)?.[1]
        || /回复(?:主人|观众|目标)\s+rpid\s*=\s*(\d{9,})/i.exec(line)?.[1]),
    })
  }
  return rows
}

/** 先剔除删除记录、统一根楼层、去重，最后才计入最近 n 个名额。 */
export function selectReplyThreads(text, n = 5) {
  const rows = parseWatchRows(text)
  const deleted = new Set(rows.filter((r) => r.deleted).map((r) => keyOf(r.bv, r.rpid)))
  const selected = new Map()
  for (const row of rows.slice().reverse()) {
    const root = row.root || row.rpid
    const key = keyOf(row.bv, root)
    if (row.deleted || deleted.has(key) || deleted.has(keyOf(row.bv, row.rpid))) continue
    if (!selected.has(key)) {
      if (selected.size >= n) continue
      selected.set(key, { bv: row.bv, rpid: root, key, ownIds: [], repliedParents: [] })
    }
  }
  for (const row of rows) {
    const thread = selected.get(keyOf(row.bv, row.root || row.rpid))
    if (!thread) continue
    if (!row.deleted && !deleted.has(keyOf(row.bv, row.rpid))) thread.ownIds.push(row.rpid)
    if (row.parent) thread.repliedParents.push(row.parent)
  }
  return [...selected.values()].map((r) => ({ ...r, ownIds: [...new Set(r.ownIds)], repliedParents: [...new Set(r.repliedParents)] }))
}

function legacyRequestKeys(text, n) {
  const keys = new Set()
  for (const row of parseSeen(text).reverse()) {
    if (row.rpid) keys.add(keyOf(row.bv, row.rpid)) // 旧版请求的是子 rpid 时，不能误算作已查过根楼层。
    if (keys.size >= n) break
  }
  return keys
}

/** 返回可先落盘的基线；全新安装和新纳入楼层遇到失败时，重试不能不断前移基线。 */
export function prepareReplyPoll(text, state = {}, now = Date.now(), n = 5) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('回复监听状态格式错误')
  for (const field of ['lastCheck', 'initialSince']) {
    if (state[field] != null && (!Number.isFinite(Number(state[field])) || Number(state[field]) <= 0)) throw new Error(`回复监听检查时间错误：${field}`)
  }
  if (state.threads != null && (typeof state.threads !== 'object' || Array.isArray(state.threads))) throw new Error('回复监听楼层状态格式错误')
  const rows = selectReplyThreads(text, n)
  const legacy = legacyRequestKeys(text, n)
  const initialSince = Number(state.initialSince) > 0 ? Number(state.initialSince) : now
  const threads = { ...(state.threads || {}) }
  for (const row of rows) {
    const old = threads[row.key]
    if (old && Number(old.lastCheck) > 0 && Array.isArray(old.seenIds)) continue
    if (old != null) throw new Error(`回复监听楼层检查点错误：${row.key}`)
    const previous = Number(state.lastCheck)
    const since = previous > 0
      ? (state.version !== 2 && legacy.has(row.key) ? previous : now - BACKFILL_MS)
      : initialSince
    threads[row.key] = { lastCheck: since, seenIds: [] }
  }
  return { rows, state: { ...state, version: 2, initialSince, threads } }
}

/** 只做候选筛选/检查点规划；网络与启动均注入，测试不会连 B 站或启动模型。 */
export async function pollReplyThreads(plan, { now = Date.now(), fetchReplies, startRound, log = () => {} }) {
  const state = { ...plan.state, threads: { ...plan.state.threads } }
  const candidates = []
  const successful = []
  for (const row of plan.rows) {
    const old = state.threads[row.key]
    try {
      const res = await fetchReplies(row)
      if (!res || res.success === false || res.ok === false || !Array.isArray(res.replies)) throw new Error(res?.error || '回复接口未返回有效列表')
      const known = new Set(old.seenIds.map(String))
      const own = new Set(row.ownIds)
      const answered = new Set(row.repliedParents)
      for (const reply of res.replies) {
        if (reply.role === '本号') {
          if (id(reply.rpid)) own.add(id(reply.rpid))
          if (id(reply.parent)) answered.add(id(reply.parent))
        }
      }
      const fresh = []
      const floor = Math.floor(old.lastCheck / 1000) * 1000 // ctime 只有秒：重叠一秒，并以 rpid 防重复。
      for (const reply of res.replies) {
        const rid = id(reply.rpid)
        if (!rid || known.has(String(rid))) continue
        known.add(String(rid))
        if (reply.role === '本号' || own.has(rid) || answered.has(rid) || !own.has(id(reply.parent))) continue
        if (Number(reply.ctime) * 1000 >= floor) fresh.push({ ...reply, bv: row.bv, root: row.rpid })
      }
      candidates.push(...fresh)
      const fullPage = res.replies.length >= 20
      successful.push({ row, fresh, checkpoint: { lastCheck: now, seenIds: [...known].slice(-400), fullPage } })
      if (fullPage && !old.fullPage) log(`[回复监听] ${row.key} 返回满页；当前接口只提供第一页，不能据此保证历史回复全覆盖`)
    } catch (e) {
      log(`[回复监听] 查 ${row.key} 失败，保留该楼层检查点：${e?.message ?? e}`)
    }
  }
  let started = false
  if (candidates.length) {
    try {
      const result = await startRound(candidates)
      started = result?.started === true
    } catch (e) { log(`[回复监听] 启动失败，保留待触发楼层检查点：${e?.message ?? e}`) }
  }
  for (const { row, fresh, checkpoint } of successful) {
    if (!fresh.length || started) state.threads[row.key] = checkpoint
  }
  if (successful.length) state.lastCheck = now // 仅供显示；筛选用各楼层自己的检查点。
  return { state, checked: successful.length, found: candidates.length, started }
}
