// node --test test/
// 用桩 ctx 跑真实的 index.js：/run 走真实的 runDuty（dsh 换成下面的假脚本），/verify 走真实的 runVerify。
// 数据全是合成的；fetch 也换成了桩，整个文件不联网。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayKey } from '../lib/state.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-rounds-'))
// 只在 import 期间换 DSH_HOME：别让 hostdeps 去翻这台机器真实的 ~/.dsh。之后的路径用桩 ctx 的 dshHomePath，不读它
const realDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'import-home')
const { apply } = await import('../index.js').finally(() => {
  if (realDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realDshHome
})

// 假 dsh：和 duty_report_append 一样，把这一轮的正文原样追加到当天日报末尾
const fakeDsh = join(root, 'fake-dsh.mjs')
writeFileSync(fakeDsh, `
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const home = process.env.BILI_DUTY_HOME, day = process.env.BILI_DUTY_RUN_DAY
const body = readFileSync(join(home, 'next-round.txt'), 'utf8').trim()
const report = join(home, 'out', day + '.md')
appendFileSync(report, (existsSync(report) ? '' : '# 刷B站日报 ' + day + '\\n\\n') + body + '\\n')
`)

const RPID = 318000000001
let commentVisible = false
const strayFetches = []
globalThis.fetch = async (url) => {
  const u = String(url)
  const reply = (data) => new Response(JSON.stringify({ code: 0, data }))
  if (u.includes('/x/web-interface/view')) return reply({ aid: 1, owner: { mid: 2 }, title: '合成标题' })
  if (u.includes('/x/v2/reply/main')) return reply({ replies: commentVisible ? [{ rpid: RPID, like: 0 }] : [] })
  strayFetches.push(u)
  throw new Error('这个测试不该联网：' + u)
}

const disposers = []
after(() => {
  for (const d of disposers) { try { d() } catch { /* 收摊 */ } }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  assert.deepEqual(strayFetches, [])
})

/** 起一个插件实例（默认配置 + cfg），返回驱动它的几个小函数 */
function startHost({ cfg = {}, brokenProfile = false } = {}) {
  const home = mkdtempSync(join(root, 'home-'))
  const stateDir = join(home, 'bili-duty')
  mkdirSync(join(stateDir, 'out'), { recursive: true })
  const writeCfg = (c) => writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ dshBin: fakeDsh, dmWatch: false, manualCooldownMin: 0, dmUid: 12345, ...c }))
  writeCfg(cfg)
  if (brokenProfile) { mkdirSync(join(home, 'profiles')); writeFileSync(join(home, 'profiles', 'bili-duty'), '这里是个文件，铺 profile 会失败') }
  let handler = null
  apply({
    get: (k) => (k === 'dshHomePath' ? (...seg) => join(home, ...seg) : undefined),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    tools: { register: () => () => {} },
    webServer: { register: (r) => { handler = r.handler; return () => {} } },
  }, {})
  const call = (path) => new Promise((resolve, reject) => {
    const req = { method: 'POST', url: path, headers: {}, on: (ev, cb) => { if (ev === 'end') cb() } }
    handler(req, { writeHead: () => {}, end: (s) => resolve(JSON.parse(s)) }).catch(reject)
  })
  const logFile = join(stateDir, 'duty.log')
  const roundsDone = () => { try { return readFileSync(logFile, 'utf8').split('刷B站结束（').length - 1 } catch { return 0 } }
  const report = join(stateDir, 'out', `${dayKey()}.md`)
  return {
    stateDir,
    writeCfg,
    report: () => readFileSync(report, 'utf8'),
    setReport: (t) => writeFileSync(report, t),
    verify: () => call('/api/bili-duty/verify'),
    /** 跑一轮：这一轮模型往日报里追加 body，等退出处理（写 ## 投递 等）跑完才返回 */
    async round(body) {
      writeFileSync(join(stateDir, 'next-round.txt'), body)
      const before = roundsDone()
      const r = await call('/api/bili-duty/run')
      assert.equal(r.started, true, JSON.stringify(r))
      const deadline = Date.now() + 30_000
      while (roundsDone() === before) {
        assert.ok(Date.now() < deadline, '这一轮 30 秒还没结束')
        await new Promise((f) => setTimeout(f, 20))
      }
    },
  }
}

const block = (bv, t) => `### ${bv}\n标题：合成标题 ${t}\n**档位**：可以看\n合成正文 ${t}\n`
const picks = (t) => [...t.matchAll(/^#{2,3}[ \t]*(BV[0-9A-Za-z]{10})/gm)].map((m) => m[1])
const count = (t, re) => (t.match(re) || []).length
const fakeCred = (h) => writeFileSync(join(h.stateDir, 'bili_credential.json'), JSON.stringify({ sessdata: 'synthetic', bili_jct: 'x', buvid3: 'y' }))

// 判重表里记了 BV 但没有 rpid：verifyRecent 走「还没发过评论」那条提前返回
const noCommentYet = (h) => {
  writeFileSync(join(h.stateDir, 'seen.md'), `| ${dayKey()} | BV1aaaaaaaaa | 合成 | 合成UP | 挑了 |\n`)
  fakeCred(h)
}
// 判重表里有一条发过的评论
const oneComment = (h) => {
  writeFileSync(join(h.stateDir, 'seen.md'), `| ${dayKey()} | BV1ccccccccc | 合成 | 合成UP | 评论 | ${RPID} |\n`)
  fakeCred(h)
}

test('A：默认只私信、没发过评论，第二轮只有 ### BV ⇒ 收尾写投递不剪第二轮', async () => {
  const h = startHost()
  noCommentYet(h)
  await h.round(block('BV1aaaaaaaaa', '一轮') + '\n结尾总结一轮')
  await h.verify()
  await h.round(block('BV1bbbbbbbbb', '二轮') + '\n结尾总结二轮')
  const t = h.report()
  assert.deepEqual(picks(t), ['BV1aaaaaaaaa', 'BV1bbbbbbbbb'])
  assert.ok(t.includes('结尾总结二轮'))
  assert.equal(count(t, /^## 投递$/gm), 1)
  assert.equal(JSON.parse(readFileSync(join(h.stateDir, 'state.json'), 'utf8')).picked, 2, '全天配额要把第二轮算进去')
})

test('B：第一轮有复核节，第二轮只有 ### BV ⇒ 再次复核替换时不剪第二轮', async () => {
  const h = startHost()
  oneComment(h)
  commentVisible = false
  await h.round(block('BV1ccccccccc', '一轮'))
  assert.equal((await h.verify()).checked.length, 1)
  assert.ok(h.report().includes('没查到'))
  await h.round(block('BV1ddddddddd', '二轮'))
  commentVisible = true
  assert.equal((await h.verify()).checked.length, 1)
  const t = h.report()
  assert.deepEqual(picks(t), ['BV1ccccccccc', 'BV1ddddddddd'])
  assert.equal(count(t, /^## 评论复核/gm), 1)
  assert.ok(t.includes('公开可见') && !t.includes('没查到'), '复核节要换成新结果')
})

test('C：模型自己写了 ## 标题（一直不丢的排布）⇒ 照样不丢', async () => {
  const h = startHost()
  await h.round('## 第一轮\n\n' + block('BV1eeeeeeeee', '一轮'))
  await h.round('## 第二轮\n\n' + block('BV1fffffffff', '二轮'))
  const t = h.report()
  assert.deepEqual(picks(t), ['BV1eeeeeeeee', 'BV1fffffffff'])
  assert.equal(count(t, /^## 投递$/gm), 1)
})

test('C2：### BV 在前、模型自己的 ## 标题在后 ⇒ 前面的 BV 块也不丢', async () => {
  const h = startHost()
  await h.round(block('BV1aaaaaaaaa', '一轮'))
  await h.round(block('BV1bbbbbbbbb', '二轮') + '\n## 小结\n今天不错')
  assert.deepEqual(picks(h.report()), ['BV1aaaaaaaaa', 'BV1bbbbbbbbb'])
})

test('D：没发过评论 ⇒ 复核跑几次报告都不变（#135 的重复行）', async () => {
  const h = startHost()
  noCommentYet(h)
  await h.round(block('BV1aaaaaaaaa', '一轮'))
  const before = h.report()
  for (let i = 0; i < 3; i++) {
    const r = await h.verify()
    assert.equal(h.report(), before)
    assert.equal(r.checked.length, 0)
    assert.match(r.text, /还没发过评论/, '设置页还要靠这句提示')
    assert.equal(r.report, '')
  }
})

test('E：记录全部已确认可见且在 7 天内 ⇒ 复核不把已有的真结果冲掉', async () => {
  const h = startHost()
  oneComment(h)
  writeFileSync(join(h.stateDir, 'verify-state.json'), JSON.stringify({ [RPID]: { visible: true, at: Date.now(), how: '合成', bv: 'BV1ccccccccc', likes: 0 } }))
  const before = `# 日报\n\n### BV1ccccccccc\n正文\n\n## 评论复核（宿主自动跑的，不是那一轮自己说的）\n\n- \`BV1ccccccccc\` rpid **${RPID}** —— 公开可见（赞 0） · 依据：合成\n`
  h.setReport(before)
  for (let i = 0; i < 2; i++) {
    const r = await h.verify()
    assert.equal(r.checked.length, 0)
    assert.match(r.text, /都复核过了/)
  }
  assert.equal(h.report(), before)
})

test('子串：模型写了 ### 投递情况 ⇒ 不算 ## 投递 那一节', async () => {
  const h = startHost()
  await h.round('### 投递情况\n模型自己的小节\n\n' + block('BV1ddddddddd', '一轮'))
  const t = h.report()
  assert.deepEqual(picks(t), ['BV1ddddddddd'])
  assert.ok(t.includes('### 投递情况\n模型自己的小节'))
  assert.equal(count(t, /^#$/gm), 0, '不能留下孤立的 #')
  assert.equal(count(t, /^## 投递$/gm), 1)
})

test('#155：改好配置后，上一轮的备注不再写进后面的报告，也不重复累积', async () => {
  const h = startHost({ cfg: { dmUid: 0 } })
  await h.round(block('BV1aaaaaaaaa', '一轮'))
  assert.ok(h.report().includes('⛔ 这一轮什么都不会发出去'))
  h.writeCfg({ dmUid: 12345 })
  await h.round(block('BV1bbbbbbbbb', '二轮'))
  await h.round(block('BV1ccccccccc', '三轮'))
  const t = h.report()
  assert.ok(!t.includes('⛔'), '修好之后旧警告不该还在')
  assert.equal(count(t, /^- 投递：只私信（已找到收件人）$/gm), 1)
})

test('#155：启动时 profile 铺不上的告警要一直留着（修好要重启才变）', async () => {
  const h = startHost({ brokenProfile: true })
  await h.round(block('BV1aaaaaaaaa', '一轮'))
  await h.round(block('BV1bbbbbbbbb', '二轮'))
  const t = h.report()
  assert.equal(count(t, /^- ⚠️ 最小权限 profile 没铺上/gm), 1)
  assert.equal(count(t, /^- 投递：只私信（已找到收件人）$/gm), 1)
  assert.deepEqual(picks(t), ['BV1aaaaaaaaa', 'BV1bbbbbbbbb'])
})
