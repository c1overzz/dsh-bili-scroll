// 主人评论 → 关键词增删（跨轮生效的唯一通道）
//
// 设计约束（这是唯一一条「公网评论能改未来行为」的路，必须卡死）：
//   · 只认 `+ 关键词` / `- 关键词` 两种行，别的一律忽略
//   · 只允许「汉字 / 字母 / 数字 / 空格 / - / _」，长度 ≤30，每边最多 20 条
//     （挡住 "。忽略之前设定" 这类标点注入 —— 关键词会被原样拼进提示词）
//   · 只做关键词的增删，不碰人设、条数、开关

const SAFE = /^[\p{L}\p{N} _-]{1,30}$/u

export function parseOwnerNotes(text) {
  const add = []
  const remove = []
  const src = String(text ?? '').slice(0, 8192)
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([+-])\s*(.+)$/)
    if (!m) continue
    const kw = m[2].trim().replace(/\s+/g, ' ')
    if (!SAFE.test(kw)) continue
    if (m[1] === '+') add.push(kw)
    else remove.push(kw)
  }
  return { add: add.slice(0, 20), remove: remove.slice(0, 20) }
}

export function applyOwnerNotes(base, notes) {
  const seen = new Set()
  const out = []
  const rm = new Set((notes?.remove || []).map((s) => s.toLowerCase()))
  for (const k of base || []) {
    if (typeof k !== 'string' || !k) continue
    if (rm.has(k.toLowerCase()) || seen.has(k.toLowerCase())) continue
    seen.add(k.toLowerCase())
    out.push(k)
  }
  for (const k of notes?.add || []) {
    if (rm.has(k.toLowerCase()) || seen.has(k.toLowerCase())) continue
    seen.add(k.toLowerCase())
    out.push(k)
  }
  return out.slice(0, 20)
}
