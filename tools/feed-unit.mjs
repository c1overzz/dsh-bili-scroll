/**
 * tools/feed-unit.mjs —— 「荐片」纯函数单测（不碰网络、不碰真家目录）
 *
 * 跑法：node tools/feed-unit.mjs   （退出码 0 = 全过）
 * 覆盖：时间解析 / batchId / 历史归一化 / 信号 / 摘要 / batch 校验 / 提示词 / 状态标记 /
 *       推送文案与四种通道的请求形状 / URL 脱敏
 */
import assert from 'node:assert/strict'
import {
  parseFeedTimes, batchIdOf, normalizeHistoryItem, computeSignals, renderHistoryBrief,
  validateBatch, buildFeedPrompt, markFeedRan, defaultProfile, fmtDuration, videoUrl,
  feedPaths, readJsonl, appendJsonl,
} from '../lib/feed.mjs'
import {
  buildPushMessage, buildPushRequest, isPushConfigured, maskUrl, testBatch,
} from '../lib/push.mjs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let passed = 0
const t = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}\n    ${e?.message ?? e}`); process.exitCode = 1 }
}

console.log('feed.mjs')
t('parseFeedTimes：数组去重升序', () => {
  assert.deepEqual(parseFeedTimes(['21:00', '9:05', '21:00']), ['09:05', '21:00'])
})
t('parseFeedTimes：字符串逗号分隔', () => {
  assert.deepEqual(parseFeedTimes('08:00, 20:30'), ['08:00', '20:30'])
})
t('parseFeedTimes：全非法时退回默认', () => {
  assert.deepEqual(parseFeedTimes(['25:00', 'x', '']), ['21:00'])
})
t('parseFeedTimes：最多 3 个', () => {
  assert.equal(parseFeedTimes(['01:00', '02:00', '03:00', '04:00']).length, 3)
})
t('batchIdOf：格式 YYYYMMDD-HHmm', () => {
  assert.match(batchIdOf(new Date(2026, 9, 20, 21, 3)), /^20261020-2103$/)
})
t('fmtDuration / videoUrl', () => {
  assert.equal(fmtDuration(734), '12:14')
  assert.equal(fmtDuration(3723), '1:02:03')
  assert.equal(videoUrl('BV1xx411c7mD'), 'https://www.bilibili.com/video/BV1xx411c7mD')
})
t('normalizeHistoryItem：完播率', () => {
  const it = normalizeHistoryItem({ bvid: 'BV1xx411c7mD', duration: 600, progress: 300, view_at: 100 })
  assert.equal(it.completion, 0.5)
  assert.equal(it.viewAt, 100)
})
t('normalizeHistoryItem：progress=-1 → 完播 0', () => {
  const it = normalizeHistoryItem({ bvid: 'BV1xx411c7mD', duration: 600, progress: -1 })
  assert.equal(it.completion, 0)
})
t('normalizeHistoryItem：坏 bvid 返回 null', () => {
  assert.equal(normalizeHistoryItem({ bvid: 'xx', duration: 1 }), null)
})
t('computeSignals：统计与榜单', () => {
  const now = new Date()
  const sec = Math.floor(now.getTime() / 1000)
  const items = [
    normalizeHistoryItem({ bvid: 'BV1aaaaaaaaa', author: 'A', duration: 600, progress: 600, view_at: sec - 3600 }),
    normalizeHistoryItem({ bvid: 'BV1bbbbbbbbb', author: 'A', duration: 600, progress: 60, view_at: sec - 7200 }),
    normalizeHistoryItem({ bvid: 'BV1ccccccccc', author: 'B', duration: 300, progress: 30, view_at: sec - 80000 }),
  ]
  const s = computeSignals(items, now)
  assert.equal(s.counts.total, 3)
  assert.equal(s.counts.last7d, 3)
  assert.equal(s.topCompleted.length, 1)
  assert.equal(s.topCompleted[0].bvid, 'BV1aaaaaaaaa')
  assert.equal(s.lowestCompleted.length, 2)
  assert.equal(s.byAuthor.find((a) => a.author === 'A').count, 2)
})
t('renderHistoryBrief：包含关键小节', () => {
  const items = [normalizeHistoryItem({ bvid: 'BV1aaaaaaaaa', title: 'T', author: 'A', duration: 60, progress: 60, view_at: 1 })]
  const brief = renderHistoryBrief({ days: 30, count: 1, items }, computeSignals(items), new Date(2026, 9, 20))
  for (const s of ['浏览摘要', '完播率最高的', '最近 20 条', '完播率最低的', '按 UP 主统计', '最近 7 天 vs 30 天']) assert.ok(brief.includes(s), s)
  assert.ok(brief.includes('https://www.bilibili.com/video/BV1aaaaaaaaa'))
})
t('markFeedRan：新的一天不继承旧时间', () => {
  let st = markFeedRan({ day: '2026-10-19', runs: { '2026-10-19': ['21:00'] } }, '2026-10-20', '21:00')
  assert.deepEqual(st.runs['2026-10-20'], ['21:00'])
  assert.equal(st.day, '2026-10-20')
})
t('defaultProfile：固定小节', () => {
  for (const s of ['核心兴趣', '最近在关注', '喜欢的 UP 主', '明确不想看', '证据与观察', '更新日志']) {
    assert.ok(defaultProfile().includes(s), s)
  }
})

console.log('batch 校验')
const goodBatch = {
  id: '20261020-2100',
  createdAt: '2026-10-20T21:03:12+08:00',
  depth: 'medium',
  items: [{
    bvid: 'BV1xx411c7mD', title: '一条测试视频', author: 'UP', duration: 734,
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    stats: { view: 100, like: 10, reply: 2 }, score: 0.87,
    summary: '这讲讲的是 A 和 B。', why: '你最近看完的 3 条都在讲 A。', highlights: ['看点一'],
  }],
}
t('validateBatch：合法通过并归一化', () => {
  const v = validateBatch(goodBatch, { batchId: '20261020-2100' })
  assert.equal(v.ok, true, v.error)
  assert.equal(v.batch.items.length, 1)
  assert.equal(v.batch.items[0].score, 0.87)
})
t('validateBatch：id 不符', () => {
  assert.equal(validateBatch(goodBatch, { batchId: '20261020-2200' }).ok, false)
})
t('validateBatch：bvid 重复', () => {
  const b = { ...goodBatch, items: [goodBatch.items[0], { ...goodBatch.items[0] }] }
  assert.equal(validateBatch(b, { batchId: b.id }).ok, false)
})
t('validateBatch：url 不指向 B站', () => {
  const b = { ...goodBatch, items: [{ ...goodBatch.items[0], url: 'https://example.com/x' }] }
  assert.equal(validateBatch(b, { batchId: b.id }).ok, false)
})
t('validateBatch：summary/why 为空', () => {
  const b = { ...goodBatch, items: [{ ...goodBatch.items[0], why: '' }] }
  assert.equal(validateBatch(b, { batchId: b.id }).ok, false)
})
t('validateBatch：0 条 / 超上限', () => {
  assert.equal(validateBatch({ ...goodBatch, items: [] }, { batchId: goodBatch.id }).ok, false)
  const many = Array.from({ length: 11 }, (_, i) => ({ ...goodBatch.items[0], bvid: 'BV1' + String(i).padStart(9, '0') }))
  assert.equal(validateBatch({ ...goodBatch, items: many }, { batchId: goodBatch.id }).ok, false)
})

console.log('提示词')
t('buildFeedPrompt：路径/参数/工具齐全', () => {
  const state = 'C:/home/bili-duty'
  const prompt = buildFeedPrompt({
    ownerDoc: '人设', stateDir: state, charter: state + '/feed.md',
    batchId: '20261020-2100',
    batchFile: state + '/feed/batches/20261020-2100.json',
    perBatch: 4, depth: 'medium', historyDays: 30, avoid: ['asmr'], profileNote: '在看 DSH',
    tools: ['bili_history', 'bili_rcmd_feed'],
  })
  for (const s of ['20261020-2100', 'batchId', '兴趣画像', '历史摘要', 'bili_history', 'asmr', '在看 DSH', '不公开发言']) {
    assert.ok(prompt.includes(s), s)
  }
})

console.log('推送')
t('isPushConfigured', () => {
  assert.equal(isPushConfigured({ pushType: 'off', pushUrl: 'https://x' }), false)
  assert.equal(isPushConfigured({ pushType: 'ntfy', pushUrl: '' }), false)
  assert.equal(isPushConfigured({ pushType: 'ntfy', pushUrl: 'https://ntfy.sh/t' }), true)
})
t('maskUrl 不泄露 key', () => {
  assert.ok(!maskUrl('https://sctapi.ftqq.com/SCT123.send').includes('SCT123'))
})
t('buildPushMessage：标题与链接', () => {
  const m = buildPushMessage(testBatch(new Date(2026, 9, 20, 21, 0)))
  assert.ok(m.title.includes('1 条'), m.title)
  assert.ok(m.markdown.includes('测试'))
})
t('buildPushRequest：serverchan 表单', () => {
  const { init } = buildPushRequest({ pushType: 'serverchan', pushUrl: 'https://sctapi.ftqq.com/K.send' }, testBatch())
  assert.equal(init.method, 'POST')
  assert.ok(String(init.body).includes('title='))
  assert.ok(String(init.body).includes('desp='))
})
t('buildPushRequest：ntfy 纯文本 + ASCII header', () => {
  const { init } = buildPushRequest({ pushType: 'ntfy', pushUrl: 'https://ntfy.sh/t' }, testBatch())
  assert.ok(init.headers.Title)
  assert.ok(/^[\x20-\x7E]+$/.test(init.headers.Title))
  assert.ok(String(init.body).includes('大肥鱼荐片'))
})
t('buildPushRequest：wecom JSON markdown', () => {
  const { init } = buildPushRequest({ pushType: 'wecom', pushUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' }, testBatch())
  const body = JSON.parse(init.body)
  assert.equal(body.msgtype, 'markdown')
  assert.ok(body.markdown.content.length > 10)
})
t('buildPushRequest：webhook JSON items', () => {
  const { init } = buildPushRequest({ pushType: 'webhook', pushUrl: 'https://example.com/hook' }, testBatch())
  const body = JSON.parse(init.body)
  assert.equal(body.items.length, 1)
  assert.ok(body.content.includes('大肥鱼'))
})
t('buildPushRequest：坏 URL 抛错', () => {
  assert.throws(() => buildPushRequest({ pushType: 'webhook', pushUrl: 'nope' }, testBatch()))
})

console.log('JSONL 读写')
t('appendJsonl / readJsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-unit-'))
  try {
    const f = join(dir, 'x.jsonl')
    appendJsonl(f, { a: 1 }); appendJsonl(f, { a: 2 }); writeFileSync(f, 'not json\n', { flag: 'a' })
    const rows = readJsonl(f)
    assert.equal(rows.length, 2)
    assert.equal(readJsonl(f, 1)[0].a, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

if (!process.exitCode) console.log(`\n✓ 全部通过（${passed} 项）`)
else console.error('\n✗ 有失败项')
