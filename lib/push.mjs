/**
 * lib/push.mjs —— 手机推送（零依赖，只用 fetch）
 * ============================================================================
 * 支持四种用户可配的通道（URL 由用户自己粘贴，插件不内置任何 key）：
 *   serverchan  Server酱³ / Turbo：POST form（title + desp）
 *   ntfy        任意 ntfy 服务：POST 纯文本，标题放 ASCII header（中文进正文）
 *   wecom       企业微信群机器人：POST JSON（msgtype=markdown）
 *   webhook     任意自建：POST JSON {title, content, items}
 *
 * 原则：
 *   · 推送失败**不影响**这一批入库（面板照常能看）—— 只在 push.log / lastError 里记一笔
 *   · 日志里不打印完整 URL（Server酱 的 key 就在路径里）
 *   · 内容里不许出现账号/路径/内部术语（章程与模板双重约束）
 * ============================================================================
 */
import { fmtDuration } from './feed.mjs'

/** 推送 URL 是否配好（off 或空 URL 都算没配） */
export function isPushConfigured(cfg) {
  const type = String(cfg?.pushType || 'off')
  const url = String(cfg?.pushUrl || '').trim()
  return type !== 'off' && /^https?:\/\/\S+/i.test(url)
}

/** 日志里用的脱敏 URL（只留 host） */
export function maskUrl(url) {
  try {
    const u = new URL(String(url))
    return `${u.protocol}//${u.host}/***`
  } catch { return '（无效 URL）' }
}

/** 一条推荐压成一行（防止 why 里换行把推送撑爆） */
function oneLine(s, max = 160) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/**
 * 把一批推荐渲染成推送文案
 * @param {object} batch 校验通过的 batch
 * @returns {{title:string, markdown:string, plain:string, asciiTitle:string}}
 */
export function buildPushMessage(batch) {
  const items = Array.isArray(batch?.items) ? batch.items : []
  const d = new Date(batch?.createdAt || Date.now())
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const title = `🐟 大肥鱼荐片 · ${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}（${items.length} 条）`
  const md = [title, '']
  const plain = [`大肥鱼荐片 · ${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}（${items.length} 条）`, '']
  items.forEach((it, i) => {
    md.push(`${i + 1}. ${oneLine(it.title, 120)}`)
    plain.push(`${i + 1}. ${oneLine(it.title, 120)}`)
    const meta = [it.author, it.duration ? fmtDuration(it.duration) : ''].filter(Boolean).join(' · ')
    if (meta) { md.push(`   ${meta}`); plain.push(`   ${meta}`) }
    const why = oneLine(it.why, 200)
    if (why) { md.push(`   ${why}`); plain.push(`   ${why}`) }
    if (it.url) { md.push(`   ${it.url}`); plain.push(`   ${it.url}`) }
    md.push('')
    plain.push('')
  })
  const asciiTitle = `Bili Feed (${items.length})`
  return { title, markdown: md.join('\n').trim(), plain: plain.join('\n').trim(), asciiTitle }
}

/** 企业微信 markdown 内容有 4096 字节上限，按 UTF-8 字节截断 */
function truncateUtf8(text, maxBytes) {
  const s = String(text || '')
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8')
    if (bytes + b > maxBytes) break
    out += ch
    bytes += b
  }
  return out + '\n…（已截断）'
}

/**
 * 构造一次推送请求（纯函数，便于单测）
 * @returns {{url:string, init:object}}
 */
export function buildPushRequest(cfg, batch) {
  const type = String(cfg?.pushType || 'off')
  const url = String(cfg?.pushUrl || '').trim()
  if (!/^https?:\/\/\S+/i.test(url)) throw new Error('推送 URL 不合法（要以 http(s):// 开头）')
  const msg = buildPushMessage(batch)
  const timeout = AbortSignal.timeout(8000)
  if (type === 'serverchan') {
    return {
      url,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new URLSearchParams({
          // Server酱 标题上限 32 字（中文也算 1 个），超了会被截或报错
          title: String(msg.title).slice(0, 32),
          desp: msg.markdown,
        }).toString(),
        signal: timeout,
      },
    }
  }
  if (type === 'ntfy') {
    return {
      url,
      init: {
        method: 'POST',
        headers: {
          // HTTP header 不做非 ASCII：中文标题进正文，header 只放 ASCII 标记
          Title: msg.asciiTitle,
          Tags: 'fish,sparkles',
          'content-type': 'text/plain; charset=utf-8',
        },
        body: msg.plain,
        signal: timeout,
      },
    }
  }
  if (type === 'wecom') {
    const content = truncateUtf8(`**${msg.title}**\n\n${msg.markdown}`, 4000)
    return {
      url,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
        signal: timeout,
      },
    }
  }
  if (type === 'webhook') {
    return {
      url,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          title: msg.title,
          content: msg.markdown,
          items: (batch?.items || []).map((it) => ({ bvid: it.bvid, title: it.title, url: it.url, why: it.why })),
        }),
        signal: timeout,
      },
    }
  }
  throw new Error(`不认识的推送通道：${type}`)
}

/**
 * 真发一次。永不抛（失败也返回 {ok:false}），调用方决定怎么记。
 * @returns {Promise<{ok:boolean, type:string, status?:number, error?:string, skipped?:boolean}>}
 */
export async function sendPush(cfg, batch, { log = () => {} } = {}) {
  const type = String(cfg?.pushType || 'off')
  if (!isPushConfigured(cfg)) return { ok: false, skipped: true, type, error: '推送没开（pushType/pushUrl 没配）' }
  let req
  try { req = buildPushRequest(cfg, batch) } catch (e) { return { ok: false, type, error: String(e?.message ?? e) } }
  try {
    const res = await fetch(req.url, req.init)
    let body = ''
    try { body = (await res.text()).slice(0, 300) } catch { /* 读不到就算了 */ }
    if (!res.ok) {
      log(`推送失败（${type} ${maskUrl(cfg.pushUrl)}）：HTTP ${res.status} ${body}`)
      return { ok: false, type, status: res.status, error: `HTTP ${res.status} ${body}`.trim() }
    }
    log(`推送成功（${type} ${maskUrl(cfg.pushUrl)}）`)
    return { ok: true, type, status: res.status }
  } catch (e) {
    log(`推送失败（${type} ${maskUrl(cfg.pushUrl)}）：${e?.message ?? e}`)
    return { ok: false, type, error: String(e?.message ?? e) }
  }
}

/** 测试推送用的假 batch（面板「发条测试」） */
export function testBatch(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return {
    id: `test-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`,
    createdAt: now.toISOString(),
    items: [{
      bvid: 'BV1test00000',
      title: '这是一条测试推送',
      author: '大肥鱼',
      duration: 0,
      url: 'https://www.bilibili.com/',
      summary: '能收到这条，说明推送通道配好了。',
      why: '面板里点「发条测试」发出的，不是真的推荐。',
      highlights: [],
    }],
  }
}
