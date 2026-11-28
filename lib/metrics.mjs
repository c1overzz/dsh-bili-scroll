/**
 * 一轮的「效率账」（2026-11-28 本机加）。
 *
 * 为什么要它：每次调优都得手动去翻 `~/.dsh/sessions/…/session.v4.jsonl.zstd`
 * 数步数、数工具字符、算耗时（zstd 解压 + 逐行 JSON），又慢又容易算错。
 * 这里把同一件事做成函数：轮结束后由 index.js 调一次，往 duty.log 记一行、
 * 顺手把这一行的摘要贴到当天日报末尾 —— 12:40 / 18:40 的汇报就会自带效率数字。
 *
 * 口径（跟人工脚本一致）：
 * - 步数 = tool/call 事件里出现过的 data.step 去重个数（一次模型往返算一步）
 * - 工具字符 = tool/result 事件里 data.message.content 各段 text 的长度之和
 * - 输出 token = assistant/message 的 usage.outputTokens 累加；cache 同理
 * - 耗时 = 最后一条事件时间 - 第一条事件时间
 *
 * 任何一环出问题都返回 { ok: false, why }，调用方只记一句「没算出来」，绝不能让这一轮受影响。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSION_FILE_RE = /^session\.v\d+\.jsonl(\.zstd)?$/

function decodeSession(file) {
  const buf = readFileSync(file)
  if (!file.endsWith('.zstd')) return buf.toString('utf8')
  try {
    return zstdDecompressSync(buf).toString('utf8')
  } catch {
    return ''
  }
}

/** 在桶里找这一轮刚写的那个会话目录（mtime >= since，取最新的）。 */
export function findRoundSession({ bucketDir = '', sessionRoot = '', since = 0, exclude = new Set() } = {}) {
  const roots = []
  if (bucketDir) roots.push(bucketDir)
  if (sessionRoot) {
    try {
      for (const n of readdirSync(sessionRoot)) {
        const d = join(sessionRoot, n)
        if (d === bucketDir) continue
        try { if (statSync(d).isDirectory()) roots.push(d) } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
  }
  let best = null
  for (const root of roots) {
    let names = []
    try { names = readdirSync(root).filter((n) => /^session-/.test(n)) } catch { continue }
    for (const n of names) {
      if (exclude.has(n)) continue
      const dir = join(root, n)
      let file = ''
      try {
        const f = readdirSync(dir).find((x) => SESSION_FILE_RE.test(x))
        if (!f) continue
        file = join(dir, f)
      } catch { continue }
      // 目录 mtime 是「建会话」的时间、文件 mtime 才是「最后一次写」—— 取两者更新的那个，
      // 免得一轮刚开始时目录时间刚好差一点点被判成"不是我这一轮"
      let mt = 0
      try { mt = statSync(dir).mtimeMs } catch { mt = 0 }
      try { const fm = statSync(file).mtimeMs; if (fm > mt) mt = fm } catch { /* 用目录时间 */ }
      if (since > 0 && mt < since) continue
      if (!best || mt > best.mtimeMs) best = { dir, file, snapshot: n, mtimeMs: mt }
    }
  }
  return best
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

function textLen(parts) {
  if (!Array.isArray(parts)) return 0
  let n = 0
  for (const p of parts) {
    if (typeof p === 'string') n += p.length
    else if (p && typeof p.text === 'string') n += p.text.length
  }
  return n
}

/** 解一份会话快照，算出这一轮的效率账。 */
export function metricsFromSession(file) {
  const text = decodeSession(file)
  if (!text.trim()) return { ok: false, why: '会话文件是空的（可能还没落盘）' }
  const steps = new Set()
  const calls = []
  const results = new Map()
  const usage = { inTokens: 0, outTokens: 0, cacheTokens: 0 }
  let first = 0
  let last = 0
  let bad = 0
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let ev
    try { ev = JSON.parse(s) } catch { bad += 1; continue }
    if (Number.isFinite(ev?.time)) {
      if (!first) first = ev.time
      last = ev.time
    }
    const type = ev?.type
    const d = ev?.data || {}
    if (type === 'tool/call') {
      calls.push({ id: d.callId, name: String(d.name || '?'), step: d.step })
      if (Number.isFinite(d.step)) steps.add(d.step)
    } else if (type === 'tool/result') {
      const id = d?.message?.toolCallId
      if (id) results.set(id, textLen(d.message.content))
    } else if (type === 'assistant/message') {
      const u = d?.usage
      if (u) {
        usage.inTokens += num(u.inputTokens)
        usage.outTokens += num(u.outputTokens)
        usage.cacheTokens += num(u.cacheReadTokens)
      }
    }
  }
  const byTool = new Map()
  let totalChars = 0
  for (const c of calls) {
    const chars = results.get(c.id) || 0
    totalChars += chars
    const cur = byTool.get(c.name) || { name: c.name, calls: 0, chars: 0 }
    cur.calls += 1
    cur.chars += chars
    byTool.set(c.name, cur)
  }
  return {
    ok: true,
    steps: steps.size || (calls.length ? 1 : 0),
    toolCalls: calls.length,
    toolChars: totalChars,
    byTool: [...byTool.values()].sort((a, b) => b.chars - a.chars),
    inTokens: usage.inTokens,
    outTokens: usage.outTokens,
    cacheTokens: usage.cacheTokens,
    ms: first && last > first ? last - first : 0,
    badLines: bad,
  }
}

/** 查 + 算一步到位。 */
export function readRoundMetrics(opts = {}) {
  const hit = findRoundSession(opts)
  if (!hit) return { ok: false, why: '没找到这一轮的会话文件' }
  const m = metricsFromSession(hit.file)
  return m.ok ? { ...m, sessionId: hit.snapshot, file: hit.file } : m
}

const shortName = (n) => String(n)
  .replace(/^mcp__[A-Za-z0-9_-]+__/, '')
  .replace(/^bili_/, '')
  .replace(/_batch$/, '')

const kk = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)))
const cn = (n) => Math.round(n).toLocaleString('en-US')

/** 一行摘要（写进 duty.log / 日报末尾都是这一行）。 */
export function formatRoundMetrics(m) {
  const top = (m.byTool || []).filter((t) => t.chars >= 300).slice(0, 4)
    .map((t) => shortName(t.name) + ' ' + cn(t.chars)).join(' / ')
  const parts = []
  parts.push(m.steps + ' 步')
  parts.push('工具 ' + cn(m.toolChars) + ' 字符' + (top ? '（' + top + '）' : ''))
  parts.push('输出 ' + kk(m.outTokens) + ' tok')
  if (m.ms) parts.push('耗时 ' + Math.round(m.ms / 1000) + ' 秒')
  return parts.join(' · ')
}
