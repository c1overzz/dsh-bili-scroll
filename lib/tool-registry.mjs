import { createPathLayout } from './path-layout.mjs'

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

const imageOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => {
    const src = value && typeof value === 'object' ? value : { value }
    const { image, images, ...rest } = src
    const parts = [{ type: 'text', text: JSON.stringify(rest, null, 2) }]
    const refs = [...(image ? [image] : []), ...(Array.isArray(images) ? images : [])]
    for (const ref of refs) parts.push({ type: 'image', attachment: ref })
    return parts
  },
}

const safeJson = (value) => {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
}

/**
 * Register all Bilibili tools against the host.
 *
 * Tool behavior is intentionally injected rather than importing host state.
 * This keeps the contracts reusable in tests and makes apply() a composition
 * root instead of a second business layer.
 */
export function createToolRegistry({
  registerTool,
  getHost = () => null,
  defineTool,
  stateDir,
  outDir,
  getConfig,
  refreshConfig = () => {},
  persistConfig,
  hasCredential = () => false,
  call,
  callRaw,
  dutyRunner,
  installManager,
  reports,
  windows,
  dayKey,
  inWindow,
  loginStart,
  loginPoll,
  saveCredential,
  renderQrPng,
  log = () => {},
}) {
  if (typeof getConfig !== 'function') throw new TypeError('createToolRegistry requires getConfig()')
  if (typeof call !== 'function' || typeof callRaw !== 'function') throw new TypeError('createToolRegistry requires MCP callbacks')
  if (!dutyRunner) throw new TypeError('createToolRegistry requires dutyRunner')
  if (!reports) throw new TypeError('createToolRegistry requires reports')
  if (typeof registerTool !== 'function') throw new TypeError('createToolRegistry requires registerTool()')
  const layout = createPathLayout(stateDir, { outDir })

  const registrations = []
  const names = []
  const tool = (spec) => {
    const registration = registerTool(defineTool({
    ...spec,
    output: spec.output || textOutput,
    async execute(args, exec) { return safeJson(await spec.execute(args, exec)) },
    }))
    names.push(spec.name)
    registrations.push(registration)
    return registration
  }

  const attachImages = async (exec, images) => {
    const attachments = getHost('attachments')
    if (!attachments?.saveImages) {
      return { ok: false, reason: 'attachments', hint: '宿主的图片服务不可用（ctx.get("attachments") 是空的）' }
    }
    const llm = getHost('llm')
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (!llm?.resolveModelInfo) {
      return { ok: false, reason: 'model_probe', hint: `查不到模型能力（provider=${provider} model=${model}）` }
    }
    let modalities
    try {
      modalities = (await llm.resolveModelInfo(provider, model, exec?.signal))?.inputModalities
    } catch (error) {
      return { ok: false, reason: 'model_probe', hint: `查模型能力失败（${provider}/${model}）：${String(error?.message ?? error)}` }
    }
    if (!Array.isArray(modalities)) {
      return { ok: false, reason: 'model_probe', hint: `模型 ${provider}/${model} 没声明输入模态` }
    }
    if (!modalities.includes('image')) {
      return { ok: false, reason: 'model_no_image', hint: `模型 ${provider}/${model} 不支持图片输入（${modalities.join(',') || '无'}）` }
    }
    try {
      const refs = await attachments.saveImages(images.map((image) => ({
        data: Buffer.from(image.data, 'base64'),
        mediaType: image.mimeType,
      })))
      return { ok: true, refs }
    } catch (error) {
      return { ok: false, reason: 'save_failed', hint: '存图片失败：' + String(error?.message ?? error) }
    }
  }

  tool({
    name: 'bili_whoami',
    description: '看 B站 那边登录的是谁（凭证是否有效、昵称、mid）。第一次用要先在「刷B站」设置页里扫码登录。',
    parameters: {},
    async execute() {
      if (!hasCredential()) return { ok: false, loggedIn: false, hint: '还没登录：去 dsh 设置页的「刷B站」里点「扫码登录」（凭证会存在插件自己的家目录里）' }
      const result = await call('bili_check_credential', {})
      return { ok: true, ...(typeof result === 'object' ? result : { raw: result }) }
    },
  })

  tool({
    name: 'bili_search',
    description: '搜 B站 视频（可排序）。返回标题 / BV号 / 播放量 / UP / 时长 等。\n⚠️ 刷一轮的用法：搜近 7 天的、按播放或最新都行，然后**读字幕原文**再判断（别看摘要下结论）。',
    parameters: {
      keyword: { type: 'string', description: '搜索关键词' },
      num: { type: 'number', description: '返回几条（默认 10，最大 50）' },
      order: { type: 'string', description: 'totalrank=综合（默认）/ click=播放 / pubdate=最新 / dm=弹幕' },
    },
    async execute(args) {
      return call('bili_search', {
        keyword: String(args.keyword ?? ''),
        num: Math.max(1, Math.min(Number(args.num) || 10, 50)),
        order: String(args.order || 'totalrank'),
      })
    },
  })

  tool({
    name: 'bili_subtitle',
    description: '取一个视频的字幕（AI 字幕）全文。**判断内容就靠它** —— 没有字幕时，若设置里开了「本地转写」再想别的办法，否则直接跳过这条。',
    parameters: { bvid: { type: 'string', description: 'BV号' } },
    async execute(args) { return call('bili_subtitle', { bvid: String(args.bvid ?? '') }) },
  })

  tool({
    name: 'bili_comments',
    description: '取一个视频的热门评论（含点赞/回复数）。刷一轮时顺手翻一眼，看值不值得占用使用者一次注意力。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      num: { type: 'number', description: '取几条（默认 30）' },
    },
    async execute(args) { return call('bili_comments', { bvid: String(args.bvid ?? ''), num: Math.max(1, Number(args.num) || 30) }) },
  })

  tool({
    name: 'bili_cover',
    description: '看一个视频的封面（等比缩到 512px 宽）。最便宜的一档"看一眼"：能看出风格、标题美术、大致题材，但看不出视频里具体发生了什么。',
    parameters: { bvid: { type: 'string', description: 'BV号' } },
    output: imageOutput,
    async execute(args, exec) {
      const result = await callRaw('bili_cover', { bvid: String(args.bvid ?? '') }, { signal: exec?.signal })
      const meta = result.json && typeof result.json === 'object' ? result.json : { raw: result.json }
      if (!meta.ok) return meta
      const image = result.images?.[0]
      if (!image) return { ...meta, ok: false, error: 'MCP 没返回图片' }
      const attached = await attachImages(exec, [image])
      return attached.ok
        ? { ...meta, image_attached: true, image: attached.refs[0] }
        : { ...meta, image_attached: false, image_skip_reason: attached.reason, hint: attached.hint }
    },
  })

  tool({
    name: 'bili_frames',
    description: '看视频里的画面（从 B 站自带的故事板裁 1-6 帧，每帧 480×270）。\n想知道"这条视频到底拍了什么"就用它 —— 字幕告诉你说什么，画面告诉你拍的是什么。\n默认按时长均匀取 3 帧；想盯某个时刻（比如字幕里提到的那段）就传 at。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      num: { type: 'number', description: '取几帧，1-6，默认 3' },
      at: { type: 'array', items: { type: 'number' }, description: '指定时间点（秒）列表；传了就以它为准，忽略 num' },
    },
    output: imageOutput,
    async execute(args, exec) {
      const at = Array.isArray(args.at) ? args.at.map(Number).filter(Number.isFinite) : undefined
      const result = await callRaw('bili_frames', {
        bvid: String(args.bvid ?? ''),
        num: Math.max(1, Math.min(Number(args.num) || 3, 6)),
        ...(at && at.length ? { at } : {}),
      }, { signal: exec?.signal })
      const meta = result.json && typeof result.json === 'object' ? result.json : { raw: result.json }
      if (!meta.ok) return meta
      if (!result.images?.length) return { ...meta, ok: false, error: 'MCP 没返回图片' }
      const attached = await attachImages(exec, result.images)
      return attached.ok
        ? { ...meta, image_attached: true, images: attached.refs }
        : { ...meta, image_attached: false, image_skip_reason: attached.reason, hint: attached.hint }
    },
  })

  tool({
    name: 'bili_reply',
    description: '在视频下发评论（或回复某条评论）。这就是"@ 本人"那一下：短、干净、纯文本 @ 写在正文里。\n🔴 安全闸：设置页的「自动评论并 @ 你」**默认是关的**；关着的时候这个工具会拒绝 —— 除非本人当场让你发（那时传 force: true）。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      text: { type: 'string', description: '评论正文（短、干净、纯文本 @；别写敏感词）' },
      rpid: { type: 'number', description: '要回复的评论 id（0/不填 = 发新评论）' },
      force: { type: 'boolean', description: '本人当场让你发的，传 true 越过"自动评论关着"的闸' },
    },
    async execute(args) {
      const cfg = getConfig()
      const commentOn = Boolean(cfg.autoComment && cfg.mentionName && cfg.dmMode !== 'only')
      if (!commentOn && !args.force) {
        return {
          ok: false,
          blocked: true,
          hint: cfg.dmMode === 'only'
            ? '现在是「只私信」模式（dmMode=only）—— 规定不发公开评论，改成用 bili_send_message 私信。确实要发时传 force: true。'
            : '要发评论得同时满足两条：设置里开着「自动评论并 @ 你」、并且填了「要 @ 谁」。或者本人当场让你发时传 force: true。',
        }
      }
      return call('bili_reply', { bvid: String(args.bvid ?? ''), text: String(args.text ?? ''), rpid: Number(args.rpid) || 0 })
    },
  })

  tool({
    name: 'bili_status',
    description: '看它今天的状态：跑了没跑、挑了几条、额度剩多少、报告在哪、登录过没有、下次窗口什么时候开。',
    parameters: {},
    async execute() {
      refreshConfig()
      const cfg = getConfig()
      const state = reports.readState()
      const now = new Date()
      return {
        ok: true,
        today: dayKey(now),
        ranToday: state.day === dayKey(now) ? Number(state.count || 0) : 0,
        pickedToday: reports.countPickedToday(now),
        perDay: cfg.perDay,
        dshCli: dutyRunner.dshCliCached(),
        windows: Object.fromEntries(Object.entries(windows).map(([key, value]) => [key, {
          label: value.label, start: value.start, end: value.end,
          switchOn: Boolean(cfg[key]), opening: inWindow(now, value),
        }])),
        peakValley: cfg.peakValley,
        autoComment: cfg.autoComment,
        dmMode: cfg.dmMode,
        dmUid: Number(cfg.dmUid) || 0,
        transcribe: cfg.transcribe,
        loggedIn: hasCredential(),
        home: stateDir,
        report: layout.reportFile(dayKey(now)),
      }
    },
  })

  tool({
    name: 'bili_run',
    description: '**立刻跑一轮**（不等窗口）：起一个 headless 会话，把 duty.md 交给它去刷、写报告。适合"我现在就想看一份"的场合。',
    parameters: {},
    async execute() { return { ok: true, ...dutyRunner.runDuty('manual') } },
  })

  tool({
    name: 'bili_login_start',
    description: '开始 B站 扫码登录：出二维码（画成 PNG 存在插件家目录里，返回路径）和一个 key。\n用法：拿到 PNG 后用 `present` 把它推给本人（手机 B站 → 我的 → 扫一扫），再用 `bili_login_poll` 轮询。\n⚠️ 二维码大约 180 秒有效，出码要马上递过去；手机上确认时选「记住我」那种长期登录。',
    parameters: {},
    async execute() {
      refreshConfig()
      const { key, url } = await loginStart()
      const png = await renderQrPng(getConfig().pythonPath, stateDir, url)
      return {
        ok: true, key, url, png,
        hint: png ? '用 present 把这张 PNG 推给本人扫；扫完调 bili_login_poll' : '没画出 PNG：先去设置里点「建 venv 装依赖」（venv 里要有 qrcode）',
      }
    },
  })

  tool({
    name: 'bili_login_poll',
    description: '查扫码结果：waiting 还没扫 / scanned 扫了待确认 / ok 成功 / expired 过期。成功时会自动把凭证写进插件家目录的 `bili_credential.json`（MCP 认的那四个字段）。',
    parameters: { key: { type: 'string', description: 'bili_login_start 给的那个 key' } },
    async execute(args) {
      const result = await loginPoll(String(args.key ?? ''))
      if (result.state === 'ok') {
        const file = saveCredential(result.credential)
        log(`登录成功，凭证已写入 ${file}`)
        return { ok: true, state: 'ok', file }
      }
      return { ok: result.state !== 'unknown', state: result.state, code: result.code, message: result.message }
    },
  })

  tool({
    name: 'bili_setup',
    description: '给刷B站装运行环境：在插件家目录建一个**独立 venv**、装上那个 Python MCP 的依赖，装完自动把 `pythonPath` 指过去。\n**第一次用之前跑一次**。⭐ 它**起完就返回、不等装完**（几分钟的活），进度看家目录里的 `install.log`。',
    parameters: {},
    async execute() { return installManager.runInstall() },
  })

  tool({
    name: 'bili_config',
    description: '读 / 改「刷B站」的设置。不给 `patch` 就是读；给了就改（只认 schema 里的字段）。\n例：`{"perDay":5,"peakValley":true,"noon":true,"night":true,"autoComment":false,"transcribe":false,"keywords":["DeepSeek Harness"]}`；私信投递：`{"dmMode":"only","dmUid":12345678}`（dmMode = off / only / both）。',
    parameters: { patch: { type: 'object', additionalProperties: true, description: '要改的字段（可省）' } },
    async execute(args) {
      let host = null
      if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) host = (await persistConfig(args.patch)).host
      return { ok: true, config: getConfig(), windows, home: stateDir, venvReady: installManager.venvReadyNow(), host }
    },
  })

  return {
    attachImages,
    imageOutput,
    names,
    dispose() {
      for (const registration of registrations.reverse()) {
        try {
          if (typeof registration === 'function') registration()
          else registration?.dispose?.()
        } catch { /* host cleanup is best effort */ }
      }
    },
  }
}
