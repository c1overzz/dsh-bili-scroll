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
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
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
      const [runNote, setRunNote] = React.useState(null)
      const [report, setReport] = React.useState(null)        // 非 null = 报告已展开   // 顶部那行状态（跑一轮/装依赖的反馈原来在最底下，看不见）
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
        if (cfg && mention === null) setMention(cfg.mentionName || '')
        if (cfg && dmUid === null) setDmUid(cfg.dmUid ? String(cfg.dmUid) : '')
        if (cfg && dmMode === null) setDmMode(cfg.dmMode || 'off')
        if (cfg && aiKw === null) setAiKw((cfg.aiKeywords || []).join('\n'))
      }, [cfg])

      const win = { ...DEFAULT_WINDOWS, ...(st?.windows || {}) }

      const say = (text, tone) => {
        setMsg(text); setMsgTone(tone || '')
        setRunNote(text ? { t: text, tone: tone || '' } : null)   // ⭐ 同时镜像到顶部，免得提示掉到页面最底下看不见
      }

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
            say(`${what || '设置'}：⚠️ 未生效 → ${bad.join('、')}`, 'warn')
            setRunNote(`⚠️ 这几个设置**没写进去**：${bad.join('、')}\n`
              + '最常见的原因：插件加了新字段，但**服务端那半还没重载** —— 重启一次 dsh 就好。')
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
          h('span', { 'data-bd-badge': '' }, `今天已挑 ${st.ranToday} / ${cfg.perDay} 条`),
          h('span', { 'data-bd-badge': '' }, '环境' + (st.venvReady ? '已就绪' : (st.installing ? '正在装' : '未装'))),
          h('span', { 'data-bd-badge': '' }, st.loggedIn ? 'B站已登录' : 'B站未登录'),
            h('span', { 'data-bd-badge': '' }, 'v' + (st.version || '?')),
          h('div', { 'data-bd-grow': '' }),
          h('button', { 'data-bd-btn': '', disabled: busy === 'run', onClick: onRun }, '现在跑一轮')),
          runNote ? h('div', { 'data-bd-msg': '', 'data-good': runNote.tone === 'good' ? '' : undefined,
            'data-warn': runNote.tone === 'warn' ? '' : undefined }, runNote.t) : null,

        /* ── 定时 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '什么时候自己跑'),
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
            }))) : null),

        /* ── 一轮挑几条 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '一轮挑几条'),
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

        /* ── 发言与转写 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '它会不会替你说话'),
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
              }))) : null,
          h(ToggleRow, {
            label: '自动评论并 @ 你',
            note: '默认关；开了之后它会在挑中的视频下面留评论，并 @ 你填的那个人',
            on: sw('autoComment'),
            onChange: (v) => patch({ autoComment: v }, '自动评论'),
          }),
          sw('autoComment') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '每轮最多发几条评论'),
                h('div', { 'data-bd-note': '' }, '每条评论里 @ 一次下面那个人')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 1, max: 20,
                value: perRound ?? '',
                onChange: (e) => setPerRound(e.target.value),
                onBlur: () => { const n = Math.max(1, Math.min(Number(perRound) || 1, 20)); setPerRound(String(n)); patch({ commentPerRound: n }, '每轮几条评论') },
              })),
            h('div', { 'data-bd-label': '' }, '要 @ 谁（B站 昵称）'),
            h('input', {
              'data-bd-input': '', value: mention ?? '',
              placeholder: '填你要 @ 的那个人的 B站 昵称；留空 = 只写报告、不发评论',
              onChange: (e) => setMention(e.target.value),
              onBlur: () => { const v = String(mention || '').trim(); setMention(v); patch({ mentionName: v }, '要 @ 谁') },
            }),
            h('div', { 'data-bd-note': '' }, '留空的话它就不发评论了 —— 因为评论存在的意义就是 @ 那一下')) : null,
          h('div', { 'data-bd-label': '' }, '投递方式（评论 还是 私信）'),
          h('select', {
            'data-bd-input': '', value: dmMode ?? 'off',
            onChange: (e) => { setDmMode(e.target.value); patch({ dmMode: e.target.value }, '投递方式') },
          },
            h('option', { value: 'off' }, '只发评论 —— 在视频下面 @ 你（默认）'),
            h('option', { value: 'only' }, '只私信 —— 一条公开评论都不发，最不打扰别人'),
            h('option', { value: 'both' }, '评论 + 私信 —— 两边都发')),
          (dmMode && dmMode !== 'off') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-label': '' }, '私信发给谁（B站 UID，数字）'),
            h('input', {
              'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, value: dmUid ?? '',
              placeholder: '对方的数字 UID；比如你自己的另一个号',
              onChange: (e) => setDmUid(e.target.value),
              onBlur: () => { const n = Math.max(0, Number(dmUid) || 0); setDmUid(n ? String(n) : ''); patch({ dmUid: n }, '私信收件人') },
            }),
            h('div', { 'data-bd-note': '' }, '私信内容 = 本轮每条的「标题 + 链接 + 一句话」，一轮合并成一条发（不受 150 字限制）'),
            h('div', { 'data-bd-note': '' }, '⚠️ 建议先让这个号和收件人互关：B站 对「陌生人私信」会限流，还可能不弹提醒')) : null,
          h(ToggleRow, {
            label: '在 AI 号下面楼中楼回复',
            note: '默认开；开了之后，评论区里如果已经有 AI / 机器人号把值得的点说过了，它就在那条下面回一句。关掉 = 永远只发自己的顶层评论，不去别人的评论下面留言',
            on: sw('aiReply'),
            onChange: (v) => patch({ aiReply: v }, '楼中楼回复'),
          }),
          sw('aiReply') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-label': '' }, '额外用来识别 AI 的关键词（一行一个）'),
            h('textarea', {
              'data-bd-input': '', rows: 4,
              placeholder: '留空 = 只用内置那批（AI / Bot / 机器人 / 助手 / Agent / 测试 / 大肥鱼 / 鲸鱼娘 …）',
              value: aiKw ?? '', onChange: (e) => setAiKw(e.target.value),
              onBlur: () => {
                const list = String(aiKw || '').split('\n').map((s) => s.trim()).filter(Boolean)
                setAiKw(list.join('\n'))
                patch({ aiKeywords: list }, '自定义 AI 识别词')
              },
            }),
            h('div', { 'data-bd-note': '' }, '这些是「补充」不是「替换」—— 内置那批一直在用，这里留空就只按内置的认')) : null,
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
            'data-bd-input': '', value: ws ?? '', placeholder: '留空 = dsh 自己的工作目录',
            onChange: (e) => setWs(e.target.value),
          }),
          h('div', { 'data-bd-label': '' }, '日报写多细'),
          h('select', {
            'data-bd-input': '', value: rl ?? 'full',
            onChange: (e) => { setRl(e.target.value); patch({ reportLevel: e.target.value }, '日报形态') },
          },
            h('option', { value: 'full' }, '完整 —— 每条：标题 / UP / 为什么值得（默认）'),
            h('option', { value: 'brief' }, '薄 —— 每条一两行，只留值不值得 + 链接'),
            h('option', { value: 'off' }, '不写 —— 只发评论，不生成日报文件')),
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onSaveText }, '保存'),
            msg ? h('div', { 'data-bd-msg': '', 'data-good': msgTone === 'good' ? '' : undefined, 'data-warn': msgTone === 'warn' ? '' : undefined }, msg) : null)),

        /* ── 环境与账号 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '环境与账号'),
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
