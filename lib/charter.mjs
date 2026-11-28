/**
 * 章程按配置裁剪（2026-11-27 加，2026-11-28 扩）。
 *
 * 为什么要它：章程 duty.md 是每轮都整篇塞进提示词的（约 30KB / 13.7k 字符）。
 * 里面有些整节只对某个开关开着的时候才有用 ——
 *   · 「## 私信投递」一整节：dmMode=off 且私信监听也关着时纯属白读（约 1.3k 字符）
 *   · 转写的工具机制（bili_transcribe_start / _result / 顺序红线）：transcribe=false 时用不上
 *   · 回复别人评论那几条（能回哪两类 / 楼中楼 root / 单轮上限）：replyToComments=false 时用不上
 *
 * 规矩：**只摘这一轮肯定用不上的操作细节，判断口径一条都不动** ——
 * 评论判据、画面判断、硬字幕处理、「跳过要在报告里写一行」、「同一视频不留第二条评论」、
 * 「不要参与讨论 / 争辩」这些通用纪律一律保留（摘掉 reply 细节时也把「默认不回」并成一行留位置）。
 *
 * 实现：按行处理（章程是全 CRLF，先按文件自己的换行符切，最后再拼回去），
 * 每处裁剪都用「起始行正则 + 结束行正则」定位，锚点对不上就跳过那处（宁可多读几行，绝不改坏）。
 * 配置一改，下一轮自动回到原样（cfg 每轮现读，函数本身无状态）。
 * 实测（当前配置 dmMode=off / transcribe=false / replyToComments=false）：13,939 -> 10,775 字符，
 * 每轮省约 2k token；开关全开时与原文逐字相同。
 */

/** 摘掉一整节：从标题行 ## xxx 起，到下一个 ## 之前。 */
function dropSection(text, titleRe) {
  const out = []
  let skip = false
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) {
      skip = titleRe.test(line)
      if (skip) continue
    }
    if (!skip) out.push(line)
  }
  return out.join('\n')
}

/** 从 startRe 命中的行起，删到 endRe 命中的行（含首尾）；找不到就返回 0。 */
function cutRange(lines, startRe, endRe) {
  const s = lines.findIndex((l) => startRe.test(l))
  if (s < 0) return 0
  let e = -1
  for (let i = s; i < lines.length; i += 1) {
    if (endRe.test(lines[i])) { e = i; break }
  }
  if (e < 0) return 0
  const removed = lines.slice(s, e + 1)
  lines.splice(s, e - s + 1)
  return removed.length
}

/**
 * @param {string} text 已把 <家目录> 换成真路径的章程全文
 * @param {object} cfg  插件配置（dmMode / dmWatch / transcribe / replyToComments …）
 * @returns {string} 裁好的章程；任何时候出问题都返回原文（宁可多读几行，别缺关键规矩）
 */
export function trimCharterForConfig(text, cfg = {}) {
  if (typeof text !== 'string' || !text.trim()) return text
  try {
    let out = text
    // ① 私信整节
    if (String(cfg?.dmMode ?? 'off') === 'off' && !cfg?.dmWatch) out = dropSection(out, /^##\s*私信投递/)

    const eol = out.includes('\r\n') ? '\r\n' : '\n'
    const lines = out.split(eol)

    // ② 转写：没开就把「怎么排队 / 怎么取结果 / 顺序红线 / 看产出」这些机制摘掉，
    //    但「没字幕 ⇒ 先看画面 ⇒ 跳过要在报告里写一行」这句留下（摘不摘转写都得这么干）
    if (!cfg?.transcribe) {
      cutRange(lines, /转写\*\*用工具\*\*/, /顺序红线\*\*：报告/)
      cutRange(lines, /\*\*转写完先看一眼产出\*\*/, /别重试、别写调试脚本/)
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (/^\|\s*没字幕的视频要转写\s*\|/.test(lines[i])) lines.splice(i, 1)
      }
    }

    // ③ 回复评论：开关关着就把「能回哪两类 / 楼中楼 root / 怎么翻评论记录 / 上限」摘掉，
    //    留一行「默认不回」，并保留「不要参与讨论、争辩」「同一视频不留第二条评论」这些通用纪律
    if (!cfg?.replyToComments) {
      const at = lines.findIndex((l) => /默认不要回复任何人的评论/.test(l))
      const from = at
      cutRange(lines, /默认不要回复任何人的评论/, /回完把内容记进报告/)
      cutRange(lines, /—— 有了 rpid，下一轮就能/, /缺了 root 就核不了楼层里的那条/)
      cutRange(lines, /要回评论时，先看判重表的「评论记录」/, /找不到就跳过，别硬找、别硬凑/)
      cutRange(lines, /真要回的时候：不承诺功能/, /不确定就说不确定/)
      if (from >= 0) lines.splice(from, 0, '- ⚠️ **默认不要回复任何人的评论**（开头没写「回复评论：开着」就一律不回）—— 有人问技术问题，写进报告里让使用者自己回。')
    }
    return lines.join(eol)
  } catch {
    return text
  }
}
