import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
function wrapper() {
  const start = source.indexOf("  tool({\n    name: 'bili_stickers'")
  const end = source.indexOf('\n  tool({', source.indexOf("name: 'bili_reply'", start))
  assert(start > 0 && end > start)
  const registered = {}, calls = []
  const cfg = { autoComment: true, mentionName: '测试', dmMode: 'off' }
  new Function('tool', 'call', 'cfg', source.slice(start, end))(
    t => { registered[t.name] = t },
    async (name, args) => { calls.push({ name, args }); return { ok: true } }, cfg)
  return { registered, calls, cfg }
}

test('catalog query is read-only and clamps result count', async () => {
  const { registered, calls } = wrapper()
  await registered.bili_stickers.execute({ emotion: '感谢', query: '比心', limit: 99 })
  assert.deepEqual(calls, [{ name: 'bili_stickers', args: { emotion: '感谢', query: '比心', limit: 30 } }])
})

test('real wrapper forwards sticker, original text and nested root', async () => {
  const { registered, calls } = wrapper()
  assert(registered.bili_reply.parameters.sticker)
  assert(registered.bili_reply.parameters.root)
  await registered.bili_reply.execute({ bvid: 'BVoffline', text: '@测试 原文', rpid: 71, root: 70, sticker: '感谢_比心.png' })
  assert.deepEqual(calls, [{ name: 'bili_reply', args: { bvid: 'BVoffline', text: '@测试 原文', rpid: 71, root: 70, sticker: '感谢_比心.png' } }])
})

test('original comment switch and DM-only gate still block sending', async () => {
  const { registered, calls, cfg } = wrapper()
  cfg.autoComment = false
  assert((await registered.bili_reply.execute({ text: 'blocked' })).blocked)
  cfg.autoComment = true; cfg.dmMode = 'only'
  assert((await registered.bili_reply.execute({ text: 'blocked' })).blocked)
  assert.equal(calls.length, 0)
})

test('headless whitelist exposes catalog without enabling comment writes', () => {
  const start = source.indexOf('  const mcpWhitelist = () => {')
  const end = source.indexOf('\n  const ensureOverlay', start)
  assert(start > 0 && end > start)
  const whitelist = new Function('cfg', source.slice(start, end) + '\nreturn mcpWhitelist()')
  const list = whitelist({ autoComment: false, replyToComments: false, dmMode: 'off' })
  assert(list.includes('bili_stickers')); assert(!list.includes('bili_reply'))
  assert(whitelist({ autoComment: true, dmMode: 'off' }).includes('bili_reply'))
})
