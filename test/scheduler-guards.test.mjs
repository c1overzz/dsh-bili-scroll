/**
 * test/scheduler-guards.test.mjs —— 定时器与配置写入的几道防线。
 *
 * 覆盖 2026-10-30 查出来的三处：
 *   ① tick 是 async 的（里面 await 启动确认），没有防重入 ⇒ 可能两跳叠加
 *   ② slotRetryAt 只在失败时写、成功时从不删 ⇒ 旧退避值跨天仍然挡路
 *   ③ 客户端切投递方式时顺手改 autoComment ⇒ 覆盖用户自己的开关
 *   ④ 没登录也照常跑一整轮 ⇒ 白花 token，评论全失败
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = readFileSync(resolve(HERE, '..', 'index.js'), 'utf8')
const CLIENT = readFileSync(resolve(HERE, '..', 'client.js'), 'utf8')

test('① tick 有防重入：进入时置位、finally 复位', () => {
  assert.ok(/let ticking = false/.test(INDEX), '没有 ticking 标记')
  assert.ok(/if \(ticking\) return/.test(INDEX), '没有进入时的重入判断')
  // 复位必须放在 finally，否则中途 return 会把标记永久卡住
  const tickBody = INDEX.slice(INDEX.indexOf('const tick = async'))
  const finallyIdx = tickBody.indexOf('finally')
  assert.ok(finallyIdx > 0 && /ticking = false/.test(tickBody.slice(finallyIdx, finallyIdx + 80)),
    'ticking 没有在 finally 里复位 —— 中途 return 会让它永久卡住')
})

test('② 分时成功后会清掉 slotRetryAt', () => {
  const idx = INDEX.indexOf('分时到点（${why}）')
  assert.ok(idx > 0, '没找到成功日志那行')
  const after = INDEX.slice(idx, idx + 900)
  assert.ok(/slotRetryAt: ''/.test(after),
    '成功跑完之后没有清 slotRetryAt —— 旧的退避值会一直留着')
})

test('③ 切投递方式不再顺手改 autoComment', () => {
  assert.ok(/patch\(\{ dmMode: v \}/.test(CLIENT), '没有找到只提交 dmMode 的写法')
  assert.equal(/patch\(\{ dmMode: v, autoComment:/.test(CLIENT), false,
    '还在用「切投递方式顺便改 autoComment」的写法 —— 会覆盖用户自己的开关')
})

test('④ 没登录时 runDuty 直接返回、不启动', () => {
  const runDuty = INDEX.slice(INDEX.indexOf('const runDuty = '), INDEX.indexOf('const runDutyConfirmed'))
  assert.ok(/if \(!hasCredential\(\)\)/.test(runDuty), 'runDuty 里没有登录检查')
  assert.ok(/needLogin: true/.test(runDuty), '没有把"需要登录"这个原因带回去')
  // 检查必须在 spawn 之前
  assert.ok(runDuty.indexOf('hasCredential()') < runDuty.indexOf('spawn('),
    '登录检查必须在 spawn 之前，否则还是会起进程')
})

test('两个开关不一致时，界面给的是按钮而不只是文字', () => {
  assert.ok(/打开自动评论/.test(CLIENT), '没有一键打开自动评论的按钮')
  assert.ok(/改回只发私信/.test(CLIENT), '没有一键改回私信的按钮')
})
