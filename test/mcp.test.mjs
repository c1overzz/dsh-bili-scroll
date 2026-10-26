import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { McpClient } from '../lib/mcp.mjs'

function fakeProcess(onRequest = () => {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = {
    writable: true,
    write(line) {
      onRequest(JSON.parse(line))
      return true
    },
  }
  child.kill = () => { child.killed = true; return true }
  child.stdout.setEncoding = () => {}
  child.stderr.setEncoding = () => {}
  return child
}

test('MCP stop rejects pending requests and is safe before the child exits', async () => {
  let child
  child = fakeProcess((message) => {
    if (message.id === 1) {
      queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: 1, result: {} }) + '\n'))
    }
  })
  const client = new McpClient({ command: 'python', spawn: () => child })
  await client.start()

  const pending = client.call('slow', {})
  await new Promise((resolve) => setImmediate(resolve))
  client.stop()

  await assert.rejects(pending, /MCP 子进程已停止/)
  assert.equal(client.running, false)
  assert.equal(child.killed, true)
})

test('a stale exit event from the previous child cannot clear a replacement', async () => {
  const children = []
  const spawn = (_command, _args, options) => {
    const child = fakeProcess((message) => {
      if (message.id === 1) {
        queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: 1, result: {} }) + '\n'))
      } else if (message.id) {
        queueMicrotask(() => child.stdout.emit('data', JSON.stringify({
          id: message.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] },
        }) + '\n'))
      }
    })
    children.push(child)
    return child
  }
  const client = new McpClient({ command: 'python', spawn })
  await client.start()
  const old = children[0]
  client.stop()
  await client.start()
  const current = children[1]

  old.emit('exit', 0)
  assert.equal(client.running, true)
  assert.deepEqual(await client.call('ping'), { ok: true })
  assert.equal(Boolean(current.killed), false)
})
