import { spawn as defaultSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createCommandRunner } from './command-runner.mjs'
import { createPathLayout } from './path-layout.mjs'

/**
 * Host-side Bilibili favorites service.
 *
 * The model never receives this write capability. The service only reads the
 * current report's picked BV ids and delegates the actual API call to the
 * user's home-directory favops.py helper.
 */
export function createFavoriteService({
  stateDir,
  outDir,
  getConfig,
  refreshConfig = () => {},
  hasCredential = () => false,
  pickIdsFromReport = () => [],
  dayKey = () => new Date().toISOString().slice(0, 10),
  pyEnv = () => process.env,
  spawn = defaultSpawn,
  commandRunner = null,
  log = () => {},
  timeoutMs = 30_000,
}) {
  if (typeof getConfig !== 'function') throw new TypeError('createFavoriteService requires getConfig()')

  const layout = createPathLayout(stateDir, { outDir })
  outDir = layout.outDir

  const runner = commandRunner || createCommandRunner({ spawn, baseEnv: process.env, baseCwd: stateDir })
  if (!runner || typeof runner.run !== 'function') {
    throw new TypeError('createFavoriteService requires commandRunner.run()')
  }

  const favOps = async (args, signal) => {
    const cfg = getConfig() || {}
    const python = String(cfg.pythonPath || 'python')
    const result = await runner.run(python, [layout.favopsFile, ...args], {
      cwd: stateDir,
      env: pyEnv(),
      timeoutMs,
      signal,
    })
    if (result.timedOut) return { ok: false, error: `favops 超时（${Math.round(timeoutMs / 1000)} 秒）` }
    if (result.error && !result.stdout) return { ok: false, error: String(result.error?.message ?? result.error) }
    try {
      return JSON.parse(String(result.stdout).trim().split('\n').pop() || '{}')
    } catch {
      return { ok: false, error: (result.stderr || result.stdout || 'favops 没有输出').slice(-300) }
    }
  }

  let busy = false
  const controllers = new Set()
  const favToday = async (why = 'manual') => {
    if (busy) return { ok: false, error: '上一次收藏还没跑完，等它完事' }
    busy = true
    const currentController = new AbortController()
    controllers.add(currentController)
    const signal = currentController.signal
    try {
      refreshConfig()
      const cfg = getConfig() || {}
      const folderId = Math.max(0, Math.floor(Number(cfg.favFolderId) || 0))
      if (folderId <= 0) return { ok: false, error: '还没选收藏夹（设置页「自动收藏到」选一个）' }
      if (!hasCredential()) return { ok: false, error: '还没扫码登录 B站' }
      const script = layout.favopsFile
      if (!existsSync(script)) return { ok: false, error: 'favops.py 不在家里（重启一次 dsh 会自动铺好）' }
      const report = layout.reportFile(dayKey())
      const ids = pickIdsFromReport(report)
      if (!ids.length) return { ok: false, error: '今天的报告里没有挑中的视频（行首 ### BV号 那些）' }

      const failures = []
      let added = 0
      for (const bvid of ids) {
        if (signal.aborted) return { ok: false, error: '收藏已取消（插件正在退出）', added, total: ids.length, failures }
        const result = await favOps(['add', bvid, String(folderId)], signal)
        if (result?.ok) added++
        else failures.push(`${bvid}: ${result?.error || '未知原因'}`)
      }
      log(`自动收藏（${why}）：${added}/${ids.length} 条` + (failures.length ? `，失败 ${failures.length}` : ''))
      if (failures.length) log('  收藏失败明细：' + failures.slice(0, 5).join(' | '))
      return { ok: true, added, total: ids.length, failures }
    } finally {
      busy = false
      controllers.delete(currentController)
    }
  }

  const listFolders = async () => {
    const currentController = new AbortController()
    controllers.add(currentController)
    try {
      return await favOps(['folders'], currentController.signal)
    } finally {
      controllers.delete(currentController)
    }
  }

  return {
    favOps,
    favToday,
    listFolders,
    isBusy: () => busy,
    stop() {
      if (!controllers.size) return false
      for (const currentController of controllers) {
        try { currentController.abort() } catch {}
      }
      return true
    },
  }
}
