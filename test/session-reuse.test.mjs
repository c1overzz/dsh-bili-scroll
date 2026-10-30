/**
 * test/session-reuse.test.mjs —— 会话复用的两件事。
 *
 * ⭐ 2026-10-30（用户："提示词这么长，一个对话窗里多次会不会影响"）：
 *   ① 续会话时**不再内联章程**（duty.md 12737 字符 ≈ 7600 token/轮，纯重复付费）
 *   ② 加轮次上限（默认 10）：上下文每轮 +2 万多 token，5 轮 13 万、20 轮几十万，
 *      超过就主动开新的，顺便让新一轮重读最新判重表
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = readFileSync(resolve(HERE, '..', 'index.js'), 'utf8')

test('续会话时跳过读章程文件', () => {
  const fn = INDEX.slice(INDEX.indexOf('const promptFor = '), INDEX.indexOf('const promptFor = ') + 1600)
  assert.ok(/resumed/.test(fn), 'promptFor 没有 resumed 参数')
  assert.ok(/if \(!resumed\) charterText = readFileSync/.test(fn),
    '续会话时还在读章程 —— 白花 7600 token')
})

test('续会话时提示词给的是"继续按上面那份章程"，不是整份章程', () => {
  const fn = INDEX.slice(INDEX.indexOf('const promptFor = '), INDEX.indexOf('const promptFor = ') + 12000)
  assert.ok(/继续按上面那份值班章程刷一轮/.test(fn), '续会话没有专门的短提示')
  assert.ok(/别重复挑同一条/.test(fn), '续会话没提醒别重复挑（这是复用的主要好处之一）')
})

test('调用处按 reuseSid 传 resumed', () => {
  const call = INDEX.slice(INDEX.indexOf("args.push(promptFor(") - 400, INDEX.indexOf("args.push(promptFor(") + 120)
  assert.ok(/promptFor\(why, \{ resumed: Boolean\(reuseSid\) \}\)/.test(call),
    '调用处没有把 resumed 传进去')
})

test('有轮次上限，且默认 10', () => {
  assert.ok(/reuseSessionMax: z\.natural\(\)\.default\(10\)/.test(INDEX), '没有 reuseSessionMax 配置项')
  assert.ok(/reuseSessionMax: 10/.test(INDEX), 'DEFAULTS 里没有 reuseSessionMax')
})

test('超过上限时不再复用，并说明原因', () => {
  const fn = INDEX.slice(INDEX.indexOf('const readDutySession'), INDEX.indexOf('const readDutySession') + 1200)
  assert.ok(/j\.used/.test(fn), '没有读 used 计数')
  assert.ok(/>= max/.test(fn), '没有和上限比较')
  assert.ok(/开个新的/.test(fn), '超过上限时没说明原因')
  assert.ok(/return ''/.test(fn), '超过上限时应该返回空（不复用）')
})

test('续上之后计数会 +1（否则永远到不了上限）', () => {
  assert.ok(/const bumpDutySessionUsed/.test(INDEX), '没有 bumpDutySessionUsed')
  assert.ok(/bumpDutySessionUsed\(todayKey\)/.test(INDEX), '调用处没调 bump')
  const fn = INDEX.slice(INDEX.indexOf('const bumpDutySessionUsed'), INDEX.indexOf('const bumpDutySessionUsed') + 400)
  assert.ok(/Number\(j\.used \|\| 0\) \+ 1/.test(fn), '没有真的 +1')
})

test('第一轮记下会话时 used 从 1 起算', () => {
  assert.ok(/writeDutySession\(todayKey, id, 1\)/.test(INDEX), '新建会话时 used 不是从 1 开始')
})
