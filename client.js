/**
 * dsh-bili-scroll —— 浏览器半端（**面板挂在右侧栏**）
 * ============================================================================
 * ⭐ **client bundle 不是 ESM，是自注册脚本**（2026-10-14 从官方包里挖到的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ **入口：右侧栏**（2026-10-16 从「设置页」搬过来的）
 *
 * 原来是注册成 `settings.section`（设置里的一页）。搬到右侧栏是因为
 * 使用者更希望它**随手就能开**：右侧栏是常驻的，设置页要专门点进去。
 *
 * 右侧栏要注册**三处**（两阶段注册，少一处就点不动或没标题）：
 *
 *   ① tab 类型定义   `ctx.sidebarRightTabs.register({ id, kind, title, guide })`
 *      —— `guide` 让它在右侧栏「开始」页出现一张卡
 *   ② tab 本体       `slots.register('sidebar.right.pane.tab', { key: <①的 id> })`
 *      —— 🔴 **只注册①的卡是点不动的**：卡片的点击行为被官方写死成
 *         `openTab(selected.kind, { replaceTab: true })`，必须真有这个 kind 的页面
 *   ③ tab 标题芯片   `slots.register('sidebar.right.pane.tab.title', { key: <①的 id> })`
 *      —— 可选，不注册就用 ① 里的 `title()`
 *
 * ⚠️ **两个 inject 是两回事**（极易错）：
 *   · 本文件 `inject`（下面是 `['slots', 'sidebarRightTabs']`）= **客户端服务短名**
 *   · `package.json` 的 `dsh.client.inject` = **模块包名**（预加载哪些 client 模块）
 *   填错任一处 ⇒ 该 entry 永远 pending ⇒ **整页 `Failed to load plugins`**（不是局部失效）。
 *   ⚠️ 改 `package.json` 那处属于**包元数据** ⇒ **必须重启宿主**才生效（JS 那处走 HMR）。
 *
 * ⚠️ **id / kind 撞车会 throw**，而 throw 同样拖垮整个 entry ⇒ 已扫过：
 *   内置 kind 有 keyed/list/plan/subagentchat/terminal，第三方见过 wb-switch；
 *   本插件用 `bili-scroll`，未占用。
 *
 * 这一页要满足使用者说的形状：
 *   · **总开关 → 打开之后下面才展开子开关**（峰谷自动刷 → 中午 / 晚上）
 *   · **数字项要能自己填**（定量刷：每天几条）
 *   · **账号绑定必须在面板里**（扫码登录 + 二维码直接显示在页里）
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
/* 右侧栏 tab 的外层：撑满并自己滚（右侧栏比设置页窄得多，别写死 max-width） */
[data-bd-tabwrap]{display:block;height:100%;overflow:auto;box-sizing:border-box;padding:14px 12px 24px;}
[data-bd-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;}
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
[data-bd-select]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;cursor:pointer;}
[data-bd-select]:focus{outline:none;border-color:#3b82f6;}
[data-bd-persona]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;line-height:1.5;resize:vertical;}
[data-bd-row2]{display:flex;gap:8px;}
[data-bd-row2]>*{flex:1;min-width:0;}
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
      const [rl, setRl] = React.useState(null)          // 日报形态：full / brief / off
      const [newVer, setNewVer] = React.useState('')    // 发现的新版本号（空 = 没发现）
      // ⚠️ 输入框必须绑"本地草稿"：页面每 5 秒轮询 /status，服务端那份会把 config 盖掉
      //    ⇒ 直接绑 cfg 的话，用户打字打到一半就被冲没了 ✗（2026-10-14 陌生人验收时抓到）
      const [perDay, setPerDay] = React.useState(null)
      const [perRound, setPerRound] = React.useState(null)
      const [replyPer, setReplyPer] = React.useState(null)
      const [mention, setMention] = React.useState(null)
      const [login, setLogin] = React.useState(null)
      const [runNote, setRunNote] = React.useState(null)
      const [report, setReport] = React.useState(null)        // 非 null = 报告已展开   // 顶部那行状态（跑一轮/装依赖的反馈原来在最底下，看不见）
      const [loginState, setLoginState] = React.useState('')
      const [loginTone, setLoginTone] = React.useState('')
      // ── 人设（2026-10-15 新增）──
      // ⭐ 人设**不走 /status 轮询**，只在挂载时 GET /persona 一次，之后完全由本地草稿管；
      //    否则每 5 秒的轮询会把用户正在编辑的正文冲掉（与上面输入框同一个教训）。
      const [persona, setPersona] = React.useState(null)
      const [personaSaved, setPersonaSaved] = React.useState(null)   // 服务端那份（用来判"有没有未保存改动"）
      const [personaFile, setPersonaFile] = React.useState('')
      const [personaChars, setPersonaChars] = React.useState(null)
      const [personaMsg, setPersonaMsg] = React.useState('')
      const [personaTone, setPersonaTone] = React.useState('')
      // ── 模型（2026-10-15 新增）──
      // 清单从 /models 拉（**不硬编码**：DSH 的 provider/模型由使用者装的路由决定）
      const [models, setModels] = React.useState(null)          // [{id,name,models:[{id,name}]}]
      const [modelsNote, setModelsNote] = React.useState('')
      const [mProvider, setMProvider] = React.useState(null)
      const [mModel, setMModel] = React.useState(null)
      const [mEffort, setMEffort] = React.useState(null)

      const cfg = st?.config
      React.useEffect(() => {
        if (cfg && kws === null) setKws((cfg.keywords || []).join('\n'))
        if (cfg && rl === null) setRl(cfg.reportLevel || 'full')
        if (cfg && perDay === null) setPerDay(String(cfg.perDay ?? 5))
        if (cfg && perRound === null) setPerRound(String(cfg.commentPerRound ?? 1))
        if (cfg && replyPer === null) setReplyPer(String(cfg.replyPerRound ?? 1))
        if (cfg && mention === null) setMention(cfg.mentionName || '')
      }, [cfg])

      const win = { ...DEFAULT_WINDOWS, ...(st?.windows || {}) }

      // ⭐ 人设：挂载时取一次（**不进轮询**，免得冲掉正在编辑的草稿）
      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const d = await jget('/persona')
            if (!alive || !d?.ok) return
            setPersona((cur) => (cur === null ? (d.text || '') : cur))
            setPersonaSaved(d.text || '')
            setPersonaFile(d.file || '')
            setPersonaChars(d.chars ?? (d.text || '').length)
          } catch { /* 取不到就等用户点保存 */ }
        })()
        return () => { alive = false }
      }, [])

      // ⭐ 模型清单：同样只在挂载时取一次（providers/模型不会天天变）
      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const d = await jget('/models')
            if (!alive) return
            if (Array.isArray(d?.providers)) setModels(d.providers)
            if (d?.note) setModelsNote(d.note)
            else if (d && d.ok === false && d.error) setModelsNote(d.error)
            const cur = d?.current || {}
            setMProvider((v) => (v === null ? (cur.provider || '') : v))
            setMModel((v) => (v === null ? (cur.model || '') : v))
            setMEffort((v) => (v === null ? (cur.reasoningEffort || '') : v))
          } catch (e) { setModelsNote(String(e?.message ?? e)) }
        })()
        return () => { alive = false }
      }, [])

      const say = (text, tone) => {
        setMsg(text); setMsgTone(tone || '')
        setRunNote(text ? { t: text, tone: tone || '' } : null)   // ⭐ 同时镜像到顶部，免得提示掉到页面最底下看不见
      }

      const patch = async (p, what) => {
        setBusy(JSON.stringify(p))
        try {
          const r = await jpost('/config', p)
          if (r?.config) setSt((old) => ({ ...old, config: r.config }))
          say(what ? `${what}：已保存` : '已保存', 'good')
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
        await patch({ keywords: list }, '关键词')
      }

      // ⭐ 保存人设：POST /persona ⇒ 落盘 persona.md。下一轮 promptFor() 现读 ⇒ 即时生效
      const onSavePersona = async () => {
        const text = String(persona || '')
        setBusy('persona')
        setPersonaMsg('')
        try {
          const r = await jpost('/persona', { text })
          if (r?.ok) {
            setPersonaSaved(text)
            setPersonaChars(r.chars ?? text.length)
            setPersonaTone('good')
            setPersonaMsg('人设已保存 —— 下一轮就用新的（不用重启）')
            say('人设已保存', 'good')
          } else {
            setPersonaTone('warn'); setPersonaMsg(r?.error || '保存失败')
          }
        } catch (e) { setPersonaTone('warn'); setPersonaMsg(String(e?.message ?? e)) }
        finally { setBusy('') }
      }

      // ⭐ 保存模型选择：写进 config，下一轮 overlay 会把它覆盖进那一轮
      const onSaveModel = async () => {
        await patch({
          llmProvider: String(mProvider || '').trim(),
          llmModel: String(mModel || '').trim(),
          llmReasoningEffort: String(mEffort || '').trim(),
        }, '模型')
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
                !st.asrReady ? '还没装 —— 没装的话转写用不了'
                  : (st.asrModelReady ? '环境和模型都好了' : '环境好了；模型会在第一次转写时自动下（几百 MB）'))),
            h('div', { 'data-bd-note': '' },
              '点一下就好：建一个独立环境、装 faster-whisper + yt-dlp，并把 Whisper 模型也下好',
              h('br'),
              '（模型默认 small，几百 MB，走国内镜像；装一次就够了）'),
            st.asrTail ? h('div', null,
              h('div', { 'data-bd-note': '' }, st.asrInstalling ? '正在装转写依赖（进度）：' : '转写依赖的日志（末尾）—— 只有「没字幕的视频」用得到它：'),
              h('pre', { 'data-bd-pre': '' }, st.asrTail)) : null) : null),

        /* ── 关注什么 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '关注什么'),
          h('textarea', {
            'data-bd-input': '', rows: 5, placeholder: '一行一个关键词；留空用内置那几组',
            value: kws ?? '', onChange: (e) => setKws(e.target.value),
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

        /* ── 用哪个模型（2026-10-15 新增） ── */
        (() => {
          const provs = models || []
          const cur = provs.find((p) => p.id === mProvider)
          const mlist = cur?.models || []
          const isCustom = Boolean(mProvider) && !cur            // 存着一个下拉里没有的 provider（自定义/已下线）
          return h('div', { 'data-bd-sec': '' },
            h('div', { 'data-bd-h': '' }, '用哪个模型'),
            h('div', { 'data-bd-note': '' },
              '跑一轮时会用这里选的模型（覆盖 headless profile 的默认）。留空 = 用那个 profile 原本的默认。'),
            modelsNote ? h('div', { 'data-bd-note': '', 'data-warn': '' }, modelsNote) : null,
            h('div', { 'data-bd-row2': '' },
              h('select', {
                'data-bd-select': '',
                value: mProvider ?? '',
                onChange: (e) => { setMProvider(e.target.value); setMModel('') },   // 换 provider 要清掉 model
              },
                h('option', { value: '' }, '（不指定，用 profile 默认）'),
                ...provs.map((p) => h('option', { key: p.id, value: p.id }, `${p.name}（${p.id}）`)),
                isCustom ? h('option', { value: mProvider }, `${mProvider}（当前值，已不在清单里）`) : null),
              h('select', {
                'data-bd-select': '',
                value: mModel ?? '',
                disabled: !mProvider,
                onChange: (e) => setMModel(e.target.value),
              },
                h('option', { value: '' }, mProvider ? '（该 provider 默认）' : '（先选 provider）'),
                ...mlist.map((m) => h('option', { key: m.id, value: m.id }, m.name && m.name !== m.id ? `${m.name}（${m.id}）` : m.id)),
                (mModel && !mlist.some((m) => m.id === mModel))
                  ? h('option', { value: mModel }, `${mModel}（当前值，已不在清单里）`) : null)),
            h('div', { 'data-bd-row2': '' },
              h('select', {
                'data-bd-select': '',
                value: mEffort ?? '',
                onChange: (e) => setMEffort(e.target.value),
              },
                h('option', { value: '' }, '（思考档位：不指定）'),
                ...['off', 'low', 'medium', 'high', 'max'].map((x) => h('option', { key: x, value: x }, x))),
              h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onSaveModel }, '保存模型')),
            h('div', { 'data-bd-note': '' },
              mProvider && mModel ? `当前：${mProvider} / ${mModel}${mEffort ? ` · ${mEffort}` : ''}`
                : '当前：未指定（用 profile 默认）'))
        })(),

        /* ── 人设（2026-10-15 新增：不再用 AGENTS.md，改插件自己的文本框） ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '它的人设'),
          h(ToggleRow, {
            label: '启用下面这份人设',
            note: '默认开；关掉的话它就中性出场，不扮演任何人格',
            on: sw('personaEnabled'),
            onChange: (v) => patch({ personaEnabled: v }, '启用人设'),
          }),
          sw('personaEnabled') ? h('div', { 'data-bd-sub': '' },
            h('textarea', {
              'data-bd-input': '', 'data-bd-persona': '', rows: 12,
              placeholder: '写它的说话方式与准则。例如：\n· 叫我「老板」，说话短、别客套\n· 只推我看得懂的技术内容，别推营销号\n· 拿不准的事就说没查到，不许编',
              value: persona ?? '',
              onChange: (e) => setPersona(e.target.value),
            }),
            h('div', { 'data-bd-row': '' },
              h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: busy === 'persona', onClick: onSavePersona }, '保存人设'),
              h('button', {
                'data-bd-btn': '', disabled: busy === 'persona' || !(persona || '').trim(),
                onClick: () => { setPersona(''); },
              }, '清空'),
              (persona !== null && personaSaved !== null && persona !== personaSaved)
                ? h('span', { 'data-bd-note': '' }, '有未保存的改动') : null),
            h('div', { 'data-bd-note': '' },
              personaChars != null ? `当前 ${personaChars} 字符` : '',
              personaChars != null ? h('br') : null,
              '存本地：', h('code', null, personaFile || ''),
              h('br'),
              '每一轮开始前现读这个文件 —— 保存后**立刻生效**，不用重启 dsh。'),
            personaMsg ? h('div', {
              'data-bd-msg': '',
              'data-good': personaTone === 'good' ? '' : undefined,
              'data-warn': personaTone === 'warn' ? '' : undefined,
            }, personaMsg) : null) : null),

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
            h('button', { 'data-bd-btn': '', onClick: () => copyText(st.report) }, '复制报告路径')),
          report !== null ? h('pre', { 'data-bd-pre': '' }, report) : null),
      )
    }

    /** 右侧栏 tab 类型 id；也是 `sidebar.right.pane.tab` 那个 keyed 槽的键。 */
    const TAB_ID = 'bili-scroll'
    /** tab 类型的 kind：openTab 用它指名；不能与内置重名（见文件头）。 */
    const TAB_KIND = 'bili-scroll'

    /**
     * 右侧栏 tab 的本体 = 当前这个面板组件（**不是 iframe**）。
     *
     * 为什么不像别的插件那样嵌 iframe：本插件的面板**本来就是 React 组件**
     * （`Panel` 就在本文件里），直接复用最省事 —— 没有 iframe 的高度/滚动条打架问题，
     * 也不用再发一份页面出去。（若面板是独立 HTML，那才该用 iframe。）
     */
    function BiliScrollTab() {
      return h('div', { 'data-bd-tabwrap': '' }, h(Panel))
    }

    return {
      /**
       * ⚠️ 这里是**客户端服务短名**，不是包名。
       *    包名那份在 package.json 的 `dsh.client.inject`（两处含义不同）。
       *    `sidebarRightTabs` 由 `@deepseek-ai/dsh-client-ui-sidebar-right` 提供。
       */
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-duty')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-duty: 面板样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        // ── ① tab 类型定义：让它在右侧栏「开始」页出现一张卡 ──
        //    整段包 try/catch：boot 对「任一 entry 未激活」是致命的，
        //    宁可本插件没入口，也不能把整页 boot 拖垮。
        try {
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            // `extension` = 可被 builtin 覆盖的扩展带；三值只有 extension / builtin / fallback。
            priority: 'extension',
            keepMounted: true,                 // 切走/换会话不卸载，否则每次展开都回首页
            title: () => '刷B站',
            guide: [
              {
                id: 'panel',
                order: 40,                     // 排在 wb-switch(30) 之后
                title: () => '刷B站',
                description: () => '每天替你看一轮 B站、挑出值得的，写份日报',
              },
            ],
          })
        } catch (e) { console.error('[dsh-bili-duty] 注册右侧栏 tab 类型失败：', e) }

        // ── ② tab 本体（🔴 只注册 ① 的卡是点不动的）──
        //    key 必须是 ① 里的 `id`，不是 `kind`。
        try {
          ctx.effect(() => slots.inject('sidebar.right.pane.tab', () =>
            slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, BiliScrollTab),
          ), 'bili-duty: 右侧栏 tab 本体')
        } catch (e) { console.error('[dsh-bili-duty] 注册右侧栏 tab 本体失败：', e) }

        // ── ③ tab 标题芯片（可选；不注册会用 ① 的 title()）──
        try {
          ctx.effect(() => slots.inject('sidebar.right.pane.tab.title', () =>
            slots.register(
              { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
              function BiliScrollTitle() { return h('span', null, '刷B站') },
            ),
          ), 'bili-duty: 右侧栏 tab 标题')
        } catch (e) { console.error('[dsh-bili-duty] 注册右侧栏 tab 标题失败：', e) }
      },
    }
  },
})
