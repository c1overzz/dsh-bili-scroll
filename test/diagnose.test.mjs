// node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnoseRound } from '../lib/diagnose.mjs'

const tail = 'dsh: NO_ADAPTER: no adapter registered for provider "custom-gw"\n'

test('NO_ADAPTER：认得出 provider', () => {
  const d = diagnoseRound(tail)
  assert.equal(d.hint, 'NO_ADAPTER')
  assert.match(d.title, /custom-gw/)
  assert.match(d.body, /custom-gw/)
})

test('#130：不再让人往 cordis.patch.yml 里加顶层 provider / model（YAML 非法，overlay 也会盖掉它）', () => {
  const { body } = diagnoseRound(tail)
  assert.doesNotMatch(body, /^\s*provider: /m)
  assert.doesNotMatch(body, /^\s*model: /m)
  assert.doesNotMatch(body, /cordis\.patch\.yml/)
})

test('#130：第一条指向真正有效的办法 —— 在设置页钉 DeepSeek', () => {
  const { body } = diagnoseRound(tail)
  assert.match(body, /用哪个模型跑/)
  assert.match(body, /deepseek-account/)
  assert.match(body, /deepseek-official/)
})

test('#144：第二条说清 bili-duty 每次启动被覆盖，要装进自建 profile', () => {
  const { body } = diagnoseRound(tail)
  assert.match(body, /自建的 profile/)
  assert.match(body, /headlessProfile/)
  assert.match(body, /bili-duty.*覆盖/)
  assert.match(body, /保留模板里关掉文件、命令和联网/)
})
