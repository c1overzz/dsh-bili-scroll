import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPathLayout } from './path-layout.mjs'
import { fetchWithTimeout } from './net.mjs'

/** Settings-page diagnostics, kept independent from the HTTP transport. */
export function createDiagnostics({
  stateDir,
  outDir,
  getConfig,
  getVersion = () => '',
  dutyRunner,
  call = async () => { throw new Error('MCP 不可用') },
  venvReadyNow = () => false,
  missingVenvDeps = () => [],
  hasCredential = () => false,
  loadCredential = () => null,
  getResolvedDmUid = () => 0,
  dayKey = () => new Date().toISOString().slice(0, 10),
  pythonEnvDir = '.venv-asr',
  fetchImpl = globalThis.fetch,
  log = () => {},
}) {
  if (typeof getConfig !== 'function') throw new TypeError('createDiagnostics requires getConfig()')
  const layout = createPathLayout(stateDir, { outDir })
  if (!dutyRunner) throw new TypeError('createDiagnostics requires dutyRunner')

  const config = () => getConfig() || {}

  const checkUp = async () => {
    const result = { ok: false, steps: [] }
    if (!venvReadyNow()) {
      result.error = '环境还没装好（可能上次装失败了）—— 点「重装主依赖」再试一次'
      return result
    }
    if (!hasCredential()) {
      result.error = '还没登录：点「扫码登录」，手机 B站 扫一下'
      return result
    }
    try {
      const who = await call('bili_check_credential', {})
      result.who = (typeof who === 'object' ? JSON.stringify(who) : String(who)).slice(0, 140)
      result.steps.push('登录有效')
    } catch (error) {
      result.error = '登录检查失败：' + (error?.message ?? error)
      return result
    }
    try {
      const search = await call('bili_search', { keyword: 'DeepSeek Harness', num: 3 })
      const text = typeof search === 'string' ? search : JSON.stringify(search)
      result.sample = text.slice(0, 160)
      result.steps.push('能搜到东西')
      result.ok = text.length > 2
      if (!result.ok) result.error = '搜到了空结果'
    } catch (error) {
      result.error = '搜索失败：' + (error?.message ?? error)
    }
    return result
  }

  const diagnose = () => {
    const tail = (() => {
      try {
        const file = layout.logFile
        return existsSync(file) ? readFileSync(file, 'utf8').slice(-6000) : '（没有 duty.log）'
      } catch (error) { return '（日志读不到：' + String(error?.message ?? error) + '）' }
    })()
    const current = config()
    const sensitive = ['personaPrompt', 'mentionName', 'workspace', 'dshBin', 'dmUid', 'dmOwnerUid', 'keywords']
    const masked = { ...current }
    for (const key of sensitive) {
      const value = masked[key]
      if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) masked[key] = ''
      else masked[key] = Array.isArray(value) ? `(已填 ${value.length} 项)` : `(已填 ${String(value).length} 字)`
    }
    const tailSafe = tail.split('\n')
      .map((line) => (/收到新消息|私信内容|私信监听：收到/.test(line) ? '（一行私信内容已略去）' : line))
      .join('\n')
    let dshLine = ''
    try {
      const resolved = dutyRunner.resolveDsh()
      dshLine = resolved.missing ? `没找到（${resolved.hint}）` : `${resolved.command} ${resolved.args.join(' ')}`
    } catch (error) { dshLine = '探测失败：' + error?.message }
    return [
      '=== 刷B站 诊断信息 ===',
      '版本：' + getVersion(),
      '平台：' + process.platform + ' ' + process.arch + ' · node ' + process.versions.node + (process.versions.electron ? ' · electron ' + process.versions.electron : ''),
      'dsh：' + dshLine,
      'headless profile：' + dutyRunner.effectiveProfile() + '（最小权限：' + dutyRunner.getProfileState() + '）',
      'pythonPath：' + current.pythonPath,
      'venv 就绪：' + (venvReadyNow() ? '是' : '否') + (missingVenvDeps().length ? '（缺：' + missingVenvDeps().join(' / ') + '）' : ''),
      '转写环境：' + (existsSync(pythonEnvDir === '.venv-asr' ? layout.asrVenvDir : join(stateDir, pythonEnvDir)) ? '在' : '没装'),
      'B站 登录：' + (hasCredential() ? '有凭证' : '没有凭证'),
      '投递方式：' + (current.dmMode || 'off') + (Number(current.dmUid) > 0 ? '（UID 已填 ' + current.dmUid + '）' : '（UID 没填，会用昵称查）'),
      '自动评论：' + (current.autoComment ? '开' : '关') + ' · 回复评论：' + (current.replyToComments ? '开' : '关'),
      '家目录：' + stateDir,
      '今天的报告：' + layout.reportFile(dayKey()),
      '', '--- 配置（已脱敏）---', JSON.stringify(masked, null, 2),
      '', '--- duty.log 末尾（私信内容已略去）---', tailSafe,
    ].join('\n')
  }

  const selfCheck = async () => {
    const items = []
    const put = (name, ok, detail, fix) => items.push({ name, ok, detail: detail || '', fix: ok ? '' : (fix || '') })
    try {
      const dsh = dutyRunner.resolveDsh()
      put('能找到 dsh（跑一轮要用）', !dsh.missing, dsh.missing ? '没找到：' + dsh.hint : `${dsh.command} ${(dsh.args || []).join(' ')}`, '在设置页「dsh 路径」里填上 …/@deepseek-ai/dsh/lib/bin.js')
    } catch (error) { put('能找到 dsh（跑一轮要用）', false, String(error?.message ?? error), '同上') }
    const missing = missingVenvDeps()
    put('Python 主依赖装好了', venvReadyNow(), missing.length ? '缺：' + missing.join(' / ') : '就绪', '点「重装主依赖」，等它跑完再看这里')

    if (!hasCredential()) put('B站 已登录', false, '还没有凭证', '点「扫码登录」，手机确认时选「记住我 / 长期」')
    else {
      let loggedIn = false
      let detail = '家目录里有凭证文件，但没能验真（网络不通？）'
      try {
        const credential = loadCredential()
        if (credential?.sessdata || credential?.SESSDATA) {
          const response = await fetchWithTimeout(fetchImpl, 'https://api.bilibili.com/x/web-interface/nav', {
            headers: { 'User-Agent': 'Mozilla/5.0', Cookie: 'SESSDATA=' + (credential.sessdata || credential.SESSDATA) },
          }, 8_000)
          const payload = await response.json().catch(() => null)
          loggedIn = Boolean(payload?.data?.isLogin)
          detail = loggedIn ? `已登录：${payload.data.uname || '（没拿到昵称）'}（uid ${payload.data.mid || '?'}）` : '凭证还在，但 B站 说这个登录已经失效'
        } else detail = '凭证文件里缺 SESSDATA'
      } catch (error) { detail = '验真请求失败：' + String(error?.message ?? error) }
      put('B站 已登录（真验一次）', loggedIn, detail, '点「扫码登录」重新扫一次，手机确认时选「记住我 / 长期」')
    }

    let writable = true
    try {
      const file = join(layout.root, '.diag-write-test')
      writeFileSync(file, 'x')
      rmSync(file)
    } catch { writable = false }
    put('家目录可写（报告要写在这儿）', writable, writable ? stateDir : '写不进去', '检查杀软是否拦了这个目录，或把家目录换到别的盘')

    let reachable = false
    let reachDetail = ''
    try {
      const response = await fetchWithTimeout(fetchImpl, 'https://api.bilibili.com/x/web-interface/nav', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 8_000)
      reachable = response.ok
      reachDetail = 'HTTP ' + response.status
    } catch (error) { reachDetail = String(error?.message ?? error) }
    put('能连上 B站', reachable, reachDetail, '检查网络 / 加速器；公司或校园网可能拦了')

    const current = config()
    const dmMode = String(current.dmMode || 'off')
    const resolvedDmUid = Number(getResolvedDmUid()) || 0
    const configuredDmUid = Number(current.dmUid) || 0
    const needsRecipient = dmMode === 'only' || dmMode === 'both'
    const dmOk = !needsRecipient || configuredDmUid > 0 || resolvedDmUid > 0
    const dmDetail = dmMode === 'off'
      ? '当前是「只发评论」'
      : (configuredDmUid > 0
        ? 'UID ' + configuredDmUid
        : (resolvedDmUid > 0 ? '按昵称查到 ' + resolvedDmUid : '还没查到（自动轮会先尝试解析）'))
    put('知道私信发给谁（或没开私信）', dmOk, dmDetail, '填「私信发给谁（UID）」，或填「要 @ 谁」的昵称让它自己查')
    return { ok: items.every((item) => item.ok), items }
  }

  return { checkUp, diagnose, selfCheck }
}
