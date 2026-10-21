/**
 * lib/taste.mjs —— 「口味账」：使用者**主动 @ 她**看过的视频 = 强兴趣信号
 * ============================================================================
 * 起因（2026-10-21）：@ 到的那条视频以前只用来"回一句"，对挑选**零影响** ——
 *   使用者明明点名说"我想看这个"，下一轮她还是照关键词随便挑 ✗。
 *
 * 为什么必须落盘：**每一轮都是独立进程**（headless spawn），模型手里没有任何上一轮的上下文。
 *   只在章程里写"优先同类"没用 —— 它不知道"同类"指谁 ⇒ 得由宿主记账、下一轮喂给它 ✓。
 *
 * 记账内容：@ 视频的 标题 / UP 主 / 标签（只读接口，不花 token）。
 *   下一轮 `tasteHint()` 把 UP 主和标签按出现次数排出来 —— 同类优先，仅此而已：
 *   ⚠️ **不加配额、不强制**，没有同类就照常挑（别让"优先"变成"只能挑这些"）。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCredential } from './verify.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const FILE = 'taste.json'
const KEEP = 30          // 只留最近 30 条，别让文件只长不消
const TOP_AUTHORS = 5
const TOP_TAGS = 8
const SHOW_LATEST = 5    // 摘要里列几条原文（标题能让它泛化到标签之外的同类）

export function tasteFile(stateDir) { return join(stateDir, FILE) }

export function readTaste(stateDir) {
  try {
    const j = JSON.parse(readFileSync(tasteFile(stateDir), 'utf8'))
    const videos = Array.isArray(j?.videos) ? j.videos.filter((v) => v && v.bvid) : []
    return { videos }
  } catch { return { videos: [] } }
}

function saveTaste(stateDir, t) {
  try { writeFileSync(tasteFile(stateDir), JSON.stringify(t, null, 2), 'utf8') } catch { /* 写不了就当这轮没学到，下次再说 */ }
}

async function jget(url, cred) {
  const headers = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: 'https://www.bilibili.com/' }
  if (cred?.sessdata) headers.Cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct || ''}; buvid3=${cred.buvid3 || ''}`
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(12000) })
    return JSON.parse(await r.text())
  } catch { return null }
}

/** 取一条视频的 标题 / UP / 分区 / 标签。失败返回 null（绝不抛）。 */
export async function fetchVideoMeta(bvid, cred = null) {
  const bv = String(bvid || '').trim()
  if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) return null
  let j = await jget(`https://api.bilibili.com/x/web-interface/view/detail?bvid=${bv}`, cred)
  let v = j?.data?.View
  const tags = Array.isArray(j?.data?.Tags)
    ? j.data.Tags.map((t) => String(t?.tag_name || '').trim()).filter(Boolean)
    : []
  if (!v) {
    j = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, cred)
    v = j?.data
  }
  if (!v?.bvid && !v?.title) return null
  return {
    bvid: v.bvid || bv,
    title: String(v.title || '').slice(0, 120),
    author: String(v.owner?.name || ''),
    mid: Number(v.owner?.mid) || 0,
    tags: tags.slice(0, 8),
  }
}

/**
 * 把这一轮 @ 到的视频记进口味账：按 bvid 去重、留最近 KEEP 条。
 * ⚠️ 记录的是"**他 @ 过**"这件事本身 —— 跟他那条 @ 回成没回成无关（那就是兴趣信号）。
 */
export async function recordMentions(stateDir, items, log = () => {}) {
  const list = (items || []).filter((m) => m && (m.watchBvid || m.bvid))
  if (!list.length) return { added: 0, total: readTaste(stateDir).videos.length }
  const cred = loadCredential(stateDir)
  const got = []
  for (const m of list) {
    const meta = await fetchVideoMeta(String(m.watchBvid || m.bvid), cred)
    if (meta) got.push({ ...meta, at: Math.floor(Date.now() / 1000) })
  }
  if (!got.length) return { added: 0, total: readTaste(stateDir).videos.length }
  const cur = readTaste(stateDir)
  const map = new Map()
  for (const v of [...cur.videos, ...got]) map.set(v.bvid, v)   // 后来的覆盖：元数据可能更新过
  const videos = [...map.values()].sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-KEEP)
  saveTaste(stateDir, { videos })
  log(`口味账：记下 ${got.length} 条 @ 过的视频（共 ${videos.length} 条）`)
  return { added: got.length, total: videos.length }
}

const tally = (values) => {
  const n = new Map()
  for (const v of values) if (v) n.set(v, (n.get(v) || 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
}

/**
 * 给提示词用的一节：UP 主 / 标签（按出现次数）+ 最近几条原文。
 * 没有账本 ⇒ 返回 ''（一个字都不占）。
 */
export function tasteHint(stateDir) {
  const { videos } = readTaste(stateDir)
  if (!videos.length) return ''
  const authors = tally(videos.map((v) => v.author)).slice(0, TOP_AUTHORS)
  const tagMap = new Map()
  for (const v of videos) for (const t of (v.tags || [])) tagMap.set(t, (tagMap.get(t) || 0) + 1)
  const tags = [...tagMap.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_TAGS)
  const latest = [...videos].sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-SHOW_LATEST).reverse()
  let s = `\n⭐ **使用者的口味（他主动 @ 她看的视频 = 强兴趣，账本里 ${videos.length} 条）：**\n`
  if (authors.length) s += `  · 他点名过的 UP 主：${authors.map(([a, n]) => (n > 1 ? `${a}（${n} 次）` : a)).join('、')}\n`
  if (tags.length) s += `  · 高频标签 / 主题：${tags.map(([t, n]) => (n > 1 ? `${t}（${n} 次）` : t)).join('、')}\n`
  s += `  · 最近 @ 的视频：${latest.map((v) => `${v.bvid}《${v.title}》${v.author ? `（${v.author}）` : ''}`).join('；')}\n`
  s += `  ⇒ 搜到**这些 UP 主的更新**、或**同标签的同类视频**时，**优先**当成"值得"（挑的时候排前面）。\n`
  s += `     ⚠️ 只是"优先看"：**不加配额、也不强求** —— 没有同类就照常挑，别硬凑、别为了凑数去收低质的。\n`
  return s
}

// ── 单独跑：node lib/taste.mjs <stateDir> [bvid]（方便手工验；带 bvid 只查它、不落账）──
if (process.argv[1] && /taste\.mjs$/.test(process.argv[1])) {
  const dir = process.argv[2] || join(process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh'), 'bili-duty')
  const bv = process.argv[3]
  if (bv) {
    console.log(JSON.stringify(await fetchVideoMeta(bv, loadCredential(dir)), null, 2))
  } else if (existsSync(tasteFile(dir))) {
    console.log(JSON.stringify(readTaste(dir), null, 2))
    console.log(tasteHint(dir))
  } else {
    console.log('还没有口味账：' + tasteFile(dir))
  }
}