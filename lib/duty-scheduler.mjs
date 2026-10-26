/**
 * Schedule duty rounds inside the configured off-peak windows.
 *
 * The scheduler owns only time-window gating and state bookkeeping. It does
 * not know how a round is executed or how reports are stored beyond the small
 * callbacks supplied by the composition root.
 */
export function createDutyScheduler({
  getConfig,
  refreshConfig = () => {},
  windows,
  windowKeys = ['noon', 'night'],
  inWindow,
  dayKey,
  readState = () => ({}),
  bumpState = () => {},
  countPickedToday = () => 0,
  roundsToday = () => 0,
  getDmUid = () => 0,
  warmUid = async () => 0,
  runDuty = () => ({ started: false }),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = 60_000,
  log = () => {},
}) {
  if (typeof getConfig !== 'function') throw new TypeError('createDutyScheduler requires getConfig()')
  if (typeof dayKey !== 'function') throw new TypeError('createDutyScheduler requires dayKey()')
  if (typeof inWindow !== 'function') throw new TypeError('createDutyScheduler requires inWindow()')
  if (!windows || typeof windows !== 'object') throw new TypeError('createDutyScheduler requires windows')

  // The durable state file is the source of truth across restarts. This
  // in-memory set closes the smaller window where a child has started but the
  // filesystem write fails: do not launch the same window again in this host
  // lifetime after the child eventually exits.
  const claimedWindows = new Set()
  const warmedRecipientKeys = new Set()
  let recipientWarmup = null

  const tick = () => {
    try {
      refreshConfig()
      const cfg = getConfig() || {}
      if (!cfg.peakValley) return { started: false, reason: 'disabled' }

      const now = new Date()
      const state = readState() || {}
      const today = dayKey(now)
      if (countPickedToday(now) >= Number(cfg.perDay || 0)) return { started: false, reason: 'quota' }
      if (String(cfg.reportLevel || 'full') === 'off' && roundsToday(now) >= 1) {
        return { started: false, reason: 'report-off-round-limit' }
      }

      for (const key of windowKeys) {
        if (!cfg[key] || !windows[key] || !inWindow(now, windows[key])) continue
        const stateKey = `${today}:${key}`
        if (state.windows?.[stateKey] || claimedWindows.has(stateKey)) continue
        const why = `window:${key}`

        // Manual runs warm a nickname recipient in the HTTP layer. Scheduled
        // rounds have no request to do that for them, so wait for the same
        // lookup before spawning a child. Missing names still fall through;
        // duty-prompt remains fail-closed and will write the explanation.
        const needsRecipient = ['only', 'both'].includes(String(cfg.dmMode || 'off'))
          && Number(cfg.dmUid) <= 0
          && String(cfg.mentionName || '').trim()
          && Number(getDmUid()) <= 0
        const recipientKey = `${stateKey}\u0000${String(cfg.mentionName || '').trim()}`
        if (needsRecipient && recipientWarmup) {
          return { started: false, why, reason: 'warming-recipient' }
        }
        if (needsRecipient && !warmedRecipientKeys.has(recipientKey)) {
          warmedRecipientKeys.add(recipientKey)
          if (!recipientWarmup) {
            try {
              recipientWarmup = Promise.resolve(warmUid())
                .catch((error) => { log('自动轮预热私信 UID 失败：' + String(error?.message ?? error)); return 0 })
                .finally(() => { recipientWarmup = null })
            } catch (error) {
              log('自动轮预热私信 UID 失败：' + String(error?.message ?? error))
              recipientWarmup = null
            }
          }
          return { started: false, why, reason: 'warming-recipient' }
        }

        // Start first, then commit the window reservation. A missing dsh CLI
        // or a still-running previous round must not consume today's window;
        // the next scheduler tick should be allowed to retry it.
        const result = runDuty(why)
        if (!result?.started) {
          return {
            started: false,
            why,
            reason: result?.busy ? 'busy' : 'launch-failed',
            result,
          }
        }
        claimedWindows.add(stateKey)
        let statePersisted = true
        try {
          bumpState({
            windows: { ...(state.windows || {}), [stateKey]: true },
            count: roundsToday(now) + 1,
            lastRunAt: now.toISOString(),
            lastWhy: key,
          })
        } catch (error) {
          statePersisted = false
          log(`值班轮已启动，但窗口状态没写进去（本次宿主内不会重复启动）：${error?.message ?? error}`)
        }
        return { started: true, why, result, statePersisted }
      }
      return { started: false, reason: 'outside-window' }
    } catch (error) {
      log(`定时器这一跳出错（已兜住，不影响宿主）：${error?.stack ?? error}`)
      return { started: false, reason: 'error', error: String(error?.message ?? error) }
    }
  }

  let timer = null
  const start = () => {
    if (timer) return timer
    timer = setIntervalFn(tick, intervalMs)
    timer?.unref?.()
    return timer
  }
  const stop = () => {
    if (!timer) return
    clearIntervalFn(timer)
    timer = null
  }

  return { tick, start, stop, isRunning: () => Boolean(timer) }
}

