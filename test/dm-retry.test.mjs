/**
 * test/dm-retry.test.mjs —— 「退出登录之后，旧的失败重试不能把私信任务重新拉起来」。
 *
 * ⭐ 评审第 7 条之二：kill 掉子进程 ⇒ 退出码非 0 ⇒ 走进"续会话失败，立刻重试"
 *   ⇒ 800ms 后又跑起来，用的还是已经删掉的凭证。
 *
 * 这里分三层验：
 *   ① 判定函数本身（真模块）
 *   ② index.js 里两处重试都走了这个判定（源码断言，防止以后被改回去）
 *   ③ 退出登录路由确实把 epoch 加一了（源码断言）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dmRetryAllowed } from '../lib/dm-retry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = resolve(HERE, '..', 'index.js')

test('同一代 ⇒ 允许重试；退出登录后（代次变了）⇒ 不允许', () => {
  assert.equal(dmRetryAllowed(3, 3), true)
  assert.equal(dmRetryAllowed(3, 4), false)
  assert.equal(dmRetryAllowed(0, 1), false)
})

test('字符串/数字混着传也不会误判', () => {
  assert.equal(dmRetryAllowed('3', 3), true)
  assert.equal(dmRetryAllowed(3, '4'), false)
})

test('index.js 的重试前都用了这个判定（两处：立即重试 + 定时器回调）', () => {
  const src = readFileSync(INDEX, 'utf8')
  const hits = src.match(/dmRetryAllowed\(epoch, dmRunEpoch\)/g) || []
  assert.equal(hits.length, 2, '应该有两处判定，实际 ' + hits.length + ' 处')
  // 不能退回到裸比较
  assert.equal(/epoch !== dmRunEpoch/.test(src), false, '还有裸比较，说明没走统一判定')
})

test('退出登录会把 epoch 加一，并清掉挂起的重试定时器', () => {
  const src = readFileSync(INDEX, 'utf8')
  const logout = src.slice(src.indexOf("path === '/api/bili-duty/logout'"))
  assert.ok(logout.length > 0, '没找到退出登录路由')
  const block = logout.slice(0, 1600)
  assert.ok(/dmRunEpoch \+= 1/.test(block), '退出登录没有把 epoch 加一')
  assert.ok(/clearTimeout\(dmRetryTimer\)/.test(block), '退出登录没有清掉挂起的重试定时器')
  // 加一必须在 kill 之前
  assert.ok(block.indexOf('dmRunEpoch += 1') < block.indexOf('dmChild.kill()'),
    'epoch 必须在 kill 之前加一，否则 kill 触发的回调会在加一前就跑')
})

test('runDmReply 每次都会记下发起时的代次', () => {
  const src = readFileSync(INDEX, 'utf8')
  const fn = src.slice(src.indexOf('function runDmReply(fromUid, text)'))
  assert.ok(/const epoch = dmRunEpoch/.test(fn.slice(0, 400)), 'runDmReply 没记 epoch')
})
