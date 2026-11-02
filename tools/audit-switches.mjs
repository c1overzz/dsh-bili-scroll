/**
 * tools/audit-switches.mjs —— 逐个核对「设置里的开关到底有没有用」。
 *
 * 为什么需要它：用户的原话是「不要我没开这个时间段跑他还跑了」。
 * 这类 bug 最隐蔽 —— 开关在设置页存在、能存能读，但**代码里根本没读它**，
 * 或者读了却没在关键分支上生效。光看代码容易漏，所以要机器逐个核。
 *
 * 检查两类：
 *   A. 死开关：schema 里有、DEFAULTS 里有，但代码里**从来没读过** cfg.<key>
 *   B. 弱开关：读是读了，但"关掉"时没有任何 return / 分支保护（只能靠人看）
 *
 * 用法：node tools/audit-switches.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const INDEX = readFileSync(resolve(ROOT, 'index.js'), 'utf8')
const CLIENT = readFileSync(resolve(ROOT, 'client.js'), 'utf8')

// ① 从 schema 里抠出全部键
const cfgStart = INDEX.indexOf('export const Config')
const cfgEnd = INDEX.indexOf('const DEFAULTS', cfgStart)
const schemaBlock = INDEX.slice(cfgStart, cfgEnd)
const keys = [...schemaBlock.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*z\./gm)].map((m) => m[1])

// ② 抠 DEFAULTS
const defStart = INDEX.indexOf('const DEFAULTS = {')
const defEnd = INDEX.indexOf('}', defStart)
const defaultsBlock = INDEX.slice(defStart, defEnd)
const inDefaults = new Set([...defaultsBlock.matchAll(/([a-zA-Z][a-zA-Z0-9]*):/g)].map((m) => m[1]))

// ③ 宿主代码里除了 schema/DEFAULTS 之外的部分（避免把定义本身算成"使用"）
const bodyStart = defEnd
const BODY = INDEX.slice(bodyStart)

const results = []
for (const k of keys) {
  // 用法统计：cfg.<key> / cfg?.[key]
  const uses = (BODY.match(new RegExp(`cfg\\??\\.${k}\\b`, 'g')) || []).length
  // ⚠️ 还有动态下标访问：`for (const k of ['noon','night']) { if (!cfg[k]) ... }`
  //    这种静态点号找不到，得看这个键是否出现在某个字面量数组里，且该数组被拿去遍历后 cfg[...]
  const inLiteralList = new RegExp(`\\[\\s*[^\\]]*'${k}'[^\\]]*\\]`).test(BODY)
  const hasDynamicCfg = /cfg\[[a-zA-Z_$][\w$]*\]/.test(BODY)
  const dynamicUse = inLiteralList && hasDynamicCfg
  const inClient = new RegExp(`\\b${k}\\b`).test(CLIENT)
  const inDefaultsFlag = inDefaults.has(k)
  results.push({ key: k, uses, inClient, inDefaults: inDefaultsFlag, dynamicUse })
}

const dead = results.filter((r) => r.uses === 0 && !r.dynamicUse)
const noDefault = results.filter((r) => !r.inDefaults)

console.log('=== 共 ' + keys.length + ' 个配置项 ===\n')

if (dead.length) {
  console.log('❌ 死开关（代码里从没读过 cfg.<key>）：')
  for (const r of dead) {
    console.log('   ' + r.key.padEnd(22) + (r.inClient ? '（界面有，宿主没读）' : '（界面也没有）'))
  }
  console.log('')
} else {
  console.log('✓ 没有死开关：每个键在宿主里至少被读过一次\n')
}

if (noDefault.length) {
  console.log('❌ 没有进 DEFAULTS（会被 normalize 丢掉）：')
  for (const r of noDefault) console.log('   ' + r.key)
  console.log('')
} else {
  console.log('✓ 所有键都在 DEFAULTS 里\n')
}

console.log('=== 逐项使用次数（宿主代码里 cfg.<key> 出现几次）===')
for (const r of results.sort((a, b) => a.uses - b.uses)) {
  const flag = (r.uses === 0 && !r.dynamicUse) ? '❌' : (r.uses === 0 && r.dynamicUse ? '✓ ' : (r.uses === 1 ? '⚠️ ' : '✓ '))
  const note = r.uses === 0 && r.dynamicUse ? '（动态下标 cfg[k]）' : ''
  console.log('  ' + flag + ' ' + r.key.padEnd(22) + ' ' + String(r.uses).padStart(2) + ' 次' + note + (r.inClient ? '  [界面有]' : ''))
}

process.exit(dead.length || noDefault.length ? 1 : 0)
