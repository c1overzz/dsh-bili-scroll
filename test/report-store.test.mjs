import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createReportStore,
  extractPickedBvids,
  parseSeenText,
} from '../lib/report-store.mjs'

const today = new Date('2026-10-24T12:00:00Z')
const dayKey = () => '2026-10-24'

async function makeStore() {
  const stateDir = await mkdtemp(join(tmpdir(), 'bili-duty-reports-'))
  const outDir = join(stateDir, 'out')
  await mkdir(outDir, { recursive: true })
  const store = createReportStore({ stateDir, outDir, dayKey })
  store.ensureFiles()
  return { stateDir, outDir, store }
}

test('picked video extraction ignores fenced examples and duplicates', () => {
  const text = [
    '### BV1aa1aa1aa1',
    '```markdown',
    '### BV2bb2bb2bb2',
    '```',
    '## BV1aa1aa1aa1',
  ].join('\n')

  assert.deepEqual(extractPickedBvids(text), ['BV1aa1aa1aa1'])
})

test('seen parser accepts timestamps, shifted columns, and comment delivery records', () => {
  const rows = parseSeenText([
    '| 日期 | BV | 标题 | UP | 状态 |',
    '| --- | --- | --- | --- | --- |',
    '| 2026-10-24 18:51 | BV1aa1aa1aa1 | 标题里 | 也有竖线 | 收（值得看） |',
    '| BV1aa1aa1aa1 | 317831597441 | root | 时间 | 正文 |',
  ].join('\n'))

  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    day: '2026-10-24',
    bvid: 'BV1aa1aa1aa1',
    title: '标题里',
    up: '也有竖线',
    status: '收（值得看）',
    picked: true,
    commented: false,
    delivered: true,
    url: 'https://www.bilibili.com/video/BV1aa1aa1aa1',
  })
  // A comment record has no date and is intentionally not a watched-video row,
  // but its BV still marks the matching watched row as delivered when present.
})

test('report store counts picks, creates single-video notes, and keeps newest metadata', async () => {
  const { stateDir, outDir, store } = await makeStore()
  const oldReport = [
    '### BV1aa1aa1aa1',
    '**档位**：可以看',
    '**为什么值得**：旧理由',
  ].join('\n')
  const report = [
    '# 刷B站 · 2026-10-24',
    '',
    '### BV1aa1aa1aa1',
    '**标题**：今天的标题',
    '**档位**：值得看',
    '**为什么值得**：新理由',
    '',
    '### BV2bb2bb2bb2',
    '**标题**：第二条',
    '**档位**：可以看',
  ].join('\n')
  await writeFile(join(outDir, '2026-10-23.md'), oldReport, 'utf8')
  await writeFile(join(outDir, '2026-10-24.md'), report, 'utf8')

  assert.equal(store.countPicks(join(outDir, '2026-10-24.md')), 2)
  assert.equal(store.countPickedToday(today), 2)
  assert.deepEqual(store.reportMeta().get('BV1aa1aa1aa1'), { tier: '值得看', why: '新理由' })

  assert.equal(store.syncNotes(today), 2)
  const notes = (await readdir(join(stateDir, 'reports'))).sort()
  assert.deepEqual(notes, ['BV1aa1aa1aa1-2026-10-24.md', 'BV2bb2bb2bb2-2026-10-24.md'])
  assert.match(await readFile(join(stateDir, 'reports', notes[0]), 'utf8'), /今天的标题|第二条/)
  assert.equal(store.syncNotes(today), 0)
})

test('report store owns watched filtering, report reads, and missing-report stubs', async () => {
  const { stateDir, outDir, store } = await makeStore()
  await writeFile(join(stateDir, 'seen.md'), [
    '| 日期 | BV | 标题 | UP | 状态 |',
    '| --- | --- | --- | --- | --- |',
    '| 2026-10-24 | BV1aa1aa1aa1 | 精选 | UP | 收（值得看） |',
    '| 2026-10-24 | BV2bb2bb2bb2 | 跳过 | UP | 跳过 |',
  ].join('\n'), 'utf8')
  await writeFile(join(outDir, '2026-10-24.md'), '### BV1aa1aa1aa1\n**档位**：值得看\n', 'utf8')

  const watched = store.listWatched({ state: 'picked', limit: 1 })
  assert.equal(watched.total, 1)
  assert.equal(watched.rows[0].bvid, 'BV1aa1aa1aa1')
  assert.equal(store.readReport('2026-10-24').exists, true)

  const created = store.stubReportIfMissing(17, join(stateDir, 'duty.log'))
  assert.equal(created, false)
  await writeFile(join(outDir, '2026-10-25.md'), '# placeholder', 'utf8')
  assert.equal(store.readReport('2026-10-25').text, '# placeholder')
})

test('missing report explains recognized startup failures', async () => {
  const { stateDir, outDir, store } = await makeStore()
  const logFile = join(stateDir, 'duty.log')
  await writeFile(logFile, 'NO_ADAPTER: no adapter registered for provider "baomiao-oneapi"', 'utf8')
  assert.equal(store.stubReportIfMissing(1, logFile), true)
  const report = await readFile(store.reportFileOf(), 'utf8')
  assert.match(report, /模型提供方没注册驱动：baomiao-oneapi/)
  assert.match(report, /每个 profile 各装各的/)
})

test('rollSeen moves only rows older than thirty days into month archives', async () => {
  const { stateDir, store } = await makeStore()
  await writeFile(join(stateDir, 'seen.md'), [
    '# 判重表',
    '| 日期 | BV | 标题 | UP | 状态 |',
    '| --- | --- | --- | --- | --- |',
    '| 2026-08-01 | BV1aa1aa1aa1 | 旧 | UP | 跳过 |',
    '| 2026-10-24 | BV2bb2bb2bb2 | 新 | UP | 收 |',
  ].join('\n'), 'utf8')

  const moved = store.rollSeen()
  assert.equal(moved, 1)
  assert.match(await readFile(join(stateDir, 'seen.md'), 'utf8'), /BV2bb2bb2bb2/)
  assert.doesNotMatch(await readFile(join(stateDir, 'seen.md'), 'utf8'), /BV1aa1aa1aa1/)
  assert.ok(existsSync(join(stateDir, 'seen', '2026-08.md')))
})
