import test from 'node:test'
import assert from 'node:assert/strict'

import {
  incrementQuota,
  latestIncoming,
  markIncoming,
  normalizeQuota,
  quotaAllows,
  resolveOwnerUid,
} from '../lib/dm-policy.mjs'

test('owner UID prefers the explicit owner and never uses the outbound recipient', () => {
  assert.equal(resolveOwnerUid({ configuredUid: 42, loggedInUid: 99 }), 42)
  assert.equal(resolveOwnerUid({ configuredUid: 0, loggedInUid: 99 }), 99)
  assert.equal(resolveOwnerUid({ configuredUid: 0, loggedInUid: 0 }), 0)
})

test('DM policy selects only a new incoming message', () => {
  const messages = [
    { key: 'old', fromMe: false },
    { key: 'reply', fromMe: true },
    { key: 'new', fromMe: false },
  ]
  assert.deepEqual(latestIncoming(messages, 'old'), messages[2])
  assert.equal(latestIncoming(messages, 'new'), null)
  assert.equal(latestIncoming([{ key: 'mine', fromMe: true }], ''), null)
})

test('DM policy normalizes daily quota and preserves safety ordering', () => {
  const quota = normalizeQuota({ day: 'yesterday', n: 99 }, 'today')
  assert.deepEqual(quota, { day: 'today', n: 0 })
  assert.equal(quotaAllows(quota, 1), true)
  const nextSeen = markIncoming({}, 42, 'm1')
  const nextQuota = incrementQuota(quota)
  assert.deepEqual(nextSeen, { '42': 'm1' })
  assert.deepEqual(nextQuota, { day: 'today', n: 1 })
  assert.equal(quotaAllows(nextQuota, 1), false)
})
