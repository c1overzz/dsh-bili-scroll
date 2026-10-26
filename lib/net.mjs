/**
 * Small network helpers shared by host-side Bilibili services.
 *
 * Every external request gets a bounded lifetime, while callers can still
 * cancel it during host disposal or when a newer poll supersedes it.
 */
export function timeoutSignal(parent, timeoutMs) {
  const limit = Math.max(1, Number(timeoutMs) || 1)
  const timeout = AbortSignal.timeout(limit)
  if (!parent) return timeout
  if (parent.aborted) return parent
  return AbortSignal.any([parent, timeout])
}

export async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 10_000) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchWithTimeout requires fetchImpl()')
  return fetchImpl(url, { ...options, signal: timeoutSignal(options.signal, timeoutMs) })
}
