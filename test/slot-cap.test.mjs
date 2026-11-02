/**
 * test/slot-cap.test.mjs —— 排点必须**严格升序、不重复、不越界**。
 *
 * 2026-10-30 压测（30 次里偶发 1 次）查出来的真 bug：
 *   第 j 个点的上界写死成 `L - 1`，但**后面还有 k-1-j 个点要放**。
 *   指数分布是重尾的（末尾几个权重可能都很大）⇒ 后面几个点一起撞到 L-1，
 *   Math.min 把它们全压成同一个下标 ⇒ **排到同一分钟**。
 *
 * 为什么这很严重（不是"看着难看"）：
 *   tick 是**按顺序消费**时间点的，同一分钟两个点 ⇒ 同一跳里连着开两轮，
 *   等于"分时随机"退化成"连着发"，而且是最容易被看出来是机器人的那种。
 *
 * 这里不复刻实现 —— 直接把宿主 index.js 里的 spreadSlots 抽出来跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = readFileSync(resolve(HERE, '..', 'index.js'), 'utf8')

/** 从宿主源码里取出 spreadSlots 的函数体，放进沙箱求值 —— 测的是线上那段代码本身 */
function loadSpreadSlots() {
  const lines = INDEX.split('\n')
  const start = lines.findIndex((l) => l.includes('const spreadSlots = (mins, n) =>'))
  assert.ok(start >= 0, '没找到 spreadSlots')
  const out = []
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i])
    depth += (lines[i].match(/\{/g) || []).length
    depth -= (lines[i].match(/\}/g) || []).length
    if (i > start && depth <= 0) break
  }
  const src = out.join('\n').replace(/^\s*const spreadSlots =/, 'return')
  // eslint-disable-next-line no-new-func
  return new Function(src)()
}

const spreadSlots = loadSpreadSlots()
const minsOf = (L) => Array.from({ length: L }, (_, i) => i * 60000)

test('各种「可用分钟数 × 要几条」组合下，时间点都严格升序（不重复）', () => {
  for (const L of [1, 2, 3, 4, 5, 10, 60, 120, 480]) {
    for (const n of [1, 2, 3, 5, 10, 20, 50]) {
      for (let t = 0; t < 120; t++) {
        const { times } = spreadSlots(minsOf(L), n)
        for (let i = 1; i < times.length; i++) {
          assert.ok(times[i] > times[i - 1],
            `L=${L} n=${n}：第 ${i} 个点 ${times[i]} 没有大于前一个 ${times[i - 1]}（排到同一分钟了）`)
        }
      }
    }
  }
})

test('时间点不会越界（不会排到可用范围之外）', () => {
  for (const L of [1, 2, 3, 7, 33, 100]) {
    const mins = minsOf(L)
    for (const n of [1, 2, 5, 20]) {
      for (let t = 0; t < 120; t++) {
        const { times } = spreadSlots(mins, n)
        for (const x of times) {
          assert.ok(x !== undefined && x !== null, `L=${L} n=${n}：排出了 undefined`)
          assert.ok(mins.includes(x), `L=${L} n=${n}：排出的 ${x} 不在可用分钟里`)
        }
      }
    }
  }
})

test('要几条就排几条（可用分钟够的时候）', () => {
  for (const L of [10, 60, 480]) {
    for (const n of [1, 2, 5, 10]) {
      if (n > L) continue
      for (let t = 0; t < 60; t++) {
        const { times } = spreadSlots(minsOf(L), n)
        assert.equal(times.length, n, `L=${L} n=${n}：只排了 ${times.length} 个点`)
      }
    }
  }
})

test('可用分钟不够时，最多排到"每分钟一个"，不重复也不硬凑', () => {
  for (const L of [1, 2, 3]) {
    for (const n of [5, 10, 50]) {
      for (let t = 0; t < 60; t++) {
        const { times } = spreadSlots(minsOf(L), n)
        assert.ok(times.length <= L, `L=${L} n=${n}：排了 ${times.length} 个点，超过可用分钟数`)
        const uniq = new Set(times)
        assert.equal(uniq.size, times.length, '有重复的时间点')
      }
    }
  }
})

test('没有可用分钟 ⇒ 空计划，不抛错', () => {
  const r = spreadSlots([], 5)
  assert.deepEqual(r.times, [])
  assert.equal(r.wanted, 5)
})
