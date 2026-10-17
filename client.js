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
[data-bd-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:640px;}
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
      // ⭐ 全页**唯一**的反馈位 —— 原来 msg / runNote 各存一份、上下各渲染一遍，同一句话出现两遍 ✗
      const [note, setNote] = React.useState(null)
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
      const [aiKw, setAiKw] = React.useState(null)          // 自定义 AI 识别词（本地草稿，一行一个）
      const [mention, setMention] = React.useState(null)
      const [login, setLogin] = React.useState(null)
      const [report, setReport] = React.useState(null)        // 非 null = 报告已展开
      const [loginState, setLoginState] = React.useState('')
      const [loginTone, setLoginTone] = React.useState('')

      const cfg = st?.config
      React.useEffect(() => {
        if (cfg && kws === null) setKws((cfg.keywords || []).join('\n'))
        if (cfg && ws === null) setWs(cfg.workspace || '')
        if (cfg && rl === null) setRl(cfg.reportLevel || 'full')
        if (cfg && perDay === null) setPerDay(String(cfg.perDay ?? 5))
        if (cfg && perRound === null) setPerRound(String(cfg.commentPerRound ?? 1))
        if (cfg && replyPer === null) setReplyPer(String(cfg.replyPerRound ?? 1))
        if (cfg && mention === null) {
          // ⭐ 新配置是列表（mentionNames）；老配置是单名字（mentionName）—— 这里自动迁移着显示
          const list = Array.isArray(cfg.mentionNames) ? cfg.mentionNames.filter(Boolean) : []
          setMention(list.length ? list.join('\n') : (cfg.mentionName || ''))
        }
        if (cfg && dmUid === null) setDmUid(cfg.dmUid ? String(cfg.dmUid) : '')
        if (cfg && dmMode === null) setDmMode(cfg.dmMode || 'off')
        if (cfg && aiKw === null) setAiKw((cfg.aiKeywords || []).join('\n'))
      }, [cfg])

      const win = { ...DEFAULT_WINDOWS, ...(st?.windows || {}) }

      /** ⭐ 全页唯一的反馈出口：按钮 / 保存 / 复核的结果都走这里，只在状态条下面显示一处 */
      const say = (text, tone) => setNote(text ? { t: text, tone: tone || '' } : null)

      const patch = async (p, what) => {
        setBusy(JSON.stringify(p))
        try {
          const r = await jpost('/config', p)
          if (r?.config) setSt((old) => ({ ...old, config: r.config }))
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
          if (r && r.ok) say('已请系统打开：' + (r.opened || '') + '（要是没看到窗口，用旁边的「复制报告路径」——那个一定成）', 'good')
          else say('打不开（' + ((r && r.error) || '未知原因') + '）—— 你可以手动打开这个路径：' + ((r && r.dir) || ''))
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

      /** 一行一个 → 去空行、去首尾空格、**顺手去重**（原来同一个词填两遍会原样存进去） */
      const asList = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean)
        .filter((x, i, a) => a.indexOf(x) === i)

      const saveText = (over) => patch({
        keywords: asList(over?.kws ?? kws),
        workspace: String((over?.ws ?? ws) || '').trim(),
      }, '关键词与工作区')

      if (!cfg) {
        return h('div', { 'data-bd-page': '' }, h('div', { 'data-bd-note': '' }, '读设置中…'))
      }

      const sw = (k) => Boolean(cfg[k])

      // ⭐ 楼中楼只在「真的会发公开评论」时才有意义：没开自动评论、或投递方式选了「只私信」时
      //    它整个不生效 —— 界面上要置灰 + 说清原因，而不是留个亮着却什么都不干的开关 ✗
      const canComment = sw('autoComment') && (dmMode || 'off') !== 'only'

return h('div', { 'data-bd-page': '' },

        /* ── 顶部状态条 ── */
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

        h('div', { 'data-bd-note': '' },
          '开关和下拉**点了就生效**；文字框**改完自动存**（离开输入框也会存）—— 没有保存按钮'),

        /* ── ① 什么时候自己跑 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '什么时候自己跑'),
          h(ToggleRow, {
            label: '峰谷时段自动刷',
            note: '只在谷时跑：工作日 12–14 点、18 点以后，周末全天',
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
          h(NumRow, {
            label: '每天最多挑几条',
            note: '0 = 不自动刷（手动跑不受限）',
            value: perDay ?? '', min: 0, max: 50,
            onInput: setPerDay,
            onDone: (n) => patch({ perDay: n }, '每天挑几条'),
          }),
          st.lastRunAt ? h('div', { 'data-bd-note': '' }, `上次跑：${new Date(st.lastRunAt).toLocaleString('zh-CN')}`) : null),

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
              label: '要 @ 谁（一行一个 B站 昵称）',
              note: '⭐ 按顺序全部 @ 上、中间自动留空格（B站 靠空格才认得出 @）'
                + ' · 留空 = 只写报告不发评论 · 昵称要跟 B站 上完全一致，错一个字那个 @ 就不亮',
            },
              h('textarea', {
                'data-bd-input': '', rows: 3,
                placeholder: '一行一个昵称',
                value: mention ?? '',
                onChange: (e) => {
                  setMention(e.target.value)
                  autoSave('mention', () => patch({ mentionNames: asList(e.target.value), mentionName: '' }, '要 @ 谁'))
                },
                onBlur: () => { setMention(asList(mention).join('\n')); flushSave('mention') },
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
              label: '私信发给谁（B站 UID）',
              note: '⚠️ 要跟对方**互关**，否则会被限流、还可能不弹提醒'
                + ' · 内容 = 每条的「标题 + 链接 + 一句话」，一轮合成一条',
            },
              h('input', {
                'data-bd-input': '', type: 'number', min: 0, value: dmUid ?? '',
                placeholder: '对方的数字 UID',
                onChange: (e) => setDmUid(e.target.value),
                onBlur: () => { const n = Math.max(0, Number(dmUid) || 0); setDmUid(n ? String(n) : ''); patch({ dmUid: n }, '私信收件人') },
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
              label: '额外用来识别 AI 的词（一行一个）',
              note: '补充、不是替换 —— 内置那批（AI / Bot / 机器人 / 助手 / Agent / 大肥鱼 / 鲸鱼娘 …）一直在用',
            },
              h('textarea', {
                'data-bd-input': '', rows: 3,
                placeholder: '填了会额外认这些词',
                value: aiKw ?? '',
                onChange: (e) => {
                  setAiKw(e.target.value)
                  autoSave('aiKw', () => patch({ aiKeywords: asList(e.target.value) }, '自定义 AI 识别词'))
                },
                onBlur: () => { setAiKw(asList(aiKw).join('\n')); flushSave('aiKw') },
              }))) : null),

        /* ── ③ 刷什么 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '刷什么'),
          h(Field, {
            label: '关键词（一行一个）',
            note: '留空 = 用内置那几组（日语翻唱 / 音乐 / LIVE / 现场 …）',
          },
            h('textarea', {
              'data-bd-input': '', rows: 5, placeholder: '一行一个关键词',
              value: kws ?? '',
              onChange: (e) => { setKws(e.target.value); autoSave('kws', () => saveText({ kws: e.target.value })) },
              onBlur: () => flushSave('kws'),
            })),
          h(Field, {
            label: '工作区',
            note: '它按这个目录里的 AGENTS.md 认设定 · 留空 = dsh 自己的工作目录',
          },
            h('input', {
              'data-bd-input': '', value: ws ?? '', placeholder: '/path/to/your/notes',
              onChange: (e) => { setWs(e.target.value); autoSave('ws', () => saveText({ ws: e.target.value })) },
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
          h(ToggleRow, {
            label: '在本机转写一遍',
            note: '默认关 · 不花 API 钱，但慢；没装依赖时会直接跳过这些视频',
            on: sw('transcribe'),
            onChange: (v) => patch({ transcribe: v }, '本地转写'),
          }),
          sw('transcribe') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('button', { 'data-bd-btn': '', disabled: busy === 'asr', onClick: onInstallAsr },
                st.asrReady ? '重装转写依赖' : '装转写依赖'),
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-note': '' },
                  !st.asrReady ? '还没装 —— 现在开着也没用，没字幕的视频会被跳过'
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
            h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('out') }, '打开报告文件夹'),
            h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('home') }, '打开家目录'),
            h('button', { 'data-bd-btn': '', onClick: () => copyText(st.report) }, '复制报告路径')),
          report !== null ? h('pre', { 'data-bd-pre': '' }, report) : null),
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
