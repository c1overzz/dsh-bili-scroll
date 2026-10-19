// WPR2 的轻量断言：直接 import 上游仓库里的 index.js（纯函数部分），不启动宿主
import { mentionListOf, dmListOf, mcpToolList, normWindows, normEveryDays, migrateDelivery } from '../index.js'

let bad = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got); const w = JSON.stringify(want)
  if (g === w) { console.log(`✓ ${name}`); return }
  bad++; console.log(`✗ ${name}\n    got  ${g}\n    want ${w}`)
}

// 老键兜底
eq('mentionName 兜底', mentionListOf({ mentionName: '本鱼' }), ['本鱼'])
// 新键优先
eq('mentionNames 优先', mentionListOf({ mentionName: 'a', mentionNames: ['b', ' c ', ''] }), ['b', 'c'])
// 去重
eq('去重', mentionListOf({ mentionNames: ['x', 'x', 'y'] }), ['x', 'y'])
// 空
eq('全空', mentionListOf({ mentionName: '', mentionNames: [] }), [])
// 截断 10 个
eq('最多 10 个', mentionListOf({ mentionNames: Array.from({ length: 15 }, (_, i) => 'n' + i) }).length, 10)

// ── 私信名单 ──
eq('dmUid 兜底', dmListOf({ dmUid: 123 }), [123])
eq('dmUids 优先 + 去重', dmListOf({ dmUid: 9, dmUids: ['1', '2', '2'] }), [1, 2])
eq('dmUids 过滤非数字', dmListOf({ dmUids: ['0', '-3', 'abc', '42'] }), [42])

// ── 白名单 ──
const has = (l) => l.includes('bili_send_message')
eq('私信名单非空 ⇒ 白名单带上发送工具', has(mcpToolList({ dmMode: 'only', dmUids: ['1'] })), true)
eq('私信关着 ⇒ 不给发送工具', has(mcpToolList({ dmMode: 'off', dmUids: ['1'] })), false)
eq('私信开着但没名单 ⇒ 也不给', has(mcpToolList({ dmMode: 'both' })), false)
eq('autoDm 开 + 名单 ⇒ 白名单带上发送工具', has(mcpToolList({ autoDm: true, dmUids: ['1'] })), true)
eq('autoDm 关 ⇒ 哪怕名单有也不给', has(mcpToolList({ autoDm: false, dmUids: ['1'] })), false)
eq('迁移：dmMode=only ⇒ 关公开评论、开私信', migrateDelivery({ dmMode: 'only' }), { autoComment: false, autoDm: true })
eq('迁移：dmMode=both ⇒ 开私信', migrateDelivery({ dmMode: 'both' }), { autoDm: true })
eq('迁移：dmMode=off ⇒ 关私信', migrateDelivery({ dmMode: 'off' }), { autoDm: false })
eq('迁移：新键优先于老键', migrateDelivery({ dmMode: 'off', autoDm: true }), { autoDm: true })

// ── 谷时窗口 ──
eq('窗口归一化：补零', normWindows({ noon: { start: '9:5', end: '14:00' } }).noon.start, '09:05')
eq('窗口归一化：非法丢掉', normWindows({ noon: { start: 'x', end: '14:00' } }), {})
eq('窗口归一化：只给一半也丢', normWindows({ night: { start: '18:00' } }), {})
eq('窗口归一化：钳到 23:59', normWindows({ night: { start: '99:99', end: '01:00' } }).night.start, '23:59')

// ── 每几天跑一轮 ──
eq('间隔：默认 1', normEveryDays(undefined), 1)
eq('间隔：字符串也认', normEveryDays('3'), 3)
eq('间隔：0 / 负数 / 非数字 ⇒ 回 1', [normEveryDays(0), normEveryDays(-2), normEveryDays('x')], [1, 1, 1])
eq('间隔：上限 9', normEveryDays(99), 9)

process.exit(bad ? 1 : 0)
