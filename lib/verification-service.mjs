/**
 * Host-side comment verification with concurrency protection and report sync.
 */
export function createVerificationService({
  stateDir,
  verifyRecent,
  appendVerifyToReport,
  log = () => {},
}) {
  if (typeof verifyRecent !== 'function') throw new TypeError('createVerificationService requires verifyRecent()')
  if (typeof appendVerifyToReport !== 'function') throw new TypeError('createVerificationService requires appendVerifyToReport()')

  let verifying = false
  let controller = null
  const runVerify = async (why = 'manual') => {
    if (verifying) return { ok: false, error: '上一次复核还没跑完，等它完事' }
    verifying = true
    const currentController = new AbortController()
    controller = currentController
    try {
      log(`评论复核开始（${why}）`)
      const result = await verifyRecent(stateDir, { log, signal: currentController.signal })
      const report = appendVerifyToReport(stateDir, result.text)
      if (result.checked.length) {
        log(`评论复核结束（${why}）：查了 ${result.checked.length} 条${report ? `，已写进 ${report}` : ''}`)
      } else {
        log(`评论复核结束（${why}）：没有可核的记录（不算错）`)
      }
      return {
        ok: true,
        why,
        checked: result.checked,
        skipped: result.skipped,
        text: result.text,
        report: report || '',
      }
    } catch (error) {
      log(`评论复核失败（${why}）：${error?.message ?? error}`)
      return { ok: false, why, error: String(error?.message ?? error) }
    } finally {
      verifying = false
      if (controller === currentController) controller = null
    }
  }

  return {
    runVerify,
    isVerifying: () => verifying,
    stop() {
      if (!controller) return false
      try { controller.abort() } catch {}
      return true
    },
  }
}
