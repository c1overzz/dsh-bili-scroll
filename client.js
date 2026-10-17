/**
 * dsh-bili-scroll —— 浏览器半端（**设置在「设置」里的一页**）
 * ============================================================================
 * ⭐ **client bundle 不是 ESM，是自注册脚本**（2026-10-14 从官方包里挖到的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ **怎么进「设置」**（抄第三方插件 `dsh-meme/client.js`，2026-10-14 使用者指出位置不对后才查到）：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'bili-scroll', order: 30, label: '刷B站' },   // label = 左侧导航那一项
 *       () => h(Panel),
 *     ))
 *
 *   ⇒ **别自己糊一个标题栏按钮 + 全屏 overlay** ✗（第一版就是这么干的，使用者一眼看出"跟别的插件不一样"）。
 *
 * 这一页要满足使用者 2026-10-14 说的形状：
 *   · **总开关 → 打开之后下面才展开子开关**（峰谷自动刷 → 中午 / 晚上）
 *   · **数字项要能自己填**（定量刷：每天几条）
 *   · **账号绑定必须在设置页里**（扫码登录 + 二维码直接显示在页里）
 *   · 会发东西出去的（自动评论）、要下大模型的（本地转写）**默认关**
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/bili-duty'
    const jget = async (p) => (await fetch(API + p, { credentials: 'same-origin' })).json()
    const jpost = async (p, body) => (await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })).json()

    const CSS = `
[data-bd-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:1080px;}
[data-bd-sec]{display:flex;flex-direction:column;gap:8px;}
[data-bd-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-row]{display:flex;align-items:center;gap:10px;}
[data-bd-grow]{flex:1;min-width:0;}
[data-bd-label]{font-size:13px;}
[data-bd-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-bd-sw][data-on]{background:#3b82f6;}
[data-bd-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-bd-sw][data-on] i{left:19px;}
[data-bd-sw][disabled]{opacity:.45;cursor:default;}
[data-bd-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-bd-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-bd-input]:focus{outline:none;border-color:#3b82f6;}
[data-bd-num]{width:88px;text-align:center;}
[data-bd-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-bd-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-bd-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-bd-btn][disabled]{opacity:.5;cursor:default;}
[data-bd-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-msg][data-warn]{color:#f59e0b;}
[data-bd-msg][data-good]{color:#22c55e;}
[data-bd-qr]{display:flex;gap:14px;align-items:flex-start;}
[data-bd-qr] img{width:150px;height:150px;border-radius:8px;background:#fff;padding:6px;}
[data-bd-pre]{margin:6px 0 0;padding:8px 9px;border-radius:8px;max-height:170px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bd-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-bd-badge]{font-size:11px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bd-badge][data-tone="ok"]{color:#22c55e;}
[data-bd-badge][data-tone="off"]{color:#f59e0b;}
[data-bd-field]{display:flex;flex-direction:column;gap:6px;}
[data-bd-grow2]{flex:1;min-width:0;}
[data-bd-dim]{opacity:.5;}
[data-bd-note][data-warn]{color:#f59e0b;}
/* ── 多标签输入（2026-10-18）── */
[data-bd-chips]{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));}
[data-bd-chips]:focus-within{border-color:#3b82f6;}
[data-bd-chip]{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:3px 4px 3px 9px;
  border-radius:999px;font-size:12px;line-height:18px;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.26));
  color:var(--dsw-alias-label-primary,inherit);}
[data-bd-chip-t]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bd-chip-x]{flex:none;width:16px;height:16px;padding:0;border:0;border-radius:50%;cursor:pointer;
  font-size:12px;line-height:1;font-family:inherit;background:transparent;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-chip-x]:hover{background:rgba(239,68,68,.22);color:#ef4444;}
[data-bd-chip-in]{flex:1;min-width:90px;padding:3px 2px;border:0;background:transparent;color:inherit;
  font-size:12px;font-family:inherit;}
[data-bd-chip-in]:focus{outline:none;}
/* ── 时段编辑器（2026-10-18）── */
[data-bd-wins]{display:flex;flex-direction:column;gap:8px;}
[data-bd-win]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
[data-bd-win-n]{flex:none;width:18px;height:18px;border-radius:50%;font-size:11px;line-height:18px;text-align:center;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.2));
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-win][data-bad] [data-bd-win-n]{background:rgba(245,158,11,.25);color:#f59e0b;}
[data-bd-win-dash]{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-time]{flex:1;min-width:96px;box-sizing:border-box;padding:6px 8px;border-radius:8px;font-size:12px;
  font-family:inherit;color:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));}
[data-bd-time]:focus{outline:none;border-color:#3b82f6;}
[data-bd-btn][data-bd-tiny]{flex:none;padding:6px 10px;}
[data-bd-warn]{font-size:11px;line-height:17px;padding:7px 9px;border-radius:8px;color:#f59e0b;
  background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);}
[data-bd-tally]{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-tally][data-soft]{opacity:.7;}
[data-bd-tabs]{position:sticky;top:0;z-index:5;display:flex;gap:4px;padding:4px 0 10px;overflow-x:auto;-webkit-overflow-scrolling:touch;}
[data-bd-tab]{flex:none;padding:6px 16px;border-radius:8px;font-size:13px;cursor:pointer;border:0;font-family:inherit;
  background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-tab]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));}
[data-bd-tab][data-on]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));color:inherit;font-weight:600;}
[data-bd-pane-settings]{display:flex;flex-direction:column;gap:18px;max-width:640px;}
[data-bd-pane-report],[data-bd-pane-debug]{display:flex;flex-direction:column;gap:14px;}
[data-bd-sum]{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;}
[data-bd-stat]{padding:9px 12px;border-radius:10px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));}
[data-bd-stat] b{display:block;font-size:19px;line-height:25px;font-weight:600;}
[data-bd-stat][data-tone="ok"] b{color:#22c55e;}
[data-bd-stat] span{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-chips]{display:flex;gap:6px;overflow-x:auto;padding:2px 0 6px;-webkit-overflow-scrolling:touch;}
[data-bd-chip]{flex:none;padding:5px 10px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;color:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));background:transparent;}
[data-bd-chip][data-on]{background:#3b82f6;border-color:#3b82f6;color:#fff;font-weight:600;}
[data-bd-round]{display:flex;flex-direction:column;gap:10px;}
[data-bd-fold]{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:10px;overflow:hidden;}
[data-bd-sec-head]{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;padding:9px 12px;
  font-size:13px;font-weight:600;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-bd-sec-head]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));}
[data-bd-sec-head] i{font-style:normal;font-size:10px;opacity:.55;transition:transform .15s;display:inline-block;}
[data-bd-sec-head][data-open] i{transform:rotate(90deg);}
[data-bd-fold-body]{display:flex;flex-direction:column;gap:8px;padding:10px 12px;}
[data-bd-card]{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));border-radius:9px;padding:9px 11px;
  display:flex;flex-direction:column;gap:5px;}
[data-bd-card] a{color:#3b82f6;text-decoration:none;font-weight:600;font-size:13px;line-height:18px;}
[data-bd-card] a:hover{text-decoration:underline;}
[data-bd-meta]{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);align-items:center;}
[data-bd-bv]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;padding:1px 5px;border-radius:4px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,#c9ccd1);text-decoration:none;}
[data-bd-quote]{font-size:12px;line-height:17px;padding-left:8px;border-left:2px solid #3b82f6;color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bd-prose]{font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bd-li]{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:17px;padding:3px 0;flex-wrap:wrap;}
[data-bd-kvrow]{font-size:12px;line-height:18px;display:flex;gap:8px;flex-wrap:wrap;}
[data-bd-kvkey]{flex:none;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-feed]{display:flex;flex-direction:column;gap:2px;max-height:380px;overflow:auto;font-size:12px;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.16));border-radius:9px;padding:6px;}
[data-bd-ev]{display:flex;gap:8px;align-items:baseline;padding:3px 6px;border-radius:6px;flex-wrap:wrap;}
[data-bd-ev][data-bad]{background:rgba(239,68,68,.13);}
[data-bd-ev][data-round]{background:rgba(59,130,246,.14);}
[data-bd-ev] time{flex:none;font-size:11px;opacity:.55;font-family:ui-monospace,monospace;}
[data-bd-ev][data-mono] span{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;}
[data-bd-pill]{flex:none;font-size:10px;padding:1px 6px;border-radius:999px;line-height:15px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.2));}
[data-bd-pill][data-ok]{background:rgba(34,197,94,.18);color:#22c55e;}
[data-bd-pill][data-bad]{background:rgba(239,68,68,.2);color:#f87171;}
[data-bd-pill][data-run]{background:rgba(59,130,246,.2);color:#60a5fa;}
[data-bd-pre][data-tall]{max-height:520px;}

/* ── 目录浏览（2026-10-18）：服务器 / NAS 上没有桌面，"打开文件夹"没意义，
      改成在设置页里把目录真列出来 —— 能看、能下载 ✓ ── */
[data-bd-files]{display:flex;flex-direction:column;gap:1px;max-height:340px;overflow:auto;padding:5px;
  border:1px solid var(--dsw-alias-border-secondary,#00000014);border-radius:10px;}
[data-bd-file]{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;
  font-size:12px;line-height:17px;}
[data-bd-file]:hover{background:var(--dsw-alias-bg-hover,#0000000a);}
[data-bd-file-n]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bd-file-m]{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px;font-variant-numeric:tabular-nums;
  white-space:nowrap;}
[data-bd-file][data-cur]{background:var(--dsw-alias-bg-hover,#0000000a);}
[data-bd-crumb]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;
  color:var(--dsw-alias-label-secondary,#6b7280);}
[data-bd-crumb] b{font-weight:500;color:var(--dsw-alias-label-primary,#111827);}
[data-bd-narrow]{width:auto;max-width:200px;}

/* ⭐ 窄屏（手机）：少几列、字号小一点、按钮挤一挤 —— 别横向溢出 */
@media (max-width:640px){
  [data-bd-page]{gap:14px;padding:0 0 10px;}
  [data-bd-pane-settings]{gap:16px;}
  [data-bd-sum]{grid-template-columns:repeat(3,1fr);gap:6px;}
  [data-bd-stat]{padding:7px 9px;}
  [data-bd-stat] b{font-size:16px;line-height:21px;}
  [data-bd-stat] span{font-size:10px;}
  [data-bd-row]{gap:8px;}
  [data-bd-btn]{padding:6px 9px;font-size:11px;}
  [data-bd-tab]{padding:6px 12px;}
  [data-bd-num]{width:70px;}
  [data-bd-narrow]{max-width:130px;}
  [data-bd-feed]{max-height:300px;}
  [data-bd-files]{max-height:260px;}
}
`

    // ⚠️ 与 lib/state.mjs 的 WINDOWS 保持一致（官方口径：工作日 9–12、14–18 是高峰，其余都是谷时）
    const DEFAULT_WINDOWS = {
      noon: { label: '中午谷时', start: '12:00', end: '14:00' },
      night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
    }

    /* ────────────── 小组件 ────────────── */

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-bd-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-bd-row': '' },
        h('div', { 'data-bd-grow': '' },
          h('div', { 'data-bd-label': '' }, label),
          note ? h('div', { 'data-bd-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    /** 数字项（label + 说明 + 右边一个窄框）—— 原来这段 JSX 在页面里手抄了 3 遍 */
    function NumRow({ label, note, value, min, max, onInput, onDone }) {
      const clamp = (raw) => Math.max(min, Math.min(Number(raw) || min, max))
      return h('div', { 'data-bd-row': '' },
        h('div', { 'data-bd-grow': '' },
          h('div', { 'data-bd-label': '' }, label),
          note ? h('div', { 'data-bd-note': '' }, note) : null),
        h('input', {
          'data-bd-input': '', 'data-bd-num': '', type: 'number', min, max,
          value,
          onChange: (e) => onInput(e.target.value),
          onBlur: () => { const n = clamp(value); onInput(String(n)); onDone(n) },
        }))
    }

    /** 竖排一项（label 在上、控件在下、说明在最后） */
    function Field({ label, note, children }) {
      return h('div', { 'data-bd-field': '' },
        label ? h('div', { 'data-bd-label': '' }, label) : null,
        children,
        note ? h('div', { 'data-bd-note': '' }, note) : null)
    }

    /* ────────────── 多标签输入（2026-10-18）──────────────
     * 换掉原来那一排"一行一个"的 textarea：那种框里**看不出一共有几个**，删一个还得精确地
     * 选中一行、多敲一个空行就多出一个空标签，粘一整串进来还得自己数行数 ✗。
     * 现在每个值是一个小标签，点 × 就没了，粘一串（逗号 / 顿号 / 换行分隔）会自动拆成多个 ✓。
     *
     * ⚠️ 分隔符**故意不含普通空格**：关键词里有 "DeepSeek Harness"、"dsh 教程" 这种带空格的，
     *    把空格当分隔符会把它们劈成两半 ✗。要按空格拆的场合（UID 那种）由调用方传 split 覆盖。
     */
    const SEP_DEFAULT = /[,，、;；\n\r]+/

    function Chips({ value, onChange, placeholder, split, max, normalize }) {
      const list = Array.isArray(value) ? value : []
      const [draft, setDraft] = React.useState('')
      const sep = split || SEP_DEFAULT
      const add = (raw) => {
        const parts = String(raw).split(sep)
          .map((s) => (normalize ? normalize(s) : s.trim()))
          .filter(Boolean)
        if (!parts.length) { setDraft(''); return }
        const next = list.slice()
        for (const p of parts) if (!next.includes(p)) next.push(p)
        onChange(max ? next.slice(0, max) : next)
        setDraft('')
      }
      const del = (i) => onChange(list.filter((_, k) => k !== i))
      return h('div', { 'data-bd-chips': '' },
        list.map((it, i) => h('span', { 'data-bd-chip': '', key: i },
          h('span', { 'data-bd-chip-t': '' }, it),
          h('button', { 'data-bd-chip-x': '', title: '删掉这一个', onClick: () => del(i) }, '×'))),
        h('input', {
          'data-bd-chip-in': '',
          value: draft,
          placeholder: list.length ? '继续加…' : (placeholder || '输入后回车'),
          onChange: (e) => {
            const v = e.target.value
            // 打进来一个分隔符就当场落成标签 —— 不必非按回车（粘一串时也不会卡住）
            if (v && sep.test(v.slice(-1))) add(v)
            else setDraft(v)
          },
          onKeyDown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(draft) }
            // 空框上按退格 = 删掉最后一个（跟主流标签输入一致的手感）
            else if (e.key === 'Backspace' && !draft && list.length) del(list.length - 1)
          },
          onBlur: () => { if (draft.trim()) add(draft) },
        }))
    }

    /* ────────────── 时段编辑器（2026-10-18）──────────────
     * ⚠️ 这里**故意复刻**了 lib/state.mjs 里那几个解析函数（浏览器这半没法 import 那个模块）。
     *    两边都要认 `HH:MM-HH:MM`、都要容忍 ~ ～ – — 这些分隔符 —— **改一边记得改另一边**。
     */
    const WIN_SEP = /^(\d{1,2}:\d{2})\s*[-~～–—]\s*(\d{1,2}:\d{2})$/
    const winParts = (s) => {
      const m = WIN_SEP.exec(String(s || '').trim())
      return m ? { s: m[1], e: m[2] } : { s: '', e: '' }
    }
    const winText = (p) => `${p.s}-${p.e}`

    /** 一条时段：左边 起 – 止 两个原生时间选择器（原生就是 24 小时制、手机上也好点），右边删除 */
    function WinRow({ idx, text, onSet, onDel }) {
      const p = winParts(text)
      const bad = !p.s || !p.e
      return h('div', { 'data-bd-win': '', 'data-bad': bad ? '' : undefined },
        h('span', { 'data-bd-win-n': '' }, idx + 1),
        h('input', {
          'data-bd-time': '', type: 'time', value: p.s,
          onChange: (e) => { const s = e.target.value; if (s) onSet(idx, winText({ s, e: p.e || s })) },
        }),
        h('span', { 'data-bd-win-dash': '' }, '→'),
        h('input', {
          'data-bd-time': '', type: 'time', value: p.e,
          onChange: (e) => { const x = e.target.value; if (x) onSet(idx, winText({ s: p.s || x, e: x })) },
        }),
        h('button', { 'data-bd-btn': '', 'data-bd-tiny': '', title: '删掉这个时段', onClick: () => onDel(idx) }, '✕'))
    }

    /** 现在几点几分 → 'HH:MM'，也给"下次什么时候跑"用 */
    const hhmmOf = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

    /** 把一个 Date 说成人话：今天 / 明天 / 几月几号 + HH:MM */
    function whenText(d) {
      if (!d) return ''
      const now = new Date()
      const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
      const diff = Math.round((day(d) - day(now)) / 86400000)
      const label = diff === 0 ? '今天' : diff === 1 ? '明天' : `${d.getMonth() + 1} 月 ${d.getDate()} 日`
      return `${label} ${hhmmOf(d)}`
    }

    function useStatus(intervalMs) {
      const [st, setSt] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status')
            if (alive && d?.ok) setSt(d)
          } catch { /* 网络抖动就下次再问 */ }
        }
        tick()
        const t = setInterval(tick, intervalMs || 5000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs])
      return [st, setSt]
    }

/* ────────────── 报告页 / 调试页（2026-10-17 加） ──────────────
     * 起因：原来「看今天的报告」就是把 80 多 KB 的 markdown 原样塞进一个 `<pre>` ——
     *   十几轮全糊在一起，翻都翻不动，想找"这轮到底收了哪几条"基本靠肉眼 ✗。
     * 现在**宿主那边**已经把它解析成结构化对象了（`lib/report.mjs`），这一页只管摆好看 ✓
     * 解析失败也不会白屏：`parsed` 为空就退回原文，永远有东西看 ✓
     */

    /** MCP 工具名的中文标签（没列举到的去掉 `bili_` 前缀直接用，别让它显示成一串英文） */
    const TOOL_CN = {
      bili_search: '搜视频', bili_subtitle: '取字幕', bili_comments: '看评论', bili_danmaku: '看弹幕',
      bili_video_info: '看视频详情', bili_reply: '发评论', bili_send_message: '发私信',
      bili_note_picks: '报账', bili_login: '出登录码', bili_login_check: '查登录',
      bili_check_credential: '验登录', bili_whoami: '看当前账号', bili_crawl: '抓取',
      bili_send_dynamic: '发动态', bili_send_opus: '发专栏', bili_upload_video: '投稿',
      bili_upload_video_multi: '投稿（分P）', bili_hot_videos: '看热门', bili_hot_buzzwords: '看热词',
      bili_weekly_hot: '看每周必看', bili_rank: '看排行', bili_video_zones: '看分区',
      bili_user_info: '看用户', bili_user_videos: '看用户投稿', bili_favorite_lists: '看法收藏夹',
      bili_favorite_content: '看法收藏夹内容', bili_unread_messages: '看未读',
      bili_received_replies: '看收到的回复', bili_received_at_and_likes: '看被 @ 和点赞',
    }
    const toolName = (t) => TOOL_CN[t] || String(t || '').replace(/^bili_/, '')

    /** 毫秒 → 「1分23秒」/「820ms」 */
    function fmtDur(ms) {
      const n = Math.max(0, Number(ms) || 0)
      if (n < 1000) return Math.round(n) + 'ms'
      const s = Math.round(n / 1000)
      if (s < 60) return s + ' 秒'
      const m = Math.floor(s / 60)
      if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒'
      return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分'
    }

    /* ── 报告页的小零件 ── */

    function Stat({ v, label, tone }) {
      return h('div', { 'data-bd-stat': '', 'data-tone': tone || undefined },
        h('b', null, String(v)),
        h('span', null, label))
    }

    /** 可折起来的一节 */
    function Sec({ title, tally, open, onToggle, children }) {
      return h('div', { 'data-bd-fold': '' },
        h('div', { 'data-bd-sec-head': '', 'data-open': open ? '' : undefined, onClick: onToggle },
          h('i', null, '▸'),
          h('span', null, title),
          tally ? h('span', { 'data-bd-tally': '' }, tally) : null),
        open ? h('div', { 'data-bd-fold-body': '' }, children) : null)
    }

    /** 收了的一条 —— 做成卡片：标题可点、下面挂 UP / 播放 / 理由 / 一句话 */
    function PickCard({ it }) {
      const href = it.url || (it.bv ? 'https://www.bilibili.com/video/' + it.bv : '')
      return h('div', { 'data-bd-card': '' },
        href ? h('a', { href, target: '_blank', rel: 'noreferrer' }, it.title || '(没写标题)')
          : h('b', null, it.title || '(没写标题)'),
        h('div', { 'data-bd-meta': '' },
          it.up ? h('span', null, 'UP ' + it.up) : null,
          it.play ? h('span', null, '播放 ' + it.play) : null,
          it.bv ? h('span', { 'data-bd-bv': '' }, it.bv) : null),
        it.why ? h('div', { 'data-bd-note': '' }, it.why) : null,
        it.one ? h('div', { 'data-bd-quote': '' }, it.one) : null,
        it.comment ? h('div', { 'data-bd-note': '', 'data-warn': '' }, '评论：' + it.comment) : null)
    }

    /** 列表一行（看过未收 / 无字幕跳过） */
    function ListRow({ it }) {
      const href = it.bv ? 'https://www.bilibili.com/video/' + it.bv : ''
      return h('div', { 'data-bd-li': '' },
        it.bv ? (href ? h('a', { 'data-bd-bv': '', href, target: '_blank', rel: 'noreferrer' }, it.bv)
          : h('span', { 'data-bd-bv': '' }, it.bv)) : null,
        h('span', { 'data-bd-grow': '' }, it.title || it.text || ''),
        it.up ? h('span', { 'data-bd-tally': '' }, it.up) : null,
        it.why ? h('span', { 'data-bd-tally': '', 'data-soft': '' }, it.why) : null)
    }

    /** `- 键：值` 那种（评论 / 私信） */
    function PairRow({ p }) {
      return h('div', { 'data-bd-kvrow': '' },
        h('b', { 'data-bd-kvkey': '' }, p.k),
        h('span', null, p.v))
    }

    /** 复核一行 */
    function VerifyRow({ it }) {
      const pill = it.visible === true ? ['公开可见', 'ok'] : (it.visible === false ? ['没查到', 'bad'] : ['未核', ''])
      return h('div', { 'data-bd-li': '' },
        h('span', { 'data-bd-pill': '', ['data-' + pill[1]]: pill[1] ? '' : undefined }, pill[0]),
        it.bv ? h('span', { 'data-bd-bv': '' }, it.bv) : null,
        it.rpid ? h('span', { 'data-bd-tally': '' }, 'rpid ' + it.rpid) : null,
        it.where ? h('span', { 'data-bd-tally': '' }, it.where) : null,
        it.detail && it.visible !== true ? h('span', { 'data-bd-tally': '', 'data-soft': '' }, it.detail) : null)
    }

    /** 把一节按类型摊开 */
    function renderSection(sec, key, open, setOpen) {
      const k = 's' + key
      const isOpen = open[k] === undefined ? sec.kind === 'picked' : open[k]
      const toggle = () => setOpen((o) => ({ ...o, [k]: !isOpen }))
      const tally = sec.count != null ? sec.count + ' 条' : null
      const head = {
        picked: '收了', seen: '看过未收', skipped: '无字幕跳过',
        comments: '评论', dm: '私信', verify: '评论复核', summary: '总结', other: sec.title,
      }[sec.kind] || sec.title

      let body = null
      if (sec.kind === 'picked') {
        body = sec.items.length
          ? sec.items.map((it) => h(PickCard, { key: it.i, it }))
          : h('div', { 'data-bd-prose': '' }, sec.raw)
      } else if (sec.kind === 'seen' || sec.kind === 'skipped') {
        body = sec.items.length
          ? sec.items.map((it, i) => h(ListRow, { key: i, it }))
          : h('div', { 'data-bd-prose': '' }, sec.raw)
      } else if (sec.kind === 'comments' || sec.kind === 'dm') {
        body = (sec.pairs?.length || sec.prose?.length)
          ? [].concat(
            (sec.pairs || []).map((p, i) => h(PairRow, { key: 'p' + i, p })),
            (sec.prose || []).map((t, i) => h('div', { key: 'x' + i, 'data-bd-prose': '' }, t)))
          : h('div', { 'data-bd-prose': '' }, sec.raw)
      } else if (sec.kind === 'verify') {
        body = sec.items.length
          ? sec.items.map((it, i) => h(VerifyRow, { key: i, it }))
          : h('div', { 'data-bd-prose': '' }, sec.raw)
      } else {
        body = h('div', { 'data-bd-prose': '' }, sec.text || sec.raw)
      }

      return h(Sec, { key, title: head, tally, open: isOpen, onToggle: toggle }, body)
    }

    /* ── 报告页 ── */

    function ReportView() {
      const [day, setDay] = React.useState('')
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [rawMode, setRawMode] = React.useState(false)
      const [ri, setRi] = React.useState(0)
      const [open, setOpen] = React.useState({})

      const load = React.useCallback(async (d) => {
        setBusy(true); setErr('')
        try {
          const r = await jget('/report' + (d ? '?day=' + encodeURIComponent(d) : ''))
          // ⚠️ jget 不看 res.ok，所以 404 也会当正常 JSON 回来 ⇒ 这里必须自己判，
          //    而且要把后端的 error 原样露出来（吞掉的话人只会看到一句没头没脑的"读不到"）
          if (!r?.ok) { setErr(r?.error || '读不到报告'); return }
          setData(r); setDay(r.day)
          // 默认停在**最后一轮**（人打开报告多半是想看刚跑完那轮）
          setRi(Math.max(0, (r.parsed?.rounds?.length || 1) - 1))
          setOpen({})
        } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
      }, [])
      React.useEffect(() => { load('') }, [load])

      if (!data) return h('div', { 'data-bd-note': '' }, busy ? '读报告…' : (err || '还没有报告'))

      const p = data.parsed
      const s = p?.stats
      const r = p?.rounds?.[ri] || null
      const days = data.days?.length ? data.days : [data.day]

      return h('div', { 'data-bd-pane-report': '' },
        h('div', { 'data-bd-row': '' },
          h('select', {
            'data-bd-input': '', 'data-bd-narrow': '', value: day,
            onChange: (e) => load(e.target.value),
          }, days.map((d) => h('option', { key: d, value: d }, d))),
          h('div', { 'data-bd-grow': '' }),
          h('button', { 'data-bd-btn': '', disabled: busy, onClick: () => load(day) }, busy ? '读取中…' : '刷新'),
          h('button', { 'data-bd-btn': '', onClick: () => setRawMode(!rawMode) }, rawMode ? '看结构化' : '看原文'),
          h('button', { 'data-bd-btn': '', onClick: () => copyText(data.file) }, '复制路径')),

        err ? h('div', { 'data-bd-msg': '', 'data-warn': '' }, err) : null,
        !data.exists ? h('div', { 'data-bd-note': '' }, '这一天还没有报告 —— 跑一轮就有了') : null,

        // 解析不出来 / 主动切原文：退回纯文本（永远有东西看，不会白屏）
        (rawMode || !p) && data.exists ? h('pre', { 'data-bd-pre': '', 'data-tall': '' }, data.text) : null,

        (!rawMode && p) ? h('div', null,
          /* 当日概览 */
          h('div', { 'data-bd-sum': '' },
            h(Stat, { v: s.rounds, label: '轮次' }),
            h(Stat, { v: s.picks, label: '收了（条）', tone: 'ok' }),
            h(Stat, { v: s.seen, label: '看过未收' }),
            h(Stat, { v: s.skipped, label: '无字幕跳过' }),
            h(Stat, { v: s.comments + s.dm, label: '评论 / 私信' }),
            h(Stat, { v: s.verified + ' / ' + s.checked, label: '复核可见' })),

          /* 轮次 */
          p.rounds.length > 1 ? h('div', { 'data-bd-chips': '' },
            ...p.rounds.map((x, i) => h('button', {
              key: i, 'data-bd-chip': '', 'data-on': i === ri ? '' : undefined,
              onClick: () => { setRi(i); setOpen({}) },
            }, String(i + 1).padStart(2, '0') + ' · ' + (x.time || '--:--') + (x.mode === 'manual' ? ' ·手' : '')))) : null,

          r ? h('div', { 'data-bd-round': '' },
            h('div', { 'data-bd-note': '' },
              '第 ' + r.n + ' 轮 · ' + (r.time || '') + (r.mode === 'manual' ? ' · 手动' : '') + (r.note ? ' · ' + r.note : '')),
            ...r.sections.map((sec, i) => renderSection(sec, i, open, setOpen))) : null) : null)
    }

    /* ── 调试页 ── */

    function EvRow({ ev }) {
      const isRound = ev.tool === '__round__'
      const tone = ev.phase === 'error' || ev.phase === 'fail' ? 'bad' : (ev.phase === 'ok' ? 'ok' : 'run')
      const mark = ev.phase === 'start' ? '▸' : (ev.phase === 'ok' ? '✓' : '✗')
      const args = ev.args && Object.keys(ev.args).length
        ? Object.entries(ev.args).map(([k, v]) => k + '=' + v).join('，') : ''
      return h('div', {
        'data-bd-ev': '',
        'data-bad': tone === 'bad' ? '' : undefined,
        'data-round': isRound ? '' : undefined,
      },
        h('time', null, ev.at || ''),
        isRound ? h('span', { 'data-bd-pill': '', 'data-run': '' }, '轮') : h('span', { 'data-bd-pill': '', ['data-' + tone]: '' }, mark),
        h('span', { 'data-bd-grow': '' },
          h('b', null, isRound ? (ev.label || '开始跑一轮') : toolName(ev.tool)),
          args ? h('span', { 'data-bd-tally': '' }, ' ' + args) : null,
          !isRound && ev.label ? h('span', { 'data-bd-tally': '', 'data-soft': '' }, ' ' + ev.label) : null,
          ev.ms != null && ev.phase !== 'start' ? h('span', { 'data-bd-tally': '' }, ' · ' + fmtDur(ev.ms)) : null,
          ev.error ? h('div', { 'data-bd-note': '', 'data-warn': '' }, '报错：' + ev.error) : null,
          ev.phase === 'fail' && ev.note ? h('div', { 'data-bd-note': '', 'data-warn': '' }, ev.note) : null))
    }

    function DebugView({ onRun, busy, st }) {
      const [d, setD] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [showRaw, setShowRaw] = React.useState(false)
      const [showPrompt, setShowPrompt] = React.useState(false)   // 提示词原文（默认收着：几千字）

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const r = await jget('/debug')
            if (!alive) return
            if (r?.ok) { setD(r); setErr('') } else setErr(r?.error || '调试接口没响应')
          } catch (e) { if (alive) setErr(String(e?.message ?? e)) }
        }
        tick()
        // ⭐ 跑着的时候 1.2 秒一次（看进度），闲着 4 秒一次（省事）
        const iv = setInterval(tick, 1500)
        return () => { alive = false; clearInterval(iv) }
      }, [])

      // 宿主端还是旧的（没重启）时 /debug 会 404 —— 与其让人对着空页面发呆，不如直说
      if (!d) {
        return h('div', { 'data-bd-note': '' },
          err || '读调试信息…',
          err ? h('div', { 'data-bd-note': '', 'data-warn': '' },
            '多半是宿主端还没重新挂载 —— 重启一次 dsh web 就有了（客户端这一半刷新页面即可）') : null)
      }

      const feed = (d.progress || []).slice().reverse()      // 新的在上面
      const bads = feed.filter((x) => x.phase === 'error' || x.phase === 'fail')

      return h('div', { 'data-bd-pane-debug': '' },
        h('div', { 'data-bd-row': '' },
          h('span', {
            'data-bd-pill': '', 'data-run': d.running ? '' : undefined, 'data-ok': d.running ? undefined : '',
          }, d.running ? '● 正在跑' : '空闲'),
          d.running ? h('span', { 'data-bd-tally': '' },
            '已跑 ' + fmtDur(d.elapsedMs) + (d.why ? '（' + d.why + '）' : '')) : null,
          d.lastExit ? h('span', { 'data-bd-tally': '' },
            '上次退出 code=' + d.lastExit.code) : null,
          h('div', { 'data-bd-grow': '' }),
          h('button', {
            'data-bd-btn': '', 'data-primary': '', disabled: d.running || busy === 'run', onClick: onRun,
          }, d.running ? '正在跑…' : '试跑一轮'),
          h('button', { 'data-bd-btn': '', onClick: () => setShowRaw(!showRaw) },
            showRaw ? '收起原始日志' : '看原始日志')),

        err ? h('div', { 'data-bd-msg': '', 'data-warn': '' }, err) : null,
        d.stats ? h('div', { 'data-bd-note': '' },
          '今天：' + d.stats.rounds + ' 轮 · 收了 ' + d.stats.picks + ' 条 · 评论/私信 '
          + (d.stats.comments + d.stats.dm) + ' · 复核可见 ' + d.stats.verified + '/' + d.stats.checked) : null,

        bads.length ? h('div', { 'data-bd-msg': '', 'data-warn': '' },
          '这一轮有 ' + bads.length + ' 处报错 —— 下面标红的就是') : null,

        // ⭐ 这台机器到底是什么环境（2026-10-18 加）：跨平台的问题（找不到 python、
        //    没有桌面、dsh 定位不对）全都得靠这几行看出来，别再让人猜 ✓
        h('div', { 'data-bd-h': '' }, '这台机器'),
        h('div', { 'data-bd-kv': '' },
          '系统：' + ((st && st.platform && st.platform.os) || '（还没读到）'),
          h('br'),
          (st && st.platform && st.platform.desktop)
            ? '文件夹：有桌面 —— 能让系统的程序打开'
            : '文件夹：没有桌面（服务器 / NAS 常态）—— 在设置页里直接翻目录',
          h('br'),
          'python：' + ((st && st.platform && st.platform.python) || '（还没定：还没装依赖就先这样）'),
          h('br'),
          'dsh：' + ((st && st.platform && st.platform.dsh) || '?')),

        h('div', { 'data-bd-h': '' }, '实时进度（MCP 每次工具调用都上报）'),
        feed.length ? h('div', { 'data-bd-feed': '' }, ...feed.map((ev, i) => h(EvRow, { key: i, ev })))
          : h('div', { 'data-bd-note': '' }, '还没有进度 —— 点「试跑一轮」看看'),

        h('div', { 'data-bd-h': '' }, '关键日志（从 duty.log 里挑出来的阶段 / 报错）'),
        d.keyLines?.length ? h('div', { 'data-bd-feed': '' },
          ...d.keyLines.slice().reverse().map((x, i) => h('div', {
            key: i, 'data-bd-ev': '', 'data-bad': x.bad ? '' : undefined,
          }, h('span', { 'data-bd-grow': '', 'data-mono': '' }, x.text))))
          : h('div', { 'data-bd-note': '' }, '还没有关键日志'),

        showRaw ? h('div', null,
          h('div', { 'data-bd-note': '' }, '原始日志尾部：' + d.logFile),
          h('pre', { 'data-bd-pre': '', 'data-tall': '' }, d.logTail || '（空）')) : null,

        /* ⭐ 这一轮被交代了什么（2026-10-18 加）：提示词是按当前设置**现拼**的，
         *    "我的设置到底生效了没"不该靠猜 —— 摊开原文，一眼能核 ✓ */
        d.prompt ? h('div', null,
          h('button', {
            'data-bd-btn': '', 'data-bd-fold': '',
            onClick: () => setShowPrompt(!showPrompt),
          }, (showPrompt ? '▾ ' : '▸ ') + `这一轮收到的话（${d.promptChars || d.prompt.length} 字）`),
          showPrompt ? h('pre', { 'data-bd-pre': '', 'data-tall': '' }, d.prompt) : null) : null)
    }

    /* ────────────── 目录浏览（2026-10-18）──────────────
     * 🔴 为什么要有：服务器 / NAS（这台就是）**没有桌面** —— `xdg-open`、文件管理器
     *    一个都没有，"打开文件夹"在那儿是**做不到**的事。但功能不该就此消失 ✗：
     *    退一步，把目录**列在设置页里**，点开看内容、要整份就下载 ✓
     *    （这也正是"合理的 Linux 实现"该有的样子：承认没有桌面，然后换个能做到的做法）
     */
    const fmtSize = (n) => {
      const v = Number(n) || 0
      if (v < 1024) return v + ' B'
      if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + ' KB'
      return (v / 1024 / 1024).toFixed(1) + ' MB'
    }
    const fmtWhen = (ms) => {
      const d = new Date(Number(ms) || 0)
      if (Number.isNaN(d.getTime())) return ''
      const p = (x) => String(x).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    function FilesPane({ what, onClose }) {
      const [st, setSt] = React.useState(null)        // null = 还在读
      const [sub, setSub] = React.useState('')        // 进到哪一层子目录
      const [busy, setBusy] = React.useState('')
      const [view, setView] = React.useState(null)    // 正在看的那个文件

      const load = async (s) => {
        setBusy('list')
        try {
          const r = await jget('/files?what=' + what + (s ? '&sub=' + encodeURIComponent(s) : ''))
          setSt(r || { ok: false, entries: [] })
          setSub(s || '')
          setView(null)
        } catch (e) { setSt({ ok: false, entries: [], error: String(e?.message ?? e) }) } finally { setBusy('') }
      }
      React.useEffect(() => { load('') }, [what])

      const openFile = async (name) => {
        setBusy('file')
        try {
          const r = await jget('/file?what=' + what
            + (sub ? '&sub=' + encodeURIComponent(sub) : '') + '&name=' + encodeURIComponent(name))
          setView({ name, ...(r || {}) })
        } catch (e) { setView({ name, ok: false, error: String(e?.message ?? e) }) } finally { setBusy('') }
      }

      const dl = (n) => '/api/bili-duty/download?what=' + what
        + (sub ? '&sub=' + encodeURIComponent(sub) : '') + '&name=' + encodeURIComponent(n)

      const entries = (st && st.entries) || []
      let body
      if (st === null) body = h('div', { 'data-bd-note': '' }, '正在读目录…')
      else if (!entries.length) body = h('div', { 'data-bd-note': '' }, st.error || '这个目录是空的')
      else body = h('div', { 'data-bd-files': '' }, ...entries.map((e, i) => h('div', {
        key: i, 'data-bd-file': '',
        'data-cur': view && view.name === e.name ? '' : undefined,
        onClick: () => (e.dir ? load(e.name) : openFile(e.name)),
      },
        h('span', { 'data-bd-file-n': '' }, (e.dir ? '📁 ' : '📄 ') + e.name),
        h('span', { 'data-bd-file-m': '' }, e.dir ? '目录' : fmtSize(e.size)),
        h('span', { 'data-bd-file-m': '' }, fmtWhen(e.mtime)),
        e.dir ? null : h('a', {
          'data-bd-file-m': '', href: dl(e.name), download: e.name,
          style: { textDecoration: 'underline' }, title: '下载这份',
          onClick: (ev) => ev.stopPropagation(),
        }, '下载'))))

      return h('div', { 'data-bd-sub': '' },
        h('div', { 'data-bd-crumb': '' },
          h('span', null, what === 'out' ? '报告目录：' : '插件家目录：'),
          h('b', null, (st && st.dir) || '…'),
          sub ? h('button', {
            'data-bd-btn': '', 'data-bd-tiny': '',
            onClick: () => load(''),
          }, '← 上一层') : null,
          h('button', {
            'data-bd-btn': '', 'data-bd-tiny': '', disabled: busy === 'list',
            onClick: () => load(sub),
          }, busy === 'list' ? '读…' : '刷新'),
          onClose ? h('button', { 'data-bd-btn': '', 'data-bd-tiny': '', onClick: onClose }, '收起') : null),
        body,
        view ? h('div', { 'data-bd-field': '' },
          h('div', { 'data-bd-label': '' }, view.name + (view.size ? '（' + fmtSize(view.size) + '）' : '')),
          view.ok === false ? h('div', { 'data-bd-warn': '' }, view.error || '读不出来')
            : h('pre', { 'data-bd-pre': '', 'data-tall': '' }, view.text || '（空文件）'),
          h('a', { 'data-bd-btn': '', href: dl(view.name), download: view.name }, '下载这份')) : null)
    }

    /* ────────────── 设置页正文 ────────────── */

    function Panel() {
      const [st, setSt] = useStatus(5000)
      const [busy, setBusy] = React.useState('')
      // ⭐ 全页**唯一**的反馈位 —— 原来 msg / runNote 各存一份、上下各渲染一遍，同一句话出现两遍 ✗
      const [note, setNote] = React.useState(null)
      const [tab, setTab] = React.useState('settings')   // 设置 / 报告 / 调试
      const [kws, setKws] = React.useState(null)           // 关键词（数组草稿）
      const [ws, setWs] = React.useState(null)
      const [rl, setRl] = React.useState(null)
      const [newVer, setNewVer] = React.useState('')       // 发现的新版本号（空 = 没发现）          // 日报形态：full / brief / off
      // ⚠️ 输入框必须绑"本地草稿"：页面每 5 秒轮询 /status，服务端那份会把 config 盖掉
      //    ⇒ 直接绑 cfg 的话，用户打字打到一半就被冲没了 ✗（2026-10-14 陌生人验收时抓到）
      const [perDay, setPerDay] = React.useState(null)
      const [perRound, setPerRound] = React.useState(null)
      const [replyPer, setReplyPer] = React.useState(null)
      // ⭐ 列表类字段现在都是**数组草稿**（标签输入是"加一个 / 删一个"的离散操作，改完直接存，不用防抖）
      const [dmUids, setDmUids] = React.useState(null)      // 私信收件人名单
      const [dmMode, setDmMode] = React.useState(null)      // 投递方式：off / only / both
      const [aiKw, setAiKw] = React.useState(null)          // 自定义 AI 识别词
      const [mention, setMention] = React.useState(null)    // 要 @ 的名单
      const [wins, setWins] = React.useState(null)          // 自定义时段（"HH:MM-HH:MM"）
      // ⭐ 目录浏览（2026-10-18）：'out' / 'home' 展开对应目录，'' 收起，null = 还没决定
      const [filesWhat, setFilesWhat] = React.useState(null)
      const [login, setLogin] = React.useState(null)
      const [report, setReport] = React.useState(null)        // 非 null = 报告已展开
      const [loginState, setLoginState] = React.useState('')
      const [loginTone, setLoginTone] = React.useState('')

      const cfg = st?.config
      // ⭐ 这台机器有没有桌面（决定"打开文件夹"是真按钮还是换成翻目录）✓
      const noDesktop = Boolean(st && st.platform && st.platform.desktop === false)
      React.useEffect(() => {
        if (cfg && kws === null) setKws(Array.isArray(cfg.keywords) ? cfg.keywords.filter(Boolean) : [])
        if (cfg && ws === null) setWs(cfg.workspace || '')
        if (cfg && rl === null) setRl(cfg.reportLevel || 'full')
        if (cfg && perDay === null) setPerDay(String(cfg.perDay ?? 5))
        if (cfg && perRound === null) setPerRound(String(cfg.commentPerRound ?? 1))
        if (cfg && replyPer === null) setReplyPer(String(cfg.replyPerRound ?? 1))
        if (cfg && mention === null) {
          // ⭐ 新配置是列表（mentionNames）；老配置是单名字（mentionName）—— 这里自动迁移着显示
          const list = Array.isArray(cfg.mentionNames) ? cfg.mentionNames.filter(Boolean) : []
          setMention(list.length ? list : (cfg.mentionName ? [String(cfg.mentionName)] : []))
        }
        if (cfg && dmUids === null) {
          // 同理：老的单个 dmUid 也自动并进名单里显示
          const list = Array.isArray(cfg.dmUids) ? cfg.dmUids.filter(Boolean) : []
          setDmUids(list.length ? list : (cfg.dmUid ? [String(cfg.dmUid)] : []))
        }
        if (cfg && dmMode === null) setDmMode(cfg.dmMode || 'off')
        if (cfg && aiKw === null) setAiKw(Array.isArray(cfg.aiKeywords) ? cfg.aiKeywords.filter(Boolean) : [])
        if (cfg && wins === null) setWins(Array.isArray(cfg.windows) ? cfg.windows.filter(Boolean) : [])
        // ⭐ 没有桌面的机器（NAS / 服务器）上「打开文件夹」是做不到的事 ⇒ 默认就把目录摊开 ✓
        if (st && filesWhat === null) setFilesWhat(st.platform && st.platform.desktop === false ? 'out' : '')
      }, [cfg, st && st.platform && st.platform.desktop])

      // ⚠️ 注意：服务端的 `st.windows` 从 2026-10-18 起是**生效的时段表**（数组，配了自定义就是自定义），
      //    不再是内置那两组的字典 ⇒ 内置的文案从 st.builtinWindows 取，常量只做兜底。
      const win = { ...DEFAULT_WINDOWS, ...(st?.builtinWindows || {}) }
      /** ⭐ 自定义时段（本地草稿数组；空的 = 用内置那两组） */
      const winList = Array.isArray(wins) ? wins : []

      /** ⭐ 全页唯一的反馈出口：按钮 / 保存 / 复核的结果都走这里，只在状态条下面显示一处 */
      const say = (text, tone) => setNote(text ? { t: text, tone: tone || '' } : null)

      const patch = async (p, what) => {
        setBusy(JSON.stringify(p))
        try {
          const r = await jpost('/config', p)
          // ⭐ 服务端顺手带回来的"时段体检 + 下次什么时候跑"（改一下立刻生效，不用等轮询）
          const extra = (r && ('windowIssues' in r))
            ? { windowIssues: r.windowIssues, customWindows: r.customWindows, nextRunAt: r.nextRunAt }
            : {}
          if (r?.config) setSt((old) => ({ ...old, config: r.config, ...extra }))
          // ⭐ 兜底自检（2026-10-17 加）：把"我发出去的"和"服务端回给我的"对一遍。
          //    起因：服务端那半没重载时，新字段会被**静默丢掉** ——
          //    界面显示"已保存"，可刷新就变回默认，使用者完全无从排查 ✗。
          //    服务端实现了 notApplied 就用它；没有（旧版本）就用这个对比兜住 ✓。
          const bad = Array.isArray(r?.notApplied) ? r.notApplied.slice() : []
          const back = r?.config || {}
          for (const k of Object.keys(p)) {
            if (bad.includes(k)) continue
            const want = p[k], got = back[k]
            const same = Array.isArray(want)
              ? JSON.stringify(want) === JSON.stringify(got || [])
              : (typeof want === 'number' ? Number(got) === want : String(got ?? '') === String(want ?? ''))
            if (!same) bad.push(k)
          }
          if (bad.length) {
            say(`⚠️ ${what || '设置'}没写进去：${bad.join('、')}`
              + '（多半是插件加了新字段、但服务端那半还没重载 —— 重启一次 dsh 就好）', 'warn')
          } else {
            say(what ? `${what}：已保存` : '已保存', 'good')
          }
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onShowReport = async () => {
        if (report !== null) { setReport(null); return }       // 再点一次收起
        setBusy('report')
        try {
          const r = await jget('/report')
          setReport(r && r.exists ? (r.text || '（报告是空的）') : '今天还没有报告 —— 跑一轮之后就有了')
        } catch (e) { setReport('读不到报告：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

      // ⭐ 复核评论：接口回"发送成功"≠ 公开可见（新号/风控会进审核，那时候连 @ 都不会推）
      //    所以让宿主真去拉一次评论列表 / 楼中楼，确认那条到底在不在。
      const onVerify = async () => {
        setBusy('verify')
        try {
          const r = await jpost('/verify', {})
          if (!r || !r.ok) { say('复核没跑成：' + ((r && r.error) || '未知原因'), 'warn'); return }
          const n = (r.checked || []).length
          const vis = (r.checked || []).filter((c) => c.visible === true).length
          if (!n) say(r.text || '没有需要复核的记录', 'good')
          else say(`复核完 ${n} 条：公开可见 ${vis} 条，其余「没查到」（可能还在审核 —— 看不到不等于没发出去）。结果也追加到今天的报告末尾了。`, vis ? 'good' : 'warn')
          if (r.report) setReport(null)
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const copyText = async (text) => {
        const v = String(text || '')
        try {
          await navigator.clipboard.writeText(v)
          say('已复制：' + v, 'good')
        } catch {
          say('复制失败 —— 路径是：' + v)       // 兜底：至少把路径显示出来，手动选中也能复制
        }
      }

      const onOpenFolder = async (what) => {
        try {
          const r = await jpost('/open', { what })
          if (r && r.ok) {
            say('已请系统打开：' + (r.opened || '') + '（要是没看到窗口，用旁边的「复制报告路径」——那个一定成）', 'good')
          } else {
            // ⭐ 打不开不是终点：**直接把目录摊在下面**（服务器 / NAS 上这才是唯一能做到的做法 ✓）
            say('打不开（' + ((r && r.error) || '未知原因') + '）—— 已经把这个目录摊在下面了，可以直接看、直接下载', 'warn')
            setFilesWhat(what)
          }
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }

      const onUpgrade = async () => {
        setBusy('upgrade')
        try {
          const r = await jpost('/upgrade', {})
          say((r && r.hint) || '正在升级', 'good')
          say('升级过程写在下面的「主依赖的日志」里 —— 完了记得重启一次 dsh（不重启还是旧版）', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onCheckUpdate = async () => {
        setBusy('update')
        try {
          const r = await jget('/update')
          if (r && r.ok && r.latest) {
            if (r.hasNew) {
              setNewVer(r.latest)
              say('有新版 v' + r.latest + '（你的是 v' + r.current + '）—— 点右边的「一键升级」，完了重启一次 dsh', 'warn')
            } else say('已经是最新版 v' + r.current, 'good')
          } else {
            say('查不到最新版（可能网络不通）—— 你现在的版本是 v' + ((r && r.current) || '?'))
          }
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onCheck = async () => {
        setBusy('check')
        say('')
        try {
          const r = await jpost('/check', {})
          if (r && r.ok) say('能用！' + (r.steps || []).join('、'))
          else say('还不能用：' + (r && r.error ? r.error : '没拿到结果'))
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onInstallAsr = async () => {
        setBusy('asr')
        say('')
        try {
          const r = await jpost('/install-asr', {})
          say(r?.started ? '开始装转写依赖 —— 进度显示在下面（要下模型，慢一点正常）' : (r?.hint || '没起来'),
            r?.started ? 'good' : 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onInstall = async () => {
        setBusy('install')
        say('')
        try {
          const r = await jpost('/install', {})
          say(r?.hint || '已经在后台开始装了', '')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onRun = async () => {
        setBusy('run')
        try {
          const r = await jpost('/run', {})
          say(r?.started ? '已经在后台跑一轮了，报告会写在 out/ 里' : '没起来，看 duty.log', r?.started ? 'good' : 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onLoginStart = async () => {
        setBusy('login')
        setLoginTone('')
        setLoginState('正在出码…')
        try {
          const r = await jpost('/login/start', {})
          if (!r?.ok) { setLoginTone('warn'); setLoginState(r?.error || '出码失败'); return }
          setLogin({ key: r.key, qr: r.qr })
          if (!r.qr) { setLoginTone('warn'); setLoginState('没画出二维码 —— 先点上面的「重装依赖」（venv 里要有 qrcode）') }
          else setLoginState('用手机 B站 扫这张码')
          let n = 0
          const timer = setInterval(async () => {
            n += 1
            try {
              const p = await jpost('/login/poll', { key: r.key })
              if (p?.state === 'ok') {
                clearInterval(timer); setLogin(null)
                setLoginTone('good'); setLoginState('登录成功')
                setSt((old) => ({ ...old, loggedIn: true }))
              } else if (p?.state === 'scanned') { setLoginTone(''); setLoginState('扫到了，请在手机上确认') }
              else if (p?.state === 'expired') { clearInterval(timer); setLogin(null); setLoginTone('warn'); setLoginState('二维码过期了，再点一次「扫码登录」') }
              else { setLoginTone(''); setLoginState('等扫码…') }
            } catch { /* 抖动就下次再问 */ }
            if (n > 90) { clearInterval(timer); setLogin(null); setLoginTone('warn'); setLoginState('超时了，再点一次「扫码登录」') }
          }, 2000)
        } catch (e) { setLoginTone('warn'); setLoginState(String(e?.message ?? e)) }
        finally { setBusy('') }
      }

      /* ⭐⭐ 文字框的保存（2026-10-17 重做）
       * 原来只有「关键词 / 工作区」两个框要靠页面底部那个「保存」按钮，
       * 而同一页另外 11 个控件全是**点一下就生效** —— 一页两种语义，
       * 使用者根本分不清那个按钮到底管谁（其实只管这两个框）✗。
       * 现在统一成**自动保存**：打字停 800ms 就存、离开输入框也立刻存一次，按钮直接删掉 ✓。
       * 按字段分别计时（`timers` 用 key 分开），免得在 A 框打字又把 B 框的待存挤掉。 */
      const timers = React.useRef({})
      const autoSave = (key, fn) => {
        timers.current[key] = fn
        clearTimeout(timers.current['t:' + key])
        timers.current['t:' + key] = setTimeout(() => {
          delete timers.current['t:' + key]
          fn()
        }, 800)
      }
      const flushSave = (key) => {
        if (!timers.current['t:' + key]) return
        clearTimeout(timers.current['t:' + key])
        delete timers.current['t:' + key]
        timers.current[key]?.()
      }
      React.useEffect(() => () => {
        for (const k of Object.keys(timers.current)) clearTimeout(timers.current[k])
      }, [])

      /* ⚠️ 原来的 `asList`（把"一行一个"的 textarea 拆成数组）随那几个框一起删了 ——
       *    现在列表字段都是 Chips，拆标签是它自己的事 ✓ */

      const saveText = () => patch({
        keywords: kws || [],
        workspace: String(ws || '').trim(),
      }, '关键词与工作区')

      if (!cfg) {
        return h('div', { 'data-bd-page': '' }, h('div', { 'data-bd-note': '' }, '读设置中…'))
      }

      const sw = (k) => Boolean(cfg[k])

      // ⭐ 楼中楼只在「真的会发公开评论」时才有意义：没开自动评论、或投递方式选了「只私信」时
      //    它整个不生效 —— 界面上要置灰 + 说清原因，而不是留个亮着却什么都不干的开关 ✗
      const canComment = sw('autoComment') && (dmMode || 'off') !== 'only'

      const TABS = [['settings', '设置'], ['report', '报告'], ['debug', '调试']]

      return h('div', { 'data-bd-page': '' },

        /* ── 顶部状态条（三个标签页共用）── */
        h('div', { 'data-bd-row': '' },
          h('span', {
            'data-bd-badge': '',
            'data-tone': Number(cfg.perDay) > 0 && st.ranToday >= Number(cfg.perDay) ? 'off' : undefined,
          }, `今天已挑 ${st.ranToday} / ${cfg.perDay} 条`),
          h('span', { 'data-bd-badge': '', 'data-tone': st.venvReady ? 'ok' : 'off' },
            st.venvReady ? '环境已就绪' : (st.installing ? '正在装环境' : '环境未装')),
          h('span', { 'data-bd-badge': '', 'data-tone': st.loggedIn ? 'ok' : 'off' },
            st.loggedIn ? 'B站已登录' : 'B站未登录'),
          h('span', { 'data-bd-badge': '' }, 'v' + (st.version || '?')),
          h('div', { 'data-bd-grow': '' }),
          h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: busy === 'run', onClick: onRun }, '现在跑一轮')),

        note ? h('div', {
          'data-bd-msg': '',
          'data-good': note.tone === 'good' ? '' : undefined,
          'data-warn': note.tone === 'warn' ? '' : undefined,
        }, note.t) : null,

        /* ── 标签页 ── */
        h('div', { 'data-bd-tabs': '' },
          ...TABS.map(([k, label]) => h('button', {
            key: k, 'data-bd-tab': '', 'data-on': tab === k ? '' : undefined,
            onClick: () => setTab(k),
          }, label))),

        tab !== 'settings' ? null : h('div', { 'data-bd-pane-settings': '' },
        h('div', { 'data-bd-note': '' },
          '开关和下拉**点了就生效**；文字框**改完自动存**（离开输入框也会存）—— 没有保存按钮'),

        /* ── ① 什么时候自己跑 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '什么时候自己跑'),
          h(ToggleRow, {
            label: '到点自动刷',
            note: '只在下面这些时段里自动跑；关着就只能手动点「现在跑一轮」',
            on: sw('peakValley'),
            onChange: (v) => patch({ peakValley: v }, '自动刷'),
          }),
          sw('peakValley') ? h('div', { 'data-bd-sub': '' },
            /* ⭐ 时段表（2026-10-18）：可以自己定，任意多条、24 小时制、跨零点也行。
             *   没配自定义时显示内置那两组开关；**一加自定义就整个接管**（那两条开关随之让位） */
            winList.length === 0
              ? h('div', { 'data-bd-field': '' },
                h('div', { 'data-bd-label': '' }, '用内置的谷时时段'),
                ...['noon', 'night'].map((k) => h(ToggleRow, {
                  key: k,
                  label: win[k].label,
                  note: `${win[k].start} – ${win[k].end}`,
                  on: sw(k),
                  onChange: (v) => patch({ [k]: v }, win[k].label),
                })),
                h('div', { 'data-bd-note': '' },
                  '内置口径：工作日 12–14 点、18 点以后，周末全天都便宜'),
                // ⭐ 这个按钮内置模式下也得在 —— 不然用户根本切不到自定义去 ✗
                h('div', { 'data-bd-row': '' },
                  h('button', {
                    'data-bd-btn': '',
                    onClick: () => { const n = ['12:00-14:00']; setWins(n); patch({ windows: n }, '时段') },
                  }, '＋ 自己定时段')))
              : h('div', { 'data-bd-field': '' },
                h('div', { 'data-bd-label': '' }, '在哪些时段跑'),
                h('div', { 'data-bd-wins': '' },
                  ...winList.map((t, i) => h(WinRow, {
                    key: i, idx: i, text: t,
                    onSet: (j, v) => { const n = winList.slice(); n[j] = v; setWins(n); patch({ windows: n }, '时段') },
                    onDel: (j) => { const n = winList.filter((_, k) => k !== j); setWins(n); patch({ windows: n }, '时段') },
                  }))),
                h('div', { 'data-bd-note': '' },
                  '24 小时制 · 起晚于止 = 跨到第二天（18:00 → 09:00 就是一整晚）· 一个时段跑一轮'),
                h('div', { 'data-bd-row': '' },
                  h('button', {
                    'data-bd-btn': '',
                    onClick: () => { const n = [...winList, '12:00-14:00']; setWins(n); patch({ windows: n }, '时段') },
                  }, '＋ 再加一个时段'),
                  h('button', {
                    'data-bd-btn': '',
                    title: '清掉自定义时段，回到内置的中午 / 夜间',
                    onClick: () => { setWins([]); patch({ windows: [] }, '时段') },
                  }, '清空 · 回内置'))),
            // ⭐ 重叠 / 重复 / 全天 —— 服务端算的，改一下立刻回来。**只告警不拦**（重叠也会正确地只跑一轮）
            (st.windowIssues || []).length
              ? h('div', { 'data-bd-warn': '' },
                '⚠️ ' + st.windowIssues.map((x) => x.text || x).join('；')
                + ' —— 重叠的两条会并成一段，只跑一轮（想跑两次就把时间错开）')
              : null,
            st.nextRunAt
              ? h('div', { 'data-bd-note': '' }, `下次自动跑：${whenText(new Date(st.nextRunAt))}`)
              : (winList.length || ['noon', 'night'].some((k) => sw(k))
                ? h('div', { 'data-bd-note': '' }, '下次自动跑：今天的时段都过了，明天见')
                : null)) : null,
          h(NumRow, {
            label: '每天最多挑几条',
            note: '0 = 不自动刷（手动跑不受限）',
            value: perDay ?? '', min: 0, max: 50,
            onInput: setPerDay,
            onDone: (n) => patch({ perDay: n }, '每天挑几条'),
          }),
          st.lastRunAt ? h('div', { 'data-bd-note': '' }, `上次跑：${new Date(st.lastRunAt).toLocaleString('zh-CN')}${st.lastWhy ? `（${st.lastWhy}）` : ''}`) : null),

        /* ── ② 它替你说话吗 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '它替你说话吗'),

          h(ToggleRow, {
            label: '自动评论并 @ 你',
            note: '在挑中的视频下面留评论，把你 @ 出来',
            on: sw('autoComment'),
            onChange: (v) => patch({ autoComment: v }, '自动评论'),
          }),
          sw('autoComment') ? h('div', { 'data-bd-sub': '' },
            h(NumRow, {
              label: '一轮最多发几条',
              value: perRound ?? '', min: 1, max: 20,
              onInput: setPerRound,
              onDone: (n) => patch({ commentPerRound: n }, '每轮几条评论'),
            }),
            h(Field, {
              label: '要 @ 谁',
              note: '⭐ 按顺序全部 @ 上、中间自动留空格（B站 靠空格才认得出 @）'
                + ' · 留空 = 只写报告不发评论 · 昵称要跟 B站 上**完全一致**，错一个字那个 @ 就不亮',
            },
              h(Chips, {
                value: mention || [],
                placeholder: '输入昵称后回车，可加多个',
                max: 20,
                onChange: (next) => { setMention(next); patch({ mentionNames: next, mentionName: '' }, '要 @ 谁') },
              }))) : null,

          h(Field, {
            label: '投递方式',
            note: '选「只私信」的话一条公开评论都不发 —— 最不打扰别人',
          },
            h('select', {
              'data-bd-input': '', value: dmMode ?? 'off',
              onChange: (e) => { setDmMode(e.target.value); patch({ dmMode: e.target.value }, '投递方式') },
            },
              h('option', { value: 'off' }, '只发评论 —— 在视频下面 @ 你'),
              h('option', { value: 'only' }, '只私信 —— 不公开发言'),
              h('option', { value: 'both' }, '评论 + 私信 —— 两边都发'))),
          (dmMode && dmMode !== 'off') ? h('div', { 'data-bd-sub': '' },
            h(Field, {
              label: '私信发给谁',
              note: '填 B站 UID（主页地址里那串数字），可以填多个 · ⚠️ 要跟对方**互关**，'
                + '否则会被限流、还可能不弹提醒 · 内容 = 每条的「标题 + 链接 + 一句话」',
            },
              h(Chips, {
                value: dmUids || [],
                placeholder: '输入 UID 后回车（可粘一串，用空格或逗号隔开）',
                max: 10,
                // UID 没有空格，所以这里**允许按空格拆**；顺手把非数字字符都吃掉
                split: /[\s,，、;；]+/,
                normalize: (s) => String(s).replace(/[^\d]/g, '').replace(/^0+/, ''),
                onChange: (next) => { setDmUids(next); patch({ dmUids: next, dmUid: 0 }, '私信收件人') },
              }))) : null,

          h(ToggleRow, {
            label: '回复别人在你评论下的留言',
            note: '只回直接回复在你评论下面的人，不参与别的讨论',
            on: sw('replyToComments'),
            onChange: (v) => patch({ replyToComments: v }, '回复评论'),
          }),
          sw('replyToComments') ? h('div', { 'data-bd-sub': '' },
            h(NumRow, {
              label: '一轮最多回几条',
              value: replyPer ?? '', min: 1, max: 10,
              onInput: setReplyPer,
              onDone: (n) => patch({ replyPerRound: n }, '每轮几条回复'),
            })) : null,

          /* ⭐ 楼中楼依附"会发公开评论"：没开自动评论、或投递方式选了「只私信」时，整个不生效 ——
           *   那就**置灰 + 说清为什么不生效**，而不是留一个亮着却什么都不干的开关 ✗ */
          h('div', canComment ? {} : { 'data-bd-dim': '' },
            h(ToggleRow, {
              label: '在 AI 号下面楼中楼回复',
              note: canComment
                ? '只在明确是 AI / 机器人的号下面回；真人一律不碰'
                : '现在不会发公开评论（没开「自动评论」，或投递方式选了「只私信」）—— 这条暂时用不上',
              on: sw('aiReply'),
              disabled: !canComment,
              onChange: (v) => patch({ aiReply: v }, '楼中楼回复'),
            })),
          (canComment && sw('aiReply')) ? h('div', { 'data-bd-sub': '' },
            h(Field, {
              label: '额外用来识别 AI 的词',
              note: '补充、不是替换 —— 内置那批（AI / Bot / 机器人 / 助手 / Agent / 大肥鱼 / 鲸鱼娘 …）一直在用',
            },
              h(Chips, {
                value: aiKw || [],
                placeholder: '输入一个词后回车',
                max: 50,
                onChange: (next) => { setAiKw(next); patch({ aiKeywords: next }, '自定义 AI 识别词') },
              }))) : null),

        /* ── ③ 刷什么 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '刷什么'),
          h(Field, {
            label: '关键词',
            note: '留空 = 用内置那几组（日语翻唱 / 音乐 / LIVE / 现场 …）· 带空格的关键词没问题（逗号或回车才断一个）',
          },
            h(Chips, {
              value: kws || [],
              placeholder: '输入关键词后回车，可加多个',
              max: 60,
              onChange: (next) => { setKws(next); patch({ keywords: next }, '关键词') },
            })),
          h(Field, {
            label: '工作区',
            note: '它按这个目录里的 AGENTS.md 认设定 · 留空 = dsh 自己的工作目录',
          },
            h('input', {
              'data-bd-input': '', value: ws ?? '', placeholder: '/path/to/your/notes',
              onChange: (e) => { setWs(e.target.value); autoSave('ws', saveText) },
              onBlur: () => flushSave('ws'),
            })),
          h(Field, { label: '日报写多细' },
            h('select', {
              'data-bd-input': '', value: rl ?? 'full',
              onChange: (e) => { setRl(e.target.value); patch({ reportLevel: e.target.value }, '日报形态') },
            },
              h('option', { value: 'full' }, '完整 —— 每条：标题 / UP / 为什么值得'),
              h('option', { value: 'brief' }, '薄 —— 每条一两行'),
              h('option', { value: 'off' }, '不写 —— 只发评论')))),

        /* ── ④ 没字幕的视频 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '没字幕的视频'),
          /* ⭐⭐ 2026-10-18 加：字幕是判断依据里最贵的一条，但**没有它不等于没法判断** ——
           *   很多视频压根没有字幕（纯音乐 / 录屏 / 无语音），可标题和简介照样看得出对不对口。
           *   开着这个开关，这些视频就退回"只看面上的信息"，值得的照样推 ✓ */
          h(ToggleRow, {
            label: '拿不到字幕的也看看',
            note: '不开 = 直接跳过。开了 = 只凭**标题 / 简介 / 播放量**判断值不值得推，'
              + '**不去分析视频内容**；报告里会单独标出哪些是没看内容、只凭标题的',
            on: sw('noSubtitlePick'),
            onChange: (v) => patch({ noSubtitlePick: v }, '拿不到字幕的也看看'),
          }),
          sw('noSubtitlePick') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-note': '' },
              '这类推荐的把握**天然小一些**（没看过内容），所以：'
              + '值得推的照样推，但报告里每条都会写明「没看内容，只凭标题 / 简介」，'
              + '理由也不会编具体内容。嫌吵的话，把「每天最多挑几条」调小一点。')) : null,
          h(ToggleRow, {
            label: '在本机转写一遍',
            note: '比"只看标题"更实在：真把语音转成文字再判断（不花 API 钱，但慢，要下模型）',
            on: sw('transcribe'),
            onChange: (v) => patch({ transcribe: v }, '本地转写'),
          }),
          sw('transcribe') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('button', { 'data-bd-btn': '', disabled: busy === 'asr', onClick: onInstallAsr },
                st.asrReady ? '重装转写依赖' : '装转写依赖'),
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-note': '' },
                  !st.asrReady ? '还没装 —— 现在开着也没用，这些视频只能按上面那条规矩处理'
                    : (st.asrModelReady ? '环境和模型都好了' : '环境好了；模型第一次转写时自动下（几百 MB）')))),
            h('div', { 'data-bd-note': '' },
              '装一次就够：独立环境 + faster-whisper + yt-dlp + Whisper small 模型（走国内镜像）'),
            st.asrTail ? h('div', null,
              h('div', { 'data-bd-note': '' }, st.asrInstalling ? '正在装（进度）：' : '日志（末尾）：'),
              h('pre', { 'data-bd-pre': '' }, st.asrTail)) : null) : null),

        /* ── ⑤ 环境与账号 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '环境与账号'),
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', disabled: busy === 'install', onClick: onInstall },
              st.venvReady ? '重装主依赖' : '装主依赖'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'check', onClick: onCheck }, '测一下'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'update', onClick: onCheckUpdate }, '检查更新'),
            newVer ? h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: busy === 'upgrade', onClick: onUpgrade },
              '升级到 v' + newVer) : null,
            h('button', { 'data-bd-btn': '', disabled: busy === 'login', onClick: onLoginStart }, '扫码登录')),
          h('div', { 'data-bd-note': '' },
            !st.venvReady ? (st.installFailed ? '上次没装成 → 看下面日志' : '先点「装主依赖」')
              : (st.loggedIn ? '都好了' : '环境好了 → 点「扫码登录」')),
          loginState ? h('div', {
            'data-bd-msg': '',
            'data-good': loginTone === 'good' ? '' : undefined,
            'data-warn': loginTone === 'warn' ? '' : undefined,
          }, loginState) : null,
          login?.qr ? h('div', { 'data-bd-qr': '' },
            h('img', { src: login.qr, alt: 'B站登录二维码' }),
            h('div', { 'data-bd-note': '' },
              '手机 B站 → 我的 → 扫一扫。', h('br'),
              '确认时选「记住我 / 长期」那张 —— 选 24 小时的话明天就得重扫。')) : null,
          st.installTail ? h('div', null,
            h('div', { 'data-bd-note': '' }, st.installing ? '正在装（进度）：' : '日志（末尾）：'),
            h('pre', { 'data-bd-pre': '' }, st.installTail)) : null),

        /* ── ⑥ 文件在哪儿 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '文件在哪儿'),
          h('div', { 'data-bd-kv': '' }, `家目录：${st.home}`, h('br'), `今天的报告：${st.report}`),
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', disabled: busy === 'report', onClick: onShowReport },
              report !== null ? '收起报告' : '看今天的报告'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'verify', onClick: onVerify }, '复核评论'),
            // ⚠️ "让系统去打开"这回事**只有在有桌面的机器上才存在** ⇒ 没有就别摆这个按钮，
            //    换成下面那两个"翻目录"（那才是服务器 / NAS 上真能做到的 ✓）
            noDesktop ? null : h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('out') }, '打开报告文件夹'),
            noDesktop ? null : h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('home') }, '打开家目录'),
            h('button', {
              'data-bd-btn': '', onClick: () => setFilesWhat(filesWhat === 'out' ? '' : 'out'),
            }, filesWhat === 'out' ? '收起目录' : '翻报告目录'),
            h('button', {
              'data-bd-btn': '', onClick: () => setFilesWhat(filesWhat === 'home' ? '' : 'home'),
            }, filesWhat === 'home' ? '收起目录' : '翻家目录'),
            h('button', { 'data-bd-btn': '', onClick: () => copyText(st.report) }, '复制报告路径')),
          noDesktop ? h('div', { 'data-bd-note': '' },
            '这台机器上没有桌面（多半是服务器 / NAS）—— 让系统"打开文件夹"在这儿是做不到的事，'
            + '所以直接把目录摊在下面：能看内容、能下载 ✓') : null,
          filesWhat ? h(FilesPane, { what: filesWhat, onClose: () => setFilesWhat('') }) : null,
          report !== null ? h('pre', { 'data-bd-pre': '' }, report) : null)),

        tab === 'report' ? h(ReportView) : null,
        tab === 'debug' ? h(DebugView, { onRun, busy, st }) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-duty')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-duty: 设置页样式')

        // ⭐ 进「设置」：label 就是左侧导航里那一项（抄 dsh-meme 的写法）
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-scroll', order: 30, label: '刷B站' },
          () => h(Panel),
        ))
      },
    }
  },
})
