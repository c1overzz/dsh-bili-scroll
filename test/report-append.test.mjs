/**
 * test/report-append.test.mjs —— 日报不能被后续写入吃掉（上游 issue #172）。
 *
 * 2.4.0 引入的真 bug：`writeRoundNotesToReport` 找到 `## 投递` 就把**后面全部截掉**，
 * 然后只重写投递那一段。而 `duty_report_append` 是纯追加 ⇒ 多轮跑时：
 *
 *   第 1 轮：  正文A / ## 投递 / 说明
 *   第 2 轮：  正文B 追加到末尾  ⇒ 正文A / ## 投递 / 说明 / 正文B
 *   第 2 轮收尾：截断 ⇒ **正文B 没了**
 *
 * 用户实测：194 行的日报掉到 91 行（#172）。
 * 而分时随机刷会让一天跑更多轮 ⇒ 这个 bug 会被放大，所以必须修。
 *
 * 这里不重写一份实现 —— 直接从宿主 index.js 里把那个函数抽出来求值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = readFileSync(resolve(HERE, '..', 'index.js'), 'utf8')

/** 把 writeRoundNotesToReport 原样抽出来，包成可调用的函数 */
function loadWriter() {
  const lines = INDEX.split('\n')
  const start = lines.findIndex((l) => l.includes('const writeRoundNotesToReport ='))
  assert.ok(start >= 0, '没找到 writeRoundNotesToReport')
  let depth = 0
  const body = []
  for (let i = start; i < lines.length; i++) {
    body.push(lines[i])
    depth += (lines[i].match(/\{/g) || []).length
    depth -= (lines[i].match(/\}/g) || []).length
    if (i > start && depth <= 0) break
  }
  const src = body.join('\n').replace(/^\s*const writeRoundNotesToReport = /, 'return ')
  return (roundNotes, cfg, files, f) => {
    const fs = {
      existsSync: (x) => files.has(x),
      readFileSync: (x) => files.get(x) ?? '',
      writeFileSync: (x, c) => files.set(x, c),
      join: (...a) => a.join('/'),
    }
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'existsSync', 'readFileSync', 'writeFileSync', 'join',
      'roundNotes', 'cfg', 'outDir', 'dayKey',
      'const _f = (() => {' + src + '})(); return _f()',
    )
    return factory(fs.existsSync, fs.readFileSync, fs.writeFileSync, fs.join, roundNotes, cfg, '/out', () => '2026-11-02')
  }
}

const writer = loadWriter()
const F = '/out/2026-11-02.md'
const CFG = { reportLevel: 'full' }

/** 造一份报告并跑一次收尾，返回跑完的内容 */
function runWith(initial, notes) {
  const files = new Map([[F, initial]])
  writer(notes, CFG, files, F)
  return files.get(F)
}

test('第 2 轮正文追加在投递段之后 ⇒ 不能被删（#172 的主场景）', () => {
  const before = [
    '# 刷B站 · 2026-11-02',
    '',
    '### BV1aaaaaaaa',
    '第一轮正文。',
    '',
    '## 投递',
    '',
    '- 投递：只私信',
    '',
    '### BV1bbbbbbbb',
    '第二轮正文。',
    '',
  ].join('\n')
  const after = runWith(before, ['投递：只私信', '投递：并评论'])
  assert.ok(after.includes('BV1aaaaaaaa'), '第一轮正文被删了')
  assert.ok(after.includes('BV1bbbbbbbb'), '第二轮正文被删了 ← 这就是 #172')
  assert.ok(after.includes('第二轮正文'), '第二轮正文的文字没了')
})

test('投递段本身要更新成最新的（旧的说明被顶掉，不是越堆越多）', () => {
  const before = [
    '# 刷B站 · 2026-11-02',
    '',
    '## 投递',
    '',
    '- 旧的投递说明',
    '',
  ].join('\n')
  const after = runWith(before, ['投递：只私信'])
  assert.ok(after.includes('投递：只私信'), '新的投递说明没写进去')
  assert.equal(after.includes('旧的投递说明'), false, '旧的投递说明应该被顶掉')
  // 只能有一个投递标题（不能每次收尾都叠一个）
  const n = (after.match(/## 投递/g) || []).length
  assert.equal(n, 1, '投递标题出现了 ' + n + ' 次，应该只有 1 次')
})

test('正文在投递段之前 ⇒ 一个字都不能动', () => {
  const before = [
    '# 刷B站 · 2026-11-02',
    '',
    '### BV1cccccccc',
    '正文在前面。',
    '',
    '## 投递',
    '',
    '- 投递：只私信',
    '',
  ].join('\n')
  const after = runWith(before, ['投递：只私信'])
  assert.ok(after.includes('BV1cccccccc'), '投递段之前的正文被动了')
  assert.ok(after.includes('正文在前面。'))
})

test('两轮都在投递段后面追加 ⇒ 两轮都要留住', () => {
  const before = [
    '# 刷B站 · 2026-11-02',
    '',
    '## 投递',
    '',
    '- 第一轮投递',
    '',
    '### BV1bbbbbbbb',
    '第二轮正文。',
    '',
    '### BV1cccccccc',
    '第三轮正文。',
    '',
  ].join('\n')
  const after = runWith(before, ['投递：并评论'])
  assert.ok(after.includes('BV1bbbbbbbb'), '第二轮正文被删')
  assert.ok(after.includes('BV1cccccccc'), '第三轮正文被删')
})

test('还没有投递段 ⇒ 追加到末尾，正文不动', () => {
  const before = [
    '# 刷B站 · 2026-11-02',
    '',
    '### BV1dddddddd',
    '这一轮还没写过投递段。',
    '',
  ].join('\n')
  const after = runWith(before, ['投递：只私信'])
  assert.ok(after.includes('BV1dddddddd'), '正文被删了')
  assert.ok(after.includes('## 投递'), '投递段没加上')
  assert.ok(after.indexOf('BV1dddddddd') < after.indexOf('## 投递'), '投递段应该在正文之后')
})

test('文件不存在 ⇒ 新建，带标题', () => {
  const files = new Map()
  writer(['投递：只私信'], CFG, files, F)
  const t = files.get(F) || ''
  assert.ok(t.includes('# 刷B站'), '新建的文件没有标题')
  assert.ok(t.includes('## 投递'))
})

test('reportLevel=off ⇒ 什么都不写', () => {
  const files = new Map([[F, '# 原样\n']])
  writer(['投递：只私信'], { reportLevel: 'off' }, files, F)
  assert.equal(files.get(F), '# 原样\n', 'reportLevel=off 时不该动文件')
})

test('没有投递记录 ⇒ 什么都不写', () => {
  const files = new Map([[F, '# 原样\n']])
  writer([], CFG, files, F)
  assert.equal(files.get(F), '# 原样\n', '没有 notes 时不该动文件')
})

test('投递段后面紧跟另一个二级标题 ⇒ 那个标题下的内容要保住', () => {
  const before = [
    '# 刷B站 · 2026-11-02',
    '',
    '### BV1eeeeeeee',
    '正文。',
    '',
    '## 投递',
    '',
    '- 投递：只私信',
    '',
    '## 评论复核',
    '',
    '复核结论：1 条可见。',
    '',
  ].join('\n')
  const after = runWith(before, ['投递：只私信'])
  assert.ok(after.includes('BV1eeeeeeee'), '正文被删')
  assert.ok(after.includes('## 评论复核'), '「评论复核」那一节被删了')
  assert.ok(after.includes('复核结论：1 条可见。'), '复核内容被删了')
})
