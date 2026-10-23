// 评论配图：宿主侧 bili_reply 工具的闸门与参数透传（离线测试，不联网、不读图库）。
// 跑法：node --test tests/
//
// 思路跟 PR #64 的 tests/comment-stickers.test.mjs 一样：从 index.js 里切出真实的
// `tool({ name: 'bili_reply', ... })` 定义，用假的 tool/call/cfg/refreshCfg 跑它，
// 这样测的是**真代码**，不是复制一份逻辑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

function loadReplyTool() {
  const start = source.indexOf("  tool({\n    name: 'bili_reply',")
  assert.ok(start > 0, 'index.js 里找不到 bili_reply 工具定义')
  const end = source.indexOf("  tool({\n    name: 'bili_status',", start)
  assert.ok(end > start, '找不到 bili_reply 的结束位置')
  const slice = source.slice(start, end)
  const calls = []
  const fakeCall = async (name, args) => { calls.push({ name, args }); return { success: true } }
  const cfg = {
    autoComment: true,
    mentionName: '测试主人',
    dmMode: 'off',
    commentPictures: true,
    commentPictureMax: 1,
  }
  // slice 形如 `  tool({...})` —— 用能记住返回值的假 tool 包一层
  const fakeTool = (def) => def
  const factory = new Function('tool', 'call', 'cfg', 'refreshCfg',
    `return (${slice.replace(/^\s+tool\(/, 'tool(')})`)
  const def = factory(fakeTool, fakeCall, cfg, () => {})
  return { def, calls, cfg }
}

test('打开开关后 pictures 会转成数组透传给 MCP', async () => {
  const { def, calls, cfg } = loadReplyTool()
  cfg.commentPictureMax = 2
  const r = await def.execute({ bvid: 'BV1xx411c7mD', text: 'hi', pictures: 'C:/pics/a.png\nC:/pics/b.jpg' })
  assert.equal(r.success, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args.pictures, ['C:/pics/a.png', 'C:/pics/b.jpg'])
  assert.equal(calls[0].args.rpid, 0)
})

test('meme / memeTag 会透传；与 pictures 合计不超限时放行', async () => {
  const { def, calls, cfg } = loadReplyTool()
  cfg.commentPictureMax = 2
  const r = await def.execute({ bvid: 'BV1xx411c7mD', text: 'hi', meme: '开心', memeTag: 'happy' })
  assert.equal(r.success, true)
  assert.equal(calls[0].args.meme, '开心')
  assert.equal(calls[0].args.meme_tag, 'happy')
})

test('配图开关关着时拒绝（默认行为）', async () => {
  const { def, calls, cfg } = loadReplyTool()
  cfg.commentPictures = false
  const r = await def.execute({ bvid: 'BV1xx411c7mD', text: 'hi', meme: '开心' })
  assert.equal(r.ok, false)
  assert.equal(r.blocked, true)
  assert.match(r.hint, /评论配图/)
  assert.equal(calls.length, 0)
})

test('回复别人的评论（rpid≠0）不允许带图', async () => {
  const { def, calls } = loadReplyTool()
  const r = await def.execute({ bvid: 'BV1xx411c7mD', text: 'hi', rpid: 123, pictures: 'C:/pics/a.png' })
  assert.equal(r.ok, false)
  assert.equal(r.blocked, true)
  assert.match(r.hint, /子评论/)
  assert.equal(calls.length, 0)
})

test('超过「每条评论最多配几张图」时拒绝', async () => {
  const { def, calls } = loadReplyTool()
  const r = await def.execute({ bvid: 'BV1xx411c7mD', text: 'hi', pictures: 'a.png\nb.png' })
  assert.equal(r.ok, false)
  assert.equal(r.blocked, true)
  assert.match(r.hint, /最多带 1 张图/)
  assert.equal(calls.length, 0)
})

test('本人当场 force: true 可以越过配图开关', async () => {
  const { def, calls, cfg } = loadReplyTool()
  cfg.commentPictures = false
  const r = await def.execute({ bvid: 'BV1xx411c7mD', text: 'hi', meme: '摸鱼', force: true })
  assert.equal(r.success, true)
  assert.equal(calls[0].args.meme, '摸鱼')
})
