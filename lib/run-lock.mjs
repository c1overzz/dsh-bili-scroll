import { closeSync, linkSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const readLock = (file) => {
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'))
    return { ...lock, mtimeMs: statSync(file).mtimeMs }
  } catch { return null }
}

/** Cross-process, fail-open lock for a single duty round. */
export function createRunLock({
  file,
  pid = process.pid,
  now = Date.now,
  isPidAlive = (value) => {
    if (!value) return false
    try { process.kill(value, 0); return true } catch (error) { return error?.code === 'EPERM' }
  },
  token = randomUUID(),
  ttlMs = 10 * 60_000,
  heartbeatMs = 60_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = () => {},
}) {
  if (!file) throw new TypeError('createRunLock requires file')
  let held = false
  let failOpen = false

  const active = (lock, at) => {
    if (!lock || String(lock.token || '') === token) return false
    const fresh = Number(lock.mtimeMs ?? lock.ts) > at - ttlMs
    if (!fresh) return false
    try { return isPidAlive(Number(lock.pid)) } catch (error) { return error?.code !== 'ESRCH' }
  }

  let heartbeat = null
  const startHeartbeat = () => {
    if (heartbeat || !(heartbeatMs > 0)) return
    heartbeat = setIntervalFn(() => {
      try {
        const current = readLock(file)
        if (String(current?.token || '') !== token) return
        const at = new Date(now())
        utimesSync(file, at, at)
      } catch (error) {
        log(`运行锁续租失败（这一轮继续跑）：${String(error?.message ?? error)}`)
      }
    }, heartbeatMs)
    heartbeat?.unref?.()
  }

  const clearStale = (expected) => {
    const reapFile = `${file}.reap`
    let fd
    let ownsReaper = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fd = openSync(reapFile, 'wx', 0o600)
        ownsReaper = true
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          log(`运行锁清理失败（这一轮照跑）：${String(error?.message ?? error)}`)
          return null
        }
        let previous
        try { previous = statSync(reapFile) } catch { continue }
        if (previous.mtimeMs > now() - ttlMs) return false
        let latest
        try { latest = statSync(reapFile) } catch { continue }
        if (latest.ino !== previous.ino || latest.mtimeMs !== previous.mtimeMs) continue
        try { unlinkSync(reapFile) } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') return false
        }
      }
    }
    if (fd === undefined) return false

    try {
      const latest = readLock(file)
      if (active(latest, now())) return false
      if (JSON.stringify(latest) !== JSON.stringify(expected)) return false
      try { unlinkSync(file); return true } catch (error) {
        if (error?.code === 'ENOENT') return true
        log(`运行锁清理失败（这一轮照跑）：${String(error?.message ?? error)}`)
        return null
      }
    } finally {
      try { closeSync(fd) } catch { /* already closed */ }
      if (ownsReaper) try { unlinkSync(reapFile) } catch { /* cleanup is best effort */ }
    }
  }

  const acquire = (why = 'window') => {
    const at = now()
    for (let attempt = 0; attempt < 3; attempt++) {
      let fd
      const temporary = `${file}.${pid}.${token}.tmp`
      try {
        fd = openSync(temporary, 'wx', 0o600)
        writeFileSync(fd, JSON.stringify({ pid, ts: at, why, token }), 'utf8')
        closeSync(fd)
        fd = undefined
        linkSync(temporary, file)
        try { unlinkSync(temporary) } catch { /* target lock is already valid */ }
        held = true
        startHeartbeat()
        return { acquired: true }
      } catch (error) {
        if (fd !== undefined) try { closeSync(fd) } catch { /* already closed */ }
        try { unlinkSync(temporary) } catch { /* best effort */ }
        if (error?.code !== 'EEXIST') {
          log(`运行锁读写失败（这一轮照跑）：${String(error?.message ?? error)}`)
          held = true
          failOpen = true
          return { acquired: true, failOpen: true }
        }
      }

      const current = readLock(file)
      if (active(current, now())) {
        log(`这一轮没跑（${why}）：另一个宿主正在跑（pid=${current.pid}）⇒ 让给它`)
        return { acquired: false, busy: true }
      }

      const cleared = clearStale(current)
      if (cleared === null) {
        held = true
        failOpen = true
        return { acquired: true, failOpen: true }
      }
      if (!cleared) continue
    }
    log('运行锁争用过多（这一轮让给另一个宿主）')
    return { acquired: false, busy: true }
  }

  const release = () => {
    if (!held) return false
    held = false
    if (failOpen) {
      failOpen = false
      return false
    }
    if (heartbeat) {
      try { clearIntervalFn(heartbeat) } catch { /* release still proceeds */ }
      heartbeat = null
    }
    const current = readLock(file)
    if (String(current?.token || '') !== token) return false
    try { unlinkSync(file); return true } catch { return false }
  }

  return { acquire, release, isHeld: () => held }
}
