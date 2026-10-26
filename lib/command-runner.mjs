import { spawn as defaultSpawn } from 'node:child_process'

/**
 * Small, dependency-free subprocess primitive shared by host services.
 *
 * It intentionally knows nothing about install/update/favorite semantics:
 * callers decide how output is logged and how an exit code is interpreted.
 */
export function createCommandRunner({
  spawn = defaultSpawn,
  baseEnv = process.env,
  baseCwd,
  windowsHide = true,
} = {}) {
  if (typeof spawn !== 'function') throw new TypeError('createCommandRunner requires spawn()')

  const run = (command, args = [], {
    cwd = baseCwd,
    env = {},
    stdio = ['ignore', 'pipe', 'pipe'],
    timeoutMs = 0,
    signal,
    capture = true,
    onStdout = () => {},
    onStderr = () => {},
  } = {}) => new Promise((resolve) => {
    let child
    let settled = false
    let timer = null
    let stdout = ''
    let stderr = ''

    const kill = () => {
      try { child?.kill?.() } catch { /* process may already be gone */ }
    }
    const onAbort = () => {
      finish({ error: new Error('命令已取消') })
      kill()
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        command,
        args: [...args],
        stdout,
        stderr,
        code: null,
        signal: null,
        timedOut: false,
        ...result,
      })
    }

    if (signal?.aborted) {
      finish({ error: new Error('命令已取消') })
      return
    }

    try {
      child = spawn(command, args, {
        cwd,
        env: { ...baseEnv, ...(env || {}) },
        windowsHide,
        stdio,
      })
    } catch (error) {
      finish({ error })
      return
    }

    const consume = (kind, chunk) => {
      const text = String(chunk)
      if (capture) {
        if (kind === 'stdout') stdout += text
        else stderr += text
      }
      try {
        if (kind === 'stdout') onStdout(text)
        else onStderr(text)
      } catch { /* a logging sink must not break process cleanup */ }
    }
    child.stdout?.on?.('data', (chunk) => consume('stdout', chunk))
    child.stderr?.on?.('data', (chunk) => consume('stderr', chunk))
    const listen = (event, handler) => {
      if (typeof child.once === 'function') child.once(event, handler)
      else child.on?.(event, handler)
    }
    listen('error', (error) => finish({ code: 1, error }))
    listen('exit', (code, exitSignal) => finish({
      code: typeof code === 'number' ? code : 1,
      signal: exitSignal || null,
    }))
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish({ error: new Error(`命令超时（${timeoutMs}ms）`), timedOut: true })
        kill()
      }, timeoutMs)
      timer.unref?.()
    }
  })

  return { run }
}

