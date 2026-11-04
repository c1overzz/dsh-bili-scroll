import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveUid } from '../lib/uid.mjs'

// #122: keep this regression test entirely offline; no actual DSH run or Bilibili DM.
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const warmBlock = source.match(/\blet dmUidCache = 0\s*\n([\s\S]*?)\n\s*const promptFor = /)?.[1]

// Extract existing in-module implementation so that the test exercises the
// actual UID warm-up logic without starting DSH or changing plugin exports.
function warmHarness(cfg, stateDir, resolver = resolveUid) {
  assert.ok(warmBlock, 'index.js should declare warmDmUid before promptFor')
  const factory = new Function('cfg', 'stateDir', 'resolveUid', 'log', `
    let dmUidCache = 0
    ${warmBlock}
    return { warmDmUid, cachedUid: () => dmUidCache }
  `)
  return factory(cfg, stateDir, resolver, () => {})
}

// Verify the shared runDuty preflight, not a separately reimplemented resolver.
const preflightMatch = source.match(
  /\bconst runDuty = async \(why = 'window'\) => \{[\s\S]*?\brefreshCfg\(\)[^\n]*\n([\s\S]*?)\n\s*const dsh = resolveDsh\(\)/,
)

async function executePreflight(cfg, warmDmUid) {
  assert.ok(preflightMatch, 'runDuty must be async and prepare UID before resolveDsh/promptFor')
  const preflight = new Function('cfg', 'warmDmUid', `return async () => {
    ${preflightMatch[1]}
  }`)
  await preflight(cfg, warmDmUid)()
}

test('scheduled run resolves nickname from the real persistent UID cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-issue-122-'))
  try {
    // resolveUid must use this cache, not reach out to Bilibili.
    writeFileSync(join(dir, 'uid-cache.json'), JSON.stringify({ '测试收件人': 456789 }))
    const cfg = { dmMode: 'only', dmUid: 0, mentionName: '测试收件人' }
    const harness = warmHarness(cfg, dir)
    await executePreflight(cfg, harness.warmDmUid)
    assert.equal(harness.cachedUid(), 456789)
    assert.match(source, /const dmUidEff = Number\(cfg\.dmUid\) \|\| dmUidCache/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('explicit dmUid skips nickname lookup', async () => {
  const cfg = { dmMode: 'only', dmUid: 987654, mentionName: '不需要查' }
  let lookups = 0
  await executePreflight(cfg, async () => { lookups += 1 })
  assert.equal(lookups, 0)
})

test('dmMode=off skips nickname lookup', async () => {
  const cfg = { dmMode: 'off', dmUid: 0, mentionName: '不需要查' }
  let lookups = 0
  await executePreflight(cfg, async () => { lookups += 1 })
  assert.equal(lookups, 0)
})

test('unresolved changed nickname cannot reuse prior cached recipient', async () => {
  const cfg = { dmMode: 'only', dmUid: 0, mentionName: '原收件人' }
  const harness = warmHarness(cfg, '', async (_dir, name) => name === '原收件人' ? 123 : 0)
  await executePreflight(cfg, harness.warmDmUid)
  assert.equal(harness.cachedUid(), 123)
  cfg.mentionName = '新收件人'
  await executePreflight(cfg, harness.warmDmUid)
  assert.equal(harness.cachedUid(), 0)
})

test('manual HTTP, bili_run, and timer all await runDuty', () => {
  assert.match(source, /async execute\(\)\s*\{\s*const r = await runDuty\('manual'\)/)
  assert.match(source, /const tick = async \(\) => \{[\s\S]*?try\s*\{[\s\S]*?await runDuty\(`window:\$\{k\}`\)[\s\S]*?\}\s*catch\s*\(e\)/)
  assert.match(source, /path === '\/api\/bili-duty\/run'[\s\S]*?\.\.\.\(await runDuty\('manual'\)\)/)
})


test('concurrent starts do not race during UID resolution', async () => {
  // Windows checkouts may use CRLF; normalize only for test extraction.
  const normalized = source.replace(/\r\n/g, '\n')
  const begin = normalized.indexOf('  let dutyStarting = false\n  const runDuty = async ')
  const end = normalized.indexOf('\n\n  /* ─────────────── 谷时定时器', begin)
  assert.ok(begin >= 0 && end > begin, 'runDuty must protect its async preflight')

  // Exercise the real runDuty function with a stalled lookup. Return early at
  // resolveDsh() so the test never spawns DSH or sends anything to Bilibili.
  const create = new Function(
    'cfg', 'warmDmUid', 'refreshCfg', 'resolveDsh', 'log',
    'stubReportIfMissing', 'dutyChild', 'dutyStartedAt',
    normalized.slice(begin, end) + '\nreturn runDuty',
  )

  let lookupCount = 0
  let releaseLookup
  const lookupGate = new Promise((resolve) => { releaseLookup = resolve })
  const runDuty = create(
    { dmMode: 'only', dmUid: 0 },
    async () => { lookupCount++; await lookupGate },
    () => {},
    () => ({ missing: true, hint: '' }),
    () => {},
    () => {},
    null,
    0,
  )

  const first = runDuty('window:night')
  const second = await runDuty('manual')
  assert.equal(second.busy, true)
  assert.equal(lookupCount, 1)
  releaseLookup()
  const result = await first
  assert.equal(result.started, false)  // Mock DSH executable intentionally missing.
})
