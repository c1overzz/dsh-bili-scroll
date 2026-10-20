/**
 * lib/report.mjs —— 把 out/<YYYY-MM-DD>.md 解析成结构（设置页「看今天的报告」用）
 *
 * 为什么要有它：
 *   - 报告是**那一轮 agent 自己写的 markdown**，格式不完全可控（有人写成 ### BV… 有人多写一句）。
 *   - 设置页原来只能把整篇原文塞进 <pre>，几十条视频翻起来很累，也看不出"今天挑了几条/评论发了几条"。
 *   - 所以这里做**尽量不假设格式**的解析：能认出来的就结构化，认不出来的原样留在 raw 里。
 *
 * 认的格式（来自 prompts/duty.md 的约定）：
 *   - 每条挑中的视频：`### BV号` 开头的一段（标题/USP/为什么值得 在下面几行）
 *   - 宿主复核追加的：`## 评论复核（…）` + `- \`BV…\` rpid **…** —— 公开可见 / 没查到`
 *   - 评论 / 私信 段落：二级或三级标题里带「评论」「私信」
 */

const RE_BV = /^(?:###|####)\s+(BV[0-9A-Za-z]{6,})\s*$/
const RE_HEAD = /^(#{2,4})\s+(.+?)\s*$/
const RE_BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/
const RE_LINK = /(https?:\/\/\S+)/
const RE_RPID = /\brpid\b[^\d]{0,3}(\d+)/i

const clean = (s) => String(s || '').replace(/^[*_`\s]+|[*_`\s]+$/g, '').trim()

/** 判断一段是不是"没写成/占位"的报告 */
export function isStub(text) {
  const t = String(text || '')
  return /<!--\s*bili-duty:\s*stub\s*-->/.test(t) || /这一轮没能正常跑完/.test(t)
}

/** 汇总："今天挑中 N 条 · 评论 M 条 · 私信 K 条 · 复核 P 条" */
export function summarize(parsed) {
  const p = parsed || {}
  const c = (p.comments || []).length
  const d = (p.dm || []).length
  const v = (p.verify || []).length
  const n = (p.picked || []).length
  const bits = [`挑中 ${n} 条`]
  if (c) bits.push(`评论 ${c} 条`)
  if (d) bits.push(`私信 ${d} 条`)
  if (v) bits.push(`复核 ${v} 条`)
  return bits.join(' · ')
}

/**
 * @param {string} text 报告原文
 * @returns {{picked:Array,comments:Array,dm:Array,verify:Array,other:Array,preamble:string,stub:boolean,raw:string}}
 */
export function parseReport(text = '') {
  const raw = String(text || '')
  const lines = raw.split(/\r?\n/)
  const picked = []
  const sections = { comments: [], dm: [], verify: [], other: [] }
  const preamble = []
  let cur = null            // 当前挑中的条目
  let curSec = null         // 当前 section 名（comments/dm/verify/other）

  const newItem = (bv) => ({ bv, title: '', up: '', url: '', body: [], rpid: '', raw: [] })

  for (const line of lines) {
    const mBv = RE_BV.exec(line)
    if (mBv) {
      cur = newItem(mBv[1])
      cur.raw.push(line)
      picked.push(cur)
      curSec = null
      continue
    }
    const mh = RE_HEAD.exec(line)
    if (mh) {
      const title = clean(mh[2])
      cur = null
      if (/复核/.test(title)) curSec = 'verify'
      else if (/私信|投递/.test(title)) curSec = 'dm'
      else if (/评论|@/.test(title)) curSec = 'comments'
      else curSec = 'other'
      sections[curSec].push({ title, items: [] })
      continue
    }
    if (cur) {
      cur.raw.push(line)
      const mb = RE_BULLET.exec(line)
      const body = mb ? mb[1] : clean(line)
      if (!body) continue
      if (!cur.title) {
        // 约定是「标题 / UP / 链接 / 播放量 / 为什么值得」—— 能按 ·/｜/ 切开就取前两段
        const parts = body.split(/\s*[|｜]\s*|\s+\/\s+/)
        cur.title = clean(parts[0]).slice(0, 120)
        if (parts[1] && !/^https?:/i.test(parts[1])) cur.up = clean(parts[1]).slice(0, 60)
      }
      const ml = RE_LINK.exec(body)
      if (ml && !cur.url) cur.url = ml[1]
      if (!cur.rpid) { const mr = RE_RPID.exec(body); if (mr) cur.rpid = mr[1] }
      cur.body.push(body)
      continue
    }
    if (curSec) {
      const mb = RE_BULLET.exec(line)
      if (mb) {
        const item = mb[1]
        const sec = sections[curSec][sections[curSec].length - 1]
        if (sec) sec.items.push(item)
        continue
      }
    }
    if (!picked.length && !sections.verify.length && !sections.comments.length) preamble.push(line)
  }

  const flat = (name) => sections[name].reduce((acc, s) => acc.concat(s.items), [])
  return {
    picked,
    comments: flat('comments'),
    dm: flat('dm'),
    verify: flat('verify'),
    other: sections.other,
    preamble: preamble.join('\n').trim(),
    stub: isStub(raw),
    raw,
  }
}

export default { parseReport, summarize, isStub }
