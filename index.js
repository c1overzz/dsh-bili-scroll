/**
 * dsh-bili-duty —— host 半端
 * ============================================================================
 * 它是什么：每天替你刷一轮 B站 的插件版。
 *   1. **插件内部起那份 Python MCP**（`vendor/bilibili-mcp/mcp_server.py`），把它的能力
 *      注册成 dsh 工具（搜 / 字幕 / 评论 / 发评论 @ 人 / 登录检查）—— 用户不用再手改 profile。
 *   2. **谷时定时器**：中午 12:00–14:00、夜间 00:30–08:30（`lib/state.mjs` 里的 `WINDOWS`），
 *      开了哪个窗口才在哪个窗口自动跑；「定量刷」的数字是**每天总量上限**。
 *   3. **跑一轮** = 起一个 `dsh --profile headless <prompt>`（跟老方案同一条路，已被验证过），
 *      把 `duty.md` 交给它，报告写进 `<家>/out/<日期>.md`。
 *   4. **设置页**（`client.js`）通过 `/api/bili-duty/*` 读写配置、看状态、扫码登录。
 *
 * 家里（`$DSH_HOME/bili-duty/`）都有什么：`config.json` / `mcp_server.py`（从 vendor 铺过来，
 * 这样凭证 `bili_credential.json` 落在家里而不是插件包里）/ `duty.md` / `out/` / `duty.log`。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

// ⭐ 这两样从**宿主那棵树**里取（拿不到就退到自己的依赖；再拿不到，defineTool 用本地等价实现）。
//    起因（2026-10-16 用户递来的完整报告 + 本机复现）：它们是 optional peer，
//    桌面版 profile 是 `autoInstallPeers: false` ⇒ 永远不装 ⇒ **裸 import 会让整条插件不激活** ✗。
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient } from './lib/mcp.mjs'
import { verifyRecent, appendVerifyToReport } from './lib/verify.mjs'
import { parseReport } from './lib/report.mjs'
import {
  WINDOWS, stateDirOf, readJson, writeJson, ensureHomeFiles, inWindow, dayKey,
  // ⭐ 自定义时段（2026-10-18）：存的是字符串数组，这里是解析 / 体检 / 定窗口那套工具
  normWindows, windowText, analyzeWindows, effectiveWindows, windowBlocks, blockAt, nextRunAt,
} from './lib/state.mjs'
import { loginStart, loginPoll, saveCredential, renderQrPng } from './lib/login.mjs'
import { ensureUv } from './lib/uvfetch.mjs'

export const name = 'bili-scroll'
export const inject = ['webServer', 'tools', 'settings']

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段
 *    （`volatileForm(schema)`，见 dsh-settings），没有这个标记写设置时会抛
 *    "Plugin entry … has no volatile fields"。另外两个条件是：
 *    **loader entry 的 id 必须等于命名空间名**（我们 patch 里就是 `bili-duty`）+ **本模块导出 Config**。
 */
// ⚠️ schemastery 彻底拿不到时，这里会是 undefined —— **插件照常加载**，只是设置页降级
//    （宁可少一个设置页，也不能因为一个 import 让整条插件不激活 ✗）
export const Config = !z ? undefined : z.object({
  /** 定量刷：每天最多挑几条 */
  perDay: z.natural().default(5).extra('volatile', true),
  /** 峰谷自动刷（总开关） */
  peakValley: z.boolean().default(false).extra('volatile', true),
  /** 峰谷子开关：中午 / 晚上（⭐ 只在**没有**自定义时段时才有意义，见 cfg.windows） */
  noon: z.boolean().default(true).extra('volatile', true),
  night: z.boolean().default(true).extra('volatile', true),
  /**
   * ⭐ 自定义时段（2026-10-18 加）：一个字符串数组，每条 `"HH:MM-HH:MM"`（24 小时制）。
   * **非空就完全接管** —— 内置的中午 / 夜间两组就此让位（noon / night 两个开关同时失效）。
   * 可以写成跨零点的（`"18:00-09:00"`），也可以起止相同表示"全天"（`"00:00-00:00"`）。
   * 时段之间允许重叠：调度器会把"此刻命中的每一条"一起记为已跑，所以只会少跑、不会多跑 ✓。
   */
  windows: z.array(z.string()).default([]).extra('volatile', true),
  /** 自动评论 @ 使用者（默认关 —— 会拿用户的号说话，必须他自己开） */
  autoComment: z.boolean().default(false).extra('volatile', true),
  /** ⭐ 私信投递：off=只发评论（现状）· only=只私信（完全不公开评论）· both=评论 + 私信 */
  dmMode: z.string().default('off').extra('volatile', true),
  /** ⭐ 私信发给谁的 UID（数字）。要在 dmMode 不是 off 时填 */
  dmUid: z.natural().default(0).extra('volatile', true),
  /**
   * ⭐⭐ 私信收件人（**一个列表**，一个 UID 一条；非空时优先于 dmUid）。
   * 一轮会给名单里**每个人各发一条**（私信是点对点的，不是群发同一封）。
   */
  dmUids: z.array(z.string()).default([]).extra('volatile', true),
  /** ⭐ 楼中楼回复：开=只在「明确是 AI / 机器人」的账号下面回；关=永远只发自己的顶层评论，绝不回复任何人 */
  aiReply: z.boolean().default(true).extra('volatile', true),
  /** ⭐ 自定义的 AI 识别特征词（**补充**，不是替换 —— 内置那批一直有效；留空 = 只用内置） */
  aiKeywords: z.array(z.string()).default([]).extra('volatile', true),
  /** 本地转写（没字幕的视频用 Whisper 转；默认关，要下模型） */
  transcribe: z.boolean().default(false).extra('volatile', true),
  /**
   * ⭐⭐ 没字幕的视频也看看（2026-10-18 加）。开着的话：拿不到字幕就不去分析内容了，
   * 只凭**标题 + 简介 + 播放/弹幕这些面上的信息**判断值不值得推荐 —— 值得就照样推，
   * 报告里会**明写"没看内容，只凭标题/简介"**，使用者一眼能分清哪些是读过的、哪些只是看着像。
   * 关着 = 老行为：没字幕就跳过（只在报告末尾记一行「因无字幕跳过 N 条」）。
   */
  noSubtitlePick: z.boolean().default(false).extra('volatile', true),
  /** 本地转写用哪个 Whisper 模型（tiny / base / small / medium） */
  asrModel: z.string().default('small').extra('volatile', true),
  /** ⭐ 每轮最多发几条评论（每条里 @ 一次下面那个人） */
  commentPerRound: z.natural().default(1).extra('volatile', true),
  /** ⭐ 要 @ 谁（B站 昵称，单个）；**留空 = 不发评论** —— 保留是为了向后兼容，新配置请用 mentionNames */
  mentionName: z.string().default('').extra('volatile', true),
  /** ⭐⭐ 要 @ 谁（**一个列表**，按顺序 @ 全部）；非空时**优先于** mentionName；留空 = 不发评论 */
  mentionNames: z.array(z.string()).default([]).extra('volatile', true),
  /** 关注关键词（空了用章程里默认那几组） */
  keywords: z.array(z.string()).default([]).extra('volatile', true),
  /** Python：指向 venv 里的那个最好 */
  pythonPath: z.string().default('python').extra('volatile', true),
  /** dsh 的 bin.js（不填就试自动探测，再退化成 shell 里的 dsh） */
  dshBin: z.string().default('').extra('volatile', true),
  /** headless 那一轮用哪个 profile */
  headlessProfile: z.string().default('headless').extra('volatile', true),
  /** 给那一轮叠一份插件自己的 patch（把 B站 MCP 挂上）—— 用户 profile 一个字都不用改 */
  overlayMcp: z.boolean().default(true).extra('volatile', true),
  /** 跑 headless 时的工作目录 */
  workspace: z.string().default('').extra('volatile', true),
  /** 日报形态：full=完整（现状）· brief=每条一两行 · off=不写报告（只发评论） */
  reportLevel: z.string().default('full').extra('volatile', true),
  /** 回复评论：默认关。开了之后只回「直接回复到它那条评论下面的人」 */
  replyToComments: z.boolean().default(false).extra('volatile', true),
  /** 每轮最多回几条 */
  replyPerRound: z.number().default(1).extra('volatile', true),
})

/**
 * ⭐ 给所有 Python 子进程统一 UTF-8。
 * 起因（2026-10-16，用户在评论区反馈）：Windows 上 Python 默认按 GBK 编解码，
 * 我们的脚本 / 内置 MCP 都会往管道里打中文与 emoji（`✅`、`—` 之类），一进管道就可能
 * 报 UnicodeDecodeError / 乱码或直接中断。**编码这种环境差异，插件该自己钉死，不该让用户碰。**
 */
const pyEnv = (extra = {}) => ({
  ...process.env,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  ...extra,
})

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  // ⭐ 自己的版本号（从 package.json 读，设置页要显示它）
  let myVer = ''
  const myVersion = () => {
    if (myVer) return myVer
    try { myVer = String(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '') } catch { myVer = '' }
    return myVer
  }
  const stateDir = stateDirOf(ctx)

  /* ══════════════════════════════════════════════════════════════════════════
   *  跨平台的那点基础设施（2026-10-18 加）
   *  ──────────────────────────────────────────────────────────────────────────
   *  起因：这套东西一开始是照着 Windows 上的 dsh 写的，到 Linux 上**有整条路走不通**
   *  （不是"体验差一点"，是根本不动）：
   *    · `python` 在多数发行版上**压根不存在**（只有 `python3`）⇒ 二维码画不出来、内部 MCP 起不来；
   *    · 一键升级硬编码 `cmd.exe /c` ⇒ 在 Linux 上必然失败；
   *    · 找 `dsh` 只猜 `/usr/local/lib`、`/usr/lib` ⇒ 装在 nvm / `.npm-global` 下就找不到，
   *      退化回裸 `dsh`，而宿主的 PATH 里常常没有它 ⇒ **静默失败**（spawn 的失败是异步的，抓不到）。
   *  这一节只干一件事：**别再靠猜平台、别再写死某一个平台的命令**。
   * ══════════════════════════════════════════════════════════════════════════ */

  const IS_WIN = process.platform === 'win32'
  const IS_MAC = process.platform === 'darwin'

  /**
   * 不用起进程的 `which`。Node 没有内置的同步版，而这里必须**同步**决定用哪个命令。
   * ⚠️ Windows 上光试 `dsh` 不行 —— PATH 里躺的是 `dsh.cmd` / `.exe` ✓
   */
  const whichSync = (name) => {
    const exts = IS_WIN ? ['.cmd', '.exe', '.bat', ''] : ['']
    const dirs = String(process.env.PATH || '').split(IS_WIN ? ';' : ':')
    for (const d of dirs) {
      if (!d) continue
      for (const ext of exts) {
        try { const p = join(d, name + ext); if (existsSync(p)) return p } catch { /* PATH 里有坏项，跳过 */ }
      }
    }
    return ''
  }

  /**
   * 把一个"可执行文件"包成 spawn 能用的形状。三种情况差别很大，写错就静默失败：
   *   · `.cmd` / `.bat`（Windows 上 npm 装的 shim）⇒ **必须**交给 shell，直接 exec 会 EINVAL
   *   · `.exe`（Windows 原生）⇒ 直接 exec
   *   · 其它（POSIX 上带 shebang 的 node 脚本）⇒ 用 `node <它>` 最稳，不依赖可执行位
   */
  const asCommand = (p) => {
    if (/\.(cmd|bat)$/i.test(p)) return { command: p, args: [], shell: true }
    if (/\.exe$/i.test(p)) return { command: p, args: [], shell: false }
    return { command: process.execPath, args: [p], shell: false }
  }

  /**
   * 找 Python。⭐ 顺序：设置里写的 → 自己建的 venv → 系统里的候选。
   * 🔴 原来三个地方直接写 `cfg.pythonPath || 'python'` —— Linux 上 `python` 常常不存在，
   *    于是「扫码登录」画不出二维码、内部 MCP 也起不来（用户只看到一句没头没脑的失败）✗
   */
  const pyCandidates = () => {
    const explicit = String(cfg.pythonPath || '').trim()
    const sys = IS_WIN ? ['python', 'py'] : ['python3', 'python']
    // ⚠️ venvPython() 只是**拼路径**，存不存在由下面逐个探 ✓
    return [...new Set([explicit, venvPython(), ...sys].filter(Boolean))]
  }

  /** 同步能定下来的那部分：设置里写的 → venv 里那份 → PATH 上的（**不做 --version 探测**） */
  const pyPathSync = () => {
    if (pyCache) return pyCache
    for (const c of pyCandidates()) {
      // 带路径的直接看文件在不在（venv 里那份就是这么来的）
      if (c.includes('/') || c.includes('\\')) { if (existsSync(c)) return c; continue }
      const hit = whichSync(c)
      if (hit) return hit
    }
    return ''
  }

  /** 第一个**真的能跑**的 python（带缓存；装完依赖可以 fresh=true 重探） */
  let pyCache = ''
  const resolvePy = async (fresh = false) => {
    if (!fresh) { const quick = pyPathSync(); if (quick) { pyCache = quick; return quick } }
    for (const c of pyCandidates()) {
      if (c.includes('/') || c.includes('\\')) {
        if (existsSync(c)) { pyCache = c; return c }
        continue
      }
      const hit = whichSync(c)
      if (hit) { pyCache = hit; return hit }
      if (await probeCmd(c)) { pyCache = c; return c }
    }
    // 一个能用的都没探到：把平台默认值交出去，让调用方**自己失败一次并报出来**（别在这里抛）
    return IS_WIN ? 'python' : 'python3'
  }

  /** 给同步代码用（写 overlay 那份 yml 的时候）：定不下来就回到平台默认 ✓ */
  const pyForSync = () => pyPathSync() || (IS_WIN ? 'python' : 'python3')

  // ⭐ "就绪"必须检查依赖真的装上了，不能只看目录存不存在
  //    （2026-10-15：只看目录，害一位真实用户"显示就绪但其实装失败"白折腾 ✗）
  const sitePkgs = (venvRoot) => {
    const win = join(venvRoot, 'Lib', 'site-packages')
    if (existsSync(win)) return win
    try {
      const lib = join(venvRoot, 'lib')
      for (const d of readdirSync(lib)) {
        if (!d.startsWith('python')) continue
        const p = join(lib, d, 'site-packages')
        if (existsSync(p)) return p
      }
    } catch { /* 没有就算了 */ }
    return win
  }
  const hasPkg = (venvRoot, prefix) => {
    try { return readdirSync(sitePkgs(venvRoot)).some((n) => n.startsWith(prefix)) } catch { return false }
  }
  const venvReadyNow = () => existsSync(venvPython()) && hasPkg(join(stateDir, '.venv'), 'bilibili_api')
  const asrReadyNow = () => existsSync(asrPython()) && hasPkg(asrDir, 'faster_whisper')
  const cfgFile = join(stateDir, 'config.json')
  const logFile = join(stateDir, 'duty.log')
  const outDir = join(stateDir, 'out')
  mkdirSync(outDir, { recursive: true })

  const log = (msg) => {
    const line = `${new Date().toISOString()}  ${msg}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 日志写不进去也不致命 */ }
    try { ctx.logger?.info?.(`[bili-duty] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }

  // 宿主依赖是从哪儿取的（桌面版那次事故的排查看这里：duty.log 里会写明白）
  for (const n of hostDeps.notes) log(n)

  /**
   * ⚠️ 2026-10-14 事故（第一次挂上就炸了整个 DSH，见当天的 lesson）：
   *   `apply(ctx, config)` 传进来的那个 `config`，字段值**不保证是标量** —— 我们的 `config.pythonPath`
   *   是个**对象**、`config.keywords` 也不是数组（日志里打成 `[object Object]`）。对象是"真值"，
   *   于是 `if (!cfg.peakValley) return` 这类守卫全部失效，一路走到 `cfg.keywords.filter(...)`
   *   抛 TypeError —— 而那是在**定时器回调**里，没人接 ⇒ **整个 dsh 进程被带走** ✗✗。
   *   ⇒ 两条规矩：
   *     ① 逐字段按默认值的类型挑一遍（拿不准就用默认值），再叠自己的 `config.json`；
   *     ② **定时器回调里绝不让异常外冒**（见 tick）—— 未捕获异常会杀掉整个宿主进程。
   */
  const DEFAULTS = {
    perDay: 5, peakValley: false, noon: true, night: true, windows: [], autoComment: false, transcribe: false, noSubtitlePick: false, asrModel: 'small',
    dmMode: 'off', dmUid: 0, dmUids: [], aiReply: true, aiKeywords: [],
    keywords: [], commentPerRound: 1, mentionName: '', mentionNames: [], pythonPath: 'python', dshBin: '', headlessProfile: 'headless', overlayMcp: true, workspace: '', reportLevel: 'full', replyToComments: false, replyPerRound: 1,
  }
  const normalize = (src, base) => {
    const out = { ...base }
    for (const k of Object.keys(base)) {
      const v = src?.[k]
      if (v === undefined || v === null) continue
      if (Array.isArray(base[k])) { if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string') }
      else if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
      else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
      else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
    }
    return out
  }
  const cfg = normalize(readJson(cfgFile, {}), normalize(config, { ...DEFAULTS }))
  /** ⭐ 要 @ 的名单：mentionNames 优先，回落到老的 mentionName（向后兼容） */
  const mentionList = (c = cfg) => {
    const list = Array.isArray(c?.mentionNames) ? c.mentionNames.map((s) => String(s).trim()).filter(Boolean) : []
    if (list.length) return list
    const one = String(c?.mentionName || '').trim()
    return one ? [one] : []
  }
  /** 要 @ 的那串标签：`@A @B`（⚠️ 每个 @ 后面都带一个空格，B站 才认得出这个 @） */
  const mentionTag = (c = cfg) => mentionList(c).map((m) => `@${m}`).join(' ')

  /**
   * ⭐ 私信收件人名单：dmUids（新）优先，回落到老的单个 dmUid（向后兼容）。
   * 顺手把 UID 规范化成**纯数字字符串**（用户从别处复制过来常带空格 / 全角数字 / @ 前缀），
   * 去重、丢零、上限 10 个 —— 一轮给每人各发一条，再多就不是"投递"是"骚扰"了。
   */
  const dmList = (c = cfg) => {
    const raw = Array.isArray(c?.dmUids) && c.dmUids.length ? c.dmUids : [c?.dmUid]
    const out = []
    for (const x of raw) {
      const n = String(x ?? '').replace(/[^\d]/g, '').replace(/^0+/, '')
      if (n && !out.includes(n)) out.push(n)
      if (out.length >= 10) break
    }
    return out
  }

  /** ⭐ 真正生效的时段表：自定义优先，空了才回落到内置的中午 / 夜间 */
  const winList = (c = cfg) => effectiveWindows(c)

  /** 时段体检（设置页要显示"哪两条重叠了"） */
  const winCheck = (c = cfg) => {
    const custom = normWindows(c?.windows)
    return custom.length
      ? { custom: true, windows: custom.map(windowText), issues: analyzeWindows(custom).issues }
      : { custom: false, windows: [], issues: [] }
  }

  /**
   * ⭐ 写配置，并把「**没写进去的键**」报出来（2026-10-17 加）。
   * 🔴 起因：`normalize(patch, cfg)` 是拿**当前 cfg 的键集**过滤的 ——
   *    插件加了新字段但**服务端那半没重载**时，设置页传上来的新字段会被**静默丢掉**，
   *    用户看到的就是"点了保存、re-enter 又变回默认"，完全无从排查 ✗。
   *    所以这里返回 notApplied，由调用方（HTTP 接口 / bili_config）报给使用者 ✓。
   */
  const saveCfg = (patch) => {
    const want = Object.keys(patch || {})
    Object.assign(cfg, normalize(patch, cfg))
    writeJson(cfgFile, cfg)
    return want.filter((k) => !(k in cfg))
  }

  ensureHomeFiles(pluginDir, stateDir, log)

  /* ── 设置命名空间：让 DSH 自带的「插件设置」能编辑这份 Config ──
   * 三个条件缺一不可（抄 qq-mode-console 的血泪注释）：
   *   ① loader entry 的 id 必须**等于命名空间名** —— 我们 cordis.patch.yml 里就是 `bili-duty` ✓
   *   ② 插件模块导出 `Config` ✓  ③ Config 里至少一个字段标 volatile ✓（我们都标了）
   */
  try {
    if (typeof ctx.settings?.register === 'function') {
      ctx.settings.register('bili-duty', Config, { base: {}, applies: 'live' })
      log('已注册设置命名空间 bili-duty')
    }
  } catch (e) {
    if (!/already registered/i.test(String(e?.message ?? e))) log(`注册设置命名空间失败：${e?.message ?? e}`)
  }

  /* ─────────────── MCP（内部起那个 Python MCP） ─────────────── */

  let mcp = null
  let mcpKey = ''
  const mcpKeyNow = () => `${cfg.pythonPath}|${join(stateDir, 'mcp_server.py')}`

  const ensureMcp = async () => {
    if (mcp?.running && mcpKey === mcpKeyNow()) return mcp
    if (mcp) { mcp.stop(); mcp = null }
    const script = join(stateDir, 'mcp_server.py')
    if (!existsSync(script)) throw new Error(`家里没有 mcp_server.py（应有 ${script}）—— 装上插件后重启一次 dsh 会自动铺好`)
    mcpKey = mcpKeyNow()
    mcp = new McpClient({
      // ⭐ 走 resolvePy：设置里的 → 自己建的 venv → 系统里的 python3/python ✓
      command: await resolvePy(),
      args: [script],
      cwd: stateDir,                     // 凭证落在家里 ✓
      // ⭐ 这个内置的 Python MCP 会往 stdout 打中文（ensure_ascii=False）；
      //    Windows 默认 GBK 的话，中文/emoji 一进管道就可能炸 ⇒ 钉死 UTF-8
      env: pyEnv(),
      log,
    })
    return mcp
  }

  const call = async (toolName, args, opts) => {
    const client = await ensureMcp()
    return client.call(toolName, args, opts)
  }

  const hasCredential = () => existsSync(join(stateDir, 'bili_credential.json'))

  /* ─────────────── 工具 ─────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }

  /**
   * 工具返回值一律过一遍这里：**宿主只吃"无损 JSON"**，塞进去任何函数/循环引用/类实例都会报
   * `value is not lossless JSON`（2026-10-14 第一次挂上就撞了一次）。
   */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  tool({
    name: 'bili_whoami',
    description: '看 B站 那边登录的是谁（凭证是否有效、昵称、mid）。第一次用要先在「刷B站」设置页里扫码登录。',
    parameters: {},
    async execute() {
      if (!hasCredential()) {
        return { ok: false, loggedIn: false, hint: '还没登录：去 dsh 设置页的「刷B站」里点「扫码登录」（凭证会存在插件自己的家目录里）' }
      }
      const r = await call('bili_check_credential', {})
      return { ok: true, ...(typeof r === 'object' ? r : { raw: r }) }
    },
  })

  tool({
    name: 'bili_search',
    description: '搜 B站 视频（可排序）。返回标题 / BV号 / 播放量 / UP / 时长 等。\n'
      + '⚠️ 刷一轮的用法：搜近 7 天的、按播放或最新都行，然后**读字幕原文**再判断（别看摘要下结论）。',
    parameters: {
      keyword: { type: 'string', description: '搜索关键词' },
      num: { type: 'number', description: '返回几条（默认 10，最大 50）' },
      order: { type: 'string', description: 'totalrank=综合（默认）/ click=播放 / pubdate=最新 / dm=弹幕' },
    },
    async execute(args) {
      return call('bili_search', {
        keyword: String(args.keyword ?? ''),
        num: Math.max(1, Math.min(Number(args.num) || 10, 50)),
        order: String(args.order || 'totalrank'),
      })
    },
  })

  tool({
    name: 'bili_subtitle',
    description: '取一个视频的字幕（AI 字幕）全文。**判断内容就靠它** —— 没有字幕时，'
      + '若设置里开了「本地转写」再想别的办法，否则直接跳过这条。',
    parameters: { bvid: { type: 'string', description: 'BV号' } },
    async execute(args) { return call('bili_subtitle', { bvid: String(args.bvid ?? '') }) },
  })

  tool({
    name: 'bili_comments',
    description: '取一个视频的热门评论（含点赞/回复数）。刷一轮时顺手翻一眼，看值不值得占用使用者一次注意力。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      num: { type: 'number', description: '取几条（默认 30）' },
    },
    async execute(args) {
      return call('bili_comments', { bvid: String(args.bvid ?? ''), num: Math.max(1, Number(args.num) || 30) })
    },
  })

  tool({
    name: 'bili_reply',
    description: '在视频下发评论（或回复某条评论）。这就是"@ 本人"那一下：短、干净、纯文本 @ 写在正文里。\n'
      + '🔴 安全闸：设置页的「自动评论并 @ 你」**默认是关的**；关着的时候这个工具会拒绝 —— '
      + '除非本人当场让你发（那时传 force: true）。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      text: { type: 'string', description: '评论正文（短、干净、纯文本 @；别写敏感词）' },
      rpid: { type: 'number', description: '要回复的评论 id（0/不填 = 发新评论）' },
      force: { type: 'boolean', description: '本人当场让你发的，传 true 越过"自动评论关着"的闸' },
    },
    async execute(args) {
      // dmMode==='only' 时本轮根本不该发公开评论 —— 在工具层也一并挡掉（除非本人当场 force）
      const commentOn = Boolean(cfg.autoComment && mentionList().length && cfg.dmMode !== 'only')
      if (!commentOn && !args.force) {
        return {
          ok: false,
          blocked: true,
          hint: cfg.dmMode === 'only'
            ? '现在是「只私信」模式（dmMode=only）—— 规定不发公开评论，改成用 bili_send_message 私信。本人当场让你发时传 force: true。'
            : '要发评论得同时满足两条：设置里开着「自动评论并 @ 你」、并且填了「要 @ 谁」。或者本人当场让你发时传 force: true。',
        }
      }
      return call('bili_reply', {
        bvid: String(args.bvid ?? ''),
        text: String(args.text ?? ''),
        rpid: Number(args.rpid) || 0,
      })
    },
  })

  tool({
    name: 'bili_status',
    description: '看它今天的状态：跑了没跑、挑了几条、额度剩多少、报告在哪、登录过没有、下次窗口什么时候开。',
    parameters: {},
    async execute() {
      const st = readJson(join(stateDir, 'state.json'), {})
      const now = new Date()
      return {
        ok: true,
        today: dayKey(now),
        ranToday: st.day === dayKey(now) ? Number(st.count || 0) : 0,
        perDay: cfg.perDay,
        // ⭐ 给的是**生效的那张时段表**（配了自定义就是自定义，没配才是内置的中午/夜间）
        windows: winList().map((w) => ({
          label: w.label, start: w.start, end: w.end,
          opening: inWindow(now, w),
        })),
        customWindows: winCheck().windows,
        windowIssues: winCheck().issues.map((x) => x.text),
        // 今天已经跑过哪几场（覆盖块 key）+ 下一次什么时候跑
        roundsDone: Object.keys(st.windows || {}),
        nextRunAt: (() => {
          const d = nextRunAt(now, winList(), Object.keys(st.windows || {}))
          return d ? d.toISOString() : null
        })(),
        peakValley: cfg.peakValley,
        autoComment: cfg.autoComment,
        // ⭐ 实际会 @ 的名单（mentionNames 优先，回落到老的 mentionName）
        mentionNames: mentionList(),
        mentionTag: mentionTag(),
        dmMode: cfg.dmMode,
        // ⭐ 私信收件人名单（dmUids 优先，回落老的单个 dmUid）+ 原来那个单独的值（向后兼容）
        dmUids: dmList(),
        dmUid: Number(cfg.dmUid) || 0,
        noSubtitlePick: Boolean(cfg.noSubtitlePick),
        aiReply: cfg.aiReply !== false,
        aiKeywords: Array.isArray(cfg.aiKeywords) ? cfg.aiKeywords : [],
        transcribe: cfg.transcribe,
        loggedIn: hasCredential(),
        home: stateDir,
        report: join(outDir, `${dayKey(now)}.md`),
      }
    },
  })

  // ⭐⭐ 报账工具：让「那一轮」把"本轮实际挑到几条"告诉插件（2026-10-17 加）
  //    没有它的话 state.json 里的 count 永远是 0 ⇒ 界面徽章永远是「今天已挑 0 / N」，
  //    而且定时器那句 `if (count >= perDay) return` 永远不成立 ⇒ **每日上限形同虚设** ✗
  tool({
    name: 'bili_note_picks',
    description: '⭐ 报账：把「**这一轮**实际挑到几条」告诉插件，它会累加进当天的额度（今天已挑 X / 上限 Y）。\n'
      + '每一轮**收尾时都要调一次**（**一条都没挑到也要调，传 count: 0**）。\n'
      + '不调的话，设置页那个「今天已挑 X / Y」会一直显示 0，而且**每天的条数上限也拦不住**。',
    parameters: { count: { type: 'number', description: '这一轮实际挑到几条（≥0 的整数）' } },
    async execute(args) {
      const r = notePicks(args?.count)
      log(`本轮报账：挑到 ${r.added} 条，今天累计 ${r.total}/${r.cap}`)
      return {
        ok: true,
        thisRound: r.added,
        todayTotal: r.total,
        cap: r.cap,
        ...(r.cap > 0 && r.total >= r.cap
          ? { note: `今天额度已经用满（${r.total}/${r.cap}）—— 后面自动那几轮不会再开跑（手动跑仍允许，但本轮开头会告诉你"还剩 0 条"，应该只写报告、不再挑新的）。` }
          : { note: `今天还剩 ${Math.max(0, r.cap - r.total)} 条额度。` }),
      }
    },
  })

  tool({
    name: 'bili_run',
    description: '**立刻跑一轮**（不等窗口）：起一个 headless 会话，把 duty.md 交给它去刷、写报告。'
      + '适合"我现在就想看一份"的场合。',
    parameters: {},
    async execute() { const r = runDuty('manual'); return { ok: true, ...r } },
  })

  tool({
    name: 'bili_login_start',
    description: '开始 B站 扫码登录：出二维码（画成 PNG 存在插件家目录里，返回路径）和一个 key。\n'
      + '用法：拿到 PNG 后用 `present` 把它推给本人（手机 B站 → 我的 → 扫一扫），再用 `bili_login_poll` 轮询。\n'
      + '⚠️ 二维码大约 180 秒有效，出码要马上递过去；手机上确认时选「记住我」那种长期登录。',
    parameters: {},
    async execute() {
      const { key, url } = await loginStart()
      const png = await renderQrPng(await resolvePy(), stateDir, url)
      return {
        ok: true, key, url, png,
        hint: png ? '用 present 把这张 PNG 推给本人扫；扫完调 bili_login_poll' : '没画出 PNG：先去设置里点「建 venv 装依赖」（venv 里要有 qrcode）',
      }
    },
  })

  tool({
    name: 'bili_login_poll',
    description: '查扫码结果：waiting 还没扫 / scanned 扫了待确认 / ok 成功 / expired 过期。'
      + '成功时会自动把凭证写进插件家目录的 `bili_credential.json`（MCP 认的那四个字段）。',
    parameters: { key: { type: 'string', description: 'bili_login_start 给的那个 key' } },
    async execute(args) {
      const r = await loginPoll(String(args.key ?? ''))
      if (r.state === 'ok') {
        const file = saveCredential(stateDir, r.credential)
        log(`登录成功，凭证已写入 ${file}`)
        return { ok: true, state: 'ok', file }
      }
      return { ok: r.state !== 'unknown', state: r.state, code: r.code, message: r.message }
    },
  })

  tool({
    name: 'bili_setup',
    description: '给刷B站装运行环境：在插件家目录建一个**独立 venv**、装上那个 Python MCP 的依赖，装完自动把 `pythonPath` 指过去。\n'
      + '**第一次用之前跑一次**。⭐ 它**起完就返回、不等装完**（几分钟的活），进度看家目录里的 `install.log`。',
    parameters: {},
    async execute() { return runInstall() },
  })

  tool({
    name: 'bili_config',
    description: '读 / 改「刷B站」的设置。不给 `patch` 就是读；给了就改（只认 schema 里的字段）。\n'
      + '例：`{"perDay":5,"peakValley":true,"autoComment":false,"transcribe":false,"keywords":["DeepSeek Harness"]}`；'
      + '⭐ **自定义时段**（24 小时制，可多条）：`{"windows":["12:00-14:00","18:00-09:00","07:30-08:15"]}` —— '
      + '**非空就完全接管**（内置的中午 `noon` / 夜间 `night` 两个开关就此失效），清成 `[]` 才回到内置那两组；'
      + '跨零点照写（`"18:00-09:00"`）、起止相同 = 全天（`"00:00-00:00"`）；时段之间**允许重叠**，允许但会告警。'
      + '私信投递：`{"dmMode":"only","dmUids":["10967510","123456"]}`（dmMode = off / only / both；'
      + '`dmUids` 是**名单**，一轮给每人各发一条；老的单个 `dmUid` 仍然认，但名单优先）；'
      + '⭐ 没字幕也推荐：`{"noSubtitlePick":true}`（只凭标题/简介判断，报告里会标注"没看内容"）；'
      + '楼中楼开关 `{"aiReply":false}`；自定义 AI 识别词 `{"aiKeywords":["XX助手","YBot"]}`（**补充**内置那批，不是替换）；'
      + '要 @ 的名单 `{"mentionNames":["某人","另一个人"]}`（按顺序全部 @ 上；老的单个 `mentionName` 仍然认，但名单优先）。',
    parameters: { patch: { type: 'object', additionalProperties: true, description: '要改的字段（可省）' } },
    async execute(args) {
      let notApplied = []
      if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) notApplied = saveCfg(args.patch)
      return {
        ok: true, config: cfg, windows: WINDOWS, home: stateDir, venvReady: venvReadyNow(),
        // ⭐ 生效的时段表 + 重叠告警（跟设置页显示的是同一份判断）
        effectiveWindows: winList(),
        customWindows: winCheck().windows,
        windowIssues: winCheck().issues.map((x) => x.text),
        // ⭐ 报出"没写进去的键"：多半是字段名拼错、或插件加了新字段但**服务端那半没重载**（重启 dsh 即可）
        ...(notApplied.length
          ? { notApplied, note: `⚠️ 这些字段没生效：${notApplied.join(', ')} —— 检查拼写；如果确认没拼错，多半是插件没重载（重启一次 dsh 即可）` }
          : {}),
      }
    },
  })

  /* ─────────────── 跑一轮（跟老方案同一条路：dsh --profile headless <prompt>） ─────────────── */

  const dutyStateFile = join(stateDir, 'state.json')
  const bumpState = (patch) => {
    const st = readJson(dutyStateFile, {})
    const today = dayKey()
    if (st.day !== today) { st.day = today; st.count = 0; st.windows = {} }
    writeJson(dutyStateFile, { ...st, ...patch })
    return st
  }

  /**
   * ⭐⭐ 记「今天挑到几条」（2026-10-17 加固，**修的是上游一个做了一半的每日额度**）。
   * 🔴 起因：`state.json` 里的 `count` 本来是"今天挑了几条"的计数器 ——
   *    UI 徽章读它（「今天已挑 X / 上限」）、定时器也靠它拦每日上限（`if (count >= perDay) return`），
   *    但**全代码里从来没有任何地方给 `count` 加过**（唯一的 `bumpState` 只写 windows / lastRunAt / lastWhy）
   *    ⇒ 徽章**永远是 0**，而且**每日上限根本没在拦** ✗。
   *    根治要靠"那一轮把本轮挑到几条报回来"，所以配了 `bili_note_picks` 工具 + prompt 里的收尾报账要求。
   */
  const picksToday = () => {
    const st = readJson(dutyStateFile, {})
    return st.day === dayKey() ? Math.max(0, Number(st.count || 0)) : 0
  }
  const notePicks = (n) => {
    const st = readJson(dutyStateFile, {})
    const today = dayKey()
    const base = st.day === today ? Math.max(0, Number(st.count || 0)) : 0
    const total = base + Math.max(0, Math.floor(Number(n) || 0))
    // 跨天就把窗口标记一起清掉（跟 bumpState 的行为保持一致）
    writeJson(dutyStateFile, { ...st, ...(st.day === today ? {} : { windows: {} }), day: today, count: total })
    return { added: total - base, total, cap: Number(cfg.perDay) || 0 }
  }

  // ⭐ 一键升级：由宿主自己跑 `dsh plugin --profile web add dsh-bili-scroll`
  //    ⚠️ 装完必须重启 dsh 才生效；⚠️ Windows 上"替换正在运行的插件"可能被文件占用挡住（我们踩过）
  let upgrading = false
  const runUpgrade = () => {
    if (upgrading) return { ok: true, busy: true, log: installLogFile, hint: '正在升级，别重复点' }
    upgrading = true
    appendInstall('\n=== ' + new Date().toISOString() + ' 开始升级（add dsh-bili-scroll）===\n')
    ;(async () => {
      try {
        const dsh = resolveDsh()
        // ⭐ 照抄那一轮的形状：resolveDsh 返回 { command, args, shell }
        //    🔴 这里原来写的是 `if (dsh.shell) { args = ['/c', cmd, ...args]; cmd = 'cmd.exe' }` ——
        //      那是**只对 Windows 成立**的写法 ⇒ Linux 上「一键升级」必然失败 ✗。
        //      正确做法是把 `shell` 交给 spawn（它自己知道该用 cmd.exe 还是 /bin/sh）✓
        const cmd = dsh.command || 'dsh'
        const args = [...(dsh.args || []), 'plugin', '--profile', 'web', 'add', 'dsh-bili-scroll']
        appendInstall('$ ' + [cmd, ...args].join(' ') + (dsh.shell ? '    （经系统 shell）' : '') + '\n')
        const code = await spawnTo(cmd, args, { sink: appendInstall, shell: dsh.shell })
        if (code === 0) appendInstall('=== 升级完成 —— 重启一次 dsh 才生效 ===\n')
        else appendInstall('=== 升级没成功（exit ' + code + '）。可以自己手动跑一次：dsh plugin --profile web add dsh-bili-scroll ===\n')
      } catch (e) { appendInstall('升级崩了：' + (e?.stack ?? e) + '\n') } finally { upgrading = false }
    })()
    return { ok: true, started: true, log: installLogFile, hint: '正在升级 —— 完成后重启一次 dsh 才生效' }
  }

  /**
   * 找到 dsh 本体。⭐ 顺序是**从最可靠到最靠猜**（原来是直接跳到猜，Linux 上常常就猜不着）：
   *   ① 设置里指定的 `dshBin`
   *   ② **正在跑的这个宿主进程自己** —— `process.argv[1]` 就是 dsh 的入口（`node <entry> web …`），
   *      跨平台一致，nvm / `.npm-global` / `%APPDATA%\npm` 那些布局**一个都不用猜** ✓
   *   ③ PATH 里那一份（Windows 上会是 `dsh.cmd`）
   *   ④ 从 **node 自己所在的位置**往外推（比写死 `/usr/local/lib` 靠谱得多）
   *   ⑤ 实在没有：退回裸 `dsh`，让 spawn 的 shell 去找
   */
  const resolveDsh = () => {
    const explicit = String(cfg.dshBin || '').trim()
    if (explicit && existsSync(explicit)) return asCommand(explicit)

    const self = String(process.argv[1] || '')
    if (self && existsSync(self) && (/[\\/]dsh(\.js)?$/i.test(self) || /[\\/]bin\.js$/i.test(self))) {
      return asCommand(self)
    }

    const onPath = whichSync('dsh')
    if (onPath) return asCommand(onPath)

    const nodeDir = dirname(process.execPath)
    const guesses = [
      join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(nodeDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(nodeDir, '..', '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(nodeDir, '..', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].filter(Boolean)
    for (const g of guesses) if (existsSync(g)) return { command: process.execPath, args: [g], shell: false }
    return { command: 'dsh', args: [], shell: true }
  }

  const promptFor = () => {
    // ⭐ 章程取哪一份：**插件里那份（永远跟版本一致）**；但家里那份如果**比它新**，说明使用者自己改过 ⇒ 听使用者的。
    const shipped = join(pluginDir, 'prompts', 'duty.md')
    const homeCopy = join(stateDir, 'duty.md')
    let duty = shipped
    try {
      if (existsSync(homeCopy) && statSync(homeCopy).mtimeMs > statSync(shipped).mtimeMs) duty = homeCopy
    } catch { /* 读不到就用 shipped 那份 */ }
    const kws = Array.isArray(cfg.keywords) ? cfg.keywords.filter(Boolean) : []
    // ⭐ 开场先让它读**工作区**的 AGENTS.md —— 这一轮的工作目录就是使用者的工作区，
    //    AGENTS.md 本来就会自动注入；这里再点一句，保证它真按使用者的设定来（别人的设定同理）。
    // ⭐ 那一轮的工作目录是**插件家**（沙箱只让它写自己工作目录里的东西 ✗），
    //    所以"使用者的设定"由**我们自己读进来**喂给它 —— 它在宿主进程里跑，没有沙箱限制 ✓
    let ownerDoc = ''
    try {
      const wsDir = String(cfg.workspace || '').trim() || process.cwd()
      const agents = join(wsDir, 'AGENTS.md')
      if (existsSync(agents)) {
        const text = readFileSync(agents, 'utf8')
        ownerDoc = '\n\n===== 使用者的 AGENTS.md（他写给自己 AI 的人设与准则，**按这个来**）=====\n'
          + text.slice(0, 6000)
          + '\n===== 设定结束 =====\n'
      }
    } catch { /* 读不到就算了，别因此跑不成 */ }
    // ⭐ 投递方式（2026-10-17 加）：dmMode = off（只评论）· only（只私信）· both（都发）
    //    commentOn 是"这一轮到底能不能发公开评论"的唯一判据（工具层的闸用的是同一套逻辑）
    // ⭐ 要 @ 的名单（mentionNames 优先，回落到老的 mentionName）
    const mentions = mentionList()
    // ⭐ 评论开头要原样写的那串：`@A @B`；**结尾必须再跟一个空格**，B站 才认得出这些 @
    const mentionTagText = mentions.map((m) => `@${m}`).join(' ')
    const commentOn = Boolean(cfg.autoComment && mentions.length && cfg.dmMode !== 'only')
    const dmTo = dmList()
    const dmOn = Boolean(cfg.dmMode !== 'off' && dmTo.length)
    // 楼中楼开关（默认开 = 只在 AI 号下面回；关了 = 永远只发自己的顶层评论）
    const aiReplyOn = cfg.aiReply !== false
    // 使用者自定义的 AI 识别词 —— **补充**内置那批，不是替换
    const aiKw = Array.isArray(cfg.aiKeywords) ? cfg.aiKeywords.map((x) => String(x).trim()).filter(Boolean) : []
    // ⭐ 今天的条数额度：perDay = 每天最多挑几条；picked = 今天已经挑过几条（靠 bili_note_picks 累加）
    const cap = Math.max(0, Number(cfg.perDay) || 0)
    const picked = picksToday()
    const left = Math.max(0, cap - picked)
    return `你是这个账号的 B站 助手。`
      + `下面是使用者的设定（如果有）—— **按它来**，别用你默认那套人格。`
      + `⭐ 语气（照章程里「语气：可爱，但不傻」那节来，**报告和评论都算**）：`
      + `**轻快、可爱、会用可爱的颜文字，但专业劲儿不能丢、别卖蠢** —— `
      + `一段最多一个颜文字、整篇 3~4 个封顶；写到失败 / 风控 / 账号出事这类话题时把颜文字收起来；`
      + `别演成"鱼言鱼语"（自称本鱼 / 本鲸、管人叫主人那套）；`
      + `⭐ 评论的开场要有"可爱 + 活泼"的调子（使用者 2026-10-17 审过的样例，照这个语感来、别逐字抄）：`
      + `楼中楼 → 「${mentionTagText || '@TA'} 嘿嘿，顺着这条我再接一句～」/「${mentionTagText || '@TA'} 诶嘿，举手补充一点点！」；`
      + `顶层 → 「${mentionTagText || '@TA'} 挖到宝啦！这期有个跟我们超对口的实测～」/「${mentionTagText || '@TA'} 报告！今天挖到一期好料」/「${mentionTagText || '@TA'} 发现一条好东西，先给你占个座～」。`
      + `⚠️ **每条换着说、别老用同一句**（像机器人刷屏，也吃风控）；**别再用「补一句：」这种正经起手**；`
      + `口癖可用「挖到宝啦 / 诶 / 哇 / 报告！/ 说到点子上了 / 对的对的」，句尾用「～」收；`
      + `人称偶尔用「我」「咱」就行，**不许给自己起名，也不许管人叫主人**。`
      + ownerDoc
      + `然后读章程 ${duty}，按里面的要求刷一轮 B站，`
      + (cfg.reportLevel === 'brief'
        ? `日报写成薄版：每条一两行（值不值得 + 链接）就够，别写长摘要。`
        : cfg.reportLevel === 'off'
          ? `这一轮不要写日报文件，也别生成任何报告；只有真发了评论就一句话记下。`
          : `把报告写到 ${join(outDir, `${dayKey()}.md`)}。`)
      + `今天的条数上限是 **${cap} 条**（设置里「每天最多挑几条」）—— `
      + `**今天已经挑过 ${picked} 条、这一轮最多还能挑 ${left} 条**`
      + `${left <= 0 ? '（⚠️ **额度已经用满**：这一轮就**只写报告、不要再挑新的**，挑到 0 条是正常的）' : ''}；`
      + `关键词${kws.length ? `用这些：${kws.join('、')}` : '用章程里的默认那几组'}。`
      + `⭐⭐ **收尾必须报账**：这一轮的**最后一步**，一定要调用一次 \`bili_note_picks\`，`
      + `把你**这一轮实际挑到的条数**传进去（**一条都没挑到也要传 count: 0**，别省这一步）—— `
      + `插件靠它维护「今天已挑 X / ${cap}」和每日上限，**不报的话界面上永远是 0**。`
      + `本地转写：${cfg.transcribe
        ? (asrReadyNow()
          ? '开着，而且装好了（没字幕的视频用家里那份 asr.py 转，命令见章程）'
          : '**开着、但依赖没装好** ⇒ 这些视频按下面那条"没字幕也看看"的规矩处理')
        : '关着'}；`
      // ⭐⭐ 「没字幕也看看」（2026-10-18 加）：字幕是判断依据里最贵的一条，但**没有它不等于没法判断**。
      //    开着就退回"只看标题 / 简介这些面上的东西"——**不分析内容**，判断标准相应放宽、结论要标注。
      + (cfg.noSubtitlePick
        ? `⭐⭐ **没字幕的视频也看看**（这个开关开着）：拿不到字幕（也没有转写 / 转写是空的）时，**不要直接跳过** —— `
          + `改看**标题、简介、分区、播放/弹幕/点赞这些面上的信息**，觉得对口就**照样收进报告**。`
          + `🔴 但这时**不要去分析视频内容**：没看过的就是没看过 —— 报告里那条要**明写「没看内容，只凭标题/简介」**，`
          + `理由也只能说"从标题/简介看像哪一类"，**不许编具体内容**（别提"视频里讲了什么/演示了什么" ✗）。`
          + `⚠️ 这类"只看标题"的条数**单独数一行**：报告末尾写「其中 M 条没看内容、只凭标题/简介」。`
        : `没字幕的视频**照老规矩跳过**（只凭标题/简介判断不够稳，这个开关关着）；`)
      + `⭐ 不管哪种情况，**报告里都要写一行「因无字幕跳过 N 条」**（N=0 也写）—— 别让它悄悄少几条。`
      + `判重表 = ${join(stateDir, 'seen.md')}（**就是这个绝对路径**，别写到家目录 ~、也别写到别处）；`
      + `⚠️ 它读不出来或写不进去，**必须在报告里明说** —— 那一轮宁可不发评论，也别当成"没有记录"重发一遍。`
      + `自动评论并 @ ${mentions.length ? mentions.join('、') : '（还没填要 @ 谁）'} 是${commentOn
        ? `开着的（每轮最多 ${cfg.commentPerRound} 条评论，每条 **150 字内**、短、干净）`
        : (cfg.dmMode === 'only'
          ? '关着的 —— 当前是「**只私信**」模式：**这一轮一条公开评论都不许发**（楼中楼也不许），改走私信'
          : '关着的（只写报告，别发评论）')}。`
      + (commentOn
        ? `🔴 **每条评论的开头，必须原样写成**：\`${mentionTagText} \` —— ⚠️ **注意结尾还有那个空格**：`
          + `B站 是**靠空格判定 @ 到哪儿结束**的，所以 ${mentions.map((m) => `@${m}`).join('、')} **每一个 @ 后面都要跟一个空格**，`
          + `写完最后一个名字**还要再补一个空格**，然后才接着写正文 ✗✗ `
          + `（写成 ${mentions.join('')} 这种连在一起的、或者漏了空格，B站 一个都认不出来 = **白 @** ✗）。`
          + `⭐ 名字按上面给的顺序 @，**一个都不能漏**。`
        : '')
      + (dmOn
        ? `⭐⭐ **私信投递**：用 bili_send_message 把这一轮的结果发给 ${dmTo.length > 1
          ? `这 **${dmTo.length} 个** UID：${dmTo.join('、')}`
          : `UID **${dmTo[0]}**`}。`
          + (dmTo.length > 1
            ? `⚠️ **一人一条**（私信是点对点的，不是群发同一封）—— 逐个发，` +
              `每条都按下面的规矩写完整，**别把几个人的 UID 塞进同一次调用** ✗。`
            : '')
          + `内容**别照抄评论那套**：把本轮每条值得的写成 **标题 + 链接 + 一句话理由**`
          + `（私信是私人渠道、不占别人的地方，可以比评论长一点，但**别啰嗦**）。`
          + `🔴🔴 **但私信有长度上限 —— 实测 500 字符就顶了**：`
          + `490 字那条能发出去、再长就被接口拒（报 **code 21007**）✗。`
          + `所以**一条私信务必控制在 500 字以内、最多塞 4~5 条** —— 宁可少放一条，也别整条被拒；`
          + `⚠️ **被拒了就精简一次重发**（删理由、砍条目），**别原样无脑重试** ✗。`
          + `语气照章程「语气」那节来（可爱 + 专业、颜文字最多 1 个）。`
          + `🔴🔴 **私信是写给「人」看的，必须是干净的人话** —— **不许出现任何设置名 / 内部术语 / 台账口径** ✗：`
          + `dmMode、only、aiReply、判据、白名单、prompt、token、复核 这类词，**一个都不许出现在私信正文里**；`
          + `**更不许写「公开评论一条没发 / 楼中楼跳过」这种内部机制说明** ✗`
          + `（那是在跟使用者念操作手册，可读性极差）。他关心的只有：**这次挑了哪几条、为什么值得**。`
          + `（想交代"没别的了"就用一句人话，比如「今天没什么新的了」；`
          + `⚠️ **不要**把「无字幕跳过 N 条」这种统计口径搬进私信 —— 那是**报告**里写的，不是私信里写的。）`
          + `⚠️ 私信里**不用 @ 任何人**；⚠️ **一轮给一个人只发一条私信**（多条合并成一条）；`
          + `⚠️ 私信里**不要**写"本鱼 / 本鲸 / 主人 / 人家"那套；⚠️ 发完把"已私信"记进报告（**报告里**可以写口径）。`
          + (cfg.dmMode === 'both' ? `⚠️ 现在是 **both**：公开评论照发（走下面那一整套规矩），私信**另外**再发一条。` : '')
        : '')
      + (commentOn
        ? (aiReplyOn
          ? `⭐⭐「只在明确是 AI / 机器人的账号下面楼中楼」—— **绝不碰真人**（使用者定的策略，每次发评论前都要走这一步）：`
            + `先用 bili_comments 看这条视频的热门评论，**并判断说话的是不是 AI**（现在会返回 user / sign / mid / level），然后三选一：`
            + `① **明确是 AI / 机器人账号**（大肥鱼 / 鲸鱼娘那种：昵称或签名里有 AI 字样，或正文是"本鱼 / 本鲸 / 人家 + 主人 + 插件 / 判据 / 一轮 / 替我刷"那套鱼言鱼语）`
            + `、**且它已经把"值得"的那个点说出来过** ⇒ **不要另发新评论**，改成**在它那条评论下面回一条楼中楼**`
            + `（bili_reply 带上它的 rpid），正文开头照样是「${mentionTagText} 」（**注意结尾那个空格**）；⭐ **只呼应 / 补充，不许抢功、不许贬低**；`
            + `② **其它一切情况**（没人说过 / 说了的是真人 / 拿不准）⇒ **发自己的新评论（顶层）**，开头写「${mentionTagText} 」（**带结尾空格**）。`
            + (aiKw.length
              ? `⭐ 使用者**另外自定义**了这些 AI 识别特征（⚠️ **内置那批照常有效，这批只是补充**）：`
                + aiKw.map((k) => `「${k}」`).join(' ') + ` —— 昵称 / 签名 / 正文里沾上任意一个，也算"疑似 AI"，照样走上面那套判断。`
              : '')
            + `🔴 **绝对不许在真人的评论下面回复** —— 判不准就当真人，宁可多发一条顶层评论，也不要在真人下面留痕；`
            + `⚠️ 不许硬凑"他是 AI"的证据，判断只用 bili_comments 已返回的字段、别为此多花工具调用；`
            + `⚠️ 同一个视频只留一条（新评论 or 楼中楼，二选一）；⚠️ 走楼中楼时判重表里**同时记**自己那条的 rpid 和被回复的根评论 rpid；`
            + `⚠️ 评论区取不到就当"没人说过"、按 ② 发，别卡住。`
          : `⚠️ **楼中楼回复：关着**（使用者关的）—— **不许在任何人的评论下面回复**，`
            + `不管对方是不是 AI、有没有先说过这个点，**一律只发自己的顶层评论**，开头写「${mentionTagText} 」（**带结尾空格**）；`
            + `评论区里有没有 AI 号都跟你无关，**别为此去翻评论区**；`
            + `⚠️ 同一个视频只留一条评论（就是你自己那条顶层）✓。`)
        : '')
      + (cfg.replyToComments && commentOn
        ? `回复评论：开着（每轮最多回 ${Number(cfg.replyPerRound) || 1} 条）—— 只回「直接回复到你那条评论下面的人」，回完记进报告；找不到你那条评论就跳过，别硬找。`
        : `回复评论：关着（${commentOn && aiReplyOn
          ? '**上面那条「只在 AI 号下面楼中楼」的 ① 除外**，其余一个字都不要回任何人'
          : '一个字都不要回任何人'} —— 有人回复你那条评论也不要理会）。`)
      + `最后用一句话汇报你挑到了什么。现在几点了自己看一眼系统时间。`
  }

  /**
   * 给 headless 那一轮写一份 overlay —— 把 B站 MCP 挂上去。
   * 🔴 为什么需要它：**某个 profile 能拿到什么工具，取决于它自己那层的 patch**
   *    （headless 里那两条 B站 MCP 就是当初手写进去的）。分发给别人时不能要求人家改 profile，
   *    所以插件自己生成一份、跑的时候 `--patch` 带上（dsh 支持可重复的 `--patch`）。
   */
  const ensureOverlay = () => {
    if (!cfg.overlayMcp) return null
    const file = join(stateDir, 'headless-overlay.yml')
    const script = join(stateDir, 'mcp_server.py')
    const posix = (p) => String(p).replace(/\\/g, '/')
    const yml = [
      '- insert:',
      '    - id: mcp-bili-duty',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: bili-duty',
      '        transport: stdio',
      `        command: '${posix(pyForSync())}'`,
      '        args:',
      `          - '${posix(script)}'`,
      '',
    ].join('\n')
    try { writeFileSync(file, yml, 'utf8'); return file } catch (e) { log(`写 overlay 失败：${e?.message ?? e}`); return null }
  }

  /**
   * ⭐ 评论发出后复核（2026-10-16 加的行 —— 起因是用户在评论区反馈
   *    「**回执成功不等于公开可见，新号会被压审**」）：
   * 那一轮的 `bili_reply` 回"发送成功"只代表**接口收了**；新号 / 风控会让它进审核，
   * 那时候连 @ 通知都不会推 ⇒ 插件以为发了、下一轮又不再发 ⇒ **一条都没到人**。
   * 所以由**宿主**（有网络、有凭证、不受沙箱限制）去拉一次评论列表 / 楼中楼来核。
   * ⚠️ 措辞守则：看不到写「**没查到**」，**绝不写"没发出去"**（翻页/热度排序都会漏）。
   */
  let verifying = false
  const runVerify = async (why = 'manual') => {
    if (verifying) return { ok: false, error: '上一次复核还没跑完，等它完事' }
    verifying = true
    try {
      log(`评论复核开始（${why}）`)
      const r = await verifyRecent(stateDir, { log })
      const f = appendVerifyToReport(stateDir, r.text)
      log(`评论复核结束（${why}）：查了 ${r.checked.length} 条${f ? `，已写进 ${f}` : ''}`)
      return { ok: true, why, checked: r.checked, skipped: r.skipped, text: r.text, report: f || '' }
    } catch (e) {
      log(`评论复核失败（${why}）：${e?.message ?? e}`)
      return { ok: false, why, error: String(e?.message ?? e) }
    } finally { verifying = false }
  }

  /**
   * ⭐ 保底：那一轮**没写出报告**时，宿主自己补一份"占位报告"。
   * 起因（2026-10-16 用户实测反馈）：有一轮卡在"转写返回空 ⇒ 以为 ASR 坏了"上反复重试，
   *   最后 `out/` 是空的、判重表也没建 ⇒ **使用者完全看不到发生了什么**，也不知道白烧了钱 ✗。
   * ⚠️ 只在"报告本来该有却没有"时补（`reportLevel: off` 不补 ✓），不覆盖已有的报告 ✓。
   */
  const stubReportIfMissing = (code) => {
    try {
      if (String(cfg.reportLevel || 'full') === 'off') return
      const f = join(outDir, `${dayKey()}.md`)
      if (existsSync(f)) return
      let tail = ''
      try { tail = readFileSync(logFile, 'utf8').slice(-1500) } catch { /* 读不到就算了 */ }
      writeFileSync(f, [
        `# 刷B站 · ${dayKey()} —— 这一轮没写出报告`,
        '',
        `> ⚠️ 那一轮结束了，但没有生成正常报告（退出码 ${code}）。`,
        '> 常见原因是它卡在某个工具上反复重试、或者把预算烧完了。下一轮它会重来。',
        '> 下面附日志尾部，方便定位（插件数据目录里的 `duty.log` 有完整版）。',
        '',
        '```',
        String(tail).trim(),
        '```',
        '',
      ].join('\n'), 'utf8')
      log('这一轮没写报告 ⇒ 宿主补了一份占位报告')
    } catch (e) { log(`补占位报告失败：${e?.message ?? e}`) }
  }

  /* ─────────────── 调试状态（设置页「调试」那一栏用）───────────────
   * ⚠️ 为什么得宿主自己记：`runDuty` 是**发起就不等**的（spawn 完立刻 return），
   *    不把 child 存下来的话，界面根本无从知道"现在到底跑没跑"、跑了多久 ✗
   */
  const progressFile = join(stateDir, 'progress.jsonl')
  let dutyChild = null
  let dutyStartedAt = null
  let dutyWhy = ''
  let dutyLastExit = null

  /** 往进度流里追一条"这一轮开始了"的分隔标记（前端按它给进度分段） */
  const markRoundStart = (why) => {
    try {
      appendFileSync(progressFile, JSON.stringify({
        ts: Date.now() / 1000,
        at: new Date().toTimeString().slice(0, 8),
        tool: '__round__', phase: 'start', label: `开始跑一轮（${why}）`, why,
      }) + '\n', 'utf8')
    } catch { /* 写不进去也不该影响跑这一轮 */ }
  }

  /** 读文件的尾巴（掐掉可能被截断的那半行） */
  const tailOf = (file, tailBytes) => {
    try {
      const st = statSync(file)
      const start = Math.max(0, st.size - tailBytes)
      let txt = readFileSync(file, 'utf8').slice(start)
      if (start > 0) { const nl = txt.indexOf('\n'); txt = nl >= 0 ? txt.slice(nl + 1) : '' }
      return txt
    } catch { return '' }
  }

  /** 进度流（MCP 那边一个工具调用写两行：start / ok|fail|error） */
  const readProgress = (keep = 240) => {
    const txt = tailOf(progressFile, 400_000)
    const out = []
    for (const ln of txt.split('\n')) {
      if (!ln.trim()) continue
      try { out.push(JSON.parse(ln)) } catch { /* 半行/坏行跳过 */ }
    }
    return out.slice(-keep)
  }

  /** duty.log 里的"关键行" —— 那 1MB transcript 人根本读不动，只挑阶段与报错出来 */
  // ⚠️ 那 1.2 万行里大半是模型自己的 transcript（连章程正文都在里面），所以关键词得挑准：
  //    · 裸的「失败 / 超时」会被报告正文里的「失败两次就记为跳过」之类误伤 ⇒ 要求带上下文
  //    · 真日志里接口报错长这样：`错误代码：-650，信息：用户等级太低。` ⇒ 单独认一条
  const KEY_LINE = /刷B站(开跑|结束|起不来)|评论复核(开始|结束)|Traceback|Uncaught|Unhandled|错误代码|Error:|Exception|code=[0-9]|失败[（(：:]|请求超时|连接超时/
  const KEY_BAD = /Traceback|Uncaught|Unhandled|错误代码|Error:|Exception|起不来|失败[（(：:]|请求超时|连接超时|code=[1-9]/
  const readKeyLines = (keep = 80) => {
    const out = []
    for (const ln of tailOf(logFile, 600_000).split('\n')) {
      const t = ln.trim()
      if (!t || !KEY_LINE.test(t)) continue
      out.push({ text: t.slice(0, 320), bad: KEY_BAD.test(t) })
    }
    return out.slice(-keep)
  }

  const debugInfo = () => {
    const running = Boolean(dutyChild)
    let stats = null
    try {
      const p = join(outDir, dayKey() + '.md')
      if (existsSync(p)) stats = parseReport(readFileSync(p, 'utf8')).stats
    } catch { /* 报告还没有/读不动都不算调试失败 */ }
    return {
      ok: true, running, why: dutyWhy,
      startedAt: dutyStartedAt, elapsedMs: dutyStartedAt ? Date.now() - dutyStartedAt : 0,
      lastExit: dutyLastExit, today: dayKey(),
      progress: readProgress(), keyLines: readKeyLines(),
      logTail: tailOf(logFile, 6000), logFile, progressFile,
      // ⭐ 这一轮**到底被交代了什么**（2026-10-18 加）：提示词是按当前设置现拼的，
      //    光看设置页只能猜"它会不会按我说的做" —— 把原文摊出来，有疑问一眼就能核 ✓
      prompt: promptFor(),
      promptChars: promptFor().length,
      stats,
    }
  }

  const runDuty = (why = 'window') => {
   try {
    const dsh = resolveDsh()
    const overlay = ensureOverlay()
    const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
    if (overlay) args.push('--patch', overlay)
    args.push(promptFor())
    // ⭐ 这一轮的工作目录 = 使用者（或别的用户）的**工作区** —— 只有这样它的 `AGENTS.md` 才会自动加载。
    // ⭐ 工作目录 = **插件家**：那一轮**被沙箱关着**，只写得了自己工作目录里的东西 ✗
    //    （2026-10-14 教训：为了让它读工作区里的 AGENTS.md 把 cwd 改成工作区 ⇒
    //      它写不了家目录里的 out/ 报告、整轮卡在"我是被沙箱关着的"上面打转 ✗；
    //      现在改成"设定由插件读进来、内联进提示词" ✓，cwd 回到插件家 ✓）
    const cwd = stateDir
    log(`刷B站开跑（${why}）：${dsh.command} ${args.slice(0, 3).join(' ')} …  cwd=${cwd}`)
    const child = spawn(dsh.command, args, {
      cwd,
      shell: dsh.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // ⭐ PYTHONUTF8 / PYTHONIOENCODING：Windows 上 Python 默认按 GBK 编解码，
      //    中文 / emoji 打进管道会炸（用户反馈过 UnicodeDecodeError），一律按 UTF-8 来
      env: pyEnv({ BILI_DUTY_HOME: stateDir }),
    })
    const pick = (buf) => appendFileSync(logFile, String(buf), 'utf8')
    child.stdout?.on('data', pick)
    child.stderr?.on('data', pick)
    // ⭐ 调试页要看到"正在跑"：把 child / 开始时间 / 为什么跑 都留一份
    dutyChild = child
    dutyStartedAt = Date.now()
    dutyWhy = why
    markRoundStart(why)
    child.on('exit', (code) => {
      if (dutyChild === child) dutyChild = null          // 只有"当前这一轮"才清，避免连跑时互相顶掉
      dutyLastExit = { code, at: Date.now(), why }
      log(`刷B站结束（${why}，code=${code}）`)
      stubReportIfMissing(code)   // ⭐ 没写报告就补一份占位 —— 别让使用者什么都看不到
      // ⭐ 发完评论之后**过一会儿再核一次**（2026-10-16 加的「评论发出后复核」）：
      //    接口回"发送成功"≠ 公开可见（新号/风控会进审核）；而"不公开"时连 @ 通知都不会推 ⇒
      //    插件会以为发了、下一轮不再发 ⇒ 一条都没到人。等 90 秒再查，避免把"还在审核"误判成"没发出去"。
      setTimeout(() => { Promise.resolve(runVerify('round')).catch((e) => log('复核异常：' + (e?.message ?? e))) }, 90_000)
    })
    child.on('error', (e) => log(`刷B站起不来：${e?.message ?? e}`))
    return { started: true, why, profile: cfg.headlessProfile, cwd, log: logFile }
   } catch (e) {
    log(`刷B站开跑失败（${why}）：${e?.stack ?? e}`)
    return { started: false, why, error: String(e?.message ?? e) }
   }
  }

  /* ─────────────── 谷时定时器 ───────────────
   * 🔴 2026-10-14 事故（使用者那边表现为"DSH 突然崩了、网页 Failed to fetch (gateway/internal)"）：
   *    第一版是 `setInterval(tick, 60_000)`，回调里抛的 TypeError **没人接**，直接把整个宿主进程带走
   *    （`dsh: fatal uncaught exception`）。⇒ **定时器回调必须自己兜住所有异常**：
   *    插件再错也只该"这一轮没跑成"，绝不该杀宿主。
   */
  const tick = () => {
    try {
      if (!cfg.peakValley) return
      const now = new Date()
      const st = readJson(dutyStateFile, {})
      const today = dayKey(now)
      const count = st.day === today ? Number(st.count || 0) : 0
      if (count >= Number(cfg.perDay || 0)) return
      /* ⭐ 自定义时段（2026-10-18）：生效的那张表由 winList() 给 —— 配了自定义就用自定义，
       *    没配才回落到内置的中午/夜间。**判"这一场跑过没有"靠的是覆盖块**（见 state.mjs 里那段长注释）：
       *    互相重叠的时段算同一场，跨零点的算作开始那天那一场 —— 否则重叠会一小时刷两轮、
       *    跨零点会在凌晨多刷一轮 ✗ */
      const at = blockAt(now, windowBlocks(winList()))
      if (!at || st.windows?.[at.key]) return
      bumpState({
        windows: { ...(st.windows || {}), [at.key]: true },
        lastRunAt: now.toISOString(),
        lastWhy: at.labels.join(' + '),
      })
      runDuty(`window:${at.key}`)
    } catch (e) {
      log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    }
  }

  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()                                    // 别因为这个定时器让进程不肯退出
    ctx.effect(() => () => clearInterval(timer), 'bili-duty: 谷时定时器')
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── HTTP（设置页用） ─────────────── */

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  // ── 「打开文件夹」以及**没有桌面时的退路** ────────────────────────────────
  //  🔴 原来这里是一句 `if (process.platform !== 'win32') return { error:'这个按钮目前只做了 Windows' }`
  //     —— Linux 使用者点下去只看到一句拒绝，功能是**缺的** ✗。
  //  ✅ 现在分两层：
  //     ① 有桌面的机器：macOS 用 `open`，Linux 依次挑真的装了的打开器；
  //     ② **没有桌面**（服务器 / NAS，这台就是）：老实说清楚，并把路径带回去，
  //        设置页那边可以直接翻这个目录 / 看文件内容 / 下载 ✓
  const desktopOpeners = (dir) => {
    if (IS_MAC) return [['open', [dir]]]
    if (IS_WIN) {
      // ⭐ 顺序有讲究：`cmd start` 走 shell 的 ShellExecute，**最可能真的弹出窗口**；
      //    PATH 不全时 explorer.exe 找不到 ✗；spawn 的失败是**异步**的（下面必须挂 error 监听）
      return [
        ['cmd.exe', ['/c', 'start', '', dir]],
        [join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [dir]],
        ['powershell.exe', ['-NoProfile', '-Command', "Start-Process -FilePath '" + dir.replace(/'/g, "''") + "'"]],
      ]
    }
    // Linux / 其它 POSIX：**挑真的在的**那个 —— 很多 NAS 上一个都没有（⇒ 空数组，走第 ② 层）
    const cands = [
      ['xdg-open', [dir]], ['gio', ['open', dir]], ['kde-open5', [dir]], ['kde-open', [dir]],
      ['exo-open', [dir]], ['gnome-open', [dir]], ['deepin-open-file', [dir]],
      ['nautilus', [dir]], ['dolphin', [dir]], ['thunar', [dir]], ['nemo', [dir]],
      ['pcmanfm', [dir]], ['caja', [dir]], ['nemo', [dir]],
    ]
    return cands.map(([c, a]) => [whichSync(c), a]).filter(([c]) => c)
  }

  /** ⚠️ 只允许**单层**文件名：挡掉 `../`、绝对路径、盘符 —— 这是个能读任意路径的口子 ✗ */
  const safeName = (n) => {
    const s = String(n || '')
    if (!s || s.length > 200 || s.includes('/') || s.includes('\\') || s.includes('..')) return ''
    return s.replace(/[\x00-\x1f]/g, '')
  }
  const dirOf = (what) => (String(what) === 'home' ? stateDir : outDir)

  /** 列一个目录：目录在前，其余按时间**新→旧**（"刚跑完那份报告"永远在最上面 ✓） */
  const listDir = (dir) => {
    const rows = []
    for (const name of readdirSync(dir)) {
      try {
        const st = statSync(join(dir, name))
        rows.push({ name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs })
      } catch { /* 读不了就不列，别整个接口挂掉 */ }
    }
    rows.sort((a, b) => (a.dir === b.dir ? b.mtime - a.mtime : (a.dir ? -1 : 1)))
    return rows.slice(0, 300)
  }

  /** 目标目录 = 白名单根 + **单层**子目录（子目录名同样要过 safeName，挡掉 ../ ✗） */
  const subDir = (which, sub) => {
    const base = dirOf(which)
    const seg = safeName(sub)
    return seg ? join(base, seg) : base
  }

  const venvPython = () => process.platform === 'win32'
    ? join(stateDir, '.venv', 'Scripts', 'python.exe')
    : join(stateDir, '.venv', 'bin', 'python')

  /**
   * 建 venv + 装依赖 —— ⭐ **起完就返回，不等它装完**。
   *
   * 🔴 为什么必须这样（2026-10-14 事故）：第一版是 `async` 全程 await，
   *    而"建 venv + pip install"在使用者这条网络上要**几分钟** ⇒ 那个工具调用一直挂着，
   *    **整个会话僵住、连"暂停"都卡，最后只能重启 dsh** ✗。
   *    现在的做法：spawn 出去、输出追加进 `install.log`，函数立刻返回；
   *    想知道装完没 —— 读日志，或看 `bili_duty_status` 里的 `installing`。
   * 依赖走**国内镜像**（使用者那条网络 pip 直连只有 ~24KB/s ✗；uv + 清华源是几十秒 ✓）。
   */
  let installing = false
  const installLogFile = join(stateDir, 'install.log')
  const appendInstall = (s) => { try { appendFileSync(installLogFile, s, 'utf8') } catch { /* 写不进去就算了 */ } }

  let uvOk = null
  const haveUv = async () => {
    if (uvOk !== null) return uvOk
    uvOk = await new Promise((resolve) => {
      try {
        const c = spawn('uv', ['--version'], { windowsHide: true, stdio: 'ignore' })
        c.on('exit', (code) => resolve(code === 0))
        c.on('error', () => resolve(false))
      } catch { resolve(false) }
    })
    return uvOk
  }

  /** 探一下某个命令在不在（用于"这台机器有没有 python"）—— 陌生人第一条坎就卡在这儿 */
  const probeCmd = (cmd) => new Promise((resolve) => {
    try {
      const c = spawn(cmd, ['--version'], { windowsHide: true, stdio: 'ignore' })
      c.on('exit', (code) => resolve(code === 0))
      c.on('error', () => resolve(false))
    } catch { resolve(false) }
  })

  const spawnLogged = (cmd, args) => new Promise((resolve) => {
    appendInstall(`\n$ ${cmd} ${args.join(' ')}\n`)
    let c
    try { c = spawn(cmd, args, { cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: pyEnv() }) }
    catch (e) { appendInstall(`起不来：${e?.message ?? e}\n`); return resolve(1) }
    const w = (b) => appendInstall(String(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    c.on('exit', (code) => { appendInstall(`\n--- exit ${code} ---\n`); resolve(code) })
    c.on('error', (e) => { appendInstall(`起不来：${e?.message ?? e}\n`); resolve(1) })
  })

  // ───────── 本地转写（ASR）：**独立环境**，别把主 venv 撑成 1GB ─────────
  const asrDir = join(stateDir, '.venv-asr')
  const asrLogFile = join(stateDir, 'asr-install.log')
  const asrPython = () => join(asrDir, process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python')
  const appendAsr = (s) => { try { appendFileSync(asrLogFile, String(s)) } catch { /* 日志写不了也不能炸 */ } }
  // ⭐ 转写的临时目录必须由**宿主**预先建好：值班那一轮跑在沙箱里，
  //    而沙箱只允许写"该子进程启动前就已存在"的目录（2026-10-14 那一轮自己挖出来的规则）
  const asrTmp = join(stateDir, 'tmp', 'asr')
  try { mkdirSync(asrTmp, { recursive: true }) } catch { /* 建不了也别拦着插件加载 */ }

  // ⭐ 判重表也由**宿主**预先建好（两个原因）：
  //   ① 那一轮被沙箱关着，"新建文件"会被拒（2026-10-14 那条规矩）；
  //   ② 它读不出判重表 ⇒ 以为"没记录过" ⇒ 同一批视频反复推送（用户实测反馈 2026-10-16）。
  const seenFile = join(stateDir, 'seen.md')
  try {
    if (!existsSync(seenFile)) {
      writeFileSync(seenFile, [
        '# 刷B站 · 判重表（宿主预建，那一轮只往后面追加）',
        '',
        '## 评论记录（BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字）',
        '',
        '| BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字 |',
        '| --- | --- | --- | --- | --- |',
        '',
        '## 看过的视频',
        '',
      ].join('\n'), 'utf8')
    }
  } catch { /* 建不了也别拦着插件加载 */ }
  let installingAsr = false

  /** 找 uv：系统里的 → 插件家里下好的 → 自己下一份（给"两样都没有"的人）；主/转写两套安装共用 */
  const resolveUv = async () => {
    const bundled = join(stateDir, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
    if (await haveUv()) return 'uv'
    if (existsSync(bundled)) return bundled
    appendInstall('这台机器上没有 uv —— 我下一份放进插件家目录（单文件、免管理员、约 15MB，只需要一次）…\n')
    const got = await ensureUv({ dir: join(stateDir, 'bin'), log: appendInstall })
    if (got) appendInstall('uv 已就位：' + got + '\n')
    return got
  }

  /** 跟 spawnLogged 一样，但可以写进别的日志、可以带环境变量 */
  const spawnTo = (cmd, args, { sink = appendInstall, env = null, shell = false } = {}) => new Promise((resolve) => {
    sink(`\n$ ${cmd} ${args.join(' ')}\n`)
    let c
    try {
      // ⚠️ `shell` 必须有：Windows 上 npm 装出来的是 `dsh.cmd`（直接 exec 会 EINVAL ✗），
      //    而 POSIX 上交给 /bin/sh 也对；**别在外面手写 `cmd.exe /c`** —— 那只在 Windows 成立 ✗
      c = spawn(cmd, args, { cwd: stateDir, windowsHide: true, shell, stdio: ['ignore', 'pipe', 'pipe'],
        env: pyEnv(env || {}) })
    } catch (e) { sink(`起不来：${e?.message ?? e}\n`); return resolve(1) }
    const w = (b) => sink(String(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    c.on('exit', (code) => { sink(`\n--- exit ${code} ---\n`); resolve(code) })
    c.on('error', (e) => { sink(`起不来：${e?.message ?? e}\n`); resolve(1) })
  })

  /** 装"本地转写"那一套：独立环境 + faster-whisper + yt-dlp + 先把 Whisper 模型下好 */
  const runAsrInstall = () => {
    if (installingAsr) return { ok: true, busy: true, log: asrLogFile, hint: '正在装转写依赖，别重复起' }
    installingAsr = true
    appendAsr(`\n=== ${new Date().toISOString()} 开始装"本地转写"依赖 ===\n`)
    ;(async () => {
      try {
        const mirror = process.env.BILI_DUTY_PIP_MIRROR || 'https://pypi.tuna.tsinghua.edu.cn/simple'
        const hf = process.env.BILI_DUTY_HF_ENDPOINT || 'https://hf-mirror.com'
        const py = asrPython()
        const uvCmd = await resolveUv()
        if (!existsSync(py)) {
          // --seed：把 pip 也装进去（uv 默认不给）—— 不然出现问题时连 pip 都没有，没法补救 ✗
          if (uvCmd) await spawnTo(uvCmd, ['venv', '--seed', asrDir], { sink: appendAsr })
          else await spawnTo(await resolvePy(), ['-m', 'venv', asrDir], { sink: appendAsr })
        }
        if (!existsSync(py)) {
          appendAsr('建环境失败 —— 先点上面的「装依赖」，把 uv 或 Python 准备好\n')
          log('转写：建环境失败'); return
        }
        appendAsr('装 faster-whisper + yt-dlp（走国内镜像）…\n')
        let code = 1
        // ⚠️ av 必须钉在 17 以下：faster-whisper 1.2.1 会调 av.open(metadata_errors=…)，
        //    而 av 17+ 不再接受这个参数 ⇒ 装了最新的 av 反而转不了（2026-10-14 在主人机器上实证）
        const AV_PIN = process.env.BILI_DUTY_AV_PIN || 'av>=12,<17'
        if (uvCmd) code = await spawnTo(uvCmd, ['pip', 'install', '--python', py, '-i', mirror, 'faster-whisper', 'yt-dlp', AV_PIN], { sink: appendAsr })
        if (code !== 0) code = await spawnTo(py, ['-m', 'pip', 'install', '-i', mirror, 'faster-whisper', 'yt-dlp', AV_PIN], { sink: appendAsr })
        if (code !== 0) { appendAsr('装包失败 —— 看上面的报错\n'); log('转写：装包失败'); return }
        // ⭐ 顺手把模型也下好（不然第一次跑那一轮会卡在下载上 ✗）；模型走 HuggingFace 国内镜像
        const model = String(cfg.asrModel || 'small')
        // 模型缓存必须放进插件家：默认的 ~/.cache 在本机拒绝写入（2026-10-14 实测 WinError 5）
        const hfHome = join(stateDir, '.hf-cache')
        try { mkdirSync(hfHome, { recursive: true }) } catch { /* 建不了后面会给报错 */ }
        appendAsr(`下 Whisper 模型「${model}」（缓存在 ${hfHome}，源 ${hf}，几百 MB，只需要一次）…\n`)
        const code2 = await spawnTo(py, ['-c',
          'import os,sys;os.environ["HF_HUB_DISABLE_XET"]="1";from faster_whisper import WhisperModel;WhisperModel(sys.argv[1], device="cpu", compute_type="int8");print("模型就绪")',
          model], { sink: appendAsr, env: { HF_ENDPOINT: hf, HF_HOME: hfHome, HF_HUB_DISABLE_XET: '1' } })
        appendAsr(`=== 结束（装包 exit ${code}，模型 exit ${code2}，asrReady=${asrReadyNow()}）===\n`)
        log(`装转写依赖结束：exit=${code}/${code2}`)
      } catch (e) {
        appendAsr(`装转写依赖崩了：${e?.stack ?? e}\n`)
        log(`装转写依赖崩了：${e?.message ?? e}`)
      } finally { installingAsr = false }
    })()
    return { ok: true, started: true, log: asrLogFile, hint: '正在后台装转写依赖 —— 进度显示在下面（要下几百 MB 模型，慢一点正常）' }
  }

  const runInstall = () => {
    if (installing) return { ok: true, busy: true, log: installLogFile, hint: '正在装，别重复起' }
    installing = true
    appendInstall(`\n=== ${new Date().toISOString()} 开始装依赖 ===\n`)
    ;(async () => {
      try {
        const reqFile = join(pluginDir, 'vendor', 'bilibili-mcp', 'requirements.txt')
        const mirror = process.env.BILI_DUTY_PIP_MIRROR || 'https://pypi.tuna.tsinghua.edu.cn/simple'
        const venvPy = venvPython()
        // ⭐ 候选**一个个试**：设置里写的 → venv 里那份 → 系统里的 python3 / python。
        //    🔴 原来只试 `cfg.pythonPath || 'python'` —— Linux 上 `python` 常常不存在，
        //       于是"明明装了 python3"也会被判成"这台机器上没有可用的 python" ✗
        let py = ''
        for (const c of pyCandidates()) {
          if (c.includes('/') || c.includes('\\')) { if (existsSync(c)) { py = c; break } continue }
          const hit = whichSync(c)
          if (hit) { py = hit; break }
          if (await probeCmd(c)) { py = c; break }
        }
        const tried = pyCandidates().join(' / ')
        const uvCmd = await resolveUv()   // ⭐ 系统里的 → 家里下好的 → 自己下一份
        if (!existsSync(venvPy) && !uvCmd && !py) {
          const msg = `这台机器上没有 uv，也没找到可用的 python（试过 ${tried}），而且我自动下 uv 也没成功`
            + '（大概是网络到不了 GitHub / PyPI 镜像）。⇒ 请手动装一份 uv（单个可执行文件，'
            + 'https://docs.astral.sh/uv/install/ ）或 Python 3.10+，然后回来再点一次「装依赖」。'
          appendInstall(msg + '\n'); log(msg); installing = false; return
        }
        if (!existsSync(venvPy)) {
          if (uvCmd) await spawnLogged(uvCmd, ['venv', join(stateDir, '.venv')])
          if (!existsSync(venvPy) && !uvCmd && py) await spawnLogged(py, ['-m', 'venv', join(stateDir, '.venv')])
        }
        let code = 1
        if (uvCmd) code = await spawnLogged(uvCmd, ['pip', 'install', '--python', venvPy, '-i', mirror, '-r', reqFile])
        if (code !== 0) code = await spawnLogged(venvPy, ['-m', 'pip', 'install', '-i', mirror, '-r', reqFile])
        if (code === 0 && existsSync(venvPy)) { saveCfg({ pythonPath: venvPy }); appendInstall(`已把 pythonPath 设为 ${venvPy}\n`) }
        appendInstall(`=== 结束（exit ${code}，venvReady=${venvReadyNow()}）===\n`)
        log(`装依赖结束：exit=${code} venvReady=${existsSync(venvPy)}`)
      } catch (e) {
        appendInstall(`装依赖崩了：${e?.stack ?? e}\n`)
        log(`装依赖崩了：${e?.message ?? e}`)
      } finally { installing = false }
    })()
    return { ok: true, started: true, log: installLogFile, hint: '正在后台装依赖 —— 进度就显示在下面（走国内镜像，通常几十秒到一两分钟）' }
  }

  /** 「测一下」：真跑一次查询再下结论（判据落在载荷上，不看自报） */
  const checkUp = async () => {
    const out = { ok: false, steps: [] }
    if (!venvReadyNow()) { out.error = '环境还没装好（可能上次装失败了）—— 点「重装主依赖」再试一次'; return out }
    if (!hasCredential()) { out.error = '还没登录：点「扫码登录」，手机 B站 扫一下'; return out }
    try {
      const who = await call('bili_check_credential', {})
      out.who = (typeof who === 'object' ? JSON.stringify(who) : String(who)).slice(0, 140)
      out.steps.push('登录有效')
    } catch (e) { out.error = '登录检查失败：' + (e?.message ?? e); return out }
    try {
      const s = await call('bili_search', { keyword: 'DeepSeek Harness', num: 3 })
      const t = typeof s === 'string' ? s : JSON.stringify(s)
      out.sample = t.slice(0, 160)
      out.steps.push('能搜到东西')
      out.ok = t.length > 2
      if (!out.ok) out.error = '搜到了空结果'
    } catch (e) { out.error = '搜索失败：' + (e?.message ?? e) }
    return out
  }

  let updateCache = null            // { at, latest } —— 检查更新的结果缓存

  const status = () => {
    const st = readJson(dutyStateFile, {})
    const today = dayKey()
    const now = new Date()
    const wins = winList()
    const check = winCheck()
    return {
      ok: true,
      home: stateDir,
      config: cfg,
      // ⭐ 时段那套（2026-10-18）：给的是**生效的那张表**（配了自定义就是自定义），
      //    外加体检告警与"下次什么时候跑" —— 设置页直接显示，不用自己再算一遍
      windows: wins.map((w) => ({
        key: w.key, label: w.label, start: w.start, end: w.end,
        opening: inWindow(now, w),
      })),
      windowsCustom: check.custom,
      windowsText: check.windows,
      windowIssues: check.issues,
      nextRunAt: (() => {
        const d = nextRunAt(now, wins, Object.keys(st.windows || {}))
        return d ? d.toISOString() : null
      })(),
      builtinWindows: WINDOWS,
      // ⭐ 这台机器是什么环境（2026-10-18 加）：设置页据此决定「打开文件夹」该怎么呈现 ——
      //    有桌面就照旧；**没有桌面**（服务器 / NAS 常态）就直接把目录列出来 ✓
      platform: {
        os: process.platform,
        desktop: desktopOpeners(stateDir).length > 0,
        // 这里报**真找得到的那个**，不是设置里那个字符串 ——
        // 否则 Linux 上会显示 python（而这台机器压根没有），看着像是没问题
        python: pyPathSync() || String(cfg.pythonPath || ''),
        dsh: (() => { const d = resolveDsh(); return [d.command, ...(d.args || [])].join(' ') })(),
      },
      today,
      ranToday: st.day === today ? Number(st.count || 0) : 0,
      lastRunAt: st.lastRunAt || null,
      lastWhy: st.lastWhy || null,
      loggedIn: hasCredential(),
      venvReady: venvReadyNow(),
      version: myVersion(),
      installFailed: !installing && !venvReadyNow() && (() => { try { return readFileSync(installLogFile, 'utf8').length > 0 } catch { return false } })(),
      installing,
      // ── 本地转写那一套的状态（设置页要显示进度）──
      asrReady: asrReadyNow(),
      // 模型下没下（免得界面写"就绪"、其实还得现下）
      asrModelReady: (() => { try { return existsSync(join(stateDir, '.hf-cache', 'hub')) } catch { return false } })(),
      asrInstalling: installingAsr,
      asrLog: asrLogFile,
      asrTail: (() => { try { return readFileSync(asrLogFile, 'utf8').slice(-1400) } catch { return '' } })(),
      installLog: installLogFile,
      // ⭐ 让设置页能显示"装到哪了"（陌生人原来只看到一句"后台在装" ✗）
      installTail: (() => { try { return readFileSync(installLogFile, 'utf8').slice(-1400) } catch { return '' } })(),
      report: join(outDir, `${today}.md`),
      log: logFile,
    }
  }

  const handle = async (req, res, url) => {
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/bili-duty/status') return sendJson(res, 200, status())

    if (req.method === 'GET' && path === '/api/bili-duty/config') {
      return sendJson(res, 200, {
        ok: true, config: cfg, windows: WINDOWS, home: stateDir,
        effectiveWindows: winList(),
        // ⭐ 自定义时段体检：设置页要拿它显示"哪两条重叠了"
        customWindows: winCheck().windows,
        windowIssues: winCheck().issues,
      })
    }

    if (req.method === 'POST' && path === '/api/bili-duty/config') {
      const body = await readBody(req)
      const patch = {}
      for (const k of ['perDay', 'peakValley', 'noon', 'night', 'windows', 'autoComment', 'transcribe', 'noSubtitlePick', 'asrModel',
        'commentPerRound', 'mentionName', 'mentionNames', 'dmMode', 'dmUid', 'dmUids', 'aiReply', 'aiKeywords',
        'keywords', 'pythonPath', 'dshBin', 'headlessProfile', 'workspace', 'reportLevel', 'replyToComments', 'replyPerRound']) {
        if (k in body) patch[k] = body[k]
      }
      if ('perDay' in patch) patch.perDay = Math.max(0, Math.min(Number(patch.perDay) || 0, 50))
      // ⭐ 自定义时段：统一走 normWindows 规范化（丢掉看不懂的、压成 "HH:MM-HH:MM"、上限 12 条）。
      //    ⚠️ 不在这一层拒绝"重叠" —— 重叠是允许的（调度器会把命中的每条一起记账），只是要告警 ✓
      if ('windows' in patch) patch.windows = normWindows(patch.windows).map(windowText)
      if ('noSubtitlePick' in patch) patch.noSubtitlePick = Boolean(patch.noSubtitlePick)
      if ('dmMode' in patch) patch.dmMode = ['off', 'only', 'both'].includes(String(patch.dmMode)) ? String(patch.dmMode) : 'off'
      if ('dmUid' in patch) patch.dmUid = Math.max(0, Math.min(Number(patch.dmUid) || 0, Number.MAX_SAFE_INTEGER))
      // ⭐ 私信名单：只留数字（顺手吃掉用户粘进来的空格 / 全角 / @ 前缀），去重、丢零、上限 10
      if ('dmUids' in patch) patch.dmUids = (Array.isArray(patch.dmUids) ? patch.dmUids : [])
        .map((x) => String(x ?? '').replace(/[^\d]/g, '').replace(/^0+/, ''))
        .filter((x, i, a) => x && a.indexOf(x) === i)
        .slice(0, 10)
      if ('aiReply' in patch) patch.aiReply = Boolean(patch.aiReply)
      if ('aiKeywords' in patch) patch.aiKeywords = Array.isArray(patch.aiKeywords)
        ? patch.aiKeywords.map((x) => String(x).trim()).filter(Boolean).slice(0, 50) : []
      if ('mentionNames' in patch) patch.mentionNames = Array.isArray(patch.mentionNames)
        ? patch.mentionNames.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : []
      if ('reportLevel' in patch) patch.reportLevel = ['full', 'brief', 'off'].includes(String(patch.reportLevel)) ? String(patch.reportLevel) : 'full'
      if ('replyToComments' in patch) patch.replyToComments = Boolean(patch.replyToComments)
      if ('replyPerRound' in patch) patch.replyPerRound = Math.max(1, Math.min(Number(patch.replyPerRound) || 1, 10))
      // ⭐ 两类"没生效"都要报出去（否则用户只会看到"保存了又变回默认"，无从排查）：
      //    ignored  = 这个插件版本的白名单里压根没有（多半是装了个旧包）
      //    dropped  = 白名单里有，但 normalize 被"当前 cfg 的键集"过滤掉了（**插件没重载的典型症状**）
      const ignored = Object.keys(body).filter((k) => !['ok'].includes(k) && !(k in patch))
      const dropped = saveCfg(patch)
      const notApplied = [...new Set([...ignored.filter((k) => !(k in cfg)), ...dropped])]
      log(`设置已更新：${JSON.stringify(patch)}${notApplied.length ? ` ⚠️ 没生效：${notApplied.join(', ')}` : ''}`)
      // ⭐ 顺手把"时段体检 + 下次什么时候跑"带回去（2026-10-18）：
      //    设置页改完一条时段**立刻**就能看到"这两条重叠了"，不用等 5 秒轮询，
      //    也不用在浏览器那半再复刻一遍重叠判断（复刻就迟早会两边不一致 ✗）。
      const st0 = readJson(dutyStateFile, {})
      const wins0 = winList()
      const next0 = nextRunAt(new Date(), wins0, Object.keys(st0.windows || {}))
      return sendJson(res, 200, {
        ok: true, config: cfg, notApplied,
        customWindows: winCheck().windows,
        windowIssues: winCheck().issues,
        effectiveWindows: wins0,
        nextRunAt: next0 ? next0.toISOString() : null,
      })
    }

    if (req.method === 'POST' && path === '/api/bili-duty/run') {
      return sendJson(res, 200, { ok: true, ...runDuty('manual') })
    }

    // 建 venv + 装依赖（**不等它**：几分钟的活，进度写 install.log）
    if (req.method === 'POST' && path === '/api/bili-duty/install') {
      return sendJson(res, 200, runInstall())
    }

    // 装"本地转写"那套（独立环境：faster-whisper + yt-dlp + Whisper 模型）
    if (req.method === 'POST' && path === '/api/bili-duty/install-asr') {
      return sendJson(res, 200, runAsrInstall())
    }

    // ⭐ 「复核评论」：拿判重表里最近的记录，去 B站 核一遍到底公开可见没有
    //    （设置页那个按钮、以及每轮结束 90 秒后自动跑一次，都走这里）
    if (req.method === 'POST' && path === '/api/bili-duty/verify') return sendJson(res, 200, await runVerify('manual'))

    // 「看今天的报告」：把报告的文本读出来给设置页显示（浏览器不能直接开本地文件 ✗）
    // ⭐ 调试：现在跑没跑 / 跑到哪了 / 报了什么错（设置页「调试」那一栏轮询它）
    if (req.method === 'GET' && path === '/api/bili-duty/debug') {
      return sendJson(res, 200, debugInfo())
    }

    if (req.method === 'GET' && path === '/api/bili-duty/report') {
      const day = String(url.searchParams.get('day') || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      const file = join(outDir, day + '.md')
      let text = ''
      let exists = false
      try { exists = existsSync(file); if (exists) text = readFileSync(file, 'utf8').slice(0, 1000000) } catch { /* 读不到就给空 */ }
      // ⭐ 顺手把 markdown **解析成结构化对象**给前端 —— 那一大坨混在一起的报告，
      //    前端才有办法按"轮次 / 分节 / 条目"摊开显示（解析失败就退回纯文本，不会白屏）✓
      let parsed = null
      try { if (exists) parsed = parseReport(text, { day, file }) } catch (e) { log('报告解析失败：' + (e?.message ?? e)) }
      // 顺手把"有哪些天的报告"列出来（报告页要能切日期；读目录比让前端猜便宜）
      let days = []
      try {
        days = readdirSync(outDir).filter((x) => /^\d{4}-\d{2}-\d{2}\.md$/.test(x))
          .map((x) => x.slice(0, -3)).sort().reverse()
      } catch { /* 目录还没建 */ }
      return sendJson(res, 200, { ok: true, day, exists, file, text, parsed, days })
    }

    // 「打开文件夹」：浏览器开不了本地目录 ⇒ 让宿主去开（只认 out / home 两个，别的不受理）
    if (req.method === 'POST' && path === '/api/bili-duty/open') {
      const body = await readBody(req)
      const which = String(body?.what || 'out') === 'home' ? 'home' : 'out'
      const dir = dirOf(which)
      const attempts = desktopOpeners(dir)
      let lastErr = ''
      for (const [cmd, args] of attempts) {
        const err = await new Promise((resolve) => {
          let done = false
          let child
          // ⚠️ 不要再传 windowsHide（2026-10-15 实测：传了以后"成功"但窗口不出现 ✗）
          try { child = spawn(cmd, args, { detached: true, stdio: 'ignore' }) } catch (e) { resolve(String(e?.message ?? e)); return }
          child.on('error', (e) => { if (!done) { done = true; resolve(String(e?.message ?? e)) } })
          setTimeout(() => { if (!done) { done = true; try { child.unref() } catch { /* 无所谓 */ } resolve('') } }, 500)
        })
        if (!err) {
          log(`打开文件夹：用了 ${cmd}（没报错；窗口不一定真弹出来了）`)
          return sendJson(res, 200, { ok: true, opened: dir, via: cmd, dir, which })
        }
        lastErr = err
        log(`打开文件夹失败（${cmd}）：${err}`)
      }
      // ② 没有桌面 ⇒ 不是"报个错就完了"：把路径和原因带回去，设置页据此换成"翻目录" ✓
      return sendJson(res, 200, {
        ok: false, dir, which, path: dir,
        noDesktop: attempts.length === 0,
        error: attempts.length
          ? `打开器都没成功（${lastErr || '未知原因'}）`
          : (IS_WIN ? '没找到能打开文件夹的程序' : '这台机器上没有桌面环境（能"打开文件夹"的程序一个都没有）'),
        hint: attempts.length ? '可以「复制路径」，或者在下面直接翻这个目录' : '没关系 —— 在下面直接翻这个目录、看内容、下载都行',
      })
    }

    // ── 没有桌面时的退路：列目录 / 看文件 / 下载 ─────────────────────────
    //  为什么要有：服务器与 NAS 上"打开文件夹"**无从谈起**。与其甩一句打不开，
    //  不如让设置页真的能看见这些文件（这也是"合理的 Linux 实现"该有的样子 ✓）
    if (req.method === 'GET' && path === '/api/bili-duty/files') {
      const which = url.searchParams.get('what') === 'home' ? 'home' : 'out'
      const sub = safeName(url.searchParams.get('sub'))
      const dir = subDir(which, sub)
      try { return sendJson(res, 200, { ok: true, which, sub, dir, entries: listDir(dir) }) }
      catch (e) { return sendJson(res, 200, { ok: false, which, sub, dir, entries: [], error: '目录读不出来：' + (e?.message ?? e) }) }
    }

    if (req.method === 'GET' && path === '/api/bili-duty/file') {
      const which = url.searchParams.get('what') === 'home' ? 'home' : 'out'
      const dir = subDir(which, url.searchParams.get('sub'))
      const name = safeName(url.searchParams.get('name'))
      if (!name) return sendJson(res, 400, { ok: false, error: '文件名不合法' })
      try {
        const st = statSync(join(dir, name))
        if (st.isDirectory()) return sendJson(res, 200, { ok: false, name, error: '这是个目录，点进去看' })
        // 报告通常几十 KB；放个 2MB 的闸，别把设置页撑爆（要整份就去下载 ✓）
        if (st.size > 2 * 1024 * 1024) {
          return sendJson(res, 200, { ok: false, name, size: st.size, error: `文件有点大（${Math.round(st.size / 1024)} KB），下载来看吧` })
        }
        return sendJson(res, 200, { ok: true, which, name, size: st.size, text: readFileSync(join(dir, name), 'utf8') })
      } catch (e) { return sendJson(res, 200, { ok: false, name, error: '读不出来：' + (e?.message ?? e) }) }
    }

    if (req.method === 'GET' && path === '/api/bili-duty/download') {
      const which = url.searchParams.get('what') === 'home' ? 'home' : 'out'
      const dir = subDir(which, url.searchParams.get('sub'))
      const name = safeName(url.searchParams.get('name'))
      if (!name) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('文件名不合法') }
      try {
        const data = readFileSync(join(dir, name))
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          // ⚠️ 非 ASCII 文件名要额外给 `filename*`（RFC 5987）—— 只写 filename 会被浏览器丢掉 ✗
          'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e"]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          'content-length': String(data.length),
        })
        return res.end(data)
      } catch (e) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('读不出来：' + (e?.message ?? e))
      }
    }

    // 「一键升级」：点了它自己跑 add（⚠️ 之后要重启才生效）
    if (req.method === 'POST' && path === '/api/bili-duty/upgrade') return sendJson(res, 200, runUpgrade())

    // 「检查更新」：⚠️ 只在用户点按钮时才联网（不偷偷发请求 ✓），结果缓存一天 ✓
    if (req.method === 'GET' && path === '/api/bili-duty/update') {
      const out = { ok: true, current: myVersion(), latest: '', hasNew: false, page: 'https://www.npmjs.com/package/dsh-bili-scroll' }
      try {
        if (updateCache && Date.now() - updateCache.at < 24 * 3600 * 1000) out.latest = updateCache.latest
        else {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 8000)
          const r = await fetch('https://registry.npmjs.org/dsh-bili-scroll/latest', { signal: ctrl.signal })
          clearTimeout(timer)
          const j = await r.json()
          out.latest = String(j.version || '')
          updateCache = { at: Date.now(), latest: out.latest }
        }
      } catch (e) { out.ok = false; out.error = String(e?.message ?? e); return sendJson(res, 200, out) }
      // ⭐ 要比谁更新，不能只比不相等 —— 否则本地版本高于 npm 时会误报有新版
      const vnum = (v) => String(v || '').split('.').map((x) => parseInt(x, 10) || 0)
      const cmp = (a, b) => {
        const x = vnum(a), y = vnum(b)
        for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0) }
        return 0
      }
      out.hasNew = Boolean(out.latest) && cmp(out.latest, out.current) > 0
      return sendJson(res, 200, out)
    }

    // 「测一下」：真跑一次，回答"能不能用"
    if (req.method === 'POST' && path === '/api/bili-duty/check') {
      return sendJson(res, 200, await checkUp())
    }

    // ── 扫码登录（设置页用）──
    if (req.method === 'POST' && path === '/api/bili-duty/login/start') {
      const { key, url } = await loginStart()
      const png = await renderQrPng(await resolvePy(), stateDir, url)
      let qr = null
      if (png) { try { qr = 'data:image/png;base64,' + readFileSync(png).toString('base64') } catch { qr = null } }
      log(`出码：${url}${qr ? '（已画成 PNG）' : '（没画出 PNG —— venv 里大概还没有 qrcode）'}`)
      return sendJson(res, 200, { ok: true, key, url, qr })
    }

    if (req.method === 'POST' && path === '/api/bili-duty/login/poll') {
      const body = await readBody(req)
      const r = await loginPoll(String(body.key || ''))
      if (r.state === 'ok') {
        const file = saveCredential(stateDir, r.credential)
        log(`登录成功，凭证已写入 ${file}`)
        return sendJson(res, 200, { ok: true, state: 'ok', file })
      }
      return sendJson(res, 200, { ok: r.state !== 'unknown', state: r.state, code: r.code, message: r.message })
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-duty',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'bili-duty: /api/bili-duty 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  ctx.effect(() => () => { try { mcp?.stop() } catch { /* 收摊 */ } }, 'bili-duty: 收 MCP 子进程')
  log(`已挂载（家=${stateDir}，python=${cfg.pythonPath}，峰谷=${cfg.peakValley ? '开' : '关'}）`)
}
