import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  clampConfig,
  normalizeConfig,
} from '../lib/config.mjs'

test('configuration has one complete default contract', () => {
  assert.equal(CONFIG_DEFAULTS.headlessProfile, 'bili-duty')
  assert.equal(CONFIG_DEFAULTS.dmWatchMinutes, 1)
  assert.deepEqual(CONFIG_KEYS, Object.keys(CONFIG_DEFAULTS))
})

test('normalizeConfig ignores unknown and incorrectly typed values', () => {
  const result = normalizeConfig({
    perDay: '8',
    peakValley: 'yes',
    keywords: ['AI', 3, null],
    unknown: 'ignored',
  })
  assert.equal(result.perDay, 8)
  assert.equal(result.peakValley, CONFIG_DEFAULTS.peakValley)
  assert.deepEqual(result.keywords, ['AI'])
  assert.equal('unknown' in result, false)
})

test('normalizeConfig does not share the default keyword array', () => {
  const result = normalizeConfig({})
  result.keywords.push('local')
  assert.deepEqual(CONFIG_DEFAULTS.keywords, [])
})

test('clampConfig applies shared bounds and reports truncation', () => {
  const logs = []
  const result = clampConfig({
    perDay: 999,
    unknown: 'drop-me',
    commentPerRound: -2,
    replyPerRound: 999,
    dmWatchMinutes: 0,
    dmReplyPerDay: 999,
    dmOwnerUid: Number.MAX_SAFE_INTEGER + 100,
    favFolderId: 3.9,
    dmMode: 'unsafe',
    dmUid: Number.MAX_SAFE_INTEGER + 100,
    reportLevel: 'invalid',
    personaPrompt: 'x'.repeat(60_005),
  }, { log: (line) => logs.push(line) })

  assert.equal(result.perDay, 50)
  assert.equal('unknown' in result, false)
  assert.equal(result.commentPerRound, 0)
  assert.equal(result.replyPerRound, 10)
  assert.equal(result.dmWatchMinutes, 1)
  assert.equal(result.dmReplyPerDay, 20)
  assert.equal(result.favFolderId, 3)
  assert.equal(result.dmOwnerUid, Number.MAX_SAFE_INTEGER)
  assert.equal(result.dmMode, 'off')
  assert.equal(result.dmUid, Number.MAX_SAFE_INTEGER)
  assert.equal(result.reportLevel, 'full')
  assert.equal(result.personaPrompt.length, 60_000)
  assert.equal(logs.length, 1)
})
