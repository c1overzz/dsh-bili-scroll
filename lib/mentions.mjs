/**
 * lib/mentions.mjs —— 「有人 @ 我」
 * ============================================================================
 * 目标：使用者在他的号上 @ 她（插件登录的小号），她**在下一轮顺带**看到，
 *      点进去读视频，再在**那条评论下面**回一句。
 *
 * 为什么由宿主先拉通知，而不是让模型自己查：
 *   ① 模型没有判断「哪条是主人的 @」的可靠依据 —— UID 过滤、去重、额度必须写死在代码里；
 *   ② 每条 @ 都要带上一个**准确的 rpid / root**，那是回复的落点，不能让模型猜；
 *   ③ 通知接口会重复出现同一条（翻页 / 已读状态），宿主记一份账才不会被重复触发。
 *
 * 接口：`GET /x/msgfeed/at`（和 /x/msgfeed/reply 同一套形状）
 *   data.items[].user.mid / nickname
 *   data.items[].item.source_content   ← 那条 @ 的原文
 *   data.items[].item.uri              ← 评论所在视频
 *   data.items[].item.source_id        ← 那条 @ 的评论 rpid
 *   data.items[].item.root_id          ← 楼中楼的根（顶层时 = source_id 或 0）
 *   data.items[].item.business_id      ← 1 = 视频评论
 *   ⚠️ 接口返回的是「所有 @ 我的人」；我们只处理 atOwnerUid 那一个。
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCredential } from './verify.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const AT_API = 'https://api.bilibili.com/x/msgfeed/at'
const STATE_FILE = 'at-state.json'
const HANDLED_TTL = 30 * 86400      // 账本留 30 天，之后清掉，别让文件只长不消
const FIRST_LOOKBACK = 600          // 第一次查（没记过账）时，只看最近 10 分钟，别翻旧账

const headersFor = (cred) => ({
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct || ''}; buvid3=${cred.buvid3 || ''}; DedeUserID=${cred.dedeuserid || ''}`,
})

async function jget(url, headers) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
    const text = await r.text()
    try { return JSON.parse(text) } catch { return { code: -999, message: 'not json' } }
  } catch (e) { return { code: -998, message: String(e?.message ?? e) } }
}

/** 从一段文字里抠 BV 号（评论原文 / 通知 uri / b23 跳转后的 URL 都能用） */
export function extractBv(text) {
  const m = /BV[0-9A-Za-z]{10}/.exec(String(text || ''))
  return m ? m[0] : ''
}

/** b23.tv / bili2233.cn 短链 → BV；解析不了就返回空 */
async function resolveShortLink(text) {
  const m = /(?:b23\.tv|bili2233\.cn)\/([0-9A-Za-z]+)/i.exec(String(text || ''))
  if (!m) return ''
  const url = `https://b23.tv/${m[1]}`
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
  try {
    const r = await fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(8000) })
    const loc = r.headers.get('location') || ''
    const bv = extractBv(loc)
    if (bv) return bv
    if (r.status >= 200 && r.status < 300) return extractBv(await r.text())
  } catch { /* 换下面那条再试 */ }
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    return extractBv(r.url) || extractBv(await r.text())
  } catch { return '' }
}

/** 拉一页「@我的」。返回的 items 是原始通知（含上文的字段）。 */
export async function fetchAtFeed(stateDir, { limit = 20 } = {}) {
  const cred = loadCredential(stateDir)
  if (!cred) throw Object.assign(new Error('还没扫码登录，读不了 @ 通知'), { code: 'NO_CRED' })
  const u = new URL(AT_API)
  u.searchParams.set('build', '0')
  u.searchParams.set('mobi_app', 'web')
  u.searchParams.set('platform', 'web')
  u.searchParams.set('web_location', '333.1387')
  const j = await jget(u.toString(), headersFor(cred))
  if (j?.code !== 0) {
    if (j?.code === -101) throw new Error('登录态失效了（-101）—— 去设置页重新扫一次码')
    throw new Error(`读 @ 通知失败：code=${j?.code} ${j?.message || ''}`.trim())
  }
  const items = Array.isArray(j?.data?.items) ? j.data.items : []
  return {
    items: items.slice(0, Math.max(1, Number(limit) || 20)),
    cursor: j?.data?.cursor || null,
    count: items.length,
    botUid: Number(cred.dedeuserid) || 0,
  }
}

const detailOf = (raw) => {
  let d = raw?.item
  if (typeof d === 'string') { try { d = JSON.parse(d) } catch { d = {} } }
  return d && typeof d === 'object' ? d : {}
}

/**
 * 把一条原始通知收拾成我们真正需要的字段。
 * 注意两个「视频」：`bvid` = 评论所在的视频（回复时必须用它）；
 * `watchBvid` = 要看的视频（原话里另外给了链接时，collect 会把它换掉）。
 */
export function normalizeAt(raw, { botUid = 0 } = {}) {
  const d = detailOf(raw)
  const u = raw?.user || {}
  const text = String(d.source_content ?? d.target_reply_content ?? d.root_reply_content ?? '').trim()
  const uri = String(d.uri || d.native_uri || '').trim()
  const sourceId = Number(d.source_id) || 0
  const targetId = Number(d.target_id) || 0
  const rootRaw = Number(d.root_id) || 0
  const rpid = sourceId || targetId
  const root = rootRaw && rootRaw !== rpid ? rootRaw : 0
  let time = Number(raw?.at_time ?? raw?.reply_time ?? d.at_time ?? d.reply_time ?? 0)
  if (time > 1e12) time = Math.floor(time / 1000)   // 有的接口给毫秒
  const uid = Number(u.mid) || 0
  return {
    id: String(raw?.id ?? `${uid}:${rpid}`),
    uid,
    nickname: String(u.nickname || u.uname || ''),
    text,
    uri,
    bvid: extractBv(uri),
    watchBvid: '',
    rpid,
    root,
    businessId: Number(d.business_id) || 0,
    title: String(d.title || ''),
    time,
    isBot: Boolean(botUid) && uid === botUid,
  }
}

/**
 * 把报告里的 `## @ 互动` 那一节剔掉 —— 宿主数「今天挑了几条」时，回 @ 的视频不算挑中。
 * 从这一节标题起剔到下一个一/二级标题（节里的三级标题也一并剔掉）。
 */
export function stripAtSections(text) {
  const out = []
  let inAt = false
  for (const line of String(text).split(/\r?\n/)) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      if (/^@\s*互动/.test(h[2].trim())) { inAt = true; continue }
      if (inAt && h[1].length <= 2) inAt = false
    }
    if (!inAt) out.push(line)
  }
  return out.join('\n')
}

export function atStateFile(stateDir) { return join(stateDir, STATE_FILE) }

export function readAtState(stateDir) {
  try {
    const j = JSON.parse(readFileSync(atStateFile(stateDir), 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}

function saveAtState(stateDir, st) {
  try { writeFileSync(atStateFile(stateDir), JSON.stringify(st, null, 2), 'utf8') } catch { /* 写不了就下次再来 */ }
}

function pruneHandled(handled) {
  const now = Math.floor(Date.now() / 1000)
  const out = {}
  for (const [k, v] of Object.entries(handled || {})) {
    const t = Number(v?.injectedAt || v?.at || 0)
    if (!t || now - t < HANDLED_TTL) out[k] = v
  }
  return out
}

/**
 * 从「现在」起算新 @（旧 @ 不回）。
 * 打开开关时调用（force）；如果使用者是手改 config.json 开的，第一次 collect 兜底也会补一个。
 */
export function armAtWatcher(stateDir, { force = false } = {}) {
  const st = readAtState(stateDir)
  if (!force && Number(st.since) > 0) return st
  st.since = Math.floor(Date.now() / 1000)
  st.armedAt = st.since
  saveAtState(stateDir, st)
  return st
}

export function atStateInfo(stateDir) {
  const st = readAtState(stateDir)
  return {
    since: Number(st.since) || 0,
    armedAt: Number(st.armedAt) || 0,
    handled: Object.keys(st.handled || {}).length,
  }
}

function markAtHandled(stateDir, items, status = 'claimed', note = '') {
  const st = readAtState(stateDir)
  const handled = { ...(st.handled || {}) }
  const targets = { ...(st.targets || {}) }
  const now = Math.floor(Date.now() / 1000)
  for (const m of items) {
    const key = String(m.id || `${m.uid}:${m.rpid}`)
    handled[key] = {
      status,
      note: m.why || note || '',
      at: Number(m.time) || now,
      injectedAt: now,
      uid: Number(m.uid) || 0,
      rpid: String(m.rpid || ''),
      bvid: m.bvid || '',
      watchBvid: m.watchBvid || '',
      nickname: m.nickname || '',
    }
    if (m.uid && m.rpid) targets[`${m.uid}:${m.rpid}`] = key
  }
  const pruned = pruneHandled(handled)
  for (const [k, v] of Object.entries(targets)) if (!pruned[v]) delete targets[k]
  saveAtState(stateDir, { ...st, handled: pruned, targets })
}

/**
 * 挑出这一轮要处理的 @：
 *   · 只认 ownerUid（主人自己）
 *   · 只认 since 之后的（打开开关前的旧 @ 不回）
 *   · 按通知 id / (uid, rpid) 去重（同一件事不重复回）
 *   · 排在最前面的最多 max 条；**max = 0 表示不限**（这一轮通知里有多少条就处理多少条）
 * 返回的 items 里带 `watchBvid`（真的要看哪个视频）。
 */
export async function collectNewMentions(stateDir, { ownerUid = 0, max = 1, dryRun = false, log = () => {} } = {}) {
  const owner = Number(ownerUid) || 0
  if (!owner) return { items: [], skipped: [], unread: 0, botUid: 0 }
  const want = Math.trunc(Number(max))
  const cap = !Number.isFinite(want) ? 1 : (want <= 0 ? Infinity : want)

  let st = readAtState(stateDir)
  if (!Number(st.since)) {
    const now = Math.floor(Date.now() / 1000)
    st.since = Math.max(0, now - FIRST_LOOKBACK)
    st.armedAt = now
    saveAtState(stateDir, st)
    log(`第一次查 @：只看最近 ${Math.round(FIRST_LOOKBACK / 60)} 分钟（更早的不回）`)
  }
  const since = Number(st.since) || 0

  const { items: rawItems, botUid } = await fetchAtFeed(stateDir, { limit: Number.isFinite(cap) ? Math.max(30, cap) : 50 })
  if (botUid && owner === botUid) {
    log('⚠️ 填的「你的 UID」就是她登录的号 —— 自己 @ 自己通常收不到通知，请填你自己的号')
  }

  const handled = st.handled || {}
  const targets = st.targets || {}
  const candidates = []
  const skipped = []
  const seen = new Set()

  for (const raw of rawItems) {
    const m = normalizeAt(raw, { botUid })
    if (!m.uid || m.uid !== owner || m.isBot) continue
    if (m.time && m.time < since) continue
    if (handled[String(m.id)] || targets[`${m.uid}:${m.rpid}`]) continue
    if (!m.rpid) { skipped.push({ ...m, why: '通知里没有评论 rpid，回不了' }); continue }
    if (!m.bvid) { skipped.push({ ...m, why: '这不是视频评论，或者定位不到视频，没有回复入口' }); continue }
    const key = `${m.bvid}:${m.rpid}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(m)
  }

  if (!dryRun) for (const s of skipped) markAtHandled(stateDir, [s], 'skipped', s.why)

  candidates.sort((a, b) => (a.time || 0) - (b.time || 0))
  const picked = cap === Infinity ? candidates : candidates.slice(0, cap)
  for (const m of picked) {
    const explicit = extractBv(m.text) || await resolveShortLink(m.text)
    m.watchBvid = explicit && explicit !== m.bvid ? explicit : m.bvid
  }
  if (!dryRun && picked.length) markAtHandled(stateDir, picked, 'claimed')

  return { items: picked, skipped, unread: candidates.length, botUid, since }
}

/** 设置页「看看最近谁 @ 了她」：不按 UID 过滤，也不动账本 */
export async function recentMentions(stateDir, { limit = 20 } = {}) {
  const { items: rawItems, botUid } = await fetchAtFeed(stateDir, { limit })
  const items = []
  for (const raw of rawItems) {
    const m = normalizeAt(raw, { botUid })
    if (!m.uid) continue
    items.push({
      id: m.id,
      uid: m.uid,
      nickname: m.nickname,
      text: m.text.slice(0, 160),
      bvid: m.bvid,
      title: m.title,
      time: m.time,
      rpid: m.rpid,
      businessId: m.businessId,
      isBot: m.isBot,
    })
  }
  return { items, botUid }
}

// ── 单独跑：node lib/mentions.mjs <stateDir>（方便手工验；带第 3 个参数才会按 UID 挑，默认不动账本）──
if (process.argv[1] && /mentions\.mjs$/.test(process.argv[1])) {
  const dir = process.argv[2] || join(process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh'), 'bili-duty')
  const owner = Number(process.argv[3]) || 0
  const claim = process.argv.includes('--claim')
  try {
    const r = owner
      ? await collectNewMentions(dir, { ownerUid: owner, max: 5, dryRun: !claim, log: (m) => console.error(m) })
      : await recentMentions(dir)
    console.log(JSON.stringify(r, null, 2))
  } catch (e) {
    console.error('查 @ 失败：' + (e?.message ?? e))
    process.exitCode = 1
  }
}
