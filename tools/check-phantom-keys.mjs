// 对账：宿主代码里读过的 cfg.<键>，是不是都真在 schema / DEFAULTS 里。
// 幽灵键 = 代码里读、schema 里没有 ⇒ 永远 undefined ⇒ 那个开关是假的。
import { readFileSync } from 'node:fs'

const FILE = process.argv[2] || 'D:/cs0.1/bili-fork/index.js'
const src = readFileSync(FILE, 'utf8')

// 1) schema：形如 `  key: z.boolean()...`
const schemaKeys = new Set()
for (const m of src.matchAll(/^\s{2}([A-Za-z_][\w]*):\s*z\./gm)) schemaKeys.add(m[1])

// 2) DEFAULTS 那一行对象
const defM = src.match(/const DEFAULTS\s*=\s*\{([\s\S]*?)\n\s*\}/)
const defaultKeys = new Set()
if (defM) for (const m of defM[1].matchAll(/([A-Za-z_][\w]*)\s*:/g)) defaultKeys.add(m[1])

// 3) 代码里读过的
const readKeys = new Map()
src.split('\n').forEach((l, i) => {
  if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
  for (const m of l.matchAll(/\bcfg\.([A-Za-z_][\w]*)/g)) {
    if (!readKeys.has(m[1])) readKeys.set(m[1], [])
    readKeys.get(m[1]).push(i + 1)
  }
})

console.log('schema 键:', schemaKeys.size, '| DEFAULTS 键:', defaultKeys.size, '| 代码读取键:', readKeys.size)
console.log()

const phantom = [...readKeys.keys()].filter((k) => !schemaKeys.has(k) && !defaultKeys.has(k))
const schemaOnly = [...schemaKeys].filter((k) => !readKeys.has(k))
const defaultsOnly = [...defaultKeys].filter((k) => !schemaKeys.has(k))

console.log('=== 幽灵键（读了但 schema/默认值里都没有 ⇒ 永远 undefined）===')
if (!phantom.length) console.log('  无')
for (const k of phantom) console.log(`  ⚠️ ${k}  ← 行 ${readKeys.get(k).join(', ')}`)

console.log()
console.log('=== schema 有、代码没读（界面上有开关但宿主不用）===')
if (!schemaOnly.length) console.log('  无')
for (const k of schemaOnly) console.log(`  ⚠️ ${k}`)

console.log()
console.log('=== DEFAULTS 有、schema 没有 ===')
if (!defaultsOnly.length) console.log('  无')
for (const k of defaultsOnly) console.log(`  ⚠️ ${k}`)
