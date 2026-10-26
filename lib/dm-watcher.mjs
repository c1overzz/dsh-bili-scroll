/**
 * Bidirectional Bilibili DM watcher.
 *
 * This service owns only DM policy/state: identifying the owner, polling
 * unread sessions, deduplicating messages, enforcing the daily quota and
 * keeping one reply session alive. DSH process mechanics are injected through
 * `startPrompt`, so the watcher is reusable without importing the host entry.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  fetchMsgs as defaultFetchMsgs,
  listSessions as defaultListSessions,
  loadCred as defaultLoadCred,
} from './dm.mjs'
import { resolveUid as defaultResolveUid } from './uid.mjs'
import { incrementQuota, latestIncoming, markIncoming, normalizeQuota, quotaAllows, resolveOwnerUid } from './dm-policy.mjs'
import { createPathLayout } from './path-layout.mjs'
import { writeJsonAtomic } from './atomic-write.mjs'

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

const writeJson = (file, value) => {
  try { writeJsonAtomic(file, value); return true } catch { return false }
}

export function createDmWatcher({
  stateDir,
  getConfig,
  refreshConfig = () => {},
  dayKey,
  log = () => {},
  startPrompt,
  rotateLog = () => {},
  loadCred = defaultLoadCred,
  listSessions = defaultListSessions,
  fetchMsgs = defaultFetchMsgs,
  resolveUid = defaultResolveUid,
  env = process.env,
  processApi = process,
  setTimer = setInterval,
  clearTimer = clearInterval,
  schedule = setTimeout,
}) {
  if (typeof getConfig !== 'function') throw new TypeError('createDmWatcher requires getConfig()')
  if (typeof dayKey !== 'function') throw new TypeError('createDmWatcher requires dayKey()')
  if (typeof startPrompt !== 'function') throw new TypeError('createDmWatcher requires startPrompt()')

  const layout = createPathLayout(stateDir)
  const dmSeenFile = layout.dmSeenFile
  const dmQuotaFile = layout.dmQuotaFile
  const dmLockFile = layout.dmLockFile
  const dmOthersFile = layout.dmOthersFile
  const dmSessionFile = layout.dmSessionFile

  let dmUidCache = 0
  let dmUidCacheName = ''
  let dmTimer = null
  let dmBusy = false
  let dmReplyRunning = false
  let lifecycle = 0
  let stopped = false
  let pollAbort = null

  const config = () => getConfig() || {}

  const dmOwnerUid = () => {
    const cfg = config()
    // `dmUid` is the outbound report recipient. It must never decide who is
    // allowed to trigger a bidirectional reply: a user may intentionally send
    // reports to somebody else. Only an explicit owner UID or the logged-in
    // account itself can enter the reply path.
    try {
      const own = Number(loadCred(stateDir)?.dedeuserid) || 0
      return resolveOwnerUid({ configuredUid: cfg.dmOwnerUid, loggedInUid: own })
    } catch { /* 没凭证就 0 */ }
    return resolveOwnerUid({ configuredUid: cfg.dmOwnerUid })
  }

  const ownerInfo = () => {
    try {
      const uid = dmOwnerUid()
      if (!uid) return null
      let name = ''
      try {
        const cache = readJson(layout.uidCacheFile, {}) || {}
        for (const [key, value] of Object.entries(cache)) {
          if (Number(value) === uid) { name = key; break }
        }
      } catch { /* 没缓存就只显示 uid */ }
      const cfg = config()
      if (!name && String(cfg.mentionName || '').trim() && Number(cfg.dmOwnerUid) === uid) {
        name = String(cfg.mentionName).trim()
      }
      const own = Number(loadCred(stateDir)?.dedeuserid) || 0
      return { uid, name, self: uid === own }
    } catch { return null }
  }

  const warmUid = async () => {
    const cfg = config()
    const explicit = Number(cfg.dmUid) || 0
    if (explicit > 0) {
      // An explicit UID supersedes any nickname lookup. Do not leave the old
      // nickname result available if the user later clears this field.
      dmUidCache = 0
      dmUidCacheName = ''
      return explicit
    }
    if (cfg.dmMode === 'off') {
      dmUidCache = 0
      dmUidCacheName = ''
      return 0
    }
    const name = String(cfg.mentionName || '').trim()
    if (!name) {
      dmUidCache = 0
      dmUidCacheName = ''
      return 0
    }
    if (dmUidCache > 0 && dmUidCacheName === name) return dmUidCache
    try {
      const mid = await resolveUid(stateDir, name, log)
      dmUidCacheName = name
      dmUidCache = mid > 0 ? mid : 0
      if (mid > 0) log(`私信对象：${name} → ${mid}`)
      return mid
    } catch (error) {
      dmUidCacheName = name
      dmUidCache = 0
      log('查私信 UID 出错：' + String(error?.message ?? error))
      return 0
    }
  }

  const readDmSession = () => {
    const value = readJson(dmSessionFile, null)
    return value && typeof value.id === 'string' && value.id ? value.id : ''
  }

  const writeDmSession = (id) => writeJson(dmSessionFile, { id, at: Date.now() })

  // Find the newest session directory created by a reply in this plugin's
  // workspace. Other DSH conversations must never be claimed accidentally.
  const discoverDmSession = (sinceTs) => {
    try {
      const root = join(env.DSH_HOME || join(env.USERPROFILE || '', '.dsh'), 'sessions')
      if (!existsSync(root)) return ''
      const wantWs = '--' + stateDir.replace(/:/g, '').replace(/[\\/]/g, '-') + '--'
      const preferred = [wantWs].filter((workspace) => existsSync(join(root, workspace)))
      const workspaces = preferred.length ? preferred : readdirSync(root)
      let best = ''
      let bestAt = 0
      for (const workspace of workspaces) {
        const workspaceDir = join(root, workspace)
        let sessions = []
        try { sessions = readdirSync(workspaceDir) } catch { continue }
        for (const session of sessions) {
          const full = join(workspaceDir, session)
          try {
            const info = statSync(full)
            if (info.isDirectory() && info.mtimeMs >= sinceTs && info.mtimeMs > bestAt) {
              bestAt = info.mtimeMs
              best = session
            }
          } catch { /* 跳过无法读取的目录 */ }
        }
      }
      return best
    } catch { return '' }
  }

  const dmPromptFor = (fromUid, text) => {
    const cfg = config()
    const raw = String(text || '').slice(0, 600)
    const bvid = (raw.match(/BV[0-9A-Za-z]{10}/) || [])[0] || ''
    const persona = (() => {
      try {
        const explicit = String(cfg.personaPrompt || '').trim()
        if (explicit) return explicit
        const workspace = String(cfg.workspace || '').trim()
        if (!workspace) return ''
        const file = join(workspace, 'AGENTS.md')
        return existsSync(file) ? readFileSync(file, 'utf8').slice(0, 4000) : ''
      } catch { return '' }
    })()
    return (persona ? '（说话风格按这份人设来：\n' + persona + '\n）\n' : '')
      + '这是 B站 私信里、账号持有者本人发来的一句话：' + JSON.stringify(raw)
      + (bvid ? `\n里面有个视频 ${bvid}：用 bili_subtitle 读一下它的字幕再回，说点具体的。` : '')
      + `\n用 bili_send_message 回他一句（uid=${Number(fromUid)}），100 字以内，像聊天。`
      + '\n⚠️ 只回纯文本：**不要 markdown 星号/加粗**、不要括号里写"（多少字…可继续发送…）"这类说明，不要复述这条要求。'
  }

  const runReply = (fromUid, text) => {
    try {
      refreshConfig()
      if (stopped) return { ok: false, error: '私信监听已停止' }
      if (dmReplyRunning) {
        log('私信回复：上一条还在跑 ⇒ 这条等下一跳')
        return { ok: false, busy: true }
      }
      // Reserve the reply slot before invoking the injected launcher. A very
      // fast child (or a test double) may fire `onExit` synchronously; setting
      // the flag only after `startPrompt()` returns would overwrite that
      // callback's cleanup and leave the watcher stuck busy forever.
      dmReplyRunning = true
      const replyLifecycle = lifecycle
      const savedSid = readDmSession()
      const result = startPrompt(dmPromptFor(fromUid, text), {
        why: '私信回复',
        sessionId: savedSid,
        logStart: false,
        logExit: false,
        onExit: ({ code, startedAt }) => {
          if (replyLifecycle !== lifecycle) return
          dmReplyRunning = false
          log(`私信回复结束（code=${code}）`)
          rotateLog()
          if (!savedSid && code === 0) {
            const id = discoverDmSession(startedAt)
            if (id) {
              writeDmSession(id)
              log('私信会话已记录：' + id.slice(0, 24) + '…（以后私信都接着这个会话）')
            } else {
              log('⚠️ 没找到这次的会话 id ⇒ 下一条私信还是新会话（不影响回复，只是没上下文）')
            }
          }
          if (savedSid && code !== 0) {
            writeDmSession('')
            log('⚠️ 续会话失败（' + savedSid.slice(0, 16) + '…）⇒ 清掉 id，立刻用新会话重试一次（这条不能没回）')
            const retry = schedule(() => {
              if (replyLifecycle !== lifecycle || stopped) return
              try { runReply(fromUid, text) } catch { /* 兜住 */ }
            }, 800)
            retry?.unref?.()
          }
        },
      })
      if (!result.started) {
        dmReplyRunning = false
        return { ok: false, error: result.error }
      }
      log(`私信回复开跑：来自 uid=${fromUid}` + (savedSid ? '（续会话 ' + savedSid.slice(0, 20) + '…）' : '（开新会话）'))
      return { ok: true }
    } catch (error) {
      dmReplyRunning = false
      log('私信回复出错：' + String(error?.message ?? error))
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  const acquirePollLock = () => {
    const lock = readJson(dmLockFile, null)
    const alive = (pid) => {
      if (!pid) return false
      try { processApi.kill(pid, 0); return true } catch { return false }
    }
    const fresh = lock && Number(lock.ts) > Date.now() - 3 * 60_000
    if (fresh && Number(lock.pid) !== processApi.pid && alive(Number(lock.pid))) {
      log('私信监听：另一个宿主正在跑（pid=' + lock.pid + '）⇒ 这一跳让给它')
      return false
    }
    writeJson(dmLockFile, { pid: processApi.pid, ts: Date.now() })
    return true
  }

  const tick = async () => {
    if (dmBusy) return { ok: true, skipped: 'busy' }
    const tickLifecycle = lifecycle
    if (stopped) return { ok: true, skipped: 'stopped' }
    dmBusy = true
    const controller = new AbortController()
    pollAbort = controller
    try {
      try { refreshConfig() } catch { /* 读不到就沿用旧值 */ }
      if (!acquirePollLock()) return { ok: true, skipped: 'other-host' }
      const cfg = config()
      if (stopped || tickLifecycle !== lifecycle) return { ok: true, skipped: 'stopped' }
      if (!cfg.dmWatch) return { ok: true, skipped: 'disabled' }
      const cred = loadCred(stateDir)
      if (!cred) return { ok: true, skipped: 'not-logged-in' }
      const owner = dmOwnerUid()
      if (!owner) {
        log('私信监听：还不知道"我自己的 UID"⇒ 先不监听（设置 → 刷B站 → 高级 →「只回谁的私信」）')
        return { ok: true, skipped: 'owner-unknown' }
      }
      if (Number(cfg.dmOwnerUid) <= 0) {
        log('私信监听：现在只回"登录账号自己"的私信；想回另一个账号的话，请在高级里填「只回谁的私信」= 你自己的 UID')
      }
      const sessions = await listSessions(cred, { signal: controller.signal })
      if (stopped || tickLifecycle !== lifecycle) return { ok: true, skipped: 'stopped' }
      const mine = sessions.filter((session) => session.uid === owner && session.unread > 0)
      const others = sessions.filter((session) => session.uid !== owner && session.unread > 0)
      if (others.length) {
        const signature = others.map((session) => session.uid + ':' + session.unread).sort().join(',')
        const seenOther = readJson(dmOthersFile, { sig: '' })
        if (seenOther.sig !== signature) {
          log('私信监听：有 ' + others.length + ' 个陌生人的未读私信，按规矩不回（只回主人本人）')
          writeJson(dmOthersFile, { sig: signature })
        }
      }
      if (!mine.length) return { ok: true, replied: 0 }

      const today = dayKey()
      let seen = readJson(dmSeenFile, {}) || {}
      let quota = normalizeQuota(readJson(dmQuotaFile, { day: '', n: 0 }), today)
      let replied = 0
      for (const session of mine) {
        const messages = await fetchMsgs(cred, session.uid, 8, { signal: controller.signal })
        if (stopped || tickLifecycle !== lifecycle) return { ok: true, skipped: 'stopped' }
        const last = latestIncoming(messages, seen[String(session.uid)])
        if (!last) continue
        if (!quotaAllows(quota, cfg.dmReplyPerDay)) {
          log('私信监听：今天额度用完了（' + quota.n + '/' + cfg.dmReplyPerDay + '）⇒ 这条先不回，明天会自动补')
          continue
        }
        log(`私信监听：收到新消息 —— ${String(last.text || '').slice(0, 40)}`)
        // Do not acknowledge a message until the reply process has actually
        // started. A missing dsh binary, a busy reply, or another immediate
        // launch failure must leave the message eligible for the next poll.
        const reply = runReply(session.uid, last.text)
        if (!reply?.ok) {
          log('私信监听：这条暂时没启动回复，保留到下一次重试')
          continue
        }
        seen = markIncoming(seen, session.uid, last.key)
        writeJson(dmSeenFile, seen)
        quota = incrementQuota(quota)
        replied++
        writeJson(dmQuotaFile, quota)
      }
      return { ok: true, replied }
    } catch (error) {
      if (stopped || tickLifecycle !== lifecycle || controller.signal.aborted) {
        return { ok: true, skipped: 'stopped' }
      }
      log('私信监查出错（已兜住）：' + String(error?.message ?? error))
      return { ok: false, error: String(error?.message ?? error) }
    } finally {
      if (pollAbort === controller) {
        pollAbort = null
        dmBusy = false
      }
    }
  }

  const start = () => {
    try {
      stopped = false
      lifecycle++
      // A restart may happen while the previous tick is still awaiting the
      // network. Cancel that request and release the busy gate so the new
      // lifecycle can begin immediately; the old tick is fenced by its
      // captured lifecycle value and cannot write state afterward.
      try { pollAbort?.abort() } catch { /* 请求可能已经结束 */ }
      pollAbort = null
      dmBusy = false
      if (dmTimer) { clearTimer(dmTimer); dmTimer = null }
      const cfg = config()
      const minutes = Math.max(1, Number(cfg.dmWatchMinutes) || 1)
      dmTimer = setTimer(() => { tick().catch((error) => log('私信定时器异常：' + String(error?.message ?? error))) }, minutes * 60_000)
      dmTimer?.unref?.()
      log(`私信监听：${cfg.dmWatch ? '已开' : '关着'}（每 ${minutes} 分钟查一次）`)
      return true
    } catch (error) {
      log('启私信监听失败：' + String(error?.message ?? error))
      return false
    }
  }

  const stop = () => {
    stopped = true
    lifecycle++
    try { if (dmTimer) clearTimer(dmTimer); dmTimer = null } catch { /* 忽略 */ }
    try { pollAbort?.abort() } catch { /* 请求可能已经结束 */ }
    pollAbort = null
    dmBusy = false
    dmReplyRunning = false
  }

  return {
    start,
    stop,
    tick,
    warmUid,
    runReply,
    ownerInfo,
    ownerUid: dmOwnerUid,
    getResolvedUid: () => {
      const cfg = config()
      if (Number(cfg.dmUid) > 0) return 0
      const name = String(cfg.mentionName || '').trim()
      return name && dmUidCacheName === name ? dmUidCache : 0
    },
    setResolvedUid: (uid) => { dmUidCache = Number(uid) || 0; dmUidCacheName = '' },
    isReplyRunning: () => dmReplyRunning,
    isStopped: () => stopped,
  }
}

