import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DEFAULT_DSH_HINT = '已经把常见位置和应用目录都翻过一遍了。可以手动把「dsh 路径」填成 <应用目录>/…/@deepseek-ai/dsh/lib/bin.js，或改用 npm 装的 dsh'

/**
 * Locate the DSH CLI without spawning a shell.
 *
 * The resolver is deliberately filesystem-only. Process launching and
 * Electron environment flags belong to headless-runner, which keeps this
 * module cheap to test and safe to reuse from diagnostics/update code.
 */
export function createDshResolver({
  getConfig = () => ({}),
  log = () => {},
  env = process.env,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
  exists = existsSync,
  readDirectories = readdirSync,
  pathJoin = join,
  pathDirname = dirname,
  resolveModule = (() => {
    try { return createRequire(import.meta.url).resolve.bind(createRequire(import.meta.url)) } catch { return null }
  })(),
  now = () => Date.now(),
  cacheTtlMs = 60_000,
} = {}) {
  const config = () => getConfig() || {}
  let autoDshLogged = ''
  let cache = { key: '', value: null, at: 0 }

  const scanForDsh = (dir, depth, budget) => {
    if (depth > 7 || budget.n > 4000) return ''
    let entries = []
    try { entries = readDirectories(dir, { withFileTypes: true }) } catch { return '' }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (++budget.n > 4000) return ''
      const candidate = pathJoin(dir, entry.name)
      if (entry.name === 'dsh') {
        const bin = pathJoin(candidate, 'lib', 'bin.js')
        if (exists(bin)) return bin
      }
      const hit = scanForDsh(candidate, depth + 1, budget)
      if (hit) return hit
    }
    return ''
  }

  const pathEntries = () => String(env.PATH || '').split(platform === 'win32' ? ';' : ':')
    .map((raw) => raw.replace(/^"|"$/g, '').trim())
    .filter(Boolean)

  const findOnPath = (names) => {
    for (const dir of pathEntries()) {
      for (const name of names) {
        const candidate = pathJoin(dir, name)
        try { if (exists(candidate)) return candidate } catch { /* ignore bad path */ }
      }
    }
    return ''
  }

  const hasDshOnPath = () => {
    const extensions = platform === 'win32' ? ['', '.cmd', '.exe', '.bat', '.ps1'] : ['']
    return Boolean(findOnPath(extensions.map((extension) => 'dsh' + extension)))
  }

  const findDshCli = () => {
    const explicit = String(config().dshBin || '').trim()
    if (explicit && exists(explicit)) return explicit

    if (typeof resolveModule === 'function') {
      for (const specifier of ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-ai/dsh']) {
        try {
          const resolved = resolveModule(specifier)
          if (resolved && exists(resolved)) return resolved
        } catch { /* try the next resolution root */ }
      }
    }

    for (const globalPath of [
      pathJoin(env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      pathJoin(env.ProgramFiles || '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].filter(Boolean)) if (exists(globalPath)) return globalPath

    const roots = []
    if (resourcesPath) roots.push(resourcesPath)
    try { roots.push(pathJoin(pathDirname(execPath), 'resources')) } catch { /* no exec path */ }
    const tried = []
    for (const root of roots) {
      if (!root || tried.includes(root) || !exists(root)) continue
      tried.push(root)
      const hit = scanForDsh(root, 0, { n: 0 })
      if (hit) return hit
    }
    return ''
  }

  const dshCliCached = () => {
    const timestamp = now()
    const explicit = String(config().dshBin || '').trim()
    const key = [explicit, String(env.PATH || ''), platform, resourcesPath || '', execPath || ''].join('\u0000')
    if (cache.key === key && cache.value !== null && timestamp - cache.at < cacheTtlMs) return cache.value
    const value = findDshCli()
    cache = { key, value, at: timestamp }
    return value
  }

  const resolveDsh = () => {
    const cli = dshCliCached()
    if (cli) {
      const explicit = String(config().dshBin || '').trim()
      if (cli !== explicit && autoDshLogged !== cli) {
        autoDshLogged = cli
        log(`自动找到 dsh：${cli}（不用手填 dshBin 了）`)
      }
      return { command: execPath, args: [cli], shell: false }
    }

    if (!hasDshOnPath()) {
      log('⚠️ 找不到 dsh（常见位置、应用目录、PATH 里都没有）⇒ ' + DEFAULT_DSH_HINT)
      return { missing: true, hint: DEFAULT_DSH_HINT }
    }
    const onPath = findOnPath(platform === 'win32'
      ? ['dsh.cmd', 'dsh.exe', 'dsh.bat', 'dsh']
      : ['dsh'])
    if (onPath) {
      log('⚠️ 没在常见位置找到 dsh，改用 PATH 里那份（绝对路径、不经 shell）：' + onPath)
      return { command: onPath, args: [], shell: false, fallback: true, hint: DEFAULT_DSH_HINT }
    }
    log('⚠️ 找不到 dsh（常见位置、应用目录、PATH 里都没有）⇒ ' + DEFAULT_DSH_HINT)
    return { missing: true, hint: DEFAULT_DSH_HINT }
  }

  return { findDshCli, dshCliCached, resolveDsh, clearCache: () => { cache = { key: '', value: null, at: 0 } } }
}
