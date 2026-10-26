/**
 * dsh-bili-scroll —— host 半端
 * ============================================================================
 * 它是什么：每天替你刷一轮 B站 的插件版。
 *   1. **插件内部起那份 Python MCP**（`vendor/bilibili-mcp/mcp_server.py`），把它的能力
 *      注册成 dsh 工具（搜 / 字幕 / 评论 / 发评论 @ 人 / 登录检查）—— 用户不用再手改 profile。
 *   2. **谷时定时器**：工作日高峰之外的中午 12:00–14:00、夜间 18:00–09:00（`lib/state.mjs` 里的 `WINDOWS`），
 *      开了哪个窗口才在哪个窗口自动跑；「定量刷」的数字是**每天总量上限**。
 *   3. **跑一轮** = 起一个 `dsh --profile bili-duty <prompt>`（profile 不可用时退回 headless），
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient } from './lib/mcp.mjs'
import { verifyRecent, appendVerifyToReport } from './lib/verify.mjs'
import { WINDOWS, stateDirOf, readJson, writeJson, ensureHomeFiles, ensureCharter, charterPath, inWindow, dayKey } from './lib/state.mjs'
import { loginStart, loginPoll, saveCredential, renderQrPng } from './lib/login.mjs'
import { loadCred as dmCred } from './lib/dm.mjs'
import { createConfigSchema } from './lib/config.mjs'
import { createConfigStore } from './lib/config-store.mjs'
import { createReportStore } from './lib/report-store.mjs'
import { createDutyRunner } from './lib/duty-runner.mjs'
import { createRoundFinalizer } from './lib/round-finalizer.mjs'
import { createDutyScheduler } from './lib/duty-scheduler.mjs'
import { createMcpService } from './lib/mcp-service.mjs'
import { createDmWatcher } from './lib/dm-watcher.mjs'
import { createInstallManager } from './lib/install-manager.mjs'
import { createUpdateManager } from './lib/update-manager.mjs'
import { createHttpApi } from './lib/http-api.mjs'
import { createFavoriteService } from './lib/favorite-service.mjs'
import { createCoverService } from './lib/cover-service.mjs'
import { createDiagnostics } from './lib/diagnostics.mjs'
import { createToolRegistry } from './lib/tool-registry.mjs'
import { createCommandRunner } from './lib/command-runner.mjs'
import { createHostRuntime } from './lib/host-runtime.mjs'
import { createStatusService } from './lib/status-service.mjs'
import { createConfigMigrations } from './lib/config-migrations.mjs'
import { createVerificationService } from './lib/verification-service.mjs'
import { createPathLayout } from './lib/path-layout.mjs'

export const name = 'bili-scroll'
// attachments / llm 故意**不**列进 inject：它们只在看图时才用 ctx.get 取，
// 取不到就把图降级成文字说明；列进来会让没有这两个服务的宿主直接装不上。
export const inject = ['webServer', 'tools', 'settings']

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段
 *    （`volatileForm(schema)`，见 dsh-settings），没有这个标记写设置时会抛
 *    "Plugin entry … has no volatile fields"。另外两个条件是：
 *    **loader entry 的 id 必须等于命名空间名**（我们 patch 里就是 `bili-scroll`）+ **本模块导出 Config**。
 */
// ⚠️ schemastery 彻底拿不到时，这里会是 undefined —— **插件照常加载**，只是设置页降级
//    （宁可少一个设置页，也不能因为一个 import 让整条插件不激活 ✗）
/* The field definitions and defaults live in lib/config.mjs. Keeping this
 * adapter here makes the DSH entry point depend on one configuration contract. */
export const Config = createConfigSchema(z)

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
  const layout = createPathLayout(stateDir)
  const logFile = layout.logFile
  const outDir = layout.outDir
  mkdirSync(outDir, { recursive: true })

  const log = (msg) => {
    const line = `${new Date().toISOString()}  ${msg}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 写不进去也不致命 */ }
    try { ctx.logger?.info?.(`[bili-duty] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }

  const host = createHostRuntime({ ctx, log })

  // 宿主依赖是从哪儿取的（桌面版那次事故的排查看这里：duty.log 里会写明白）
  for (const n of hostDeps.notes) log(n)
  /**
   * ⚠️ 2026-10-19（用户 `天文星球` 的截图）：装转写依赖时 uv 直接 exit 2 ——
   *   `error: Could not acquire lock / failed to open file C:\Users\AP\AppData\Local\uv\cache\.lock: 拒绝访问 (os error 5)`
   *   ⇒ **uv 默认把缓存放在 `%LOCALAPPDATA%\uv\cache`**，那地方一旦没权限（企业策略 / 杀软 / 别的用户建的）就彻底装不动 ✗
   *   ⇒ 把 uv 的缓存 / 工具 / 解释器目录**全部钉在插件家里**（那儿一定可写）✓ ——
   *   跟 `HF_HOME` 那次是同一类："环境差异由插件自己消掉，别让用户碰"。
   */
  const uvEnv = (extra = {}) => pyEnv({
    UV_CACHE_DIR: layout.uvCacheDir,
    UV_TOOL_DIR: layout.uvToolsDir,
    UV_PYTHON_INSTALL_DIR: layout.uvPythonDir,
    ...extra,
  })

  const commandRunner = createCommandRunner({
    baseEnv: process.env,
    baseCwd: stateDir,
    windowsHide: true,
  })

  const cfgStore = createConfigStore({ stateDir, settings: host.get('settings'), hostConfig: config, readJson, writeJson, log })
  const reports = createReportStore({
    stateDir,
    outDir,
    dayKey,
    getReportLevel: () => cfg.reportLevel,
    readJson,
    writeJson,
    log,
  })
  reports.ensureFiles()
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
  // 配置契约、归一化、范围钳制以及宿主设置镜像都由 cfgStore 统一负责。
  const loadCfg = () => cfgStore.load()
  const cfg = loadCfg()
  // ⭐ 配置是"随时可能被设置页就地改掉"的东西 ⇒ 每个入口用之前重算一遍（cfg 这个对象要一直指向同一份）
  const refreshCfg = () => { Object.assign(cfg, loadCfg()) }
  // The active persistence path is intentionally small and boring: the store
  // owns normalization, local priority, host mirroring and readback retries.
  const persistCfg = async (patch) => {
    const result = await cfgStore.persist(patch, cfg)
    Object.assign(cfg, result.next)
    return result
  }

  const installManager = createInstallManager({
    stateDir,
    pluginDir,
    getConfig: () => cfg,
    persistConfig: persistCfg,
    uvEnv,
    commandRunner,
    log,
  })
  const venvReadyNow = () => installManager.venvReadyNow()
  const asrReadyNow = () => installManager.asrReadyNow()
  const missingVenvDeps = () => installManager.missingVenvDeps()
  const installStatus = () => installManager.status()

  const migrations = createConfigMigrations({
    stateDir,
    readJson,
    markerExists: existsSync,
    writeMarker: (file, value) => writeFileSync(file, value, 'utf8'),
    persistConfig: persistCfg,
    log,
  })

  ensureHomeFiles(pluginDir, stateDir, log)

  // ⭐ 值班章程单独记账（跟 mcp_server.py 不一样：用户改过就得留着 —— 见 state.mjs 的 ensureCharter）
  ensureCharter(pluginDir, stateDir, log)

  /* ─────────────── MCP（内部起那个 Python MCP） ─────────────── */

  const mcpService = createMcpService({
    stateDir,
    getConfig: () => cfg,
    refreshConfig: refreshCfg,
    uvEnv,
    McpClient,
    log,
  })
  const call = mcpService.call
  const callRaw = mcpService.callRaw

  const hasCredential = () => existsSync(layout.credentialFile)

  /* ─────────────── 跑一轮（跟老方案同一条路：dsh --profile headless <prompt>） ─────────────── */

  const {
    paths: reportPaths,
    bumpState,
    countPickedToday,
    roundsToday,
    pickIdsFromReport,
    rollSeen,
    syncNotes,
  } = reports
  const dutyStateFile = reportPaths.stateFile
  const digestDir = reportPaths.digestDir
  let dmWatcher = null

  const favorites = createFavoriteService({
    stateDir,
    outDir,
    getConfig: () => cfg,
    refreshConfig: refreshCfg,
    hasCredential,
    pickIdsFromReport,
    dayKey,
    pyEnv,
    commandRunner,
    log,
  })
  const { favToday } = favorites
  const { coverFor } = createCoverService({ log })

  // ⭐⭐ 2.0.5（2026-10-24 用户实证，群友「羽涅」）：一键升级以前把 profile 写死成 web ✗
  //    桌面版用户的 profile 是 desktop ⇒ 升级失败，反而把 0.1.7 装进 web 里，越修越乱 ✓
  //    现在从"自己这个模块的真实路径"里取 profile 名：挂载点是 ~/.dsh/profiles/<名字>/node_modules/<包>/
  const ownProfileName = (() => {
    try {
      const u = String(import.meta.url || '').replace(/\\/g, '/')
      const m = u.match(/\/profiles\/([^/]+)\/node_modules\//)
      return m ? m[1] : ''
    } catch { return '' }
  })()
  const profileArg = ownProfileName || 'web'
  // ⭐ 顺带：把"我是从哪个 profile 加载的"报出来，排障时一眼看得出
  try { log('插件加载自 profile：' + profileArg + (ownProfileName ? '' : '（没识别到，按默认 web 处理）')) } catch { /* 忽略 */ }

  const rotateLogIfBig = (limit = 2 * 1024 * 1024) => {
    try {
      if (!existsSync(logFile) || statSync(logFile).size < limit) return
      const bak = logFile + '.1'
      try { rmSync(bak, { force: true }) } catch { /* 删不掉就算了 */ }
      renameSync(logFile, bak)
      appendFileSync(logFile, `${new Date().toISOString()}  日志超过 2MB，旧的滚到 duty.log.1\n`, 'utf8')
    } catch { /* 轮转失败不该影响跑一轮 */ }
  }

  // Verification and round bookkeeping are initialized before the runner so
  // the child lifecycle only receives already-constructed dependencies.
  const verification = createVerificationService({
    stateDir,
    verifyRecent,
    appendVerifyToReport,
    log,
  })
  const { runVerify } = verification

  const roundFinalizer = createRoundFinalizer({
    reports,
    favorites,
    getConfig: () => cfg,
    dayKey,
    readState: () => readJson(dutyStateFile, {}),
    bumpState,
    countPickedToday,
    rotateLog: rotateLogIfBig,
    runVerify,
    reportLogFile: logFile,
    log,
  })

  // One duty-runner owns CLI discovery, prompt assembly, profile/overlay setup,
  // and the child-process lifecycle. The callbacks keep report accounting and
  // optional side effects in the host entry point without coupling the runner
  // to HTTP, tools, or DSH settings.
  const dutyRunner = createDutyRunner({
    pluginDir,
    stateDir,
    outDir,
    logFile,
    digestDir,
    profileArg,
    getConfig: () => cfg,
    refreshConfig: refreshCfg,
    dayKey,
    charterPath,
    countPickedToday,
    asrReadyNow,
    getDmUid: () => dmWatcher?.getResolvedUid?.() || 0,
    getDmOwnerUid: () => dmWatcher?.ownerUid?.() || 0,
    getModelSelection: () => host.get('agentDefaultModel')?.currentSelection?.() ?? null,
    log,
    uvEnv,
    onMissingDsh: () => {
      try { reports.stubReportIfMissing(1, logFile) } catch { /* 报告兜底失败也不能阻止明确报错 */ }
    },
    onRoundExit: ({ code, why }) => roundFinalizer.finalize({ code, why }),
  })

  dmWatcher = createDmWatcher({
    stateDir,
    getConfig: () => cfg,
    refreshConfig: refreshCfg,
    dayKey,
    log,
    startPrompt: dutyRunner.startPrompt,
    rotateLog: () => rotateLogIfBig(),
  })

  const updateManager = createUpdateManager({
    getCurrentVersion: myVersion,
    profileArg,
    resolveDsh: dutyRunner.resolveDsh,
    appendLog: installManager.appendInstall,
    commandRunner,
    commandEnv: uvEnv,
    log,
    logFile: installManager.paths.installLogFile,
  })

  const scheduler = createDutyScheduler({
    getConfig: () => cfg,
    refreshConfig: refreshCfg,
    windows: WINDOWS,
    inWindow,
    dayKey,
    readState: () => readJson(dutyStateFile, {}),
    bumpState,
    countPickedToday,
    roundsToday,
    getDmUid: () => dmWatcher?.getResolvedUid?.() || 0,
    warmUid: () => dmWatcher?.warmUid?.() || 0,
    runDuty: (why) => dutyRunner.runDuty(why),
    log,
  })
  try {
    scheduler.start()
    host.dispose(() => scheduler.stop(), 'bili-duty: 谷时定时器')
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  migrations.migrate200()

  try { dmWatcher.start() } catch (e) { log('私信监听没起来：' + String(e?.message ?? e)) }
  host.dispose(() => dmWatcher.stop(), 'bili-duty: 私信监听')
  // ⭐ 2.0.4：插件被卸载/宿主退出时，把还在跑的那一轮一起收掉（以前它会变孤儿进程）
  host.dispose(() => dutyRunner.stop('插件正在卸载/退出 ⇒ 收掉还在跑的那一轮'), 'bili-duty: 跑一轮的子进程')
  host.dispose(() => roundFinalizer.stop(), 'bili-duty: 取消延迟复核')
  host.dispose(() => verification.stop(), 'bili-duty: 取消正在进行的评论复核')
  host.dispose(() => installManager.stop(), 'bili-duty: 取消依赖安装')
  host.dispose(() => favorites.stop(), 'bili-duty: 取消收藏任务')
  host.dispose(() => updateManager.stop(), 'bili-duty: 取消插件升级')

  const diagnostics = createDiagnostics({
    stateDir,
    outDir,
    getConfig: () => cfg,
    getVersion: myVersion,
    dutyRunner,
    call,
    venvReadyNow,
    missingVenvDeps,
    hasCredential,
    loadCredential: () => dmCred(stateDir),
    getResolvedDmUid: () => dmWatcher.getResolvedUid(),
    dayKey,
    fetchImpl: globalThis.fetch,
    log,
  })
  const { checkUp, diagnose, selfCheck } = diagnostics

  const toolRegistry = createToolRegistry({
    registerTool: host.registerTool,
    getHost: host.get,
    defineTool,
    stateDir,
    outDir,
    getConfig: () => cfg,
    refreshConfig: refreshCfg,
    persistConfig: persistCfg,
    hasCredential,
    call,
    callRaw,
    dutyRunner,
    installManager,
    reports,
    windows: WINDOWS,
    dayKey,
    inWindow,
    loginStart,
    loginPoll,
    saveCredential: (credential) => saveCredential(stateDir, credential),
    renderQrPng,
    log,
  })
  host.dispose(() => toolRegistry.dispose(), 'bili-duty: 收工具注册')

  const statusService = createStatusService({
    stateDir,
    outDir,
    logFile,
    getConfig: () => cfg,
    refreshConfig: refreshCfg,
    readState: () => readJson(dutyStateFile, {}),
    dayKey,
    windows: WINDOWS,
    countPickedToday,
    ownerInfo: () => dmWatcher.ownerInfo(),
    hasCredential,
    getDmUid: () => dmWatcher.getResolvedUid(),
    getVersion: myVersion,
    getPersonaFromWorkspace: (current) => {
      if (String(current.personaPrompt || '').trim()) return ''
      const workspace = String(current.workspace || '').trim()
      if (!workspace) return ''
      try {
        const file = join(workspace, 'AGENTS.md')
        return existsSync(file) ? readFileSync(file, 'utf8').slice(0, 4000) : ''
      } catch { return '' }
    },
    getNotSynced: () => Object.keys(cfgStore.readOverride()),
    getDshCli: () => dutyRunner.dshCliCached(),
    getInstallStatus: installStatus,
    asrModelReady: () => { try { return existsSync(join(layout.hfCacheDir, 'hub')) } catch { return false } },
  })
  const { getStatus: status } = statusService

  // HTTP-facing projections stay here as small host callbacks. The controller
  // itself does not know about report files, credentials, or DSH services.
  const getWatched = async ({ query }) => reports.listWatched({
    limit: query.get('limit'),
    offset: query.get('offset'),
    picked: query.get('picked') === '1',
    tier: String(query.get('tier') || ''),
    state: String(query.get('state') || ''),
  })

  const getReport = async (day) => reports.readReport(day)

  /* ─────────────── HTTP（设置页用） ─────────────── */

  const httpApi = createHttpApi({
    stateDir,
    outDir,
    getConfig: () => cfg,
    refreshConfig: refreshCfg,
    persistConfig: persistCfg,
    readSavedConfig: () => readJson(layout.configFile, {}) || {},
    windows: WINDOWS,
    log,
    dayKey,
    getStatus: status,
    rollSeen,
    syncNotes,
    runDuty: (why) => dutyRunner.runDuty(why),
    warmUid: () => dmWatcher.warmUid(),
    install: () => installManager.runInstall(),
    installAsr: () => installManager.runAsrInstall(),
    listFavFolders: () => favorites.listFolders(),
    favToday,
    getWatched,
    coverFor,
    runVerify,
    getReport,
    upgrade: () => updateManager.runUpgrade(),
    checkUpdate: () => updateManager.check(),
    checkUp,
    diagnose,
    selfCheck,
    loginStart,
    renderQrPng: (python, home, loginUrl) => renderQrPng(python, home, loginUrl),
    loginPoll,
    saveCredential: (credential) => saveCredential(stateDir, credential),
    getConnection: host.getConnection,
  })
  host.registerWebServer({ path: '/api/bili-duty', handler: httpApi.dispatch, label: 'bili-duty: /api/bili-duty 路由' })

  host.dispose(() => mcpService.stop(), 'bili-duty: 收 MCP 子进程')
  try { dutyRunner.ensureDutyProfile() } catch { /* 上面已记日志 */ }
  if (dutyRunner.getProfileState() === 'ok') log('值班轮用最小权限 profile：bili-duty（无文件系统 / 无命令 / 无联网）')
  else log('⚠️ 最小权限 profile 不可用（' + dutyRunner.getProfileState() + '）⇒ 值班轮仍用 headless（这一轮能力偏大）')
  log(`已挂载（家=${stateDir}，python=${cfg.pythonPath}，峰谷=${cfg.peakValley ? '开' : '关'}）`)
}
