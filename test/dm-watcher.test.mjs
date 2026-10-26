import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONFIG_DEFAULTS } from '../lib/config.mjs'
import { createDmWatcher } from '../lib/dm-watcher.mjs'

async function makeWatcher(overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bili-duty-dm-'))
  const config = { ...CONFIG_DEFAULTS, dmWatch: true, dmUid: 42, ...overrides.config }
  const logs = []
  const replies = []
  let replyExit = null
  const watcher = createDmWatcher({
    stateDir,
    getConfig: () => config,
    dayKey: () => '2026-10-24',
    log: (line) => logs.push(line),
    loadCred: () => ({ sessdata: 'ok', dedeuserid: 99 }),
    listSessions: async () => overrides.sessions || [],
    fetchMsgs: async () => overrides.messages || [],
    startPrompt: (prompt, options) => {
      replies.push({ prompt, options })
      replyExit = options.onExit
      return { started: true, child: {} }
    },
    ...overrides.injected,
  })
  return { watcher, config, logs, replies, getReplyExit: () => replyExit, stateDir }
}

test('DM watcher only handles the configured owner and deduplicates messages', async () => {
  const { watcher, logs, replies, getReplyExit } = await makeWatcher({
    sessions: [
      { uid: 99, unread: 1 },
      { uid: 77, unread: 2 },
    ],
    messages: [{ key: 'm1', fromMe: false, text: '你好' }],
  })

  const first = await watcher.tick()
  assert.equal(first.replied, 1)
  assert.equal(replies.length, 1)
  assert.match(replies[0].prompt, /你好/)
  assert.match(logs.join('\n'), /陌生人的未读私信/)

  getReplyExit()?.({ code: 0, startedAt: Date.now() })
  const second = await watcher.tick()
  assert.equal(second.replied, 0)
  assert.equal(replies.length, 1)
})

test('DM quota is checked before marking a message as seen', async () => {
  const { watcher, config, stateDir, replies } = await makeWatcher({
    config: { dmReplyPerDay: 1 },
    sessions: [{ uid: 99, unread: 1 }],
    messages: [{ key: 'm2', fromMe: false, text: '超额消息' }],
  })
  await writeFile(join(stateDir, 'dm-quota.json'), JSON.stringify({ day: '2026-10-24', n: 1 }), 'utf8')
  await watcher.tick()
  assert.equal(replies.length, 0)
  await assert.rejects(readFile(join(stateDir, 'dm-seen.json'), 'utf8'))
  const quota = JSON.parse(await readFile(join(stateDir, 'dm-quota.json'), 'utf8'))
  assert.equal(quota.n, 1)
  assert.equal(config.dmReplyPerDay, 1)
})

test('a reply launch failure keeps the message unseen and quota intact', async () => {
  const { watcher, stateDir, config } = await makeWatcher({
    sessions: [{ uid: 99, unread: 1 }],
    messages: [{ key: 'launch-failed', fromMe: false, text: '稍后再试' }],
    injected: {
      startPrompt: () => ({ started: false, error: '找不到 dsh' }),
    },
  })

  const result = await watcher.tick()
  assert.deepEqual(result, { ok: true, replied: 0 })
  await assert.rejects(readFile(join(stateDir, 'dm-seen.json'), 'utf8'))
  await assert.rejects(readFile(join(stateDir, 'dm-quota.json'), 'utf8'))
  assert.equal(config.dmReplyPerDay, 0)
})

test('a synchronous reply exit releases the busy flag', async () => {
  let onExit
  const { watcher, replies } = await makeWatcher({
    injected: {
      startPrompt: (_prompt, options) => {
        onExit = options.onExit
        onExit({ code: 0, startedAt: Date.now() })
        return { started: true, child: {} }
      },
    },
  })

  const result = watcher.runReply(42, '马上结束')
  assert.deepEqual(result, { ok: true })
  assert.equal(replies.length, 0)
  assert.equal(watcher.isReplyRunning(), false)
})

test('ownerInfo exposes whether the resolved owner is the logged-in account', async () => {
  const { watcher } = await makeWatcher({ config: { dmUid: 99 } })
  assert.deepEqual(watcher.ownerInfo(), { uid: 99, name: '', self: true })
})

test('stopping during a poll prevents late network results from changing DM state', async () => {
  let release
  const { watcher, stateDir, replies } = await makeWatcher({
    sessions: [{ uid: 99, unread: 1 }],
    messages: [{ key: 'late', fromMe: false, text: '不应回复' }],
    injected: {
      listSessions: () => new Promise((resolve) => { release = resolve }),
    },
  })
  const pending = watcher.tick()
  watcher.stop()
  release([{ uid: 42, unread: 1 }])
  const result = await pending
  assert.deepEqual(result, { ok: true, skipped: 'stopped' })
  assert.equal(replies.length, 0)
  await assert.rejects(readFile(join(stateDir, 'dm-seen.json'), 'utf8'))
  assert.equal(watcher.isStopped(), true)
})

test('outbound DM recipient does not become the bidirectional reply owner', async () => {
  const { watcher, replies, logs } = await makeWatcher({
    sessions: [
      { uid: 42, unread: 1 },
      { uid: 99, unread: 1 },
    ],
    messages: [{ key: 'owner-only', fromMe: false, text: '只回登录账号' }],
  })

  const result = await watcher.tick()
  assert.equal(result.replied, 1)
  assert.equal(replies.length, 1)
  assert.match(replies[0].prompt, /uid=99/)
  assert.match(logs.join('\n'), /陌生人的未读私信/)
})

test('explicit DM owner can be different from the logged-in account', async () => {
  const { watcher, replies } = await makeWatcher({
    config: { dmOwnerUid: 42 },
    sessions: [{ uid: 42, unread: 1 }, { uid: 99, unread: 1 }],
    messages: [{ key: 'explicit-owner', fromMe: false, text: '大号消息' }],
  })

  const result = await watcher.tick()
  assert.equal(result.replied, 1)
  assert.equal(replies.length, 1)
  assert.match(replies[0].prompt, /uid=42/)
})

test('clearing or changing the outbound recipient never reuses an old nickname cache', async () => {
  const resolved = []
  const { watcher, config } = await makeWatcher({
    config: { dmUid: 0, mentionName: '旧收件人' },
    injected: {
      resolveUid: async (_stateDir, name) => {
        resolved.push(name)
        return name === '旧收件人' ? 42 : 0
      },
    },
  })

  assert.equal(await watcher.warmUid(), 42)
  config.mentionName = '新收件人'
  assert.equal(await watcher.warmUid(), 0)
  config.mentionName = ''
  assert.equal(await watcher.warmUid(), 0)
  assert.deepEqual(resolved, ['旧收件人', '新收件人'])
  assert.equal(watcher.getResolvedUid(), 0)
})

test('restarting the watcher aborts the old poll and opens a new lifecycle', async () => {
  let releaseOld
  let firstSignal
  let calls = 0
  const { watcher } = await makeWatcher({
    sessions: [{ uid: 42, unread: 1 }],
    injected: {
      listSessions: async (_cred, { signal } = {}) => {
        calls++
        if (calls === 1) {
          firstSignal = signal
          return new Promise((resolve) => { releaseOld = resolve })
        }
        return []
      },
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {},
    },
  })

  const oldPoll = watcher.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)

  watcher.start()
  assert.equal(firstSignal.aborted, true)

  const newPoll = await watcher.tick()
  assert.deepEqual(newPoll, { ok: true, replied: 0 })
  releaseOld([])
  assert.deepEqual(await oldPoll, { ok: true, skipped: 'stopped' })
})

