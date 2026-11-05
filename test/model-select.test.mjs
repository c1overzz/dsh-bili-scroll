// node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { providerState, chooseModel, isStockTemplate, FALLBACK_MODEL } from '../lib/model-select.mjs'

const envOf = (profile, stock = false) => ({ profile: () => profile, templateIsStock: () => stock })
const STOCK = envOf('bili-duty', true)        // 出厂的 bili-duty
const EDITED = envOf('bili-duty', false)      // bundles 被改过的模板（#144）
const CUSTOM = envOf('my-duty')               // 自建 profile（#175）
const HEADLESS = envOf('headless')

const ses = (provider, model = 'some-model') => ({ provider, model, source: 'session' })
const pin = (provider, model = 'some-model') => ({ provider, model })
const pick = (m) => [m.provider, m.source]

test('#130 / #144 / #163：出厂 bili-duty + 没钉 + 会话是未知 provider ⇒ 退回兜底，不带着它去 NO_ADAPTER', () => {
  const m = chooseModel({ pin: null, session: ses('custom-gw', 'gw-model') }, STOCK)
  assert.deepEqual(m, {
    ...FALLBACK_MODEL,
    source: 'fallback',
    sessionIgnored: { provider: 'custom-gw', model: 'gw-model' },
  })
})

test('出厂 bili-duty + 没钉 + 会话是 Antigravity ⇒ 同样退回兜底', () => {
  assert.deepEqual(pick(chooseModel({ pin: null, session: ses('google-antigravity') }, STOCK)), ['deepseek-account', 'fallback'])
})

test('没钉 + 会话是 DeepSeek ⇒ 跟随会话，effort 也带上', () => {
  const session = { ...ses('deepseek-official', 'deepseek-pro'), reasoningEffort: 'high' }
  assert.deepEqual(chooseModel({ pin: null, session }, STOCK), session)
})

test('没钉也没有会话 ⇒ 兜底，不带 sessionIgnored', () => {
  assert.deepEqual(chooseModel({ pin: null, session: null }, STOCK), { ...FALLBACK_MODEL, source: 'fallback' })
})

test('出厂 bili-duty + 钉了未知 provider ⇒ 照用，不悄悄换（失败由 diagnose 说清楚）', () => {
  for (const session of [ses('deepseek-account'), ses('community-x'), null]) {
    assert.deepEqual(chooseModel({ pin: pin('custom-gw', 'gw-model'), session }, STOCK),
      { provider: 'custom-gw', model: 'gw-model', source: 'plugin' })
  }
})

test('钉 DeepSeek ⇒ 哪个 profile 都照用', () => {
  for (const env of [STOCK, EDITED, CUSTOM, HEADLESS]) {
    assert.deepEqual(pick(chooseModel({ pin: pin('deepseek-official'), session: ses('custom-gw') }, env)), ['deepseek-official', 'plugin'])
  }
})

test('钉 Antigravity 但这一轮不是 headless ⇒ 忽略并标出来：有能用的会话跟会话，没有就兜底', () => {
  const ag = pin('google-antigravity')
  const a = chooseModel({ pin: ag, session: ses('deepseek-account') }, STOCK)
  assert.deepEqual(pick(a), ['deepseek-account', 'session'])
  assert.deepEqual(a.ignored, ag)

  const b = chooseModel({ pin: ag, session: ses('custom-gw', 'gw-model') }, STOCK)
  assert.deepEqual(pick(b), ['deepseek-account', 'fallback'])
  assert.deepEqual(b.ignored, ag)
  assert.deepEqual(b.sessionIgnored, { provider: 'custom-gw', model: 'gw-model' })

  // 自建 profile 上未知的会话 provider 是 maybe ⇒ 跟会话
  const c = chooseModel({ pin: ag, session: ses('custom-gw') }, CUSTOM)
  assert.deepEqual(pick(c), ['custom-gw', 'session'])
  assert.deepEqual(c.ignored, ag)
})

test('钉 Antigravity 且这一轮就是 headless ⇒ 照用', () => {
  assert.deepEqual(pick(chooseModel({ pin: pin('google-antigravity'), session: null }, HEADLESS)), ['google-antigravity', 'plugin'])
})

test('#175：自建 profile、改过 bundles 的模板和 headless ⇒ 未知 provider 钉了照用，没钉跟随会话', () => {
  for (const env of [CUSTOM, EDITED, HEADLESS]) {
    assert.deepEqual(pick(chooseModel({ pin: pin('custom-gw'), session: ses('deepseek-account') }, env)), ['custom-gw', 'plugin'])
    assert.deepEqual(pick(chooseModel({ pin: null, session: ses('custom-gw') }, env)), ['custom-gw', 'session'])
  }
})

test('providerState：未知 provider 只有在出厂 bili-duty 上才是 no', () => {
  assert.equal(providerState('custom-gw', STOCK), 'no')
  assert.equal(providerState('custom-gw', EDITED), 'maybe')
  assert.equal(providerState('custom-gw', CUSTOM), 'maybe')
  assert.equal(providerState('custom-gw', HEADLESS), 'maybe')
  // 自建 profile 上 templateIsStock 不算数（比如自建 profile 恰好也只有两个 bundle，这一轮装没装还是看不到）
  assert.equal(providerState('custom-gw', envOf('my-duty', true)), 'maybe')
})

test('providerState：白名单和绑定 profile 的规矩不变', () => {
  assert.equal(providerState('', STOCK), 'no')
  assert.equal(providerState(null, CUSTOM), 'no')
  for (const env of [STOCK, EDITED, CUSTOM, HEADLESS]) {
    assert.equal(providerState('deepseek-account', env), 'yes')
    assert.equal(providerState('deepseek-official', env), 'yes')
  }
  assert.equal(providerState('google-antigravity', HEADLESS), 'yes')
  assert.equal(providerState('google-antigravity', STOCK), 'no')
  assert.equal(providerState('google-antigravity', CUSTOM), 'no')
})

test('providerState：判断 profile 或模板时抛错 ⇒ 未知 provider 算 maybe，不当成确定没有', () => {
  const boom = () => { throw new Error('boom') }
  assert.equal(providerState('custom-gw', { profile: boom, templateIsStock: () => true }), 'maybe')
  assert.equal(providerState('custom-gw', { profile: () => 'bili-duty', templateIsStock: boom }), 'maybe')
  assert.equal(providerState('google-antigravity', { profile: boom, templateIsStock: () => true }), 'no')
})

test('isStockTemplate：插件自带的模板就是出厂形状（改模板 bundles 时要同步 STOCK_BUNDLES）', () => {
  const tpl = JSON.parse(readFileSync(new URL('../profile-template/bili-duty/package.json', import.meta.url), 'utf8'))
  assert.equal(isStockTemplate(tpl), true)
})

test('isStockTemplate：加了 bundle、少了 bundle、读不到都不算出厂', () => {
  const pkg = (bundles) => ({ dsh: { profile: { bundles } } })
  assert.equal(isStockTemplate(pkg(['@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-base'])), true)
  assert.equal(isStockTemplate(pkg(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'some-provider-plugin'])), false)
  assert.equal(isStockTemplate(pkg(['@deepseek-ai/dsh-base'])), false)
  assert.equal(isStockTemplate(pkg(['@deepseek-ai/dsh-base', 'some-provider-plugin'])), false)
  assert.equal(isStockTemplate(pkg('@deepseek-ai/dsh-base')), false)
  assert.equal(isStockTemplate({}), false)
  assert.equal(isStockTemplate(null), false)
})
