/**
 * tools/feed-e2e-test.mjs —— 「荐片」一轮的端到端测试（不碰真 B站、不碰真家目录、不起真 dsh）
 *
 * 跑法：node tools/feed-e2e-test.mjs   （退出码 0 = 全过）
 *
 * 做法：
 *   ① 拿假 ctx 真跑 index.js 的 apply()，截下 HTTP 路由；
 *   ② 在临时家目录里摆一套"看起来像真的"环境：假 venv（三个包目录）、凭证文件；
 *   ③ 把 mcp_server.py 换成一个 stdio MCP 桩（只回 bili_history 的假历史）；
 *   ④ 把 dshBin 指向一个假 dsh（node 脚本：读提示词里的 batch 路径，写一份合法 batch）；
 *   ⑤ 起一个本地 webhook 收推送；
 *   ⑥ 打 POST /api/bili-feed/run → 轮询 status → 断言：batch 入库 / recommended 追加 / 历史落盘 / 推送到达 / lastError 为空。
 *
 * 这条测试覆盖的是真正容易断的编排：拿历史 → 拼提示词 → 起子进程 → 收产出 → 校验 → 入库 → 推送。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import http from 'node:http'

const HOME = mkdtempSync(join(tmpdir(), 'feed-e2e-'))
process.env.DSH_HOME = HOME
const STATE = join(HOME, 'bili-duty')

/* ───────────── 1. 假 ctx，真跑 apply ───────────── */
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
try { mod.apply(fakeCtx, {}) } catch (e) { console.error('✗ apply() 抛错：', e); process.exit(1) }

const route = (path) => {
  const spec = routes.find((r) => r.kind === 'prefix' && path.startsWith(r.path))
  if (!spec) throw new Error(`没注册前缀路由：${path}`)
  return spec
}
async function request(method, path, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(payload ? [Buffer.from(payload)] : [])
  req.method = method
  req.url = path
  const chunks = []
  const res = {
    statusCode: 0,
    writeHead(code) { this.statusCode = code },
    end(data) { if (data) chunks.push(String(data)) },
  }
  await route(path).handler(req, res)
  const text = chunks.join('')
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.statusCode, text, json }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}\n    ${e?.message ?? e}`); process.exitCode = 1 }
}

/* ───────────── 2. 摆环境 ───────────── */
// 假 venv：判据是 "python.exe 存在 + site-packages 里有三个包目录"
mkdirSync(join(STATE, '.venv', 'Scripts'), { recursive: true })
writeFileSync(join(STATE, '.venv', 'Scripts', 'python.exe'), '')
for (const p of ['bilibili_api', 'mcp', 'qrcode']) mkdirSync(join(STATE, '.venv', 'Lib', 'site-packages', p), { recursive: true })
// 假凭证：hasCredential() 只看文件在不在
writeFileSync(join(STATE, 'bili_credential.json'), JSON.stringify({ sessdata: 'test', bili_jct: 'test', buvid3: '', dedeuserid: '1' }), 'utf8')

// MCP 桩：只实现 initialize + tools/call(bili_history)
const mcpStub = String.raw`import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "serverInfo": {"name": "e2e-stub", "version": "0"}}}), flush=True)
    elif method == "tools/call":
        name = (msg.get("params") or {}).get("name")
        if name == "bili_history":
            payload = {"fetched_at": 1760000000, "days": 30, "count": 2, "items": [
                {"bvid": "BV1xx411c7mD", "title": "E2E 历史 A", "author": "UP-A",
                 "cover": "", "duration": 600, "progress": 590, "view_at": 1759990000},
                {"bvid": "BV1yy411c7mE", "title": "E2E 历史 B", "author": "UP-B",
                 "cover": "", "duration": 300, "progress": 20, "view_at": 1759980000}]}
        else:
            payload = {"count": 0, "items": []}
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}}), flush=True)
`
// apply() 已经铺过一遍 mcp_server.py；这里覆盖成桩
writeFileSync(join(STATE, 'mcp_server.py'), mcpStub, 'utf8')

// 假 dsh：从提示词最后一段里抠出「本批输出文件」的路径（模拟真 Agent 读提示词），覆写成一份合法 batch
const fakeDsh = join(HOME, 'fake-dsh.js')
writeFileSync(fakeDsh, String.raw`const fs = require('fs'); const path = require('path')
const prompt = process.argv[process.argv.length - 1] || ''
const line = prompt.split('\n').find((l) => l.includes('本批输出文件')) || ''
const file = line.split('：').slice(1).join('：').trim()
if (!file || !fs.existsSync(path.dirname(file))) process.exit(2)
const id = path.basename(file, '.json')
const batch = { id, createdAt: new Date().toISOString(), depth: 'medium', profileUpdated: true,
  meta: { recall: 12, shortlist: 4, deepRead: 2, toolCalls: 9, notes: 'e2e' },
  items: [{ bvid: 'BV1xx411c7mD', title: 'E2E 推荐视频', author: 'UP-A', cover: '', duration: 600,
    pubdate: 0, url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    stats: { view: 100, like: 5, reply: 1 }, score: 0.8,
    summary: '这是一条端到端测试的摘要。', why: '你最近把 E2E 历史 A 看到了 98%。',
    highlights: ['看点一'] }] }
fs.writeFileSync(file, JSON.stringify(batch))
process.exit(0)
`, 'utf8')

// 本地 webhook：收推送
const received = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => { received.push(body); res.writeHead(200); res.end('ok') })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

/* ───────────── 3. 跑一轮 ───────────── */
console.log('端到端：一轮荐片')
await t('配置 → run → 轮询 → 批次 / 历史 / 推送 全部就位', async () => {
  const cfg = await request('POST', '/api/bili-duty/config', {
    dshBin: fakeDsh,
    pythonPath: 'python',
    pushType: 'webhook',
    pushUrl: `http://127.0.0.1:${port}/hook`,
    feedPerBatch: 2,
    feedDepth: 'light',
  })
  assert.equal(cfg.json.ok, true)
  // 触发
  const run = await request('POST', '/api/bili-feed/run', {})
  assert.equal(run.json.ok, true, JSON.stringify(run.json))
  // 轮询（runFeed 是后台跑的）
  let st = null
  for (let i = 0; i < 150; i += 1) {
    await sleep(100)
    const r = await request('GET', '/api/bili-feed/status')
    st = r.json
    if (st.lastBatchId || st.lastError) break
  }
  assert.ok(st.lastBatchId, `没跑出批次；lastError=${st.lastError}`)
  assert.equal(st.lastError, '')
  // 历史落盘（2 条，来自 MCP 桩）
  const hist = JSON.parse(readFileSync(join(STATE, 'feed', 'history.json'), 'utf8'))
  assert.equal(hist.count, 2)
  assert.ok(hist.items[0].completion >= 0.9)   // 590/600 ≈ 0.983
  // 摘要与信号也生成了
  assert.ok(readFileSync(join(STATE, 'feed', 'history-brief.md'), 'utf8').includes('完播率最高的'))
  assert.ok(existsSync(join(STATE, 'feed', 'signals.json')))
  // 批次能被 /batch 读出来
  const b = await request('GET', '/api/bili-feed/batch')
  assert.equal(b.json.batch.id, st.lastBatchId)
  assert.equal(b.json.batch.items.length, 1)
  // recommended.jsonl 追加了 1 行
  const rec = readFileSync(join(STATE, 'feed', 'recommended.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(rec.length, 1)
  assert.equal(JSON.parse(rec[0]).bvid, 'BV1xx411c7mD')
  // 推送到达（webhook）—— finalize 里是先落 state 再 await 推送，所以这里要再等一小会
  for (let i = 0; i < 50 && !received.length; i += 1) await sleep(100)
  assert.ok(received.length >= 1, '没收到推送')
  const payload = JSON.parse(received[0])
  assert.ok(String(payload.title).includes('荐片'), payload.title)
  assert.equal(payload.items.length, 1)
  assert.equal(payload.items[0].bvid, 'BV1xx411c7mD')
  // 等这一轮彻底收尾（feedRunning=false），避免下一轮被"上一轮还没跑完"挡掉
  for (let i = 0; i < 50; i += 1) {
    const r = await request('GET', '/api/bili-feed/status')
    if (!r.json.running) break
    await sleep(100)
  }
})
await t('第二轮：宿主不覆盖 recommended（只追加）', async () => {
  const count = () => readFileSync(join(STATE, 'feed', 'recommended.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length
  // 等上一轮收尾
  for (let i = 0; i < 50; i += 1) {
    const r = await request('GET', '/api/bili-feed/status')
    if (!r.json.running) break
    await sleep(100)
  }
  const before = count()
  const run = await request('POST', '/api/bili-feed/run', {})
  assert.equal(run.json.ok, true)
  let after = before
  let lastErr = ''
  for (let i = 0; i < 150; i += 1) {
    await sleep(100)
    const r = await request('GET', '/api/bili-feed/status')
    lastErr = r.json.lastError || ''
    if (lastErr) break
    after = count()
    if (after > before) break
  }
  assert.ok(!lastErr, `第二轮报错：${lastErr}`)
  assert.ok(after > before, `recommended 没有追加（before=${before} after=${after}）`)
})

/* ───────────── 4. 收摊 ───────────── */
await new Promise((resolve) => server.close(resolve))
for (const fn of cleanups.reverse()) { try { fn() } catch { /* 收摊 */ } }
try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 删不掉就留着 */ }
if (!process.exitCode) console.log(`\n✓ 全部通过（${passed} 项）`)
else console.error('\n✗ 有失败项')
