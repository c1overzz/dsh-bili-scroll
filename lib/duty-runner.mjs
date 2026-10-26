/**
 * Runtime for one Bilibili duty round.
 *
 * This module owns the mechanics of running a headless DSH process: locating
 * the CLI, preparing the least-privilege profile and MCP overlay, preparing
 * prompt context, and keeping the child-process lifecycle safe. It deliberately does
 * not know about HTTP routes, tool registration, or the DSH settings service.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { buildDutyPrompt } from './duty-prompt.mjs'
import { createDshResolver } from './dsh-resolver.mjs'
import { createHeadlessRunner } from './headless-runner.mjs'
import { createPathLayout } from './path-layout.mjs'
import { createRunLock } from './run-lock.mjs'

const quoteYamlSingle = (value) => "'" + String(value).replace(/'/g, "''") + "'"

/**
 * Create a duty runner with explicit host callbacks.
 *
 * `getConfig` returns the mutable runtime config object. The remaining
 * callbacks are intentionally small seams: they keep this module reusable in
 * tests and prevent it from reaching into the plugin's HTTP or state code.
 */
export function createDutyRunner({
  pluginDir,
  stateDir,
  outDir,
  logFile,
  digestDir,
  profileArg = 'web',
  getConfig,
  refreshConfig = () => {},
  dayKey,
  charterPath,
  countPickedToday = () => 0,
  asrReadyNow = () => false,
  getDmUid = () => 0,
  getDmOwnerUid = () => 0,
  getModelSelection = () => null,
  log = () => {},
  uvEnv = (extra = {}) => ({ ...process.env, ...extra }),
  onMissingDsh = () => {},
  onRoundExit = () => {},
  spawn,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
  electron = process.versions.electron,
}) {
  if (typeof getConfig !== 'function') throw new TypeError('createDutyRunner requires getConfig()')
  if (typeof dayKey !== 'function') throw new TypeError('createDutyRunner requires dayKey()')
  if (typeof charterPath !== 'function') throw new TypeError('createDutyRunner requires charterPath()')

  let dutyProfileState = 'unknown'
  const config = () => getConfig() || {}
  const layout = createPathLayout(stateDir, { outDir })
  const dshResolver = createDshResolver({ getConfig: config, log, resourcesPath, execPath })
  const { resolveDsh, dshCliCached } = dshResolver
  const runLock = createRunLock({ file: layout.runLockFile, log })

  const mcpWhitelist = () => {
    const cfg = config()
    const list = [
      'bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info',
      'bili_cover', 'bili_frames', 'bili_danmaku', 'bili_recommend',
      'duty_paths', 'duty_report_append', 'duty_seen_append',
      'duty_digest_append', 'duty_seen_recent',
    ]
    if (cfg.asrInstalled !== false) list.push('bili_transcribe', 'bili_transcribe_start', 'bili_transcribe_result')
    if (String(cfg.dmMode || '').trim() !== 'only' && (cfg.autoComment || cfg.replyToComments)) {
      list.push('bili_reply')
    }
    if (String(cfg.dmMode || 'off') !== 'off' || cfg.dmWatch) list.push('bili_send_message')
    return list
  }

  const ensureDutyProfile = () => {
    const dutyProfileDir = join(dirname(stateDir), 'profiles', 'bili-duty')
    try {
      const source = join(pluginDir, 'profile-template', 'bili-duty')
      if (!existsSync(source)) { dutyProfileState = 'missing'; return false }
      mkdirSync(dirname(dutyProfileDir), { recursive: true })
      cpSync(source, dutyProfileDir, { recursive: true, force: true })
      dutyProfileState = existsSync(join(dutyProfileDir, 'cordis.patch.yml')) ? 'ok' : 'failed'
      return dutyProfileState === 'ok'
    } catch (error) {
      dutyProfileState = 'failed'
      log('⚠️ 最小权限 profile 没铺成功（' + String(error?.message ?? error) + '）⇒ 这一轮会退回 headless')
      return false
    }
  }

  const effectiveProfile = () => {
    const want = String(config().headlessProfile || '').trim()
    if (want && want !== 'headless' && want !== 'bili-duty') return want
    return dutyProfileState === 'ok' ? 'bili-duty' : (want || 'headless')
  }

  const ensureOverlay = () => {
    const cfg = config()
    const file = layout.overlayFile
    const script = layout.mcpServerFile
    const posix = (value) => String(value).replace(/\\/g, '/')
    const yaml = []

    for (const id of ['credentials', 'authorization', 'deepseek-account']) {
      yaml.push('- id: ' + id, '  disabled: false', '')
    }
    try {
      const selected = getModelSelection() || null
      const provider = selected?.provider ?? selected?.providerId
      const model = selected?.model ?? selected?.modelId
      if (provider && model) {
        yaml.push(
          '- id: agent-default-model',
          '  config:',
          '    provider: ' + String(provider),
          '    model: ' + String(model),
          ...(selected.reasoningEffort ? ['    reasoningEffort: ' + String(selected.reasoningEffort)] : []),
          '',
        )
      }
    } catch { /* old hosts do not expose model selection */ }

    if (cfg.overlayMcp) {
      yaml.push(
        '- insert:',
        '    - id: mcp-bili-duty',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: bili-duty',
        '        transport: stdio',
        '        command: ' + quoteYamlSingle(posix(cfg.pythonPath || 'python')),
        '        args:',
        '          - ' + quoteYamlSingle(posix(script)),
        '        env:',
        '          BILI_MCP_TOOLS: ' + quoteYamlSingle(mcpWhitelist().join(',')),
        '',
      )
    }
    try {
      writeFileSync(file, yaml.join('\n'), 'utf8')
      return file
    } catch (error) {
      log(`写 overlay 失败：${error?.message ?? error}`)
      return null
    }
  }

  const readCharter = () => {
    const duty = charterPath(pluginDir, stateDir)
    try { return { path: duty, text: readFileSync(duty, 'utf8').split('<家目录>').join(stateDir) } } catch { return { path: duty, text: '' } }
  }

  const readOwnerDoc = () => {
    const cfg = config()
    let persona = String(cfg.personaPrompt || '').trim()
    let personaFromFile = ''
    if (persona && !persona.includes('\n')) {
      const looksPath = /^[A-Za-z]:[\\/]/.test(persona) || /^\\\\/.test(persona) || persona.startsWith('~/')
      if (looksPath) {
        try {
          let file = persona.replace(/^~\//, process.env.USERPROFILE ? process.env.USERPROFILE + '/' : '~/')
          if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'AGENTS.md')
          if (existsSync(file)) {
            persona = readFileSync(file, 'utf8')
            personaFromFile = file
          }
        } catch { /* an unreadable path is just ordinary prompt text */ }
      }
    }
    if (persona) {
      const limit = 40_000
      if (persona.length > limit) {
        log(`⚠️ 人设提示词 ${persona.length} 字符，超过上限 ${limit} ⇒ 只送前 ${limit}（截掉 ${persona.length - limit} 字）`)
        persona = persona.slice(0, limit)
      }
      return '\n\n===== 使用者的人设' + (personaFromFile ? '（读自 ' + personaFromFile + '）' : '提示词') + '（**按这个来**）=====\n'
        + persona + '\n===== 人设结束 =====\n'
    }

    const workspace = String(cfg.workspace || '').trim()
    const agents = workspace ? join(workspace, 'AGENTS.md') : ''
    try {
      if (!agents || !existsSync(agents)) return ''
      const text = readFileSync(agents, 'utf8')
      const limit = 40_000
      if (text.length > limit) log(`⚠️ 工作区的 AGENTS.md ${text.length} 字符，超过上限 ${limit} ⇒ 只送前 ${limit}（截掉 ${text.length - limit} 字）`)
      return '\n\n===== 使用者的 AGENTS.md（他写给自己 AI 的人设与准则，**按这个来**）=====\n'
        + text.slice(0, limit) + '\n===== 设定结束 =====\n'
    } catch { return '' }
  }

  const promptFor = () => {
    const cfg = config()
    const charter = readCharter()
    const ownerDoc = readOwnerDoc()
    const today = dayKey()
    const dmUid = Number(cfg.dmUid) || Number(getDmUid()) || 0
    const dmOwnerUid = Number(cfg.dmOwnerUid) || Number(getDmOwnerUid()) || 0
    const recentComments = (() => {
      try {
        if (!existsSync(layout.commentsFile)) return []
        return readFileSync(layout.commentsFile, 'utf8').split(/\r?\n/)
          .filter((line) => line.trim().startsWith('- '))
          .slice(-5)
          .map((line) => (line.includes('·') ? line.split('·').slice(1).join('·') : line.slice(2)).trim())
          .filter(Boolean)
      } catch { return [] }
    })()
    if (cfg.dmMode === 'only' && !(dmUid > 0)) {
      log('⚠️ 选的是「只私信」，但不知道发给谁（没填 UID、也没填「@ 谁」，或查不到）⇒ 这一轮不发公开评论，也不盲发私信')
    }
    return buildDutyPrompt({
      stateDir,
      outDir,
      digestDir,
      today,
      reportPath: layout.reportFile(today),
      digestPath: join(digestDir, `${today.slice(0, 7)}.md`),
      seenPath: layout.seenFile,
      charter,
      ownerDoc,
      config: cfg,
      already: countPickedToday(),
      asrReady: asrReadyNow(),
      dmUid,
      dmOwnerUid,
      recentComments,
    })
  }

  const processRunner = createHeadlessRunner({
    resolveDsh,
    ensureOverlay,
    effectiveProfile,
    refreshConfig,
    stateDir,
    logFile,
    uvEnv,
    log,
    spawn,
    electron,
    appendOutput: (file, text, encoding) => {
      try { writeFileSync(file, text, { encoding, flag: 'a' }) } catch { /* log output is best effort */ }
    },
  })
  const { startPrompt } = processRunner

  const runDuty = (why = 'window') => {
    let acquiredLock = false
    try {
      const dutyChild = processRunner.getChild()
      const dutyStartedAt = processRunner.getStartedAt()
      if (dutyChild) {
        const alive = dutyChild.exitCode === null && !dutyChild.killed
        if (alive) {
          log('这一轮没跑（' + why + '）：上一轮还没结束（pid=' + dutyChild.pid + '，已跑 ' + Math.round((Date.now() - dutyStartedAt) / 1000) + ' 秒）')
          return { started: false, why, busy: true, error: '上一轮还没跑完' }
        }
      }
      refreshConfig()
      const dsh = resolveDsh()
      if (dsh.missing) {
        const message = `这一轮没跑：找不到 dsh。${dsh.hint}`
        log(message)
        try { onMissingDsh({ why, error: message }) } catch (error) { log('找不到 dsh 的收尾出错（已兜住）：' + String(error?.message ?? error)) }
        return { started: false, why, error: message }
      }
      const lock = runLock.acquire(why)
      if (!lock.acquired) return { started: false, why, busy: true, error: '另一个宿主正在跑这一轮' }
      acquiredLock = true
      const result = startPrompt(promptFor(), {
        why: `刷B站（${why}）`,
        trackDuty: true,
        logStart: false,
        logExit: false,
        onMissing: ({ error }) => {
          runLock.release()
          acquiredLock = false
          try { onMissingDsh({ why, error }) } catch (callbackError) { log('找不到 dsh 的收尾出错（已兜住）：' + String(callbackError?.message ?? callbackError)) }
        },
        onError: ({ error, child }) => {
          runLock.release()
          acquiredLock = false
          try { onRoundExit({ code: 1, why, child, error }) } catch (callbackError) {
            log('值班轮错误收尾出错（已兜住）：' + String(callbackError?.message ?? callbackError))
          }
        },
        onClose: () => {
          runLock.release()
          acquiredLock = false
        },
        onExit: ({ code, child }) => {
          runLock.release()
          acquiredLock = false
          log(`刷B站结束（${why}，code=${code}）`)
          try { onRoundExit({ code, why, child }) } catch (error) { log('值班轮收尾出错（已兜住）：' + String(error?.message ?? error)) }
        },
      })
      if (!result.started) {
        runLock.release()
        acquiredLock = false
        return { ...result, why }
      }
      log(`刷B站开跑（${why}）：${result.dsh?.command || ''} …  cwd=${result.cwd}`)
      return { started: true, why, profile: result.profile, cwd: result.cwd, log: result.log }
    } catch (error) {
      if (acquiredLock) runLock.release()
      log(`刷B站开跑失败（${why}）：${error?.stack ?? error}`)
      return { started: false, why, error: String(error?.message ?? error) }
    }
  }

  return {
    profileArg,
    runDuty,
    startPrompt,
    promptFor,
    mcpWhitelist,
    ensureDutyProfile,
    ensureOverlay,
    effectiveProfile,
    resolveDsh,
    dshCliCached,
    getProfileState: () => dutyProfileState,
    // Host disposal must own every prompt child, not only the scheduled duty
    // round. DM replies use the same runner but are intentionally not marked
    // as `trackDuty`, so exposing `stopAll` here closes that lifecycle gap.
    stop: processRunner.stopAll,
    getChild: processRunner.getChild,
    getStartedAt: processRunner.getStartedAt,
    releaseRunLock: runLock.release,
  }
}

