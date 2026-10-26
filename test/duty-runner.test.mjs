import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONFIG_DEFAULTS } from '../lib/config.mjs'
import { createDutyRunner } from '../lib/duty-runner.mjs'

async function makeRunner(overrides = {}) {
  const {
    config: configOverride,
    countPickedToday: pickedOverride,
    asrReadyNow: asrOverride,
    dmUid: dmUidOverride,
    dmOwnerUid: dmOwnerUidOverride,
    ...injected
  } = overrides
  const stateDir = await mkdtemp(join(tmpdir(), 'bili-duty-runner-'))
  const outDir = join(stateDir, 'out')
  const charter = join(stateDir, 'duty.md')
  await writeFile(charter, '章程：每天挑值得看的视频。', 'utf8')
  const config = { ...CONFIG_DEFAULTS, ...configOverride }
  const logs = []
  const options = {
    pluginDir: fileURLToPath(new URL('..', import.meta.url)),
    stateDir,
    outDir,
    logFile: join(stateDir, 'duty.log'),
    digestDir: join(stateDir, 'digest'),
    getConfig: () => config,
    refreshConfig: () => {},
    dayKey: () => '2026-10-24',
    charterPath: () => charter,
    countPickedToday: () => pickedOverride ?? 0,
    asrReadyNow: () => asrOverride ?? false,
    getDmUid: () => dmUidOverride ?? 0,
    getDmOwnerUid: () => dmOwnerUidOverride ?? 0,
    log: (line) => logs.push(line),
    resourcesPath: join(stateDir, 'no-resources'),
    execPath: process.execPath,
    ...injected,
  }
  return { runner: createDutyRunner(options), config, logs, stateDir, charter }
}

test('promptFor includes remaining quota and reads a workspace persona', async () => {
  const { stateDir } = await makeRunner()
  const workspace = join(stateDir, 'workspace')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace))
  await writeFile(join(workspace, 'AGENTS.md'), '说话要简洁。', 'utf8')
  const cfg = { ...CONFIG_DEFAULTS, perDay: 5, dmMode: 'only', workspace }
  const { runner: configured, logs } = await makeRunner({ config: cfg, countPickedToday: 2 })
  const prompt = configured.promptFor()
  assert.match(prompt, /今天已经挑过 2 条了/)
  assert.match(prompt, /这一轮最多再挑 3 条/)
  assert.match(prompt, /说话要简洁。/)
  assert.match(logs.join('\n'), /不发公开评论，也不盲发私信/)
})

test('mcpWhitelist keeps public replies out of dm-only rounds', async () => {
  const { runner } = await makeRunner({
    config: { dmMode: 'only', autoComment: true, mentionName: '某人', dmWatch: true },
  })
  const list = runner.mcpWhitelist()
  assert.doesNotMatch(list.join(','), /bili_reply/)
  assert.match(list.join(','), /bili_send_message/)
})

test('mcpWhitelist includes recommendation and asynchronous transcription tools', async () => {
  const { runner } = await makeRunner({ config: { asrInstalled: true } })
  const list = runner.mcpWhitelist()
  assert.ok(list.includes('bili_recommend'))
  assert.ok(list.includes('bili_transcribe_start'))
  assert.ok(list.includes('bili_transcribe_result'))
})

test('ensureOverlay writes a quoted command and the selected MCP tools', async () => {
  const { runner, stateDir } = await makeRunner({
    config: { pythonPath: "/tmp/user's python", dmMode: 'only' },
  })
  const file = runner.ensureOverlay()
  const text = await readFile(file, 'utf8')
  assert.match(text, /command: '\/tmp\/user''s python'/)
  assert.match(text, /BILI_MCP_TOOLS: '.*bili_send_message.*'/)
})

test('runDuty reports a missing CLI and refuses a concurrent round', async () => {
  const missing = await makeRunner({
    config: { dshBin: join(tmpdir(), 'definitely-not-a-dsh-bin') },
  })
  const result = missing.runner.runDuty('test')
  assert.equal(result.started, false)
  assert.match(result.error, /找不到 dsh/)

  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4321
  child.exitCode = null
  child.killed = false
  const started = await makeRunner({
    config: { dshBin: process.execPath },
    spawn: () => child,
  })
  const first = started.runner.runDuty('first')
  assert.equal(first.started, true)
  const second = started.runner.runDuty('second')
  assert.equal(second.busy, true)
  assert.match(second.error, /上一轮还没跑完/)
})

test('runDuty lock prevents a second runner instance from starting in the same home', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.killed = false
  const first = await makeRunner({ config: { dshBin: process.execPath }, spawn: () => child })
  const second = await makeRunner({
    stateDir: first.stateDir,
    config: { dshBin: process.execPath },
    spawn: () => { throw new Error('must not spawn') },
  })
  assert.equal(first.runner.runDuty('first').started, true)
  const result = second.runner.runDuty('second')
  assert.equal(result.started, false)
  assert.equal(result.busy, true)
  assert.match(result.error, /另一个宿主/)
  child.emit('exit', 0)
  child.emit('close')
})

