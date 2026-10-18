import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { Service } = await import(process.env.DSH_HOST_MODULES
  ? pathToFileURL(join(process.env.DSH_HOST_MODULES, 'cordis', 'lib', 'index.js')).href
  : '@deepseek-ai/cordis')

export const inject = ['settings', 'configEditor']
const desired = { keywords: ['native-test'], workspace: 'native-workspace', dmMode: 'only', dmUid: 42, perDay: 7 }
const check = config => {
  for (const [key, value] of Object.entries(desired)) assert.deepEqual(config[key], value, key)
}

export function apply(ctx) {
  class FixtureServer extends Service {
    constructor() { super(ctx, 'webServer') }
    register(route) {
      // Wait for the loader to mark the plugin active, so settings writes
      // exercise the real form rather than silently falling back to config.json.
      setTimeout(async () => {
        try {
          assert.ok(ctx.settings.describe().some(row => row.ns === 'bili-scroll'))
          const request = async (method, body) => {
            const req = Object.assign(new EventEmitter(), { method, url: '/api/bili-duty/config' })
            let result
            const pending = route.handler(req, {
              writeHead: code => assert.equal(code, 200),
              end: text => { result = JSON.parse(text) },
            })
            if (method === 'POST') { req.emit('data', JSON.stringify(body)); req.emit('end') }
            await pending
            if (method === 'POST') assert.equal(result.host?.ok, true, JSON.stringify(result.host))
            return result.config
          }
          if (process.env.DSH_NATIVE_PHASE === 'reload') {
            check(await request('GET'))
            const row = ctx.settings.describe().find(row => row.ns === 'bili-scroll')
            await ctx.settings.update(row.ns, { keywords: ['native-page-edit'] }, row.revision)
            await new Promise(resolve => setTimeout(resolve, 3100))
            assert.deepEqual((await request('GET')).keywords, ['native-page-edit'])
          } else {
            await request('GET')
            await request('POST', { ...desired, perDay: 3 })
            assert.deepEqual((await request('GET')).keywords, desired.keywords)
            await request('POST', { perDay: 7 })
            await new Promise(resolve => setTimeout(resolve, 3100))
            check(await request('GET'))
            check(JSON.parse(readFileSync(join(process.env.DSH_HOME, 'bili-duty', 'config.json'), 'utf8')))
          }
          console.log('Native settings ' + (process.env.DSH_NATIVE_PHASE || 'save') + ': PASS')
          process.exit(0)
        } catch (error) {
          console.error(error)
          process.exit(1)
        }
      }, 100)
      return { dispose() {} }
    }
  }
  new FixtureServer()
}
