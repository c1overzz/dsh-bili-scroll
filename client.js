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
    // Prefer the host's real primitives so switches match the surrounding DSH UI exactly.
    // Older hosts may not expose the package to third-party plugins, so keep the local fallback.
    const NativeUI = (() => {
      try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return null }
    })()

    const API = '/api/bili-duty'
    /* ⚠️ 原来 jget/jpost 直接 .json()、从不看 res.ok ⇒ HTTP 500 的 {ok:false,error}
     *    会被调用方当成「已保存 / 成功」，绿色提示把故障盖掉。（2026-10-16 审查修） */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-bd-page]{box-sizing:border-box;display:flex;flex-direction:column;gap:0;padding:0 0 24px 28px;max-width:720px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;}
[data-bd-sec]{display:flex;flex-direction:column;gap:0;padding-top:20px;}
[data-bd-h]{color:var(--dsw-alias-label-primary);margin:0;padding:0 0 4px;font-size:18px;font-weight:600;line-height:26px;letter-spacing:0;}
[data-bd-row]{box-sizing:border-box;display:flex;align-items:center;gap:24px;min-width:0;}
[data-bd-page] > [data-bd-row]:first-child{gap:8px;flex-wrap:wrap;padding:0 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);}
[data-bd-sec] > [data-bd-row]{padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);}
[data-bd-sub] > [data-bd-row]{padding:12px 0;}
[data-bd-row] > button + [data-bd-note]{margin-top:0;}
[data-bd-row]:has(> [data-bd-btn]){flex-wrap:wrap;gap:8px;padding:12px 0;}
[data-bd-sec] > [data-bd-row]:has(> [data-bd-btn]){border-bottom:0;}
[data-bd-row]:has(> [data-bd-btn]) > [data-bd-btn]{padding-left:10px;padding-right:10px;}
[data-bd-grow]{flex:1 1 auto;min-width:0;}
[data-bd-switch]{box-sizing:border-box;flex:none;align-self:flex-start;display:flex;align-items:flex-start;min-height:20px;}
[data-bd-label]{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px;}
[data-bd-note]{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:4px;}
[data-bd-sw]{box-sizing:border-box;flex:none;width:36px;height:20px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;cursor:pointer;position:relative;background:var(--dsw-alias-interactive-bg-hover);transition:background .15s,border-color .15s;padding:0;}
[data-bd-sw][data-on]{background:var(--dsw-alias-label-primary,#f7f7f8);border-color:var(--dsw-alias-label-primary,#f7f7f8);}
[data-bd-sw] i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary,#b8bbc2);box-shadow:0 1px 2px rgba(0,0,0,.18);transition:left .15s,background .15s;display:block;}
[data-bd-sw][data-on] i{left:18px;background:var(--dsw-alias-bg-layer-2,#242529);}
[data-bd-sw][disabled]{opacity:.45;cursor:default;}
[data-bd-sub]{box-sizing:border-box;margin-left:0;padding-left:0;display:flex;flex-direction:column;gap:0;}
[data-bd-card]{margin:12px 0 0;padding:16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);}
[data-bd-card] + [data-bd-card]{margin-top:8px;}
[data-bd-card] > [data-bd-row]{border-bottom:0;padding:0;}
[data-bd-card] > [data-bd-row]:has(> [data-bd-btn]){justify-content:flex-end;margin-top:16px;padding:0;}
[data-bd-card] > [data-bd-label]{margin-top:16px;}
[data-bd-card] > [data-bd-label]:first-child{margin-top:0;font-size:16px;font-weight:500;line-height:24px;}
[data-bd-card] > [data-bd-input],[data-bd-card] > [data-bd-select]{margin-top:8px;}
[data-bd-sec] > [data-bd-label]{margin-top:16px;}
[data-bd-sec] > [data-bd-input],[data-bd-sec] > [data-bd-select]{margin-top:8px;}
[data-bd-sec] > [data-bd-note]{margin-top:8px;}
[data-bd-sub] > [data-bd-label]{margin-top:16px;}
[data-bd-sub] > [data-bd-input],[data-bd-sub] > [data-bd-select]{margin-top:8px;}
[data-bd-sub] > [data-bd-note]{margin-top:8px;}
[data-bd-input]{box-sizing:border-box;width:100%;min-width:0;height:36px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay,rgba(128,128,128,.08)));color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px;transition:border-color .15s,background .15s,box-shadow .15s;}
textarea[data-bd-input]{height:auto;min-height:116px;padding:8px 10px;line-height:20px;resize:vertical;}
select[data-bd-input]{cursor:pointer;}
[data-bd-input]:hover{border-color:var(--dsw-alias-border-l2);}
[data-bd-input]:focus{outline:none;border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d8dff));box-shadow:0 0 var(--dsw-focus-ring-width,2px) color-mix(in srgb,var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d8dff)) 20%,transparent);}
[data-bd-select]{position:relative;box-sizing:border-box;width:100%;min-width:0;}
[data-bd-select-trigger]{display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;white-space:nowrap;overflow:hidden;border-color:transparent;border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-interactive-bg-hover);}
[data-bd-select-trigger]:hover{border-color:transparent;background:var(--dsw-alias-interactive-bg-hover);}
[data-bd-select-trigger]::after{content:'';box-sizing:border-box;flex:none;width:7px;height:7px;margin:0 3px 4px 8px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);transition:transform .15s;}
[data-bd-select-trigger][aria-expanded='true']::after{margin-bottom:-3px;transform:rotate(225deg);}
[data-bd-select-menu]{position:absolute;z-index:30;top:calc(100% + 6px);left:0;right:0;max-height:260px;overflow:auto;padding:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-overlay,#343538));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.28));}
[data-bd-select-option]{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:36px;padding:0 10px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer;}
[data-bd-select-option]:hover,[data-bd-select-option][data-selected]{background:var(--dsw-alias-interactive-bg-hover);}
[data-bd-select-option] > span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bd-select-check]{flex:none;color:var(--dsw-alias-label-primary);font-size:18px;line-height:1;}
[data-bd-num]{width:64px;flex:none;text-align:center;}
[data-bd-btn]{box-sizing:border-box;min-height:32px;padding:0 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;cursor:pointer;transition:background .15s,border-color .15s,color .15s;}
[data-bd-btn]:hover{background:var(--dsw-alias-interactive-bg-hover);}
[data-bd-btn]:focus-visible,[data-bd-sw]:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d8dff));outline-offset:2px;}
[data-bd-btn][data-primary]{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d8dff);border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d8dff);color:var(--dsw-static-white,#fff);}
[data-bd-btn][data-primary]:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d8dff) 88%,black);}
[data-bd-btn][disabled],[data-bd-input][disabled]{opacity:.5;cursor:default;}
[data-bd-msg]{font-size:12px;line-height:18px;margin-top:8px;padding:0;word-break:break-word;color:var(--dsw-alias-label-secondary);}
[data-bd-msg][data-warn]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#f59e0b));}
[data-bd-msg][data-good]{color:var(--dsw-alias-state-success-primary,#22c55e);}
[data-bd-qr]{display:flex;gap:16px;align-items:flex-start;margin-top:16px;padding:16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);}
[data-bd-qr] img{box-sizing:border-box;width:150px;height:150px;border-radius:var(--dsw-radius-md);background:#fff;padding:6px;}
[data-bd-pre]{box-sizing:border-box;margin:12px 0 0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);max-height:170px;overflow:auto;font:12px/18px ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',monospace;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.18));color:var(--dsw-alias-label-secondary);}
[data-bd-kv]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word;}
[data-bd-badge]{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);font-size:11px;line-height:16px;padding:1px 6px;color:var(--dsw-alias-label-secondary);background:transparent;}
[data-bd-page] button,[data-bd-page] input,[data-bd-page] select,[data-bd-page] textarea{font-family:inherit;}
[data-bd-page] button:disabled{cursor:default;}
@media (max-width:600px){[data-bd-row]{gap:12px;}[data-bd-sub]{margin-left:0;padding-left:0;}[data-bd-num]{width:64px;}[data-bd-qr]{flex-direction:column;}}
`

    // ⚠️ 与 lib/state.mjs 的 WINDOWS 保持一致（官方口径：工作日 9–12、14–18 是高峰，其余都是谷时）
    const DEFAULT_WINDOWS = {
      noon: { label: '中午谷时', start: '12:00', end: '14:00' },
      night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
    }

    /* ────────────── 小组件 ────────────── */

    function Switch({ on, onChange, disabled, label }) {
      if (NativeUI?.Switch) {
        return h(NativeUI.Switch, {
          checked: Boolean(on),
          label,
          disabled: Boolean(disabled),
          onChange,
        })
      }
      return h('button', {
        'data-bd-sw': '',
        'data-on': on ? '' : undefined,
        role: 'switch',
        'aria-checked': on,
        'aria-label': label,
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
        h('div', { 'data-bd-switch': '' },
          h(Switch, { on, onChange, disabled, label })))
    }

    // Native DSH uses a themed listbox rather than the browser's OS select popup.
    // Keep the existing change handlers working by passing a small event-shaped object.
    function MenuSelect({ value, onChange, disabled, children, ariaLabel }) {
      const [open, setOpen] = React.useState(false)
      const root = React.useRef(null)
      const options = React.Children.toArray(children).filter(Boolean)
      const selected = options.find((option) => String(option.props.value ?? '') === String(value ?? '')) || options[0]
      const selectedValue = selected ? String(selected.props.value ?? '') : String(value ?? '')

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (!root.current?.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const choose = (next) => {
        if (String(next) !== String(value ?? '')) onChange?.({ target: { value: String(next) } })
        setOpen(false)
      }

      return h('div', { 'data-bd-select': '', ref: root },
        h('button', {
          type: 'button',
          'data-bd-input': '',
          'data-bd-select-trigger': '',
          'aria-label': ariaLabel,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          disabled: Boolean(disabled),
          onClick: () => { if (!disabled) setOpen((current) => !current) },
        }, selected?.props?.children ?? selectedValue),
        open ? h('div', { 'data-bd-select-menu': '', role: 'listbox' },
          options.map((option, index) => {
            const optionValue = String(option.props.value ?? '')
            const isSelected = optionValue === selectedValue
            return h('button', {
              key: option.key ?? optionValue + ':' + index,
              type: 'button',
              'data-bd-select-option': '',
              'data-selected': isSelected ? '' : undefined,
              role: 'option',
              'aria-selected': isSelected,
              onClick: () => choose(optionValue),
            },
              h('span', null, option.props.children),
              isSelected ? h('span', { 'data-bd-select-check': '', 'aria-hidden': 'true' }, '✓') : null)
          })) : null)
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

    /* ────────────── 设置页正文 ────────────── */

    function Panel() {
      const [st, setSt] = useStatus(5000)
      const [busy, setBusy] = React.useState('')
                  const [kws, setKws] = React.useState(null)
      const [ws, setWs] = React.useState(null)
      const [rl, setRl] = React.useState(null)
      const [newVer, setNewVer] = React.useState('')       // 发现的新版本号（空 = 没发现）          // 日报形态：full / brief / off
      // ⚠️ 输入框必须绑"本地草稿"：页面每 5 秒轮询 /status，服务端那份会把 config 盖掉
      //    ⇒ 直接绑 cfg 的话，用户打字打到一半就被冲没了 ✗（2026-10-14 陌生人验收时抓到）
      const [perDay, setPerDay] = React.useState(null)
      const [perRound, setPerRound] = React.useState(null)
      const [replyPer, setReplyPer] = React.useState(null)
      const [dmUid, setDmUid] = React.useState(null)        // 私信收件人 UID（本地草稿）
      const [dmMode, setDmMode] = React.useState(null)      // 投递方式：off / only / both
      const [mention, setMention] = React.useState(null)
      const [friend, setFriend] = React.useState(null)
      const [friendKws, setFriendKws] = React.useState(null)
      const [friendsText, setFriendsText] = React.useState(null)
      const [friends, setFriends] = React.useState(null)
      const [roundSel, setRoundSel] = React.useState(null)
      const [roundEffort, setRoundEffort] = React.useState(null)
      const [watchMin, setWatchMin] = React.useState(null)
      const [login, setLogin] = React.useState(null)
      const [runNote, setRunNote] = React.useState(null)
      const [report, setReport] = React.useState(null)        // 非 null = 报告已展开   // 顶部那行状态（跑一轮/装依赖的反馈原来在最底下，看不见）
      const [loginState, setLoginState] = React.useState('')
      const [loginTone, setLoginTone] = React.useState('')
      /* ⚠️ 扫码轮询的 timer 必须能停：切走设置页后还在跑的话会在已卸载的组件上 setState，
       *    重复点「扫码登录」还会叠出第二个 timer。（2026-10-16 审查修） */
      const loginTimer = React.useRef(null)
      const alive = React.useRef(true)
      React.useEffect(() => () => {
        alive.current = false
        if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }
      }, [])

      const cfg = st?.config
      React.useEffect(() => {
        if (cfg && kws === null) setKws((cfg.keywords || []).join('\n'))
        if (cfg && ws === null) setWs(cfg.workspace || '')
        if (cfg && rl === null) setRl(cfg.reportLevel || 'full')
        if (cfg && perDay === null) setPerDay(String(cfg.perDay ?? 5))
        if (cfg && perRound === null) setPerRound(String(cfg.commentPerRound ?? 1))
        if (cfg && replyPer === null) setReplyPer(String(cfg.replyPerRound ?? 1))
        if (cfg && mention === null) setMention(cfg.mentionName || '')
        if (cfg && friend === null) setFriend(cfg.friendName || '')
        if (cfg && friendKws === null) setFriendKws((cfg.friendKeywords || []).join('、'))
        if (cfg && roundSel === null) setRoundSel(`${cfg.roundProvider || 'deepseek-account'}|${cfg.roundModel || 'deepseek-flash'}`)
        if (cfg && roundEffort === null) {
          const list = String(cfg.roundProvider || '').startsWith('sub2api') ? ['low', 'medium', 'high', 'xhigh'] : ['off', 'low', 'high', 'max']
          setRoundEffort(list.includes(cfg.roundEffort) ? cfg.roundEffort : 'high')
        }
        if (cfg && friends === null) {
          const arr = Array.isArray(cfg.friends) && cfg.friends.length
            ? cfg.friends
            : (cfg.friendName ? [{ name: cfg.friendName, keywords: cfg.friendKeywords || [], delivery: 'comment', uid: 0 }] : [])
          setFriends(arr.map((f) => ({ name: f.name || '', keywords: (f.keywords || []).join('，'), delivery: f.delivery === 'dm' ? 'dm' : 'comment', uid: Number(f.uid) || 0 })))
        }
        if (cfg && watchMin === null) setWatchMin(String(cfg.replyWatchMinutes ?? 10))
        if (cfg && dmUid === null) setDmUid(cfg.dmUid ? String(cfg.dmUid) : '')
        if (cfg && dmMode === null) setDmMode(cfg.dmMode || 'off')
      }, [cfg])

      const win = { ...DEFAULT_WINDOWS, ...(st?.windows || {}) }

      const say = (text, tone) => {
        setRunNote(text ? { t: text, tone: tone || '' } : null)   // ⭐ 同时镜像到顶部，免得提示掉到页面最底下看不见
      }

      const patch = async (p, what) => {
        setBusy(JSON.stringify(p))
        try {
          const r = await jpost('/config', p)
          if (r?.config) setSt((old) => ({ ...old, config: r.config }))
          // ⭐ DSH 原生设置页里显式设过的键由宿主说了算 ⇒ 我们这份也得写进去；写失败要说出来，别假装"已保存"
          if (r?.host && r.host.ok === false) say(`${what || '设置'}：插件自己那份存了，但 DSH 设置页那份没写进去（${r.host.error}）`, 'warn')
          else say(what ? `${what}：已保存` : '已保存', 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      // ⭐ 朋友名单：每张卡片独立编辑（昵称 / 标签 / 投递 / UID），保存时统一规范化
      const saveFriends = (list, what) => {
        const clean = (Array.isArray(list) ? list : []).map((f) => ({
          name: String(f.name || '').trim().slice(0, 40),
          keywords: String(f.keywords || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 10),
          delivery: f.delivery === 'dm' ? 'dm' : 'comment',
          uid: Math.max(0, Number(f.uid) || 0),
        })).filter((f) => f.name).slice(0, 10)
        setFriends(clean.map((f) => ({ ...f, keywords: f.keywords.join('，') })))
        patch({ friends: clean }, what || '朋友名单')
      }
      const editFriend = (i, p) => {
        const next = (friends || []).map((f, j) => (j === i ? { ...f, ...p } : f))
        setFriends(next)
        return next
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
          if (r && r.ok) say('已请系统打开：' + (r.opened || '') + '（要是没看到窗口，用旁边的「复制报告路径」——那个一定成）', 'good')
          else say('打不开（' + ((r && r.error) || '未知原因') + '）—— 你可以手动打开这个路径：' + ((r && r.dir) || ''))
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }

      const onUpgrade = async () => {
        setBusy('upgrade')
        try {
          const r = await jpost('/upgrade', {})
          // 原来这两句分两次 say，第二句把服务端的 hint 冲掉了 —— 合成一句。（2026-10-16 审查修）
          say(((r && r.hint) || '正在升级') + ' —— 升级过程写在下面的「主依赖的日志」里；完了记得重启一次 dsh（不重启还是旧版）', 'warn')
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
          // ⚠️ busy=true 不是"起不来"：并发闸挡掉了重复点击（上一轮还在跑）—— 要分开说
          if (r?.started) say('已经在后台跑一轮了，报告会写在 out/ 里', 'good')
          else if (r?.busy) say('上一轮还在跑，等它结束再点（这轮没重复启动）', 'warn')
          else say(r?.hint || '没起来，看 duty.log', 'warn')
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
          if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }   // 重复点：先把上一轮停掉
          let n = 0
          const stop = () => { clearInterval(timer); if (loginTimer.current === timer) loginTimer.current = null }
          const timer = setInterval(async () => {
            if (!alive.current) { stop(); return }        // 已经切走设置页了：别再问、别再 setState
            n += 1
            try {
              const p = await jpost('/login/poll', { key: r.key })
              if (p?.state === 'ok') {
                stop(); setLogin(null)
                setLoginTone('good'); setLoginState('登录成功')
                setSt((old) => ({ ...old, loggedIn: true }))
              } else if (p?.state === 'scanned') { setLoginTone(''); setLoginState('扫到了，请在手机上确认') }
              else if (p?.state === 'expired') { stop(); setLogin(null); setLoginTone('warn'); setLoginState('二维码过期了，再点一次「扫码登录」') }
              // ⚠️ 扫码成功但响应里没有 SESSDATA 时服务端回 state='unknown'：原来没这个分支
              //    ⇒ 界面一直显示「等扫码…」，用户白等 3 分钟才超时。（2026-10-16 审查修）
              else if (p?.state === 'unknown') {
                stop(); setLogin(null); setLoginTone('warn')
                setLoginState('没登上：' + (p?.message || '响应里没有 SESSDATA —— 再点一次「扫码登录」'))
              }
              else { setLoginTone(''); setLoginState('等扫码…') }
            } catch { /* 抖动就下次再问 */ }
            if (n > 90) { stop(); setLogin(null); setLoginTone('warn'); setLoginState('超时了，再点一次「扫码登录」') }
          }, 2000)
          loginTimer.current = timer
        } catch (e) { setLoginTone('warn'); setLoginState(String(e?.message ?? e)) }
        finally { setBusy('') }
      }

      const onSaveText = async () => {
        const list = String(kws || '').split('\n').map((s) => s.trim()).filter(Boolean)
        await patch({ keywords: list, workspace: String(ws || '').trim() }, '关键词与工作区')
      }

      if (!cfg) {
        return h('div', { 'data-bd-page': '' }, h('div', { 'data-bd-note': '' }, '读设置中…'))
      }

      const sw = (k) => Boolean(cfg[k])

      return h('div', { 'data-bd-page': '' },

        /* ── 今天 ── */
        h('div', { 'data-bd-row': '' },
          h('span', { 'data-bd-badge': '' }, `今天已挑 ${st.pickedToday ?? st.ranToday ?? 0} / ${cfg.perDay} 条`),
          h('span', { 'data-bd-badge': '' }, '环境' + (st.venvReady ? '已就绪' : (st.installing ? '正在装' : '未装'))),
          h('span', { 'data-bd-badge': '' }, st.loggedIn ? 'B站已登录' : 'B站未登录'),
            h('span', { 'data-bd-badge': '' }, 'v' + (st.version || '?')),
          h('div', { 'data-bd-grow': '' }),
          h('button', { 'data-bd-btn': '', disabled: Boolean(busy), onClick: onSaveText }, '保存'),
          h('button', { 'data-bd-btn': '', disabled: busy === 'run' || Boolean(st.running), onClick: onRun },
            st.running ? '正在跑…' : '现在跑一轮')),
          runNote ? h('div', { 'data-bd-msg': '', 'data-good': runNote.tone === 'good' ? '' : undefined,
            'data-warn': runNote.tone === 'warn' ? '' : undefined }, runNote.t) : null,

        /* ── 设置没同步到 DSH 那边时，明说出来（别再假装保存成功）──
           2026-10-18：DSH 0.2.1 某些启动方式会拒写（profile reload requires the root Include entry），
           以前的表现是"开关亮一下又被压回原状"，用户以为是自己手滑。 */
        (Array.isArray(st.notSynced) && st.notSynced.length)
          ? h('div', { 'data-bd-msg': '', 'data-warn': '' },
              `提示：有 ${st.notSynced.length} 项没能同步到 DSH 原生设置（${st.notSynced.join('、')}）。`
              + '插件会以这里的设置为准，功能照常；只是 DSH 自带的那页看不到这些值。')
          : null,

        /* ── 定时 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '什么时候跑、跑多少'),
          h(ToggleRow, {
            label: '峰谷时段自动刷',
            note: '只在谷时跑 —— 工作日 12:00–14:00 与 18:00 之后（整个周末也算谷时）；关了就只能手动跑',
            on: sw('peakValley'),
            onChange: (v) => patch({ peakValley: v }, '峰谷时段自动刷'),
          }),
          sw('peakValley') ? h('div', { 'data-bd-sub': '' },
            ...['noon', 'night'].map((k) => h(ToggleRow, {
              key: k,
              label: win[k].label,
              note: `${win[k].start} – ${win[k].end}`,
              on: sw(k),
              onChange: (v) => patch({ [k]: v }, win[k].label),
            }))) : null,
          h('div', { 'data-bd-row': '' },
            h('div', { 'data-bd-grow': '' },
              h('div', { 'data-bd-label': '' }, '每天最多挑几条'),
              h('div', { 'data-bd-note': '' }, '填 0 = 不自动刷（还是能手动跑）')),
            h('input', {
              'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, max: 50,
              value: perDay ?? '',
              onChange: (e) => setPerDay(e.target.value),
              onBlur: () => { const n = Math.max(0, Math.min(Number(perDay) || 0, 50)); setPerDay(String(n)); patch({ perDay: n }, '每天挑几条') },
            })),
          st.lastRunAt ? h('div', { 'data-bd-note': '' }, `上次跑：${new Date(st.lastRunAt).toLocaleString('zh-CN')}`) : null),

        /* ── 回复与评论 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '回复、评论与转写'),
          h(ToggleRow, {
            label: '回复评论（只回楼中楼）',
            note: '默认关；开了之后它只回「直接回复到你那条评论下面的人」，不参与讨论',
            on: sw('replyToComments'),
            onChange: (v) => patch({ replyToComments: v }, '回复评论'),
          }),
          sw('replyToComments') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '每轮最多回几条'),
                h('div', { 'data-bd-note': '' }, '只回直接回在你那条评论下面的人')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 1, max: 10,
                value: replyPer ?? '',
                onChange: (e) => setReplyPer(e.target.value),
                onBlur: () => { const n = Math.max(1, Math.min(Number(replyPer) || 1, 10)); setReplyPer(String(n)); patch({ replyPerRound: n }, '每轮几条回复') },
              })),
            h(ToggleRow, {
              label: '有人回复我时，自动起来处理',
              note: '每隔几分钟查一次自己评论过的楼中楼（不花 token），有回复才起一轮',
              on: sw('replyWatch'),
              onChange: (v) => patch({ replyWatch: v }, '回复监听'),
            }),
            sw('replyWatch') ? h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '检查间隔（分钟）'),
                h('div', { 'data-bd-note': '' }, '1–120；改完要重载插件才按新间隔跑')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 1, max: 120,
                value: watchMin ?? '',
                onChange: (e) => setWatchMin(e.target.value),
                onBlur: () => { const n = Math.max(1, Math.min(Number(watchMin) || 10, 120)); setWatchMin(String(n)); patch({ replyWatchMinutes: n }, '检查间隔') },
              })) : null) : null,
          h(ToggleRow, {
            label: '自动评论并 @ 你',
            note: '默认关；开了之后它会在挑中的视频下面留评论，并 @ 你填的那个人（「评论投递」的朋友也靠这个总开关）',
            on: sw('autoComment'),
            onChange: (v) => patch({ autoComment: v }, '自动评论'),
          }),
          sw('autoComment') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '每轮最多发几条评论'),
                h('div', { 'data-bd-note': '' }, '每条评论里 @ 一次下面那个人；填 0 = 这一轮不发评论')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, max: 20,
                value: perRound ?? '',
                onChange: (e) => setPerRound(e.target.value),
                // ⭐ 0 是合法值（= 这一轮不发评论）；范围与 index.js 的 clampPatch 一致（0–20）
                onBlur: () => { const n = Math.max(0, Math.min(Number(perRound) || 0, 20)); setPerRound(String(n)); patch({ commentPerRound: n }, '每轮几条评论') },
              })),
            h('div', { 'data-bd-label': '' }, '要 @ 谁（B站 昵称）'),
            h('input', {
              'data-bd-input': '', value: mention ?? '',
              placeholder: '填你要 @ 的那个人的 B站 昵称；留空 = 只写报告、不发评论',
              onChange: (e) => setMention(e.target.value),
              onBlur: () => { const v = String(mention || '').trim(); setMention(v); patch({ mentionName: v }, '要 @ 谁') },
            }),
            h('div', { 'data-bd-note': '' }, '留空的话它就不发评论了 —— 因为评论存在的意义就是 @ 那一下'),
            h('div', { 'data-bd-label': '' }, '你的投递方式（评论 还是 私信）'),
            h(MenuSelect, {
              'data-bd-input': '', value: dmMode ?? 'off',
              onChange: (e) => { setDmMode(e.target.value); patch({ dmMode: e.target.value }, '投递方式') },
            },
              h('option', { value: 'off' }, '只发评论 —— 在视频下面 @ 你（默认）'),
              h('option', { value: 'only' }, '只私信 —— 不公开 @ 你，结果走私信（朋友和回复按各自设置）'),
              h('option', { value: 'both' }, '评论 + 私信 —— 两边都发')),
            h('div', { 'data-bd-note': '' }, '这只管挑片评论：朋友按「投递方式」、回复按「回复评论」开关，互不影响'),
            (dmMode && dmMode !== 'off') ? h('div', { 'data-bd-sub': '' },
              h('div', { 'data-bd-label': '' }, '私信发给你自己（B站 UID，数字）'),
              h('input', {
                'data-bd-input': '', type: 'text', inputMode: 'numeric', value: dmUid ?? '',
                placeholder: '你的数字 UID；比如你自己的另一个号',
                onChange: (e) => setDmUid(e.target.value),
                onBlur: () => { const n = Math.max(0, Number(dmUid) || 0); setDmUid(n ? String(n) : ''); patch({ dmUid: n }, '私信收件人') },
              }),
              h('div', { 'data-bd-note': '' }, '私信内容 = 本轮每条的「标题 + 链接 + 一句话」，一轮合并成一条发（不受 150 字限制）')) : null) : null,
          h('div', { 'data-bd-row': '' },
            h('div', { 'data-bd-grow': '' },
              h('div', { 'data-bd-label': '' }, '朋友（可选；命中标签才 @ / 私信他们）')),
            h('button', {
              'data-bd-btn': '',
                            onClick: () => setFriends([...(friends || []), { name: '', keywords: '', delivery: 'comment', uid: 0 }]),
            }, '＋ 添加')),
          (friends || []).map((f, i) => h('div', { 'data-bd-sub': '', 'data-bd-card': '', key: 'f' + i },
            h('div', { 'data-bd-label': '' }, `朋友 ${i + 1} · 昵称（B站 昵称）`),
            h('input', {
              'data-bd-input': '', value: f.name, placeholder: '填他的 B站 昵称',
              onChange: (e) => editFriend(i, { name: e.target.value }),
              onBlur: () => saveFriends(friends, '朋友昵称'),
            }),
            h('div', { 'data-bd-label': '' }, '触发标签（按视频 tags，用、或逗号分隔）'),
            h('input', {
              'data-bd-input': '', value: f.keywords, placeholder: '哈基米，神人，搞笑',
              onChange: (e) => editFriend(i, { keywords: e.target.value }),
              onBlur: () => saveFriends(friends, '朋友标签'),
            }),
            h('div', { 'data-bd-label': '' }, '投递方式（评论 还是 私信）'),
            h(MenuSelect, {
              'data-bd-input': '', value: f.delivery,
              onChange: (e) => saveFriends((friends || []).map((x, j) => (j === i ? { ...x, delivery: e.target.value } : x)), '朋友投递方式'),
            },
              h('option', { value: 'comment' }, '评论 —— 在视频下面 @ 他（不受「只私信」影响）'),
              h('option', { value: 'dm' }, '私信 —— 不公开，发到他收件箱')),
            f.delivery === 'dm' ? h('div', { 'data-bd-label': '' }, '私信发给谁（B站 UID，数字）') : null,
            f.delivery === 'dm' ? h('input', {
              'data-bd-input': '', type: 'text', inputMode: 'numeric', value: f.uid || '',
              placeholder: '他的数字 UID；私信必填',
              onChange: (e) => editFriend(i, { uid: Number(e.target.value) || 0 }),
              onBlur: () => saveFriends(friends, '朋友 UID'),
            }) : null,
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' }),
              h('button', {
                'data-bd-btn': '',
                 onClick: () => saveFriends((friends || []).filter((_, j) => j !== i), '删除朋友'),
              }, '删除')))),
          h(ToggleRow, {
            label: '本地转写没字幕的视频',
            note: '默认关；开了以后，没字幕的视频会在本机转写一遍（不花 API 钱）',
            on: sw('transcribe'),
            onChange: (v) => patch({ transcribe: v }, '本地转写'),
          }),
          sw('transcribe') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('button', { 'data-bd-btn': '', disabled: busy === 'asr', onClick: onInstallAsr },
                st.asrReady ? '重装转写依赖' : '装转写依赖'),
              h('div', { 'data-bd-note': '' },
                !st.asrReady ? '还没装 —— 现在开着也没用：没字幕的视频会被跳过（报告里会写"因无字幕跳过 N 条"）'
                  : (st.asrModelReady ? '环境和模型都好了' : '环境好了；模型会在第一次转写时自动下（几百 MB）'))),
            h('div', { 'data-bd-note': '' },
              '点一下就好：建一个独立环境、装 faster-whisper + yt-dlp，并把 Whisper 模型也下好',
              h('br'),
              '（模型默认 small，几百 MB，走国内镜像；装一次就够了）'),
            st.asrTail ? h('div', null,
              h('div', { 'data-bd-note': '' }, st.asrInstalling ? '正在装转写依赖（进度）：' : '转写依赖的日志（末尾）—— 只有「没字幕的视频」用得到它：'),
              h('pre', { 'data-bd-pre': '' }, st.asrTail)) : null) : null),

        /* ── 关注什么 / 在哪儿刷 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '关注什么'),
          h('textarea', {
            'data-bd-input': '', rows: 5, placeholder: '一行一个关键词；留空用内置那几组',
            value: kws ?? '', onChange: (e) => setKws(e.target.value),
          }),
          h('div', { 'data-bd-label': '' }, '工作区（它按这里的 AGENTS.md 认设定）'),
          h('input', {
            'data-bd-input': '', value: ws ?? '',
            placeholder: '填你自己的工作区路径（留空 = 不读人设，按中性说话）',
            onChange: (e) => setWs(e.target.value),
          }),
          h('div', { 'data-bd-note': '' },
            '⭐ 想让它按你的设定说话，这里要填你自己平时用的那个工作区（放 AGENTS.md 的那个目录）；',
            h('br'),
            '留空不等于"用你的工作区" —— 那是不读设定、按中性说话（以前会去猜 dsh 进程自己的目录，容易读错人设）。'),
          h('div', { 'data-bd-label': '' }, '日报写多细'),
          h(MenuSelect, {
            'data-bd-input': '', value: rl ?? 'full',
            onChange: (e) => { setRl(e.target.value); patch({ reportLevel: e.target.value }, '日报形态') },
          },
            h('option', { value: 'full' }, '完整 —— 每条：标题 / UP / 为什么值得（默认）'),
            h('option', { value: 'brief' }, '薄 —— 每条一两行，只留值不值得 + 链接'),
            h('option', { value: 'off' }, '不写 —— 只发评论，不生成日报文件')),
          ),

        /* ── 环境与账号 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '环境与账号'),
          h('div', { 'data-bd-label': '' }, '这一轮用哪个模型'),
          h(MenuSelect, {
            'data-bd-input': '', value: roundSel ?? 'deepseek-account|deepseek-flash',
            onChange: (e) => {
              const [p, m] = e.target.value.split('|')
              // ⭐ 换模型时把强度一起落到新模型支持的档位（不然下拉会显示一个不存在的档）
              const opts = p === 'sub2api' ? ['low', 'medium', 'high', 'xhigh'] : ['off', 'low', 'high', 'max']
              const eff = opts.includes(roundEffort) ? roundEffort : 'high'
              setRoundSel(e.target.value)
              setRoundEffort(eff)
              patch({ roundProvider: p, roundModel: m, roundEffort: eff }, '模型')
            },
          },
            h('option', { value: 'deepseek-account|deepseek-flash' }, 'deepseek-flash —— 快、便宜（默认）'),
            h('option', { value: 'deepseek-account|deepseek-v4-pro' }, 'deepseek-v4-pro —— 更强一些'),
            h('option', { value: 'sub2api|gpt-6-astra' }, 'gpt-6-astra —— 第三方，最强也最贵')),
          h('div', { 'data-bd-label': '' }, '思考强度'),
          h(MenuSelect, {
            'data-bd-input': '', value: roundEffort ?? 'high',
            onChange: (e) => { setRoundEffort(e.target.value); patch({ roundEffort: e.target.value }, '思考强度') },
          },
            (String(roundSel || '').startsWith('sub2api')
              ? [['low', 'low —— 快'], ['medium', 'medium'], ['high', 'high —— 默认'], ['xhigh', 'xhigh —— 最费']]
              : [['off', 'off —— 不思考，最省'], ['low', 'low —— 快'], ['high', 'high —— 默认'], ['max', 'max —— 最费']]
            ).map(([v, label]) => h('option', { value: v, key: v }, label))),
          h('div', { 'data-bd-note': '' }, '只影响「刷B站」那一轮，不影响你在桌面聊天的模型；改完下一轮生效。'
            + '思考强度换模型时会自动落到它支持的档位（不支持的退 high）'),
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', disabled: busy === 'install', onClick: onInstall },
              st.venvReady ? '重装主依赖' : '装主依赖（建 venv）'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'check', onClick: onCheck }, '测一下'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'update', onClick: onCheckUpdate }, '检查更新'),
            newVer ? h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: busy === 'upgrade', onClick: onUpgrade }, '一键升级到 v' + newVer) : null,
            h('button', { 'data-bd-btn': '', disabled: busy === 'login', onClick: onLoginStart }, '扫码登录'),
            h('div', { 'data-bd-note': '' },
              !st.venvReady ? (st.installFailed ? '上次没装成 → 看下面日志' : '还没装 → 先点「装主依赖」')
                : (st.loggedIn ? '装好了 → 下一步「扫码登录」' : '环境好了 → 点「扫码登录」'))),
          loginState ? h('div', { 'data-bd-msg': '', 'data-good': loginTone === 'good' ? '' : undefined, 'data-warn': loginTone === 'warn' ? '' : undefined }, loginState) : null,
          st.installTail ? h('div', null,
            h('div', { 'data-bd-note': '' }, st.installing ? '正在装主依赖（进度）：' : '主依赖的日志（B站 搜索 / 字幕 / 评论 用得到，末尾）：'),
            h('pre', { 'data-bd-pre': '' }, st.installTail)) : null,
          login?.qr ? h('div', { 'data-bd-qr': '' },
            h('img', { src: login.qr, alt: 'B站登录二维码' }),
            h('div', { 'data-bd-note': '' },
              '手机 B站 → 我的 → 扫一扫。',
              h('br'),
              '确认时选「记住我 / 长期」那张 —— 选 24 小时的话，明天就得重扫。')) : null),

        /* ── 它是怎么干活的（给他看的） ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '它的地盘'),
          h('div', { 'data-bd-kv': '' },
            `家目录：${st.home}`,
            h('br'),
            `今天的报告：${st.report}`),
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', disabled: busy === 'report', onClick: onShowReport },
              report !== null ? '收起报告' : '看今天的报告'),
            h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('out') }, '打开报告文件夹'),
            h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('home') }, '打开家目录'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'verify', onClick: onVerify },
              '复核评论'),
            h('button', { 'data-bd-btn': '', onClick: () => copyText(st.report) }, '复制报告路径')),
          report !== null ? h('pre', { 'data-bd-pre': '' }, report) : null),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-scroll')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-scroll: 设置页样式')

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
