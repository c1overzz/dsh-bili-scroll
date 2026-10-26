/**
 * Side effects that happen after a duty child exits.
 *
 * The runner owns the child process. This coordinator owns the bookkeeping
 * around it, keeping report accounting, favorites, log rotation and delayed
 * verification out of the process lifecycle module.
 */
export function createRoundFinalizer({
  reports,
  favorites,
  getConfig = () => ({}),
  dayKey,
  readState = () => ({}),
  bumpState = () => {},
  countPickedToday = () => 0,
  rotateLog = () => {},
  runVerify = async () => {},
  reportLogFile = '',
  schedule = (fn, delay) => setTimeout(fn, delay),
  clearSchedule = (timer) => clearTimeout(timer),
  log = () => {},
  verifyDelayMs = 90_000,
}) {
  if (!reports || typeof reports.stubReportIfMissing !== 'function') {
    throw new TypeError('createRoundFinalizer requires reports')
  }
  if (!favorites || typeof favorites.favToday !== 'function') {
    throw new TypeError('createRoundFinalizer requires favorites')
  }
  if (typeof dayKey !== 'function') throw new TypeError('createRoundFinalizer requires dayKey()')
  let generation = 0
  const verifyTimers = new Set()

  const finalize = ({ code, why = 'unknown' } = {}) => {
    const currentGeneration = generation
    try { reports.stubReportIfMissing(code, reportLogFile) } catch { /* report fallback is best effort */ }

    try {
      const cfg = getConfig() || {}
      if (code === 0 && Number(cfg.favFolderId) > 0) {
        favorites.favToday('auto').catch((error) => log('自动收藏出错（已兜住）：' + String(error?.message ?? error)))
      }
    } catch (error) {
      log('自动收藏收尾出错（已兜住）：' + String(error?.message ?? error))
    }

    try { rotateLog() } catch (error) { log('日志轮转出错（已兜住）：' + String(error?.message ?? error)) }

    try {
      const state = readState() || {}
      const today = dayKey()
      const previous = state.day === today ? Number(state.picked || 0) : 0
      const picked = Number(countPickedToday()) || 0
      if (picked > previous) {
        bumpState({ picked })
        log(`今天挑到 ${picked} 条（上限 ${Number(getConfig()?.perDay) || 0} 条）`)
      }
    } catch (error) {
      log(`数挑了几条时出错（不影响这一轮）：${error?.message ?? error}`)
    }

    try {
      // The host may dispose the plugin while bookkeeping is still running.
      // Do not create a new delayed task after that lifecycle has been
      // cancelled; the generation check in the callback is not enough because
      // it would otherwise leave a stale timer pending until its delay.
      if (currentGeneration !== generation) return { ok: true, why, stopped: true }
      let timer = null
      timer = schedule(() => {
        if (timer) verifyTimers.delete(timer)
        if (currentGeneration !== generation) return
        Promise.resolve(runVerify('round')).catch((error) => log('复核异常：' + (error?.message ?? error)))
      }, verifyDelayMs)
      timer?.unref?.()
      if (timer && currentGeneration === generation) verifyTimers.add(timer)
      else if (timer) {
        try { clearSchedule(timer) } catch { /* generation guard still prevents work */ }
      }
    } catch (error) {
      log('安排评论复核出错（已兜住）：' + String(error?.message ?? error))
    }
    log(`值班轮收尾完成（${why}）`)
    return { ok: true, why }
  }

  const stop = () => {
    generation++
    if (!verifyTimers.size) return false
    for (const timer of verifyTimers) {
      try { clearSchedule(timer) } catch { /* generation guard still prevents work */ }
    }
    verifyTimers.clear()
    return true
  }

  return { finalize, stop, isPending: () => verifyTimers.size > 0 }
}

