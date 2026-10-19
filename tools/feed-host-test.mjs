/**
 * tools/feed-host-test.mjs —— 「荐片」宿主半端集成测试（不开网络、不起 MCP、不碰真家目录）
 *
 * 跑法：node tools/feed-host-test.mjs   （退出码 0 = 全过）
 * 做法：用假 ctx 真跑 index.js 的 apply()，截下它注册的两个 HTTP 前缀，
 *       然后像浏览器一样打 /api/bili-feed/* 与 /api/bili-duty/config。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

const HOME = mkdtempSync(join(tmpdir(), 'feed-host-'))
process.env.DSH_HOME = HOME

const mod = await import('../index.js')

const routes = []
const cleanups = []
const fakeCtx = {
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(HOME, ...seg) : undefined),
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (t) => t },
  settings: { describe: () => [], update: async () => { throw new Error('no form') } },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanups.push(d); return d },
  webServer: { register: (spec) => { routes.push(spec); return { dispose() {} } } },
}

try {
  mod.apply(fakeCtx, {})
} catch (e) {
  console.error('✗ apply() 抛错：', e)
  process.exit(1)
}

const route = (path) => {
  const spec = routes.find((r) => r.kind === 'prefix' && path.startsWith(r.path))
  if (!spec) throw new Error(`没注册前缀路由：${path}`)
  return spec
}

/** 打一次 HTTP：body 用 JSON 字符串 */
async function request(method, path, body) {
  const spec = route(path)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(payload ? [Buffer.from(payload)] : [])
  req.method = method
  req.url = path
  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {} },
    end(data) { if (data) chunks.push(String(data)) },
  }
  await spec.handler(req, res)
  const text = chunks.join('')
  let json = null
  try { json = JSON.parse(text) } catch { /* 不是 JSON */ }
  return { status: res.statusCode, text, json }
}

let passed = 0
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}\n    ${e?.message ?? e}`); process.exitCode = 1 }
}

console.log('路由注册')
await t('两个前缀都挂上了', () => {
  const paths = routes.map((r) => r.path).sort()
  assert.deepEqual(paths, ['/api/bili-duty', '/api/bili-feed'])
})

console.log('荐片接口')
await t('GET /api/bili-feed/status', async () => {
  const r = await request('GET', '/api/bili-feed/status')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.on, false)
  assert.equal(r.json.running, false)
  assert.equal(r.json.config.feedDepth, 'medium')
  assert.equal(r.json.home, join(HOME, 'bili-duty'))
})
await t('GET /api/bili-feed/batch：还没有批次', async () => {
  const r = await request('GET', '/api/bili-feed/batch')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.batch, null)
  assert.ok(Array.isArray(r.json.feedback))
})
await t('GET /api/bili-feed/profile：没写过时给模板', async () => {
  const r = await request('GET', '/api/bili-feed/profile')
  assert.equal(r.json.ok, true)
  assert.ok(r.json.markdown.includes('核心兴趣'))
})
await t('POST /api/bili-feed/profile：保存并读回', async () => {
  const save = await request('POST', '/api/bili-feed/profile', { markdown: '# 我的画像\n- 爱看 DSH' })
  assert.equal(save.json.ok, true)
  const back = await request('GET', '/api/bili-feed/profile')
  assert.ok(back.json.markdown.includes('爱看 DSH'))
})
await t('POST /api/bili-feed/feedback：参数校验 + 落文件', async () => {
  const bad = await request('POST', '/api/bili-feed/feedback', { bvid: 'x', action: 'like' })
  assert.equal(bad.json.ok, false)
  const ok = await request('POST', '/api/bili-feed/feedback', { bvid: 'BV1xx411c7mD', action: 'dislike', batchId: 'b1' })
  assert.equal(ok.json.ok, true)
  const file = join(HOME, 'bili-duty', 'feed', 'feedback.jsonl')
  assert.ok(existsSync(file))
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.at(-1).action, 'dislike')
})
await t('POST /api/bili-feed/run：没装依赖/没登录时明确拒绝', async () => {
  const r = await request('POST', '/api/bili-feed/run', {})
  assert.equal(r.json.ok, false)
  assert.ok(String(r.json.error).length > 0)
})
await t('POST /api/bili-feed/push-test：没配通道时拒绝', async () => {
  const r = await request('POST', '/api/bili-feed/push-test', {})
  assert.equal(r.json.ok, false)
  assert.ok(String(r.json.error).includes('推送'))
})

console.log('配置（五件套）')
await t('POST /api/bili-duty/config：feed 字段被接收并钳范围', async () => {
  const r = await request('POST', '/api/bili-duty/config', {
    feedOn: true,
    feedTimes: ['25:00', '9:5'],       // 2 个里 1 个非法；'9:5' 应归一成 09:05
    feedPerBatch: 99,                   // → 10
    feedDepth: 'deep',
    feedHistoryDays: 500,               // → 90
    feedAvoid: ['asmr', 'asmr', '  '],
    pushType: 'ntfy',
    pushUrl: 'https://ntfy.sh/t',
  })
  assert.equal(r.json.ok, true)
  const cfg = r.json.config
  assert.equal(cfg.feedOn, true)
  assert.deepEqual(cfg.feedTimes, ['09:05'])
  assert.equal(cfg.feedPerBatch, 10)
  assert.equal(cfg.feedDepth, 'deep')
  assert.equal(cfg.feedHistoryDays, 90)
  assert.deepEqual(cfg.feedAvoid, ['asmr'])
  assert.equal(cfg.pushType, 'ntfy')
  // 落盘一份（插件自己的 config.json）
  const saved = JSON.parse(readFileSync(join(HOME, 'bili-duty', 'config.json'), 'utf8'))
  assert.equal(saved.feedPerBatch, 10)
  assert.equal(saved.feedDepth, 'deep')
})
await t('status 反映新配置', async () => {
  const r = await request('GET', '/api/bili-feed/status')
  assert.equal(r.json.on, true)
  assert.equal(r.json.config.feedPerBatch, 10)
  assert.equal(r.json.pushReady, true)
})

console.log('批次读取')
await t('GET /api/bili-feed/batch：合法批次能读出来（含反馈）', async () => {
  const feedDir = join(HOME, 'bili-duty', 'feed')
  mkdirSync(join(feedDir, 'batches'), { recursive: true })
  const batch = {
    id: '20261020-2100',
    createdAt: '2026-10-20T21:03:12+08:00',
    depth: 'medium',
    items: [{
      bvid: 'BV1xx411c7mD', title: '一条测试视频', author: 'UP', duration: 734,
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      stats: { view: 100, like: 10, reply: 2 }, score: 0.87,
      summary: '讲的是 A。', why: '你最近看完的 3 条都在讲 A。', highlights: ['看点'],
    }],
  }
  writeFileSync(join(feedDir, 'batches', '20261020-2100.json'), JSON.stringify(batch), 'utf8')
  writeFileSync(join(feedDir, 'state.json'), JSON.stringify({ day: '2026-10-20', runs: {}, lastBatchId: '20261020-2100' }), 'utf8')
  const r = await request('GET', '/api/bili-feed/batch')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.batch.id, '20261020-2100')
  assert.equal(r.json.batch.items.length, 1)
  assert.ok(r.json.feedback.length >= 1)   // 前面那条 dislike
})
await t('GET /api/bili-feed/batch：坏批次返回 null 而不是 500', async () => {
  const feedDir = join(HOME, 'bili-duty', 'feed')
  writeFileSync(join(feedDir, 'batches', '20261020-2200.json'), '{"id":"20261020-2200","items":[]}', 'utf8')
  writeFileSync(join(feedDir, 'state.json'), JSON.stringify({ day: '2026-10-20', runs: {}, lastBatchId: '20261020-2200' }), 'utf8')
  const r = await request('GET', '/api/bili-feed/batch')
  assert.equal(r.status, 200)
  assert.equal(r.json.batch, null)
})

console.log('错误路径')
await t('未知路由 404', async () => {
  const r = await request('GET', '/api/bili-feed/nope')
  assert.equal(r.status, 404)
  assert.equal(r.json.ok, false)
})

for (const fn of cleanups.reverse()) {
  try { fn() } catch { /* 收摊 */ }
}
try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 删不掉就留着 */ }
if (!process.exitCode) console.log(`\n✓ 全部通过（${passed} 项）`)
else console.error('\n✗ 有失败项')
