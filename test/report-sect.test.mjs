// node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replaceSect } from '../lib/report-sect.mjs'

const NOTES = '## 投递\n\n- 新备注\n'
const VERIFY = '\n## 评论复核（宿主自动跑的，不是那一轮自己说的）\n\n- 新结果'

test('第二轮以普通文字开头 ⇒ 文字和后面的 BV 都保住，只换这一节', () => {
  const cur = '# 日报\n\n### BV1aaaaaaaaa\n正文\n\n## 投递\n\n- 旧备注\n补充一句\n\n### BV1bbbbbbbbb\n正文二\n'
  assert.equal(replaceSect(cur, '## 投递', NOTES),
    '# 日报\n\n### BV1aaaaaaaaa\n正文\n\n## 投递\n\n- 新备注\n\n补充一句\n\n### BV1bbbbbbbbb\n正文二\n\n')
})

test('第二轮直接追加 `- ` 列表 ⇒ 不被当成这一节吞掉', () => {
  let t = replaceSect('# 日报\n\n正文\n', '## 投递', NOTES)
  t += '- 模型自己的一条\n'
  t = replaceSect(t, '## 投递', '## 投递\n\n- 再新一点\n')
  assert.equal(t, '# 日报\n\n正文\n\n## 投递\n\n- 再新一点\n\n- 模型自己的一条\n\n')
})

test('子串不算：### 投递情况、## 投递情况、### 评论复核笔记', () => {
  for (const [head, marker, block] of [['### 投递情况', '## 投递', NOTES], ['## 投递情况', '## 投递', NOTES], ['### 评论复核笔记', '## 评论复核', VERIFY]]) {
    const cur = `# 日报\n\n${head}\n模型自己的小节\n\n### BV1ddddddddd\n正文\n`
    const body = block.trim()
    assert.equal(replaceSect(cur, marker, block), cur.trimEnd() + '\n\n' + body + '\n\n')
  }
})

test('带括号的标题算同一节', () => {
  const cur = '# 日报\n\n## 评论复核（旧的说明）\n\n- 旧结果\n\n### BV1ddddddddd\n正文\n'
  assert.equal(replaceSect(cur, '## 评论复核', VERIFY),
    '# 日报\n\n## 评论复核（宿主自动跑的，不是那一轮自己说的）\n\n- 新结果\n\n### BV1ddddddddd\n正文\n\n')
})

test('多轮留下的重复节收成一节，放在第一个出现的位置', () => {
  const cur = '# 日报\n\n## 投递\n\n- 一\n\n### BV1aaaaaaaaa\n正文\n\n## 投递\n\n- 二\n\n### BV1bbbbbbbbb\n正文二\n'
  assert.equal(replaceSect(cur, '## 投递', NOTES),
    '# 日报\n\n## 投递\n\n- 新备注\n\n### BV1aaaaaaaaa\n正文\n\n### BV1bbbbbbbbb\n正文二\n\n')
})

test('后面还有别的节 ⇒ 不动它', () => {
  const cur = '# 日报\n\n## 投递\n\n- 旧备注\n\n## 评论复核（说明）\n\n- 结果\n'
  assert.equal(replaceSect(cur, '## 投递', NOTES), '# 日报\n\n## 投递\n\n- 新备注\n\n## 评论复核（说明）\n\n- 结果\n\n')
})

test('这一节换完后别的宿主节留在文件尾 ⇒ 也留空行，下一轮紧贴写的 `- ` 不被吞', () => {
  let t = replaceSect('# 日报\n\n正文\n', '## 投递', NOTES)
  t = replaceSect(t, '## 评论复核', VERIFY)
  t = replaceSect(t, '## 投递', NOTES)
  t += '- 模型自己的一条\n'
  t = replaceSect(t, '## 评论复核', VERIFY)
  assert.ok(t.includes('- 模型自己的一条'))
})

test('没有这一节 ⇒ 加在文件尾，后面留一个空行', () => {
  assert.equal(replaceSect('# 日报\n\n正文\n', '## 投递', NOTES), '# 日报\n\n正文\n\n## 投递\n\n- 新备注\n\n')
})

test('标题下面不是列表 ⇒ 只换标题，下面的内容原样留着', () => {
  const cur = '# 日报\n\n## 投递\n\n模型自己写的一段\n'
  assert.equal(replaceSect(cur, '## 投递', NOTES), '# 日报\n\n## 投递\n\n- 新备注\n\n模型自己写的一段\n\n')
})

test('CRLF 的报告也认得出这一节', () => {
  const cur = '# 日报\r\n\r\n## 投递\r\n\r\n- 旧备注\r\n\r\n### BV1aaaaaaaaa\r\n正文\r\n'
  assert.equal(replaceSect(cur, '## 投递', NOTES), '# 日报\n\n## 投递\n\n- 新备注\n\n### BV1aaaaaaaaa\r\n正文\n\n')
})
