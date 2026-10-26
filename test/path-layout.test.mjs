import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { createPathLayout } from '../lib/path-layout.mjs'

test('path layout keeps every runtime artifact under the plugin home', () => {
  const home = '/tmp/bili-duty'
  const layout = createPathLayout(home)
  for (const [name, value] of Object.entries(layout)) {
    if (name === 'root' || typeof value === 'function') continue
    assert.equal(value === home || value.startsWith(home + '/'), true, `${name} escaped home: ${value}`)
  }
  assert.equal(layout.configFile, join(home, 'config.json'))
  assert.equal(layout.mcpServerFile, join(home, 'mcp_server.py'))
  assert.equal(layout.commentsFile, join(home, 'comments.md'))
  assert.equal(layout.runLockFile, join(home, 'run-lock.json'))
  assert.equal(layout.outDir, join(home, 'out'))
  assert.equal(layout.reportFile('2026-10-24'), join(home, 'out', '2026-10-24.md'))
  assert.equal(Object.isFrozen(layout), true)
})

test('path layout allows an explicit report directory without moving state files', () => {
  const layout = createPathLayout('/tmp/bili-duty', { outDir: '/tmp/reports' })
  assert.equal(layout.outDir, '/tmp/reports')
  assert.equal(layout.stateFile, '/tmp/bili-duty/state.json')
})
