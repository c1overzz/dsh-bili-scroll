/**
 * 日报解析 —— 把 `out/<日期>.md` 那份 markdown 翻成**结构化对象**，给设置页渲染用
 * ============================================================================
 * 为什么不改报告的文件格式，而是"读的时候解析"：
 *   · 那份 markdown 是**模型自己写**的（章程规定了大致形状，但它每次都不完全一样），
 *     想让它稳定吐 JSON 得改章程 + 加校验 + 处理写歪的情况，链条太长、还容易一轮全废 ✗
 *   · 解析则**零风险**：文件原样保留（照样能 grep、能 git、人也能读），
 *     解析失败也只是这一节退回"显示原文"，不会丢东西 ✓
 *   · 所以每条都留了 `raw` —— 前端**永远**有降级可显示的内容 ✓
 *
 * ⚠️ 解析的关键是**按关键词认节，不能按编号认** —— 真实报告里同一件事的编号是会变的：
 *     `## 一、收（5 条）` / `## 一、值得的 3 条`
 *     `## 四、评论（本轮 1 条）` / `## 四、公开评论（…）` / `## 五、私信（…）`
 *     `## 四、总结` / `## 五、总结` / `## 六、总结`
 *   ⇒ 而且「评论复核」里也有"评论"两个字，**必须先判 verify、再判 comments**，否则会认错 ✗
 * ============================================================================
 */

const BV_RE = /\bBV[0-9A-Za-z]{10}\b/

export const KIND_LABEL = {
  picked: '收了',
  seen: '看过未收',
  skipped: '无字幕跳过',
  comments: '评论',
  dm: '私信',
  verify: '评论复核',
  summary: '总结',
  other: '其他',
}

/** 认一节的类型（顺序有讲究：verify 必须排在 comments 前面） */
function classify(title) {
  if (/复核|核验/.test(title)) return 'verify'
  if (/私信/.test(title)) return 'dm'
  if (/总结|小结/.test(title)) return 'summary'
  if (/跳过|无字幕/.test(title)) return 'skipped'
  if (/看过未收|未收/.test(title)) return 'seen'
  if (/值得|收了|收（|收\(|^一、收|收\b/.test(title)) return 'picked'
  if (/评论|留言|回复/.test(title)) return 'comments'
  // ⭐ 早期格式（2026-10-16 那两天）没有「一、收」这一层 —— 条目直接写成 `## 1. 标题`。
  //    所以**只剩数字开头的标题**就当成"收了一条"✓（放在所有关键词判断之后，免得
  //    把 `## 1. 评论复核` 这类抢走）
  if (/^\d+[.、]\s*\S/.test(title)) return 'picked'
  return 'other'
}

/** 从标题里抠数量：`（本轮 1 条）` / `跳过 8 条` / `（5 条）` → 5；抠不到给 null */
function countIn(title) {
  const m = /(\d+)\s*条/.exec(title)
  return m ? Number(m[1]) : null
}

/** markdown 里那些记号去掉，留纯文本 */
function plain(s) {
  return String(s || '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
}

/** 从一行里抽出 BV 号 / UP / 播放量 */
function meta(line) {
  const s = String(line || '')
  const bv = (BV_RE.exec(s) || [])[0] || ''
  const up = (/UP[：:]\s*([^｜|]+)/.exec(s) || [])[1]
  const play = (/播放[：:]\s*([0-9][0-9,.]*\s*[万亿wWkK]?)/.exec(s) || [])[1]
  const url = (/https?:\/\/[^\s｜|)]+/.exec(s) || [])[0] || ''
  return { bv, up: up ? plain(up) : '', play: play ? play.trim() : '', url }
}

/* ────────────── 各节正文 → items ────────────── */

/** 收了：`### 1. 标题` + `- UP：…｜播放：…｜url` / `- 为什么值得：…` / `- 一句话：…` / `- 本轮评论：…` */
function blankPick(i) {
  return { i, title: '', bv: '', url: '', up: '', play: '', why: '', one: '', comment: '' }
}

/** 把 `- 键：值` 那几行填进一条 pick 里（新旧两种格式共用） */
function fillPick(it, lines) {
  for (const ln of lines) {
    const t = ln.trim()
    if (!t.startsWith('-')) continue
    const kv = /^-\s*([^：:]{1,12})[：:]\s*(.*)$/.exec(t)
    if (!kv) continue
    const k = plain(kv[1]), v = kv[2].trim()
    if (/^(UP|播放|链接|地址|时长|评论)/.test(k) || /https?:/.test(v)) Object.assign(it, pickMeta(it, v, k))
    else if (/为什么|值得|理由/.test(k)) it.why = v
    else if (/一句话|点评|结论/.test(k)) it.one = v
    else if (/评论|留言|回复/.test(k)) it.comment = v
    else if (!it.why) it.why = v          // 认不出来的第一条当"为什么值得"
  }
  if (!it.bv) { const m = BV_RE.exec(lines.join('\n')); if (m) it.bv = m[0] }
  return it
}

function parsePicked(body) {
  const items = []
  for (const b of body.split(/^###\s+/m).slice(1)) {
    const lines = b.split('\n')
    const head = plain(lines.shift() || '')
    const it = fillPick(blankPick(items.length + 1), lines)
    it.title = head.replace(/^\d+[.、]\s*/, '')
    if (!it.bv && head) { const m = BV_RE.exec(head); if (m) it.bv = m[0] }
    items.push(it)
  }
  return items
}

/** 早期格式：标题**就是**条目名，正文直接跟在下面（没有 `### ` 那一层） */
function parseOnePick(title, body) {
  const it = fillPick(blankPick(1), body.split('\n'))
  it.title = plain(title).replace(/^\d+[.、]\s*/, '')
  return it
}

function pickMeta(it, v, k) {
  const m = meta(v)
  const out = {}
  if (!it.bv && m.bv) out.bv = m.bv
  if (!it.url && m.url) out.url = m.url
  // ⚠️ 这里不能只看 `meta(v)` 里的 `UP：` —— kv 拆完键之后，值里那个「UP：」前缀已经没了，
  //    所以「键名就是 UP」这种情况得直接取值的第一段（`虾客云 ｜ 播放：61 ｜ url` → `虾客云`）
  if (!it.up) out.up = /^UP/.test(k) ? plain(v.split(/[｜|]/)[0]) : m.up
  if (!it.play && m.play) out.play = m.play
  if (/播放/.test(k) && m.play) out.play = m.play
  return out
}

/** 列表式（看过未收 / 无字幕跳过）：`- **BV..** 标题（UP）——说明` 或 `1. BV.. —— 标题（UP）` */
function parseList(body) {
  const items = []
  for (const raw of body.split('\n')) {
    const t = raw.trim()
    const m = /^(?:[-*]|\d+[.、])\s+(.*)$/.exec(t)
    if (!m) continue
    const rest = plain(m[1])
    const mm = meta(m[1])
    let title = rest
      .replace(/^BV[0-9A-Za-z]{10}\s*[—\-–]*\s*/, '')
      .replace(/^https?:\/\/\S+\s*/, '')
      .trim()
    const why = (/——|--\s|—\s/.test(title)) ? title.split(/——|—/).slice(1).join('—').trim() : ''
    if (why) title = title.split(/——|—/)[0].trim()
    const up = (/[（(]([^（()）]{1,24})[)）]\s*$/.exec(title) || [])[1] || mm.up
    if (up) title = title.replace(/[（(][^（()）]{1,24}[)）]\s*$/, '').trim()
    items.push({ bv: mm.bv, title: title || rest, up: up || '', why, text: rest })
  }
  return items
}

/** `- 键：值` 式（评论 / 私信那两节） */
function parseKv(body) {
  const items = []
  const prose = []
  for (const raw of body.split('\n')) {
    const t = raw.trim()
    if (!t) continue
    const m = /^[-*]\s*([^：:]{1,16})[：:]\s*(.*)$/.exec(t)
    if (m) items.push({ k: plain(m[1]), v: m[2].trim() })
    else prose.push(plain(t))
  }
  return { items, prose }
}

/** 评论复核：`- \`BV..\` rpid **123** —— 公开可见（赞 0） · 依据：…` */
function parseVerify(body) {
  const items = []
  for (const raw of body.split('\n')) {
    const t = raw.trim()
    if (!t.startsWith('-')) continue
    const s = plain(t.replace(/^-\s*/, ''))
    const bv = (BV_RE.exec(s) || [])[0] || ''
    const rpid = (/rpid\s*([0-9]+)/.exec(s) || [])[1] || ''
    const likes = (/赞\s*([0-9]+)/.exec(s) || [])[1]
    const where = (/依据[：:]\s*([^·]+)/.exec(s) || [])[1]
    const state = /公开可见/.test(s) ? true : (/没查到|未查到|看不到/.test(s) ? false : null)
    items.push({
      bv, rpid, likes: likes === undefined ? null : Number(likes),
      visible: state, where: where ? where.trim() : '',
      detail: (s.split('·').slice(1).join('·') || '').trim(),
      text: s,
    })
  }
  return items
}

/* ────────────── 主入口 ────────────── */

/** 认一轮的标题：取里面**最后一个** HH:MM 当时间，看有没有"手动"，剩下那截当备注 */
function parseRoundHead(head, n) {
  const h = plain(head)
  const times = h.match(/\d{1,2}:\d{2}/g) || []
  const time = times[times.length - 1] || ''
  const mode = /手动/.test(h) ? 'manual' : (/自动|定时|window/.test(h) ? 'auto' : '')
  const paren = (/[（(]([^（()）]*)[)）]\s*$/.exec(h) || [])[1] || ''
  const note = paren.replace(time, '').replace(/[·,，、]\s*/g, ' ').replace(/\s+/g, ' ').trim()
  return { n, title: h, time, mode, note }
}

export function parseReport(text, { day = '', file = '' } = {}) {
  const src = String(text || '')
  const out = {
    ok: true, day, file, exists: src.trim().length > 0, chars: src.length,
    stats: { rounds: 0, picks: 0, seen: 0, skipped: 0, comments: 0, dm: 0, verified: 0, checked: 0 },
    rounds: [],
  }
  if (!out.exists) return out

  // 先按一级标题切轮次；最前面如果有零散内容（没有 # 开头），当成第 0 轮收着
  const chunks = []
  const idx = []
  const re = /^#\s+(?!\#)(.*)$/gm
  let m
  while ((m = re.exec(src))) idx.push({ at: m.index, head: m[1] })
  for (let i = 0; i < idx.length; i++) {
    chunks.push(src.slice(idx[i].at, i + 1 < idx.length ? idx[i + 1].at : undefined))
  }
  const preface = idx.length ? src.slice(0, idx[0].at).trim() : src.trim()
  if (preface && !idx.length) chunks.push(src)

  let n = 0
  for (const chunk of chunks) {
    const lines = chunk.split('\n')
    const head = lines.shift() || ''
    const r = parseRoundHead(head.replace(/^#\s+/, ''), ++n)
    r.sections = []
    const body = lines.join('\n')
    const sIdx = []
    const sRe = /^##\s+(.*)$/gm
    let sm
    while ((sm = sRe.exec(body))) sIdx.push({ at: sm.index, head: sm[1] })
    if (!sIdx.length && body.trim()) {
      r.sections.push({ kind: 'other', num: 0, title: '正文', raw: body.trim(), items: [], count: null })
    }
    for (let i = 0; i < sIdx.length; i++) {
      const seg = body.slice(sIdx[i].at, i + 1 < sIdx.length ? sIdx[i + 1].at : undefined)
      const segLines = seg.split('\n')
      const title = plain(segLines.shift().replace(/^##\s+/, ''))
      const inner = segLines.join('\n').replace(/^\s*-{3,}\s*$/gm, '').trim()
      const kind = classify(title.replace(/^[一二三四五六七八九十]+[、.]\s*/, ''))
      const count = countIn(title)
      const sec = { kind, num: sIdx[i].head, title, raw: inner, count, items: [] }
      if (kind === 'picked') {
        sec.items = parsePicked(inner)
        // ⭐ 没切成 `### ` 说明是早期格式（标题即条目）—— 整节当成一条收的，别丢掉 ✓
        if (!sec.items.length && inner.trim()) sec.items = [parseOnePick(title, inner)]
        sec.count = sec.items.length || count
      }
      else if (kind === 'seen' || kind === 'skipped') { sec.items = parseList(inner); sec.count = sec.items.length || count }
      else if (kind === 'comments' || kind === 'dm') {
        const kv = parseKv(inner)
        sec.pairs = kv.items; sec.prose = kv.prose
        // 标题里没写条数时，用实际解出来的行数兜底（早期格式的「## 评论记录」就没有条数）
        sec.count = count ?? ((kv.items.length || kv.prose.length) ? 1 : 0)
        // 老格式「## 评论记录」里 `- 键：值` 一行一个字段，拿行数当条数会翻好几倍 ✗
      }
      else if (kind === 'verify') { sec.items = parseVerify(inner); sec.count = sec.items.length }
      else if (kind === 'summary') { sec.text = inner }
      r.sections.push(sec)
    }
    /* ⭐ 规范化：老格式里每条 pick 各占一个 `## N. 标题` ⇒ 合并成同一个「收了」节，
     *   这样新旧两种格式在前端长得一样（不用为历史报告写第二套渲染）✓ */
    const merged = []
    for (const sec of r.sections) {
      const prev = merged[merged.length - 1]
      if (sec.kind === 'picked' && prev && prev.kind === 'picked') {
        prev.items.push(...sec.items)
        prev.raw += '\n\n' + sec.raw
        prev.count = (prev.count || 0) + sec.items.length
        prev.items.forEach((x, i) => { x.i = i + 1 })
      } else if (sec.kind === 'verify' && prev && prev.kind === 'verify') {
        // 同一个「评论复核」标题连着出现两次（历史 bug）⇒ 合成一节，后面那一遍去重会收拾重复项
        prev.items.push(...sec.items)
        prev.raw += '\n\n' + sec.raw
        prev.count = prev.items.length
      } else merged.push(sec)
    }
    /* ⭐ 历史报告里「评论复核」被追加过两次（那个 bug 已修）⇒ 同一轮的复核按 bv+rpid 去重 */
    for (const sec of merged) {
      if (sec.kind !== 'verify' || !sec.items?.length) continue
      const seen = new Set()
      sec.items = sec.items.filter((x) => {
        const k = x.bv + ':' + x.rpid
        if (seen.has(k)) return false
        seen.add(k); return true
      })
      sec.count = sec.items.length
    }
    r.sections = merged
    out.rounds.push(r)
  }

  /* 统计 */
  const s = out.stats
  s.rounds = out.rounds.length
  for (const r of out.rounds) {
    for (const sec of r.sections) {
      if (sec.kind === 'picked') s.picks += sec.items.length
      else if (sec.kind === 'seen') s.seen += sec.items.length
      else if (sec.kind === 'skipped') s.skipped += sec.items.length
      else if (sec.kind === 'comments') s.comments += (sec.count || 0)
      else if (sec.kind === 'dm') s.dm += (sec.count || 0)
      else if (sec.kind === 'verify') {
        s.checked += sec.items.length
        s.verified += sec.items.filter((x) => x.visible === true).length
      }
    }
  }
  // 收的条数优先用标题里的数（模型有时一条写两行，条目数会比标题少）
  const titled = out.rounds.reduce((a, r) => a + r.sections
    .filter((x) => x.kind === 'picked' && x.count).reduce((b, x) => b + x.count, 0), 0)
  if (titled > s.picks) s.picks = titled
  return out
}

export default { parseReport, KIND_LABEL }