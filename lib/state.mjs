/**
 * lib/state.mjs —— 插件的"家"与配置
 * ============================================================================
 * 规矩（抄 whale_craft）：**配置、凭证、报告、日志都放插件自己的家** ——
 * `$DSH_HOME/bili-duty/`，**绝不写进插件包目录**（装进 node_modules 后可能只读、升级也会被覆盖）。
 *
 * 还有一件小事但很要紧：vendored 的 `mcp_server.py` 里，凭证路径是
 * `Path(__file__).parent / "bili_credential.json"` —— 所以**运行时要把脚本拷到家目录里再跑**，
 * 这样凭证才会落在家的目录，而不是插件包里。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { createHash as nodeCreateHash } from 'node:crypto'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createPathLayout } from './path-layout.mjs'
import { writeJsonAtomic } from './atomic-write.mjs'

/**
 * 谷时窗口（北京时间）—— 想改就改这一处。
 * ⭐ 官方口径（2026-09-10 起的新定价）：**高峰 = 工作日 9:00–12:00 与 14:00–18:00，其余全是谷时**
 *    ⇒ 12:00–14:00（夹在两个高峰之间）✓、18:00 之后的一整晚 ✓、以及**整个周末** ✓ 都便宜。
 * ⚠️ 我们原来写的 00:30–08:30 是 DeepSeek **早年**的错峰优惠时段，**已经过时** ✗
 *    —— 2026-10-14 使用者在"陌生人验收"里问「晚上峰谷真的是12点半才开始的吗」才查出来 ✓。
 */
export const WINDOWS = {
  noon: { label: '中午谷时', start: '12:00', end: '14:00' },
  night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
}

/**
 * ⭐ 2026-10-14 真机上踩到的坑（dsh 只留一句 `warning: 1 entry did not activate` + 堆栈）：
 *    `ctx.get('dshHomePath')` 返回的是**函数**，不是字符串！
 *    形状：`dshHomePath(...segments) => join(resolveDshHome(), ...segments)`（whale_craft 就是这么用的）。
 *    我一开始当字符串用（`String(p)`），路径就成了「函数源码 + \bili-duty」⇒ mkdir ENOENT ⇒ apply 抛错 ⇒ 插件不激活。
 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('bili-duty')                       // ← 函数形态：把目录名传进去
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'bili-duty')
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  writeJsonAtomic(file, value)
}

/**
 * 把 vendored 的脚本铺进家里。
 *
 * ⭐ 2026-10-22（用户 @俺爱啃猪蹄子 指出策略不一致）：以前是"内容不一样就覆盖" ⇒ **用户改过的直接丢** ✗，
 *    而章程 duty.md 是"改过就保留" —— 同一个插件两套规矩，很怪。
 *    现在改成**记住"上次我们发出去那份的指纹"**（`.shipped-<文件名>.sha`）：
 *      · 家里那份 == 我们发的 ⇒ 正常升级覆盖 ✓
 *      · 家里那份 ≠ 我们发的 ⇒ **说明用户改过** ⇒ 不覆盖，新版写到 `<文件>.new` 并提示 ✓
 *      · 没有指纹（老版本升级上来）⇒ 按老行为覆盖一次并记指纹（从这一版起才有"改过"的概念）✓
 */
export function ensureHomeFiles(pluginDir, stateDir, log = () => {}) {
  const layout = createPathLayout(stateDir)
  const copies = [
    [join(pluginDir, 'vendor', 'bilibili-mcp', 'mcp_server.py'), layout.mcpServerFile],
    [join(pluginDir, 'lib', 'asr.py'), layout.asrFile],
    [join(pluginDir, 'lib', 'favops.py'), layout.favopsFile],
  ]
  const sha = (buf) => {
    try { return nodeCreateHash('sha256').update(buf).digest('hex') } catch { return '' }
  }
  for (const [from, to] of copies) {
    try {
      if (!existsSync(from)) { log(`缺文件：${from}`); continue }
      const incoming = readFileSync(from, 'utf8')
      const markFile = join(stateDir, '.shipped-' + to.split(/[\\/]/).pop() + '.sha')
      const shipped = existsSync(markFile) ? readFileSync(markFile, 'utf8').trim() : ''
      const writeMark = (txt) => { try { writeFileSync(markFile, sha(Buffer.from(txt, 'utf8')), 'utf8') } catch { /* 记不上就下次再说 */ } }
      if (!existsSync(to)) {
        copyFileSync(from, to); writeMark(incoming); log(`已铺好：${to}`); continue
      }
      const onDisk = readFileSync(to, 'utf8')
      if (onDisk === incoming) { if (!shipped) writeMark(incoming); continue }   // 本来就是同一份
      // ⭐⭐ 2.1.0（2026-10-24 实证）：剩下两种情况的处理可以并成一条 ——
      //    这几个文件是**我们发的运行时代码**（mcp_server.py / asr.py / favops.py），
      //    用户改过也不该拦着升级：否则"宿主新、Python 侧旧"，新工具根本不出现 ✗
      //    （今天就这么栽的：家目录那份停在 11:50，值班轮里说"没有 bili_cover 这个工具"）
      //    ⇒ **先备份 .bak-<时间戳>，再覆盖**，改了什么都能自己捞回来 ✓
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      const bak = to + ".bak-" + stamp
      try { copyFileSync(to, bak) } catch { /* 备份不了也继续，原件在插件包里 */ }
      copyFileSync(from, to)
      writeMark(incoming)
      log(`已覆盖：${to}（旧的那份备份在 ${bak}）`)
    } catch (e) { log(`铺 ${to} 失败：${e?.message ?? e}`) }
  }
}

/**
 * 值班章程（prompts/duty.md）放在哪一份 —— 家里那份优先，没有才用插件里那份。
 * （家里那份由下面的 ensureCharter 保证铺好）
 */
export function charterPath(pluginDir, stateDir) {
  const home = join(stateDir, 'duty.md')
  try { if (existsSync(home)) return home } catch { /* 兜底：用插件里那份 */ }
  return join(pluginDir, 'prompts', 'duty.md')
}

/**
 * ⭐ 值班章程怎么升级 —— 2026-10-17 审查里的 M6 就是这里。
 *    老规矩（index.js 里比 mtime）：家里那份比 shipped 新 ⇒ 听使用者的。听着合理，实际是一把**单向锁**：
 *    使用者只要改过章程一个字，家里那份就永远比 shipped 新 ⇒ 插件后续版本改进的章程
 *    （0.1.5 的注入防护、空输出定义恰好就写在章程里）**永远进不来** ✗。
 *    改成记账制 —— 上次铺的是哪一版（sha256）记在 charter.sha256：
 *      · 家里那份 === 我们上次铺的 ⇒ 他没动过 ⇒ 直接用 shipped 覆盖（升级 ✓）
 *      · 家里那份变过      ⇒ 他改过 ⇒ **一个字都不动**，新版另存 duty.md.new 让他自己合 ✓
 *      · 没有账本（带账本的第一个版本刚跑起来）⇒ 分不清「没改只是版本旧」和「改过」，
 *        按「改过」处理 —— 宁可让他手动合一次，也不能偷偷吃掉他的改动 ✓
 */
export function ensureCharter(pluginDir, stateDir, log = () => {}) {
  const shipped = join(pluginDir, 'prompts', 'duty.md')
  const layout = createPathLayout(stateDir)
  const home = layout.dutyFile
  const ledger = layout.charterLedgerFile
  const fresh = layout.dutyFileNew
  const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  try {
    if (!existsSync(shipped)) { log(`缺文件：${shipped}`); return }
    const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
    const newText = readFileSync(shipped, 'utf8')
    const hShip = sha(newText)
    const hLast = readIf(ledger).trim()
    if (!existsSync(home)) {
      writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')
      log('已铺好值班章程')
      return
    }
    const hHome = sha(readFileSync(home, 'utf8'))
    if (hHome === hShip) {                              // 家里那份就是最新版（他可能只是没动过）
      if (hLast !== hShip) writeFileSync(ledger, hShip, 'utf8')
      return
    }
    if (!hLast || hHome !== hLast) {                    // 他改过（或没账本、分不清）⇒ 只另存新版
      if (hShip !== hLast && readIf(fresh) !== newText) {
        writeFileSync(fresh, newText, 'utf8')
        log(`值班章程有新版、但家里那份你改过 ⇒ 新版另存为 ${fresh}，自己合一下`)
      }
      return
    }
    writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')   // 他没动过 ⇒ 直接升级
    log('值班章程已更新到插件里这一版')
  } catch (e) { log(`铺值班章程失败：${e?.message ?? e}`) }
}

/** 'HH:MM' → 当天的分钟数 */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 现在在不在这个窗口里（支持跨零点，比如 23:00–02:00） */
export function inWindow(now, win) {
  const start = minutesOf(win.start); const end = minutesOf(win.end)
  if (start === null || end === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

