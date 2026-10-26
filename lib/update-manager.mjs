/**
 * Plugin update discovery and installation.
 *
 * This module owns version comparison, npm/GitHub lookup caches and the
 * asynchronous `dsh plugin add` lifecycle. The host entry only provides the
 * current version, dsh resolver and a logged subprocess runner.
 */

import { timeoutSignal } from './net.mjs'

const DEFAULT_REPO = 'c1overzz/dsh-bili-scroll'
const DEFAULT_PACKAGE = 'dsh-bili-scroll'

const versionParts = (value) => String(value || '')
  .trim()
  .replace(/^v/i, '')
  .split('-')[0]
  .split('.')
  .map((part) => Number.parseInt(part, 10) || 0)

const isPrerelease = (value) => /-/.test(String(value || '').trim())

/** Compare semver's numeric core, treating a prerelease as older than stable. */
export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < 3; index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0)
  }
  const aPre = isPrerelease(left)
  const bPre = isPrerelease(right)
  if (aPre === bPre) return 0
  return aPre ? -1 : 1
}

const cacheIsFresh = (cache, now, ttl) => Boolean(cache) && now - cache.at < ttl

export function createUpdateManager({
  getCurrentVersion,
  profileArg = 'web',
  packageName = DEFAULT_PACKAGE,
  repository = DEFAULT_REPO,
  resolveDsh,
  spawnTo = null,
  commandRunner = null,
  appendLog = () => {},
  commandEnv = () => ({}),
  log = () => {},
  logFile = '',
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheTtlMs = 24 * 3600 * 1000,
}) {
  if (typeof getCurrentVersion !== 'function') throw new TypeError('createUpdateManager requires getCurrentVersion()')
  if (typeof resolveDsh !== 'function') throw new TypeError('createUpdateManager requires resolveDsh()')
  if (typeof spawnTo !== 'function' && (!commandRunner || typeof commandRunner.run !== 'function')) {
    throw new TypeError('createUpdateManager requires commandRunner.run() or spawnTo()')
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('createUpdateManager requires fetchImpl()')

  let upgrading = false
  let upgradeController = null
  let lastSource = 'npm'
  let npmCache = null
  let githubCache = null

  const runCommand = async (command, args, signal) => {
    if (typeof spawnTo === 'function') return spawnTo(command, args, { signal })
    appendLog(`\n$ ${command} ${args.join(' ')}\n`)
    const result = await commandRunner.run(command, args, {
      env: commandEnv() || {},
      signal,
      onStdout: appendLog,
      onStderr: appendLog,
    })
    if (result.error) appendLog(`起不来：${result.error?.message ?? result.error}\n`)
    appendLog(`\n--- exit ${result.code ?? 1} ---\n`)
    return result.code === 0 && !result.error ? 0 : (result.code ?? 1)
  }

  const fetchLatestNpm = async (signal) => {
    const timestamp = now()
    if (cacheIsFresh(npmCache, timestamp, cacheTtlMs)) return npmCache.latest
    const response = await fetchImpl(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: timeoutSignal(signal, 8000),
    })
    const payload = await response.json()
    const latest = String(payload.version || '')
    npmCache = { at: timestamp, latest }
    return latest
  }

  const fetchLatestGithub = async (signal) => {
    const timestamp = now()
    if (cacheIsFresh(githubCache, timestamp, cacheTtlMs)) return githubCache.latest
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/contents/package.json`, {
      signal: timeoutSignal(signal, 6000),
      headers: { 'user-agent': packageName, accept: 'application/vnd.github+json' },
    })
    if (!response.ok) return ''
    const payload = await response.json()
    const text = Buffer.from(String(payload.content || ''), 'base64').toString('utf8')
    const latest = String(JSON.parse(text).version || '')
    githubCache = { at: timestamp, latest }
    return latest
  }

  const check = async () => {
    const current = String(getCurrentVersion() || '')
    const output = {
      ok: true,
      current,
      latest: '',
      hasNew: false,
      source: 'npm',
      page: `https://www.npmjs.com/package/${packageName}`,
    }

    let npmVersion = ''
    try {
      npmVersion = await fetchLatestNpm()
    } catch (error) {
      log('查 npm 版本没成功（接着查 GitHub）：' + (error?.message ?? error))
    }

    let githubVersion = ''
    try {
      githubVersion = await fetchLatestGithub()
    } catch { /* 没有加速器时安静跳过 */ }

    if (githubVersion && (!npmVersion || compareVersions(githubVersion, npmVersion) > 0)) {
      output.latest = githubVersion
      output.source = 'github'
      output.page = `https://github.com/${repository}`
    } else {
      output.latest = npmVersion || githubVersion
    }
    output.hasNew = Boolean(output.latest) && compareVersions(output.latest, current) > 0
    lastSource = output.source
    if (!output.latest) {
      output.ok = false
      output.error = '两条源都没查到版本号（网络可能不通）'
    }
    return output
  }

  const releaseSpec = async (fallback, signal) => {
    if (lastSource !== 'github') return fallback
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
        signal: timeoutSignal(signal, 8000),
        headers: { 'user-agent': packageName, accept: 'application/vnd.github+json' },
      })
      if (response.ok) {
        const payload = await response.json()
        const tag = String(payload.tag_name || '').trim()
        const version = tag.replace(/^v/, '')
        if (version && version !== String(getCurrentVersion() || '')) {
          const url = `https://github.com/${repository}/releases/download/${tag}/${packageName}-${version}.tgz`
          appendLog('（用 Release 的 tgz 直链：' + url + '）\n')
          return url
        }
      }
    } catch {
      appendLog('（查 Release 直链没成功，退回 github: 装法）\n')
    }
    return fallback
  }

  const runUpgrade = () => {
    if (upgrading) return { ok: true, busy: true, log: logFile, hint: '正在升级，别重复点' }
    upgrading = true
    const controller = new AbortController()
    upgradeController = controller
    const signal = controller.signal
    const fallback = lastSource === 'github' ? `github:${repository}` : packageName
    ;(async () => {
      try {
        const spec = await releaseSpec(fallback, signal)
        appendLog(`\n=== ${new Date().toISOString()} 开始升级（add ${spec}）===\n`)
        const dsh = resolveDsh()
        if (dsh.missing) {
          appendLog('=== 没法自动升级：找不到 dsh。' + dsh.hint + ' ===\n')
          appendLog(`=== 也可以自己手动跑一次：dsh plugin --profile ${profileArg} add ${packageName} ===\n`)
          return
        }
        let command = dsh.command || 'dsh'
        let args = [...(dsh.args || []), 'plugin', '--profile', profileArg, 'add', spec]
        if (dsh.shell) { args = ['/c', command, ...args]; command = 'cmd.exe' }
        const code = await runCommand(command, args, signal)
        if (signal.aborted) {
          appendLog('=== 升级已取消（插件正在退出）===\n')
          return
        }
        if (code === 0) appendLog('=== 升级完成 —— 重启一次 dsh 才生效 ===\n')
        else appendLog(`=== 升级没成功（exit ${code}）。可以自己手动跑一次：dsh plugin --profile ${profileArg} add ${packageName} ===\n`)
      } catch (error) {
        if (signal.aborted) return
        appendLog('升级崩了：' + (error?.stack ?? error) + '\n')
      } finally {
        upgrading = false
        if (upgradeController === controller) upgradeController = null
      }
    })()
    return { ok: true, started: true, log: logFile, hint: '正在升级 —— 完成后重启一次 dsh 才生效' }
  }

  return {
    check,
    runUpgrade,
    isUpgrading: () => upgrading,
    stop() {
      if (!upgradeController) return false
      try { upgradeController.abort() } catch {}
      return true
    },
    source: () => lastSource,
  }
}
