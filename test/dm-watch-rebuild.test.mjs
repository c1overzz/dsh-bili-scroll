/**
 * test/dm-watch-rebuild.test.mjs —— 改了私信检查间隔，真的马上生效吗？
 *
 * 2026-10-30 查出来的第 2 处「开关写了但驱动的东西没重建」：
 *   私信定时器只在插件挂载时按当时的 dmWatchMinutes 建一次。
 *   用户把 1 分钟改成 10 分钟 ⇒ 界面改了、dmTick 每跳也重读配置，
 *   但**定时器的周期没变** ⇒ 实际还是每分钟查一次 ✗
 *
 * 这里盯三件事：
 *   ① persistCfg 里真的对 dmWatchMinutes / dmWatch 做了重建
 *   ② 重建调用排在写宿主之前（写宿主可能抛错/慢，别让它挡住重建）
 *   ③ startDmWatch 必须是**函数声明**（会提升）——
 *      它写在 persistCfg 后面 2000 多行，要是写成 `const startDmWatch = ...`
 *      就会 TDZ 报错：用户一点保存就炸。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = readFileSync(resolve(HERE, '..', 'index.js'), 'utf8')

const isCode = (l) => !/^\s*(\/\/|\*|\/\*)/.test(l)
const code = INDEX.split('\n').filter(isCode).join('\n')

/** 取 persistCfg 的函数体 */
function persistBody() {
  const lines = INDEX.split('\n')
  const start = lines.findIndex((l) => l.includes('const persistCfg = async'))
  assert.ok(start >= 0, '没找到 persistCfg')
  const out = []
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i])
    depth += (lines[i].match(/\{/g) || []).length
    depth -= (lines[i].match(/\}/g) || []).length
    if (i > start && depth <= 0) break
  }
  return out.join('\n')
}

test('startDmWatch 是函数声明（会提升）—— 否则 persistCfg 里调用会 TDZ 报错', () => {
  assert.match(code, /function startDmWatch\s*\(/, 'startDmWatch 必须是 function 声明')
  assert.equal(/const\s+startDmWatch\s*=/.test(code), false, 'startDmWatch 不能写成 const 赋值（TDZ）')
  assert.equal(/let\s+startDmWatch\s*=/.test(code), false, 'startDmWatch 不能写成 let 赋值（TDZ）')
})

test('改间隔 / 开关会重建私信定时器', () => {
  const body = persistBody()
  assert.match(body, /'dmWatchMinutes'\s+in\s+clean/, 'persistCfg 没有处理 dmWatchMinutes')
  assert.match(body, /'dmWatch'\s+in\s+clean/, 'persistCfg 没有处理 dmWatch')
  assert.match(body, /startDmWatch\(\)/, 'persistCfg 里没有重建定时器')
})

test('重建排在写宿主之前（写宿主慢或失败也不该挡住重建）', () => {
  const body = persistBody()
  const rebuild = body.indexOf('startDmWatch()')
  const writeHost = body.indexOf('saveCfgHost(clean)')
  assert.ok(rebuild >= 0, '没找到重建调用')
  assert.ok(writeHost >= 0, '没找到写宿主调用')
  assert.ok(rebuild < writeHost, '重建必须在 saveCfgHost 之前')
})

test('重建失败不能把保存搞失败（必须有 try/catch）', () => {
  const body = persistBody()
  const at = body.indexOf('startDmWatch()')
  const around = body.slice(Math.max(0, at - 220), at + 220)
  assert.match(around, /try\s*\{/, '重建外面没有 try')
  assert.match(around, /catch/, '重建没有 catch')
})

test('startDmWatch 每次都先清掉旧定时器（不会越建越多）', () => {
  const lines = INDEX.split('\n')
  const start = lines.findIndex((l) => l.includes('function startDmWatch'))
  assert.ok(start >= 0)
  const body = lines.slice(start, start + 12).join('\n')
  const clear = body.indexOf('clearInterval(dmTimer)')
  const set = body.indexOf('setInterval(')
  assert.ok(clear >= 0, 'startDmWatch 没清旧定时器')
  assert.ok(set >= 0, 'startDmWatch 没建定时器')
  assert.ok(clear < set, '必须先 clearInterval 再 setInterval')
})

test('间隔仍然有下限（0 或负数不能变成疯狂轮询）', () => {
  assert.match(code, /Math\.max\(1,\s*Number\(cfg\.dmWatchMinutes\)\s*\|\|\s*1\)/, 'dmWatchMinutes 没有钳到 ≥1')
})
