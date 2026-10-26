/**
 * Local HTTP API for the settings page.
 *
 * The controller owns request parsing, route dispatch, localhost/DSH trust
 * checks and response formatting. Domain work is supplied as callbacks so the
 * controller can be tested without booting a DSH host or a Bilibili account.
 */
import { spawn as defaultSpawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPathLayout } from './path-layout.mjs'
import { CONFIG_KEYS } from './config.mjs'

export const sendJson = (res, code, value) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

export const readBody = (req, limit = 1_000_000) => new Promise((resolve) => {
  let data = ''
  let done = false
  const finish = (value) => { if (!done) { done = true; resolve(value) } }
  req.on('data', (chunk) => {
    data += chunk
    if (data.length > limit) { data = ''; finish({}); req.destroy?.() }
  })
  req.on('end', () => {
    try { finish(JSON.parse(data || '{}')) } catch { finish({}) }
  })
  req.on('error', () => finish({}))
})

const sameOriginOk = (req) => {
  try {
    const host = String(req.headers?.host || '')
    if (!host) return true
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
    const pick = String(req.headers?.origin || req.headers?.referer || '')
    if (!pick) return true
    const url = new URL(pick)
    const originAuthority = String(url.host || '').toLowerCase()
    const hostAuthority = host.toLowerCase()
    if (originAuthority && originAuthority === hostAuthority) return true
    const defaultPort = url.protocol === 'https:' ? '443' : '80'
    return `${url.hostname}:${url.port || defaultPort}`.toLowerCase() === hostAuthority
  } catch { return false }
}

const blank = (value) => value === '' || value === null || value === undefined
  || (Array.isArray(value) && value.length === 0)

export function createHttpApi({
  stateDir,
  outDir,
  getConfig,
  refreshConfig = () => {},
  persistConfig,
  readSavedConfig = () => ({}),
  windows = {},
  log = () => {},
  dayKey = () => new Date().toISOString().slice(0, 10),
  getStatus,
  rollSeen = () => {},
  syncNotes = () => {},
  runDuty = () => ({ ok: true }),
  warmUid = async () => {},
  install = () => ({ ok: false, error: '安装服务不可用' }),
  installAsr = () => ({ ok: false, error: '转写安装服务不可用' }),
  listFavFolders = async () => ({ ok: false, error: '收藏服务不可用' }),
  favToday = async () => ({ ok: false, error: '收藏服务不可用' }),
  getWatched = async () => ({ ok: true, total: 0, offset: 0, limit: 60, rows: [] }),
  coverFor = async () => null,
  runVerify = async () => ({ ok: false, error: '复核服务不可用' }),
  getReport = null,
  openExternal = async () => ({ ok: false, error: '打开服务不可用' }),
  upgrade = () => ({ ok: false, error: '升级服务不可用' }),
  checkUpdate = async () => ({ ok: false, error: '更新服务不可用' }),
  checkUp = async () => ({ ok: false, error: '自检服务不可用' }),
  diagnose = () => '',
  selfCheck = async () => ({ ok: false, items: [] }),
  loginStart = async () => ({}),
  renderQrPng = async () => null,
  loginPoll = async () => ({ state: 'unknown' }),
  saveCredential = () => '',
  getConnection,
  spawn = defaultSpawn,
  platform = process.platform,
  systemRoot = process.env.SystemRoot || 'C:\\Windows',
}) {
  if (typeof getConfig !== 'function') throw new TypeError('createHttpApi requires getConfig()')
  if (typeof getStatus !== 'function') throw new TypeError('createHttpApi requires getStatus()')
  if (typeof persistConfig !== 'function') throw new TypeError('createHttpApi requires persistConfig()')
  const layout = createPathLayout(stateDir, { outDir })
  getReport ||= async (day) => ({ ok: true, day, exists: false, file: layout.reportFile(day), text: '' })

  let fenceWarned = false
  const resolveConnection = () => {
    return typeof getConnection === 'function' ? getConnection() : null
  }

  const fenceReject = (req, res) => {
    const connection = typeof getConnection === 'function' ? getConnection() : resolveConnection()
    if (!connection) {
      if (!fenceWarned) {
        fenceWarned = true
        log('⚠️ 拿不到 DSH 信任栅栏（connection.requestRejection）⇒ 退回本机同源这一道')
      }
      return false
    }
    try {
      const rejection = connection.requestRejection({ headers: req.headers })
      if (rejection === undefined) return false
      res.statusCode = typeof rejection === 'number' ? rejection : 403
      res.end()
      return true
    } catch (error) {
      log('信任栅栏调用出错，按不通过处理：' + String(error?.message ?? error))
      res.statusCode = 403
      res.end()
      return true
    }
  }

  const openPath = async ({ what, url }) => {
    if (what === 'url') {
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: '只接受 http(s) 链接' }
      if (platform !== 'win32') {
        const opener = platform === 'darwin' ? 'open' : 'xdg-open'
        spawn(opener, [url], { detached: true, stdio: 'ignore' }).on('error', () => {})
      } else {
        // Pass the URL as an argv value instead of feeding model/report text
        // through `cmd /c`, whose metacharacters have shell semantics.
        spawn(join(systemRoot, 'explorer.exe'), [url], { detached: true, stdio: 'ignore' }).on('error', () => {})
      }
      log('打开网页：' + url)
      return { ok: true }
    }
    const dir = what === 'home' ? stateDir : outDir
    if (platform !== 'win32') return { ok: false, error: '这个按钮目前只做了 Windows' }
    const attempts = [
      ['cmd.exe', ['/c', 'start', '', dir]],
      [join(systemRoot, 'explorer.exe'), [dir]],
      ['powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${dir.replace(/'/g, "''")}'`]],
    ]
    let lastError = ''
    for (const [command, args] of attempts) {
      const error = await new Promise((resolve) => {
        let settled = false
        let child
        try { child = spawn(command, args, { detached: true, stdio: 'ignore' }) }
        catch (caught) { resolve(String(caught?.message ?? caught)); return }
        child.on('error', (caught) => { if (!settled) { settled = true; resolve(String(caught?.message ?? caught)) } })
        setTimeout(() => {
          if (!settled) { settled = true; try { child.unref?.() } catch {} resolve('') }
        }, 500)
      })
      if (!error) {
        log('打开文件夹：用了 ' + command + '（没报错；窗口不一定真弹出来了）')
        return { ok: true, opened: dir, via: command }
      }
      lastError = error
      log('打开文件夹失败（' + command + '）：' + error)
    }
    return { ok: false, error: lastError, dir }
  }

  const handle = async (req, res, url) => {
    refreshConfig()
    const path = url.pathname
    const cfg = getConfig() || {}

    if (req.method === 'GET' && path === '/api/bili-duty/status') {
      try { rollSeen() } catch {}
      try { syncNotes() } catch {}
      return sendJson(res, 200, getStatus())
    }
    if (req.method === 'GET' && path === '/api/bili-duty/config') {
      return sendJson(res, 200, { ok: true, config: cfg, windows, home: stateDir })
    }
    if (req.method === 'POST' && path === '/api/bili-duty/config') {
      const body = await readBody(req)
      const patch = {}
      for (const key of CONFIG_KEYS) if (key in body) patch[key] = body[key]
      const clears = Array.isArray(body?.clear) ? body.clear : []
      const saved = readSavedConfig() || {}
      for (const key of Object.keys(patch)) {
        if (!blank(patch[key])) continue
        const current = cfg[key] !== undefined && cfg[key] !== null ? cfg[key] : saved[key]
        const hasValue = current !== '' && current !== null && current !== undefined
          && !(Array.isArray(current) && current.length === 0)
        if (hasValue && !clears.includes(key)) {
          delete patch[key]
          log('设置：' + key + ' 收到空值，但当前不是空的 ⇒ 已忽略（要清空请用「清空」按钮）')
        }
      }
      const { clean, host } = await persistConfig(patch)
      log(`设置已更新：${JSON.stringify(clean)}（DSH 那边${host.ok ? '已同步' : '没写成：' + host.error}）`)
      return sendJson(res, 200, { ok: true, config: getConfig(), host })
    }
    if (req.method === 'POST' && path === '/api/bili-duty/run') {
      if (cfg.dmMode !== 'off' && !(Number(cfg.dmUid) > 0)) await warmUid()
      return sendJson(res, 200, { ok: true, ...runDuty('manual') })
    }
    if (req.method === 'POST' && path === '/api/bili-duty/install') return sendJson(res, 200, install())
    if (req.method === 'POST' && path === '/api/bili-duty/install-asr') return sendJson(res, 200, installAsr())
    if (req.method === 'GET' && path === '/api/bili-duty/fav-folders') {
      const result = await listFavFolders()
      return sendJson(res, 200, result?.ok ? { ok: true, folders: result.folders || [] } : { ok: false, error: result?.error || '读不到收藏夹' })
    }
    if (req.method === 'POST' && path === '/api/bili-duty/fav-today') return sendJson(res, 200, await favToday('manual'))
    if (req.method === 'GET' && path === '/api/bili-duty/watched') return sendJson(res, 200, await getWatched({ query: url.searchParams }))
    if (req.method === 'GET' && path === '/api/bili-duty/cover') {
      const cover = await coverFor(String(url.searchParams.get('bv') || ''))
      if (!cover) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('no cover'); return }
      res.writeHead(200, { 'content-type': cover.type, 'cache-control': 'max-age=86400' })
      res.end(cover.buf)
      return
    }
    if (req.method === 'POST' && path === '/api/bili-duty/verify') return sendJson(res, 200, await runVerify('manual'))
    if (req.method === 'GET' && path === '/api/bili-duty/report') {
      const day = String(url.searchParams.get('day') || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      return sendJson(res, 200, await getReport(day))
    }
    if (req.method === 'POST' && path === '/api/bili-duty/open') {
      const body = await readBody(req)
      return sendJson(res, 200, await openPath({ what: String(body?.what || 'out'), url: String(body?.u || '') }))
    }
    if (req.method === 'POST' && path === '/api/bili-duty/upgrade') return sendJson(res, 200, upgrade())
    if (req.method === 'GET' && path === '/api/bili-duty/update') return sendJson(res, 200, await checkUpdate())
    if (req.method === 'POST' && path === '/api/bili-duty/check') return sendJson(res, 200, await checkUp())
    if (req.method === 'GET' && path === '/api/bili-duty/diagnose') return sendJson(res, 200, { ok: true, text: diagnose() })
    if (req.method === 'GET' && path === '/api/bili-duty/selfcheck') return sendJson(res, 200, await selfCheck())
    if (req.method === 'POST' && path === '/api/bili-duty/login/start') {
      const { key, url: loginUrl } = await loginStart()
      const png = await renderQrPng(getConfig().pythonPath, stateDir, loginUrl)
      let qr = null
      if (png) {
        try { qr = 'data:image/png;base64,' + readFileSync(png).toString('base64') } catch {}
      }
      log(`出码：${loginUrl}${qr ? '（已画成 PNG）' : '（没画出 PNG —— venv 里大概还没有 qrcode）'}`)
      return sendJson(res, 200, { ok: true, key, url: loginUrl, qr })
    }
    if (req.method === 'POST' && path === '/api/bili-duty/login/poll') {
      const body = await readBody(req)
      const result = await loginPoll(String(body.key || ''))
      if (result.state === 'ok') {
        const file = saveCredential(result.credential)
        log(`登录成功，凭证已写入 ${file}`)
        return sendJson(res, 200, { ok: true, state: 'ok', file })
      }
      return sendJson(res, 200, { ok: result.state !== 'unknown', state: result.state, code: result.code, message: result.message })
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  const dispatch = async (req, res) => {
    if (fenceReject(req, res)) return
    if (!sameOriginOk(req)) { sendJson(res, 403, { ok: false, error: '只接受本机同源请求' }); return }
    try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) }
    catch (error) { sendJson(res, 500, { ok: false, error: error?.message ?? String(error) }) }
  }

  return { handle, dispatch, sendJson }
}
