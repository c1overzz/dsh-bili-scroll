import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as plugin from '../index.js'

test('host composition root registers resources and disposes every long-lived service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bili-duty-host-'))
  const effects = []
  const tools = []
  const routes = []
  const ctx = {
    get(name) {
      if (name === 'dshHomePath') return (...parts) => join(home, ...parts)
      if (name === 'tools') return { register(spec) { tools.push(spec); return { dispose() {} } } }
      if (name === 'webServer') return { register(route) { routes.push(route); return () => routes.pop() } }
      if (name === 'settings') return null
      return null
    },
    logger: { info() {} },
    effect(setup, label) {
      const cleanup = setup()
      effects.push({ label, cleanup })
      return cleanup
    },
  }

  assert.doesNotThrow(() => plugin.apply(ctx, {}))
  assert.equal(tools.length, 13)
  assert.equal(routes.length, 1)
  assert.ok(effects.some((item) => item.label === 'bili-duty: 谷时定时器'))
  assert.ok(effects.some((item) => item.label === 'bili-duty: 私信监听'))
  assert.ok(effects.some((item) => item.label === 'bili-duty: 跑一轮的子进程'))
  assert.ok(effects.some((item) => item.label === 'bili-duty: 收 MCP 子进程'))

  for (const { cleanup } of effects.reverse()) {
    assert.doesNotThrow(() => cleanup?.())
  }
  assert.equal(routes.length, 0)
})
