import { existsSync } from 'node:fs'
import { createPathLayout } from './path-layout.mjs'

/** Own the plugin-local Python MCP client and its configuration invalidation. */
export function createMcpService({
  stateDir,
  getConfig,
  refreshConfig = () => {},
  uvEnv = (extra = {}) => ({ ...process.env, ...extra }),
  McpClient,
  log = () => {},
}) {
  if (!stateDir) throw new TypeError('createMcpService requires stateDir')
  if (typeof getConfig !== 'function') throw new TypeError('createMcpService requires getConfig()')
  if (typeof McpClient !== 'function') throw new TypeError('createMcpService requires McpClient')

  const script = createPathLayout(stateDir).mcpServerFile
  let client = null
  let clientKey = ''

  const keyOf = () => {
    const cfg = getConfig() || {}
    return `${String(cfg.pythonPath || 'python')}|${script}`
  }

  const ensure = async () => {
    refreshConfig()
    const cfg = getConfig() || {}
    const key = keyOf()
    // `McpClient.call()` owns the actual lazy start. Reuse the instance even
    // before its child is running; otherwise two nearly simultaneous tool
    // calls can each create a Python MCP process for the same configuration.
    // If the process has already exited, McpClient can restart itself on the
    // next call, so a matching key is still the correct reuse boundary.
    if (client && clientKey === key) return client
    if (client) {
      try { client.stop() } catch { /* best effort */ }
      client = null
    }
    if (!existsSync(script)) {
      throw new Error(`家里没有 mcp_server.py（应有 ${script}）—— 装上插件后重启一次 dsh 会自动铺好`)
    }
    clientKey = key
    client = new McpClient({
      command: cfg.pythonPath || 'python',
      args: [script],
      cwd: stateDir,
      env: uvEnv(),
      log,
    })
    return client
  }

  const call = async (name, args, opts) => (await ensure()).call(name, args, opts)
  const callRaw = async (name, args, opts) => (await ensure()).callRaw(name, args, opts)
  const stop = () => {
    try { client?.stop() } catch { /* best effort */ }
    client = null
  }

  return {
    ensure,
    call,
    callRaw,
    stop,
    getClient: () => client,
    getScript: () => script,
  }
}

