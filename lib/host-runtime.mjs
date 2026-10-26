/**
 * Small adapter around the DSH host object.
 *
 * Services should not need to know whether the host exposes a capability via
 * `ctx.get`, a direct property, or a Cordis effect. Keeping those fallbacks in
 * one place makes the entry point a composition root instead of a second host
 * integration layer.
 */
export function createHostRuntime({ ctx, log = () => {} } = {}) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('createHostRuntime requires ctx')

  const get = (name, fallback = null) => {
    const tries = [
      () => (typeof ctx.get === 'function' ? ctx.get(name) : null),
      () => Reflect.get(ctx, name),
      () => (ctx.root && typeof ctx.root === 'object' ? ctx.root[name] : null),
    ]
    for (const read of tries) {
      try {
        const value = read()
        if (value != null) return value
      } catch { /* try the next host shape */ }
    }
    return fallback
  }

  const effect = (setup, label) => {
    try {
      if (typeof ctx.effect !== 'function') throw new Error('宿主没有提供 effect()')
      return ctx.effect(setup, label)
    } catch (error) {
      log(`${label || '宿主生命周期'}没挂上：${error?.message ?? error}`)
      return undefined
    }
  }

  const dispose = (cleanup, label) => effect(() => () => {
    try { cleanup?.() } catch (error) { log(`${label || '宿主清理'}失败：${error?.message ?? error}`) }
  }, label)

  let connectionTried = false
  let connection = null
  const getConnection = () => {
    if (connectionTried) return connection
    connectionTried = true
    const candidate = get('connection')
    if (candidate && typeof candidate.requestRejection === 'function') {
      connection = candidate
      log('信任栅栏：拿到了 connection 服务 ✓')
    } else {
      log('⚠️ 拿不到 connection.requestRejection ⇒ 退回“本机同源”这一道')
    }
    return connection
  }

  const registerWebServer = ({ path, handler, label = `HTTP 路由 ${path}` }) => effect(() => {
    const webServer = get('webServer') || ctx.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      throw new Error('宿主没有提供 webServer.register()')
    }
    return webServer.register({ kind: 'prefix', path, handler })
  }, label)

  const registerTool = (spec) => {
    const tools = get('tools')
    if (!tools || typeof tools.register !== 'function') throw new Error('宿主没有提供 tools.register()')
    return tools.register(spec)
  }

  return { get, effect, dispose, getConnection, registerWebServer, registerTool }
}
