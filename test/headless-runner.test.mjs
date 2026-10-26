import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createHeadlessRunner, decodeChildText } from '../lib/headless-runner.mjs'

const makeChild = () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.killed = false
  return child
}

test('headless runner preserves Electron env, overlay args, and output callbacks', async () => {
  const child = makeChild()
  const calls = []
  const output = []
  const runner = createHeadlessRunner({
    resolveDsh: () => ({ command: 'node', args: ['cli.js'], shell: false }),
    ensureOverlay: () => '/tmp/overlay.yml',
    effectiveProfile: () => 'bili-duty',
    stateDir: '/tmp/bili-duty',
    logFile: '/tmp/bili-duty/duty.log',
    electron: '1',
    uvEnv: (extra) => ({ BASE: 'yes', ...extra }),
    spawn: (command, args, options) => { calls.push({ command, args, options }); return child },
    appendOutput: (_file, text) => output.push(text),
  })
  const result = runner.startPrompt('hello', { sessionId: 's1', trackDuty: true })
  assert.equal(result.started, true)
  assert.deepEqual(calls[0].args, ['cli.js', '--profile', 'bili-duty', '--patch', '/tmp/overlay.yml', '--session-id', 's1', 'hello'])
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1')
  child.stdout.emit('data', 'stdout')
  child.stderr.emit('data', 'stderr')
  assert.deepEqual(output, ['stdout', 'stderr'])
  child.emit('exit', 0)
  child.emit('close')
  assert.equal(runner.activeCount(), 0)
  assert.equal(runner.getChild(), null)
})

test('headless runner calls close cleanup even when shutdown suppresses exit callbacks', () => {
  const child = makeChild()
  let closed = 0
  let exited = 0
  child.kill = () => { child.killed = true }
  const runner = createHeadlessRunner({
    resolveDsh: () => ({ command: 'node', args: [], shell: false }),
    effectiveProfile: () => 'headless',
    stateDir: '/tmp',
    logFile: '/tmp/duty.log',
    spawn: () => child,
  })
  runner.startPrompt('hello', { trackDuty: true, onExit: () => { exited++ }, onClose: () => { closed++ } })
  runner.stopAll()
  child.emit('exit', 0)
  child.emit('close')
  assert.equal(exited, 0)
  assert.equal(closed, 1)
})

test('headless runner contains spawn errors and decodeChildText handles text', () => {
  const logs = []
  const runner = createHeadlessRunner({
    resolveDsh: () => ({ command: 'missing', args: [], shell: false }),
    effectiveProfile: () => 'headless',
    stateDir: '/tmp',
    logFile: '/tmp/duty.log',
    spawn: () => { throw new Error('spawn failed') },
    log: (line) => logs.push(line),
  })
  const result = runner.startPrompt('hello')
  assert.equal(result.started, false)
  assert.match(result.error, /spawn failed/)
  assert.equal(decodeChildText(Buffer.from('hello')), 'hello')
  assert.match(logs.join('\n'), /开跑失败/)
})

test('headless runner reports asynchronous child errors to its owner', () => {
  const child = makeChild()
  let reported = null
  const runner = createHeadlessRunner({
    resolveDsh: () => ({ command: 'node', args: [], shell: false }),
    effectiveProfile: () => 'headless',
    stateDir: '/tmp',
    logFile: '/tmp/duty.log',
    spawn: () => child,
  })
  runner.startPrompt('hello', { onError: (event) => { reported = event } })
  child.emit('error', new Error('spawn failed'))
  child.emit('exit', 1)
  assert.equal(reported.error.message, 'spawn failed')
  assert.equal(reported.why, 'prompt')
})

test('headless runner owns stopping the tracked duty child', () => {
  const child = makeChild()
  let killed = 0
  child.kill = () => { killed++; child.killed = true }
  const runner = createHeadlessRunner({
    resolveDsh: () => ({ command: 'node', args: [], shell: false }),
    effectiveProfile: () => 'headless',
    stateDir: '/tmp',
    logFile: '/tmp/duty.log',
    spawn: () => child,
  })
  runner.startPrompt('hello', { trackDuty: true })
  assert.equal(runner.stopDuty('closing'), true)
  assert.equal(killed, 1)
  assert.equal(runner.getChild(), null)
  assert.equal(runner.stopDuty(), false)
})

test('headless runner stops untracked replies and fences their late exit callback', () => {
  const child = makeChild()
  let killed = 0
  let exits = 0
  child.kill = () => { killed++; child.killed = true }
  const runner = createHeadlessRunner({
    resolveDsh: () => ({ command: 'node', args: [], shell: false }),
    effectiveProfile: () => 'headless',
    stateDir: '/tmp',
    logFile: '/tmp/duty.log',
    spawn: () => child,
  })
  runner.startPrompt('reply', { onExit: () => { exits++ } })
  assert.equal(runner.activeCount(), 1)
  assert.equal(runner.stopAll('closing'), true)
  assert.equal(killed, 1)
  child.emit('exit', 0)
  child.emit('close')
  assert.equal(exits, 0)
  assert.equal(runner.activeCount(), 0)
  assert.equal(runner.stopAll(), false)
})
