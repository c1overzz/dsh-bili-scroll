/**
 * test/mention-env.test.mjs —— 「配置 → 环境变量 → Python 真的读到」这条链的回归。
 *
 * ⭐ 评审第 5 条：内部 MCP 以前只传 uvEnv()，BILI_MENTION_* 全是空的 ⇒
 *   Python 那边 `_MENTION_NESTED` 默认 False ⇒ **评论闸门在宿主这条路根本不执行**。
 *
 * 这个测试不是 mock：它用真实的 lib/mention-env.mjs 算出 env，
 * 再**真的起一个 python 进程**导入 mcp_server.py，把那边读到的常量写回来比对。
 * （用文件传结果，不走管道 —— 有些环境里 node 的 piped stdio 会被拦。）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mentionEnvFrom } from '../lib/mention-env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const VENDOR = resolve(HERE, '..', 'vendor', 'bilibili-mcp')

function pythonBin() {
  const cand = process.env.BILI_CHECK_PYTHON
  if (cand) return cand
  const venv = join(process.env.USERPROFILE || '', '.dsh', 'bili-duty', '.venv', 'Scripts', 'python.exe')
  return existsSync(venv) ? venv : 'python'
}

/** 起一个真 python，把 mcp_server 里的 mention 常量写进文件 */
function readConstantsFromPython(env) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mention-env-'))
  const out = join(dir, 'out.json')
  const script = join(dir, 'probe.py')
  writeFileSync(script, [
    'import json, os, sys',
    'sys.path.insert(0, r"' + VENDOR.replace(/\\/g, '\\\\') + '")',
    'import mcp_server as m',
    'json.dump({',
    '  "mode": m._MENTION_MODE,',
    '  "name": m._MENTION_NAME,',
    '  "nested": bool(m._MENTION_NESTED),',
    '  "uid": m._MENTION_UID,',
    '}, open(r"' + out.replace(/\\/g, '\\\\') + '", "w", encoding="utf-8"))',
  ].join('\n'), 'utf8')
  const r = spawnSync(pythonBin(), [script], {
    env: { ...process.env, ...env },
    stdio: 'ignore',            // 不走管道，结果走文件
    timeout: 60000,
  })
  assert.equal(r.status, 0, 'python 探针没跑成功（status=' + r.status + '）')
  return JSON.parse(readFileSync(out, 'utf8'))
}

test('开关打开时：env 里 NESTED=1，Python 侧读到 True', () => {
  const cfg = { mentionMode: 'dm', mentionName: 'No3799', dmUid: 0, nestedMention: true, nestedPerRound: 2 }
  const env = mentionEnvFrom(cfg, 12345)
  assert.equal(env.BILI_MENTION_MODE, 'dm')
  assert.equal(env.BILI_MENTION_NAME, 'No3799')
  assert.equal(env.BILI_MENTION_UID, '12345', 'dmUid 没填时要退回按昵称查到的缓存')
  assert.equal(env.BILI_MENTION_NESTED, '1')

  const got = readConstantsFromPython(env)
  assert.equal(got.mode, 'dm')
  assert.equal(got.name, 'No3799')
  assert.equal(got.nested, true, 'Python 侧没读到 NESTED ⇒ 闸门又不会执行了')
  assert.equal(got.uid, 12345)
})

test('开关关闭时：NESTED 是空串，Python 侧读到 False', () => {
  const env = mentionEnvFrom({ mentionMode: 'top', mentionName: 'No3799', nestedMention: false, nestedPerRound: 1 })
  assert.equal(env.BILI_MENTION_NESTED, '')
  const got = readConstantsFromPython(env)
  assert.equal(got.nested, false)
  assert.equal(got.mode, 'top')
})

test('每轮 0 条 ⇒ 等于关（避免"开了但一条不发"的假开关）', () => {
  const env = mentionEnvFrom({ nestedMention: true, nestedPerRound: 0 })
  assert.equal(env.BILI_MENTION_NESTED, '')
  assert.equal(readConstantsFromPython(env).nested, false)
})

test('dmUid 显式填了就以它为准，不被缓存覆盖', () => {
  const env = mentionEnvFrom({ dmUid: 999, nestedMention: false }, 12345)
  assert.equal(env.BILI_MENTION_UID, '999')
  assert.equal(readConstantsFromPython(env).uid, 999)
})
