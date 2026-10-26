import { spawn as defaultSpawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const decodeChildText = (value) => {
  try {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
    const utf8 = bytes.toString('utf8')
    if (!utf8.includes('\uFFFD')) return utf8
    try { return new TextDecoder('gbk').decode(bytes) } catch { return utf8 }
  } catch { return String(value) }
}

/**
 * Launches a headless DSH prompt and tracks the optional daily-duty child.
 * Discovery, profile selection and prompt construction are injected so this
 * module only owns process lifecycle and output handling.
 */
export function createHeadlessRunner({
  resolveDsh,
  ensureOverlay,
  effectiveProfile,
  refreshConfig = () => {},
  stateDir,
  logFile,
  uvEnv = (extra = {}) => ({ ...process.env, ...extra }),
  log = () => {},
  spawn = defaultSpawn,
  electron = process.versions.electron,
  appendOutput = appendFileSync,
}) {
  if (typeof resolveDsh !== 'function') throw new TypeError('createHeadlessRunner requires resolveDsh()')
  if (typeof effectiveProfile !== 'function') throw new TypeError('createHeadlessRunner requires effectiveProfile()')

  let dutyChild = null
  let dutyStartedAt = 0
  // Every prompt child belongs to this runner, including short-lived DM
  // replies. Keeping one ownership set lets host disposal stop all children,
  // while `dutyChild` remains the busy marker for the scheduled round.
  const active = new Set()

  const startPrompt = (prompt, {
    why = 'prompt',
    sessionId = '',
    trackDuty = false,
    logStart = true,
    logExit = true,
    onExit = () => {},
    onError = () => {},
    onClose = () => {},
    onMissing = () => {},
  } = {}) => {
    try {
      refreshConfig()
      const dsh = resolveDsh()
      if (dsh.missing) {
        const message = `${why}没跑：找不到 dsh。${dsh.hint}`
        log(message)
        try { onMissing({ why, error: message }) } catch (error) { log(`${why}找不到 dsh 的收尾出错（已兜住）：${String(error?.message ?? error)}`) }
        return { started: false, why, error: message }
      }
      const overlay = typeof ensureOverlay === 'function' ? ensureOverlay() : null
      const args = [...dsh.args, '--profile', effectiveProfile()]
      if (overlay) args.push('--patch', overlay)
      if (sessionId) args.push('--session-id', String(sessionId))
      args.push(String(prompt ?? ''))
      const cwd = stateDir
      if (logStart) log(`${why}开跑：${dsh.command} ${args.slice(0, 3).join(' ')} …  cwd=${cwd}`)
      const child = spawn(dsh.command, args, {
        cwd,
        shell: dsh.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: uvEnv({ BILI_DUTY_HOME: stateDir, ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }),
      })
      const startedAt = Date.now()
      const record = { child, startedAt, stopped: false, onClose }
      let lifecycleFinished = false
      active.add(record)
      const writeOutput = (chunk) => {
        try { appendOutput(logFile, decodeChildText(chunk), 'utf8') } catch { /* log output is best effort */ }
      }
      child.stdout?.on('data', writeOutput)
      child.stderr?.on('data', writeOutput)
      child.on('exit', (code) => {
        if (record.stopped || lifecycleFinished) return
        lifecycleFinished = true
        if (logExit) log(`${why}结束（code=${code}）`)
        try { onExit({ code, why, child, startedAt, args, dsh }) } catch (error) { log(`${why}收尾出错（已兜住）：${String(error?.message ?? error)}`) }
      })
      child.on('close', () => {
        active.delete(record)
        try { record.onClose({ child, startedAt, why }) } catch (error) {
          log(`${why}关闭收尾出错（已兜住）：${String(error?.message ?? error)}`)
        }
        if (dutyChild === child) {
          dutyChild = null
          dutyStartedAt = 0
        }
      })
      child.on('error', (error) => {
        if (record.stopped || lifecycleFinished) return
        lifecycleFinished = true
        active.delete(record)
        if (dutyChild === child) {
          dutyChild = null
          dutyStartedAt = 0
        }
        log(`${why}起不来：${error?.message ?? error}`)
        try { onError({ why, error, child, startedAt, args, dsh }) } catch (callbackError) {
          log(`${why}错误收尾出错（已兜住）：${String(callbackError?.message ?? callbackError)}`)
        }
      })
      if (trackDuty) {
        dutyChild = child
        dutyStartedAt = startedAt
      }
      return { started: true, why, profile: effectiveProfile(), cwd, log: logFile, child, startedAt, dsh }
    } catch (error) {
      log(`${why}开跑失败：${error?.stack ?? error}`)
      return { started: false, why, error: String(error?.message ?? error) }
    }
  }

  const stopDuty = (reason = '') => {
    const child = dutyChild
    if (!child || child.exitCode !== null || child.killed) {
      dutyChild = null
      dutyStartedAt = 0
      return false
    }
    if (reason) log(reason)
    for (const record of active) {
      if (record.child === child) record.stopped = true
    }
    try { child.kill() } catch (error) { log(`收值班子进程失败：${error?.message ?? error}`) }
    dutyChild = null
    dutyStartedAt = 0
    return true
  }

  const stopAll = (reason = '') => {
    const records = [...active]
    if (!records.length) return false
    if (reason) log(reason)
    for (const record of records) {
      record.stopped = true
      try { record.child.kill() } catch (error) { log(`收 headless 子进程失败：${error?.message ?? error}`) }
    }
    dutyChild = null
    dutyStartedAt = 0
    return true
  }

  return {
    startPrompt,
    stopDuty,
    stopAll,
    getChild: () => dutyChild,
    getStartedAt: () => dutyStartedAt,
    activeCount: () => active.size,
  }
}

export { decodeChildText }
