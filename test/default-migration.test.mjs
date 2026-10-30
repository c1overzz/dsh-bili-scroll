/**
 * test/default-migration.test.mjs —— 「默认值改过之后，旧配置要跟着走」。
 *
 * 实际踩到的：`spread`（分时随机刷）10-28 那版默认 true，用户没动过，
 * config.json 里因此存了 true。10-29 把默认改成 false 之后，
 * loadCfg 那条「和默认值不一样 ⇒ 用户显式设过 ⇒ 以本地为准」把它当成用户的选择，
 * 永久保留 ⇒ 设置页显示关闭、实际一直分时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = readFileSync(resolve(HERE, '..', 'index.js'), 'utf8')

test('有默认值迁移表，且 spread 在里面', () => {
  const m = INDEX.match(/const DEFAULT_MIGRATIONS = \[([\s\S]*?)\]/)
  assert.ok(m, '没有 DEFAULT_MIGRATIONS')
  assert.ok(/key: 'spread'/.test(m[1]), 'spread 不在迁移表里')
  assert.ok(/oldDefault: true/.test(m[1]), '旧默认值应该是 true')
  assert.ok(/newDefault: false/.test(m[1]), '新默认值应该是 false')
})

test('迁移**只**动「用户没设过」的键', () => {
  const block = INDEX.slice(INDEX.indexOf('const DEFAULT_MIGRATIONS'), INDEX.indexOf('const DEFAULT_MIGRATIONS') + 2200)
  assert.ok(/setList\.includes\(m\.key\)/.test(block), '没有检查 _set —— 会覆盖用户的选择')
  assert.ok(/continue/.test(block), '命中用户设过的键时没有跳过')
})

test('迁移只处理「值正好等于旧默认」的情况', () => {
  const block = INDEX.slice(INDEX.indexOf('const DEFAULT_MIGRATIONS'), INDEX.indexOf('const DEFAULT_MIGRATIONS') + 2200)
  assert.ok(/JSON\.stringify\(raw\[m\.key\]\) !== JSON\.stringify\(m\.oldDefault\)/.test(block),
    '没有比对旧默认值 —— 用户设成别的值也会被改掉')
})

test('默认值没变过的键不会被误迁移', () => {
  const block = INDEX.slice(INDEX.indexOf('const DEFAULT_MIGRATIONS'), INDEX.indexOf('const DEFAULT_MIGRATIONS') + 2200)
  assert.ok(/DEFAULTS\[m\.key\]\) === JSON\.stringify\(m\.oldDefault\)/.test(block),
    '缺「默认值本身没变过就跳过」这道判断')
})

test('迁移写盘失败不影响启动', () => {
  const block = INDEX.slice(INDEX.indexOf('const DEFAULT_MIGRATIONS'), INDEX.indexOf('const DEFAULT_MIGRATIONS') + 2400)
  assert.ok(/catch \{ \/\* 迁移失败不影响启动 \*\/ \}/.test(block), '迁移没有兜住异常')
})
