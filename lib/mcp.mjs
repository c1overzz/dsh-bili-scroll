/**
 * lib/mcp.mjs —— 一个极小的 MCP stdio 客户端（只做我们需要的三件事）
 * ============================================================================
 * 为什么不用 `@deepseek-ai/dsh-mcp-client`：那是个"把 MCP 挂成 dsh 工具"的完整插件，
 * 而我们要的是**插件内部自己起这个 Python MCP**（用户选了 A 方案：装完就能用，
 * Python 路径和登录都在设置页里，不用去改 profile 的 patch）。
 *
 * 协议就三句话：`initialize` → `notifications/initialized` → `tools/call`，
 * stdio 上是**一行一个 JSON-RPC**。
 * ============================================================================
 */
import { spawn as defaultSpawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

// 报给对端的身份：版本号**从 package.json 读**，别手写（手写的那份永远追不上发版）
const PKG = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) } catch { return {} } })()

export class McpClient {
  constructor({ command, args = [], cwd, env, log = () => {}, spawn = defaultSpawn }) {
    if (typeof spawn !== 'function') throw new TypeError('McpClient requires spawn()')
    this.cfg = { command, args, cwd, env, log, spawn }
    this.proc = null
    this.buf = ''
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.starting = null
    this.processError = null
  }

  get running() { return Boolean(this.proc) }

  async start() {
    if (this.starting) return this.starting
    if (this.proc) return
    const startPromise = (async () => {
      const { command, args, cwd, env, log, spawn } = this.cfg
      const proc = spawn(command, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.proc = proc
      this.processError = null
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk) => this.#onData(proc, chunk))
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (c) => {
        if (this.proc === proc) this.stderr = (this.stderr + c).slice(-4000)
      })
      proc.on('error', (e) => {
        log(`MCP 子进程启动失败：${e?.message ?? e}`)
        this.#endProcess(proc, e)
      })
      proc.on('exit', (code) => {
        log(`MCP 子进程退出（code=${code}）`)
        this.#endProcess(proc, new Error(`MCP 子进程退出（code=${code}）${this.stderr ? '：' + this.stderr.slice(-300) : ''}`))
      })
      await this.#request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: PKG.name || 'dsh-bili-scroll', version: PKG.version || '0.0.0' },
      }, 60000, undefined, proc)
      this.#notify('notifications/initialized', {}, proc)
      log('MCP 已就绪')
    })()
    this.starting = startPromise
    try { await startPromise } finally {
      if (this.starting === startPromise) this.starting = null
    }
  }

  stop() {
    const proc = this.proc
    if (!proc) return
    this.#endProcess(proc, new Error('MCP 子进程已停止'))
    try { proc.kill() } catch { /* 已经没了 */ }
  }

  /** 调一个 MCP 工具：能解析成 JSON 就返回对象，否则返回字符串 */
  async call(name, args = {}, opts = {}) {
    return (await this.callRaw(name, args, opts)).json
  }

  /** 同 call，但保留图片块：返回 { json, images }，images 每项是 { data, mimeType } */
  async callRaw(name, args = {}, { timeoutMs = 180000, signal } = {}) {
    await this.start()
    const result = await this.#request('tools/call', { name, arguments: args }, timeoutMs, signal)
    const blocks = result?.content ?? []
    const text = blocks.map((c) => c?.text ?? '').filter(Boolean).join('\n').trim()
    if (result?.isError) throw new Error(text || `MCP 工具 ${name} 报错`)
    const images = blocks
      .filter((c) => c?.type === 'image' && c?.data)
      .map((c) => ({ data: c.data, mimeType: c.mimeType || c.mime_type || 'image/jpeg' }))
    let json = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = text }
    return { json, images }
  }

  #onData(proc, chunk) {
    if (this.proc !== proc) return
    this.buf += chunk
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }   // 非 JSON 行（有些库会往 stdout 打日志）忽略
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error?.message ? String(msg.error.message) : JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
    }
  }

  #endProcess(proc, error) {
    // A stopped process may emit `exit` after a replacement has already been
    // started. Never let that stale event tear down the new client.
    if (this.proc !== proc) return
    this.proc = null
    this.buf = ''
    this.processError = error
    // Allow a fresh start immediately. The old start promise will settle
    // through its rejected request and its identity check in the finally block.
    this.starting = null
    for (const [, p] of this.pending) p.reject(error)
    this.pending.clear()
  }

  #send(obj, proc = this.proc) {
    if (this.proc !== proc || !proc?.stdin?.writable) throw (this.processError || new Error('MCP 子进程不在运行'))
    proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  #notify(method, params, proc = this.proc) { this.#send({ jsonrpc: '2.0', method, params }, proc) }

  #request(method, params, timeoutMs = 60000, signal, proc = this.proc) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(`MCP ${method} 已取消`))
        return
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        signal?.removeEventListener?.('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(new Error(`MCP ${method} 已取消`))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`MCP ${method} 超时（${timeoutMs}ms）${this.stderr ? '：' + this.stderr.slice(-200) : ''}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { cleanup(); resolve(v) },
        reject: (e) => { cleanup(); reject(e) },
      })
      signal?.addEventListener?.('abort', onAbort, { once: true })
      try { this.#send({ jsonrpc: '2.0', id, method, params }, proc) } catch (e) {
        cleanup(); reject(e)
      }
    })
  }
}
