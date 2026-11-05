/**
 * lib/report-sect.mjs —— 原地替换日报里宿主自己写的那一节（`## 投递` / `## 评论复核`）
 * ============================================================================
 * ⭐ #172 / #166：多轮时这一节后面还有别的轮次写的东西，只能动这一节本身。
 *   规则：找出所有 marker 节 → 全删掉 → 在第一个出现的位置插回合并后的那一节。
 *
 * 这一节在哪结束，不能靠「下一个 `## `」：章程要求模型写 `### BV号`，第二轮常常一个 `## ` 都没有，
 * 那样会一路替换到文件尾，把第二轮整个吞掉。这两节都是宿主自己生成的，形状固定：
 *   标题行 + 空行 + 连续的 `- ` 列表行。第一条不属于这个形状的行就是别人的内容。
 * ============================================================================
 */

// 必须是整行标题：等于 marker，或以「marker（」开头（`## 评论复核（宿主自动跑的…）`）。
// 不能用 indexOf：`### 投递情况` 里也有 `## 投递` 这个子串，会被当成这一节，还留下一个孤立的 `#`。
const isHead = (line, marker) => {
  const t = line.trimEnd()
  return t === marker || t.startsWith(marker + '（')
}

export function replaceSect(cur, marker, block) {
  const body = block.replace(/^\s*\n/, '').replace(/\s*$/, '')
  const lines = cur.split('\n')
  const keep = []
  let at = -1
  for (let i = 0; i < lines.length; i++) {
    if (!isHead(lines[i], marker)) { keep.push(lines[i]); continue }
    if (at < 0) at = keep.length
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    while (j < lines.length && lines[j].startsWith('- ')) j++
    while (j < lines.length && !lines[j].trim()) j++
    i = j - 1
  }
  // 写完后文件尾总留一个空行：下一轮是直接往文件尾追加的，紧贴着写会连成同一个列表（文件尾是别的宿主节时也一样）
  if (at < 0) return cur.replace(/\s*$/, '') + '\n\n' + body + '\n\n'
  const before = keep.slice(0, at).join('\n').replace(/\s*$/, '')
  const after = keep.slice(at).join('\n').replace(/^\s*\n/, '').replace(/\s*$/, '')
  return (before ? before + '\n\n' : '') + body + (after ? '\n\n' + after : '') + '\n\n'
}
