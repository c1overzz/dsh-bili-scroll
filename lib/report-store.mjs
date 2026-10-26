import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createPathLayout } from './path-layout.mjs'
import { writeJsonAtomic } from './atomic-write.mjs'
import { diagnoseRound } from './diagnose.mjs'

const PICK_RE = /^#{2,3}[ \t]*(BV[0-9A-Za-z]{10})/gm
const BVID_RE = /^BV[0-9A-Za-z]{10}$/
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/

const defaultReadJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

const defaultWriteJson = (file, value) => writeJsonAtomic(file, value)

/** Remove fenced snippets before interpreting report headings as picks. */
export function stripCodeFences(text) {
  return String(text ?? '').replace(/```[\s\S]*?```/g, '')
}

/** Return unique picked BV ids from a report string. */
export function extractPickedBvids(text) {
  const ids = new Set()
  for (const match of stripCodeFences(text).matchAll(PICK_RE)) ids.add(match[1])
  return [...ids]
}

export function countPickedBvids(text) {
  return extractPickedBvids(text).length
}

/** Parse the small metadata fields used by the watched-videos UI. */
export function reportMetaFromText(text) {
  const map = new Map()
  const blocks = String(text ?? '').split(/\n(?=###\s*BV)/)
  for (const block of blocks) {
    const match = block.match(/^###\s*(BV[0-9A-Za-z]+)/)
    if (!match) continue
    const tier = block.match(/\*\*档位\*\*\s*[：:]\s*(值得看|可以看|不值当)/)
    const why = block.match(/\*\*为什么值得\*\*\s*[：:]\s*([\s\S]*?)(?=\n\s*\*\*|$)/)
    map.set(match[1], {
      tier: tier ? tier[1] : '',
      why: why ? why[1].replace(/\s+/g, ' ').trim().slice(0, 160) : '',
    })
  }
  return map
}

/** Parse seen.md without assuming a fixed column count. */
export function parseSeenText(text) {
  const rows = []
  const seen = new Set()
  const deliveredBvs = new Set()
  const lines = String(text ?? '').split(/\r?\n/)

  for (const line of lines) {
    const hit = /\|\s*(BV[0-9A-Za-z]{10})\s*\|\s*(\d{6,})\s*\|/.exec(line)
    if (hit) deliveredBvs.add(hit[1])
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((value) => value.trim())
    const columns = cells.slice(1, cells.length - 1)
    if (columns.length < 3) continue
    const bvidIndex = columns.findIndex((value) => BVID_RE.test(value))
    if (bvidIndex < 0) continue
    const bvid = columns[bvidIndex]
    const dayRaw = bvidIndex > 0 ? columns[bvidIndex - 1] : columns[0]
    const date = DATE_RE.exec(dayRaw)
    if (!date) continue
    const day = date[1]
    const title = columns[bvidIndex + 1] || ''
    const up = columns[bvidIndex + 2] || ''
    const status = columns[columns.length - 1] || ''
    const key = `${bvid}@${day}`
    if (seen.has(key)) continue
    seen.add(key)

    const skipped = /跳过|跳了|没挑/.test(status)
    const picked = !skipped && /挑|收|选|值得看|可以看/.test(status)
    const commented = /评论/.test(status)
    const delivered = /评论|私信|已发|发给/.test(status) || deliveredBvs.has(bvid)
    rows.push({
      day,
      bvid,
      title,
      up,
      status,
      picked,
      commented,
      delivered,
      url: `https://www.bilibili.com/video/${bvid}`,
    })
  }

  rows.sort((a, b) => (
    a.day === b.day
      ? (a.picked === b.picked ? 0 : a.picked ? -1 : 1)
      : (a.day < b.day ? 1 : -1)
  ))
  return rows
}

function initialSeenText() {
  return [
    '# 刷B站 · 判重表（宿主预建，那一轮只往后面追加）',
    '',
    '## 评论记录（BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字）',
    '',
    '| BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字 |',
    '| --- | --- | --- | --- | --- |',
    '',
    '## 看过的视频',
    '',
  ].join('\n')
}

/**
 * Owns report-derived state and the files that the duty round writes around.
 * It deliberately knows nothing about DSH, HTTP, or child processes.
 */
export function createReportStore({
  stateDir,
  outDir = join(stateDir, 'out'),
  dayKey,
  getReportLevel = () => 'full',
  readJson = defaultReadJson,
  writeJson = defaultWriteJson,
  log = () => {},
}) {
  const layout = createPathLayout(stateDir, { outDir })
  outDir = layout.outDir
  const stateFile = layout.stateFile
  const seenFile = layout.seenFile
  const seenArchiveDir = layout.seenArchiveDir
  const digestDir = layout.digestDir
  const notesDir = layout.notesDir
  let notesSig = ''

  const reportFileOf = (now = new Date()) => layout.reportFile(dayKey(now))

  const ensureFiles = () => {
    try {
      if (!existsSync(seenFile)) writeFileSync(seenFile, initialSeenText(), 'utf8')
    } catch { /* 家目录不可写时，后续状态接口仍可工作 */ }
    try { mkdirSync(digestDir, { recursive: true }) } catch { /* 同上 */ }
  }

  const readState = () => readJson(stateFile, {}) || {}

  const bumpState = (patch) => {
    const state = readState()
    const today = dayKey()
    if (state.day !== today) {
      state.day = today
      state.count = 0
      state.picked = 0
      state.windows = {}
    }
    writeJson(stateFile, { ...state, ...patch })
    return state
  }

  const countPicks = (file) => {
    try { return countPickedBvids(readFileSync(file, 'utf8')) } catch { return 0 }
  }

  const parseSeenTable = () => {
    try { return parseSeenText(readFileSync(seenFile, 'utf8')) } catch { return [] }
  }

  const countPickedToday = (now = new Date()) => {
    const state = readState()
    const today = dayKey(now)
    const fromState = state.day === today ? Number(state.picked || 0) : 0
    let fromSeen = 0
    try {
      if (String(getReportLevel() || 'full') === 'off') {
        fromSeen = parseSeenTable().filter((row) => row.day === today && row.picked).length
      }
    } catch { /* 读不到就按 0 算 */ }
    return Math.max(fromState, countPicks(reportFileOf(now)), fromSeen)
  }

  const roundsToday = (now = new Date()) => {
    const state = readState()
    return state.day === dayKey(now) ? Number(state.count || 0) : 0
  }

  const reportMeta = () => {
    const map = new Map()
    let files = []
    try {
      files = readdirSync(outDir)
        .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file))
        .sort()
        .reverse()
        .slice(0, 60)
    } catch { return map }
    for (const file of files) {
      try {
        const current = reportMetaFromText(readFileSync(join(outDir, file), 'utf8'))
        // Files are visited newest first; keep the first entry when a video
        // appears in more than one daily report.
        for (const [bvid, metadata] of current) {
          if (!map.has(bvid)) map.set(bvid, metadata)
        }
      } catch { /* 单个坏报告不影响其它日期 */ }
    }
    return map
  }

  const pickIdsFromReport = (file) => {
    try { return extractPickedBvids(readFileSync(file, 'utf8')) } catch { return [] }
  }

  const listWatched = ({ limit = 60, offset = 0, picked = false, tier = '', state = '' } = {}) => {
    syncNotes()
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 60))
    const safeOffset = Math.max(0, Number(offset) || 0)
    const metadata = reportMeta()
    const notes = (() => {
      try { return new Set(readdirSync(notesDir).map((file) => file.split('-')[0])) } catch { return new Set() }
    })()
    const allRows = parseSeenTable().map((row) => {
      const report = metadata.get(row.bvid) || {}
      return { ...row, tier: report.tier || '', why: report.why || '', note: notes.has(row.bvid) }
    })
    let rows = picked ? allRows.filter((row) => row.picked) : allRows
    if (tier) rows = rows.filter((row) => row.tier === tier)
    if (state === 'picked') rows = rows.filter((row) => row.picked)
    if (state === 'skipped') rows = rows.filter((row) => !row.picked)
    if (state === 'commented') rows = rows.filter((row) => row.delivered || row.commented)
    return { ok: true, total: rows.length, offset: safeOffset, limit: safeLimit, rows: rows.slice(safeOffset, safeOffset + safeLimit) }
  }

  const readReport = (day, maxChars = 200_000) => {
    const safeDay = String(day || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
    const file = layout.reportFile(safeDay)
    let text = ''
    let exists = false
    try {
      exists = existsSync(file)
      if (exists) text = readFileSync(file, 'utf8').slice(0, maxChars)
    } catch { /* a missing or unreadable report is still a valid empty result */ }
    return { ok: true, day: safeDay, exists, file, text }
  }

  const stubReportIfMissing = (code, logFile = '') => {
    try {
      if (String(getReportLevel() || 'full') === 'off') return false
      const file = reportFileOf()
      if (existsSync(file)) return false
      let tail = ''
      try { tail = logFile ? readFileSync(logFile, 'utf8').slice(-6000) : '' } catch { /* best effort */ }
      let diagnosis = null
      try { diagnosis = diagnoseRound(tail) } catch (error) { log(`诊断失败（已兜住）：${error?.message ?? error}`) }
      if (diagnosis) log(`这一轮没跑起来：${diagnosis.title}`)
      const header = diagnosis
        ? [
            `# 刷B站 · ${dayKey()} —— 这一轮没跑起来`,
            '',
            `> ⚠️ **${diagnosis.title}**（退出码 ${code}）。`,
            '',
            diagnosis.body,
            '',
            '---',
            '',
            '## 日志尾部（完整版在插件数据目录的 \`duty.log\`）',
            '',
          ]
        : [
            `# 刷B站 · ${dayKey()} —— 这一轮没写出报告`,
            '',
            `> ⚠️ 那一轮结束了，但没有生成正常报告（退出码 ${code}）。`,
            '> 常见原因是它卡在某个工具上反复重试、或者把预算烧完了。下一轮它会重来。',
            '> 下面附日志尾部，方便定位（插件数据目录里的 `duty.log` 有完整版）。',
            '',
          ]
      writeFileSync(file, [
        ...header,
        '```',
        String(tail).trim().slice(-4000),
        '```',
        '',
      ].join('\n'), 'utf8')
      log('这一轮没写报告 ⇒ 宿主补了一份占位报告')
      return true
    } catch (error) {
      log(`补占位报告失败：${error?.message ?? error}`)
      return false
    }
  }

  const rollSeen = () => {
    try {
      if (!existsSync(seenFile)) return 0
      const lines = readFileSync(seenFile, 'utf8').split(/\r?\n/)
      const cutoff = new Date(Date.now() - 30 * 86400_000)
      const pad = (value) => String(value).padStart(2, '0')
      const cutoffKey = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`
      const keep = []
      const moved = new Map()
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('|')) {
          const cells = trimmed.split('|').map((value) => value.trim()).slice(1, -1)
          const bvidIndex = cells.findIndex((value) => BVID_RE.test(value))
          const dayRaw = bvidIndex > 0 ? cells[bvidIndex - 1] : cells[0]
          const date = /^(\d{4}-\d{2}-\d{2})/.exec(dayRaw || '')
          if (bvidIndex >= 0 && date && date[1] < cutoffKey) {
            const month = date[1].slice(0, 7)
            if (!moved.has(month)) moved.set(month, [])
            moved.get(month).push(line)
            continue
          }
        }
        keep.push(line)
      }
      if (!moved.size) return 0
      mkdirSync(seenArchiveDir, { recursive: true })
      let count = 0
      for (const [month, rows] of moved) {
        const file = join(seenArchiveDir, `${month}.md`)
        const header = existsSync(file)
          ? ''
          : `# 刷B站的判重表归档 · ${month}\n\n（从 seen.md 滚过来的旧行，判重只看最近 30 天，这里只为留档）\n\n`
        appendFileSync(file, `${header + rows.join('\n')}\n`, 'utf8')
        count += rows.length
      }
      writeFileSync(seenFile, keep.join('\n'), 'utf8')
      log(`判重表归档：${count} 行挪进 seen/（主表只剩最近 30 天）`)
      return count
    } catch (error) {
      log(`判重表归档失败（不影响使用）：${String(error?.message ?? error)}`)
      return 0
    }
  }

  const syncNotes = (now = new Date()) => {
    try {
      const file = reportFileOf(now)
      if (!existsSync(file)) return 0
      const signature = `${file}@${statSync(file).mtimeMs}`
      if (signature === notesSig) return 0
      const text = readFileSync(file, 'utf8')
      const blocks = text.split(/\n(?=###\s*BV)/).filter((block) => /^###\s*BV/.test(block.trim()))
      if (!blocks.length) { notesSig = signature; return 0 }
      mkdirSync(notesDir, { recursive: true })
      const day = dayKey(now)
      let count = 0
      for (const block of blocks) {
        const match = /^###\s*(BV[0-9A-Za-z]+)/.exec(block.trim())
        if (!match) continue
        const bvid = match[1]
        const title = (/\*\*标题\*\*\s*[：:]\s*(.+)/.exec(block) || [])[1] || bvid
        const output = join(notesDir, `${bvid}-${day}.md`)
        if (existsSync(output)) continue
        const header = `# ${title}\n\n`
          + `> 来自「刷B站」${day} 的那一轮 · ${bvid} · https://www.bilibili.com/video/${bvid}\n`
          + `> 这一份是**单条笔记**（整天的日报在 ${file}）\n\n---\n\n`
        writeFileSync(output, `${header + block.replace(/^###\s*BV[0-9A-Za-z]+/, '').trim()}\n`, 'utf8')
        count++
      }
      notesSig = signature
      if (count > 0) log(`单条笔记：新写了 ${count} 份到 ${notesDir}`)
      return count
    } catch (error) {
      log(`拆单条笔记失败：${String(error?.message ?? error)}`)
      return 0
    }
  }

  return {
    paths: { stateFile, seenFile, seenArchiveDir, digestDir, notesDir },
    ensureFiles,
    readState,
    bumpState,
    reportFileOf,
    countPicks,
    countPickedToday,
    roundsToday,
    reportMeta,
    parseSeenTable,
    pickIdsFromReport,
    listWatched,
    readReport,
    stubReportIfMissing,
    rollSeen,
    syncNotes,
  }
}
