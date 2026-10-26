/**
 * Pure DM policy helpers.
 *
 * The watcher performs I/O and starts DSH sessions; this module only decides
 * which message is actionable and how seen/quota state should advance. Keeping
 * these decisions pure makes the privacy-sensitive ordering easy to test.
 */
/**
 * Resolve the only UID allowed to trigger a bidirectional reply.
 *
 * The explicit owner setting is intentionally separate from `dmUid`, which is
 * only the recipient of outbound duty reports. With no explicit owner, the
 * logged-in account is the safe default.
 */
export function resolveOwnerUid({ configuredUid = 0, loggedInUid = 0 } = {}) {
  const explicit = Number(configuredUid) || 0
  if (explicit > 0) return explicit
  return Number(loggedInUid) || 0
}

export function latestIncoming(messages = [], seenKey = '') {
  const list = Array.isArray(messages) ? messages : []
  const last = [...list].reverse().find((message) => !message?.fromMe)
  if (!last || !last.key || String(last.key) === String(seenKey)) return null
  return last
}

export function normalizeQuota(quota, today) {
  const current = quota && typeof quota === 'object' ? { ...quota } : {}
  if (current.day !== today) return { day: today, n: 0 }
  return { day: today, n: Math.max(0, Number(current.n) || 0) }
}

export function quotaAllows(quota, limit) {
  const max = Number(limit) || 0
  return max <= 0 || Number(quota?.n) < max
}

export function markIncoming(seen, uid, messageKey) {
  return { ...(seen && typeof seen === 'object' ? seen : {}), [String(uid)]: String(messageKey) }
}

export function incrementQuota(quota) {
  return { day: quota?.day || '', n: Math.max(0, Number(quota?.n) || 0) + 1 }
}
