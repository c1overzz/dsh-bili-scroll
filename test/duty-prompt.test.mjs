import test from 'node:test'
import assert from 'node:assert/strict'

import { buildDutyPrompt } from '../lib/duty-prompt.mjs'

const base = (config = {}, extra = {}) => buildDutyPrompt({
  stateDir: '/tmp/bili-duty',
  outDir: '/tmp/bili-duty/out',
  digestDir: '/tmp/bili-duty/digest',
  today: '2026-10-24',
  reportPath: '/tmp/bili-duty/out/2026-10-24.md',
  digestPath: '/tmp/bili-duty/digest/2026-10.md',
  seenPath: '/tmp/bili-duty/seen.md',
  charter: { path: '/tmp/bili-duty/duty.md', text: '按章程刷。' },
  config: {
    perDay: 5,
    keywords: ['AI'],
    reportLevel: 'full',
    dmMode: 'off',
    autoComment: false,
    mentionName: '',
    commentPerRound: 1,
    transcribe: false,
    replyToComments: false,
    replyPerRound: 1,
    ...config,
  },
  already: 0,
  asrReady: false,
  dmUid: 0,
  ...extra,
})

test('dm-only without a recipient never falls back to public comments', () => {
  const prompt = base({ dmMode: 'only', autoComment: true, mentionName: '本人' })
  assert.match(prompt, /自动评论并 @ 本人 是关着的/)
  assert.match(prompt, /不要发公开评论，也不要调用 bili_send_message 猜收件人/)
  assert.doesNotMatch(prompt, /公开评论照发/)
  assert.doesNotMatch(prompt, /bili_send_message 把这一轮的结果发到 UID/)
})

test('dm-only without a recipient respects report-off mode', () => {
  const prompt = base({ dmMode: 'only', reportLevel: 'off' })
  assert.match(prompt, /不要生成日报，完成判重和归档即可/)
  assert.doesNotMatch(prompt, /把“只私信但没有收件人 UID”如实写进报告/)
})

test('dm-only with a recipient adds private delivery rules', () => {
  const prompt = base({ dmMode: 'only', dmUid: 123, autoComment: true, mentionName: '本人' }, { dmUid: 123 })
  assert.match(prompt, /bili_send_message 把这一轮的结果发到 UID \*\*123\*\*/)
  assert.match(prompt, /一条私信务必控制在 500 字以内/)
  assert.doesNotMatch(prompt, /公开评论照发/) 
})

test('both mode keeps public comments and private delivery distinct', () => {
  const prompt = base({ dmMode: 'both', dmUid: 123, autoComment: true, mentionName: '本人' }, { dmUid: 123 })
  assert.match(prompt, /自动评论并 @ 本人 是开着的/)
  assert.match(prompt, /现在是 \*\*both\*\*/)
})

test('reply-owner identity does not fall back to the outbound DM recipient', () => {
  const prompt = base({
    dmMode: 'off',
    dmUid: 123,
    dmOwnerUid: 0,
    replyToComments: true,
  }, { dmUid: 123, dmOwnerUid: 0 })
  assert.match(prompt, /主人本人（uid=登录账号自己）/)
  assert.doesNotMatch(prompt, /主人本人（uid=123）/)
})

test('dm-only mode explicitly disables public comments and comment replies', () => {
  const prompt = base({ dmMode: 'only', dmUid: 123, replyToComments: true }, { dmUid: 123 })
  assert.match(prompt, /公开评论和回复评论都不做/)
  assert.doesNotMatch(prompt, /回复评论：开着/)
})

test('empty keywords use account recommendations and recent comments inform new style', () => {
  const prompt = base({ keywords: [], dmMode: 'off' }, {
    recentComments: ['这期第三分钟那个转场很妙', '最后的拆解挺清楚'],
  })
  assert.match(prompt, /用 bili_recommend 刷这个账号的首页推荐流/)
  assert.match(prompt, /以前发过的评论/)
  assert.match(prompt, /这期第三分钟那个转场很妙/)
})

test('quota and report paths are rendered from the prepared snapshot', () => {
  const prompt = base({ reportLevel: 'brief', perDay: 5 }, { already: 2 })
  assert.match(prompt, /今天已经挑过 2 条了/)
  assert.match(prompt, /这一轮最多再挑 3 条/)
  assert.match(prompt, /日报写成薄版/)
  assert.match(prompt, /判重表 = \/tmp\/bili-duty\/seen\.md/)
})

