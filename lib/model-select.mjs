/**
 * 这一轮到底用哪个模型 —— 从 index.js 抽出来的纯逻辑，不读配置、不碰宿主，方便直接测选择表。
 *
 * 文件和宿主那两半（当前 profile、铺好的 package.json）由调用方用 `env` 传进来：
 *   env.profile()         这一轮实际跑的 profile 名
 *   env.templateIsStock() 插件铺的 bili-duty 是不是还是出厂的 bundles
 */

export const BASE_PROVIDERS = ['deepseek-account', 'deepseek-official']
/** 这些 provider 只装在某个特定 profile 里：{ provider: profile 名 } */
export const PROFILE_ONLY_PROVIDERS = { 'google-antigravity': 'headless' }
/** ⭐ 连「当前会话的模型」都用不了时兜底的那一对（账号登录的机器上一定能跑） */
export const FALLBACK_MODEL = { provider: 'deepseek-account', model: 'deepseek-flash' }

/** 插件自己铺的模板 profile，和它出厂的 bundles（要和 profile-template/bili-duty/package.json 一致，测试钉着） */
export const TEMPLATE_PROFILE = 'bili-duty'
export const STOCK_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']

/** 这份 package.json 的 bundles 还是不是出厂那两项（读不到、格式不对都算「不是」） */
export function isStockTemplate(pkg) {
  const bundles = pkg?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.length !== STOCK_BUNDLES.length) return false
  return STOCK_BUNDLES.every((b) => bundles.includes(b))
}

/**
 * ⭐ 2026-11-04（#175 / #130 / #163）：三态判断 —— 设置页的模型下拉需要"能选"和"确定能用"分开。
 *   'yes'   = 白名单里的（值班轮那个 profile 一定有适配器）
 *   'no'    = 绑定了别的 profile，或者这一轮跑的是出厂的 bili-duty（内容已知，只有 DeepSeek 两条路由）
 *   'maybe' = 这一轮 profile 装没装我们看不到（插件跑在 web 进程，值班轮是另一个进程）：
 *             自建 profile，或者 bundles 被改过的模板（#175、#144）
 */
export function providerState(p, env) {
  const id = String(p || '')
  if (!id) return 'no'
  if (BASE_PROVIDERS.includes(id)) return 'yes'
  const needProfile = PROFILE_ONLY_PROVIDERS[id]
  if (needProfile) {
    try { return env.profile() === needProfile ? 'yes' : 'no' } catch { return 'no' }
  }
  try {
    if (env.profile() === TEMPLATE_PROFILE && env.templateIsStock()) return 'no'
  } catch { /* 判断不了 ⇒ 就是看不到 */ }
  return 'maybe'
}

/**
 * 钉的和跟随的走两条路：
 *   · 钉了 = 用户明说要它 ⇒ 照用，不悄悄换（#130 / #163）；真没有驱动时那一轮会失败，由 lib/diagnose.mjs 说清楚。
 *     出厂 bili-duty 上是 'no' 也照用：这是 b8f0b5a 定的（选了不悄悄换）。
 *     只有绑定了别的 profile 的（比如 bili-duty 上的 Antigravity）才不带，并在 `ignored` 里标出来。
 *     出厂 bili-duty 上照用 'no' 的那种，结果里带 `likelyNoAdapter: true`，让设置页和 duty.log 在跑之前就说出来 ——
 *     不然每一轮都是一启动就 code=1，只有 duty.log 和当天的占位报告里看得到。
 *   · 跟随当前会话 = 用户没为这一轮选过 ⇒ 只有 'no' 以外才跟；否则兜底，宁可换模型，也别让这一轮在第一个请求前就死掉。
 *
 * @param {{ pin: {provider: string, model: string}|null, session: {provider: string, model: string}|null }} picks
 */
export function chooseModel({ pin, session }, env) {
  const boundElsewhere = pin && PROFILE_ONLY_PROVIDERS[pin.provider] && providerState(pin.provider, env) === 'no'
  if (pin && !boundElsewhere) {
    // 走到这里还是 'no' 的只有一种：出厂 bili-duty 上钉了白名单以外的（绑定别的 profile 的上面已经排除）
    return providerState(pin.provider, env) === 'no'
      ? { ...pin, source: 'plugin', likelyNoAdapter: true }
      : { ...pin, source: 'plugin' }
  }
  if (session && providerState(session.provider, env) !== 'no') {
    return pin ? { ...session, source: 'session', ignored: pin } : session
  }
  return {
    ...FALLBACK_MODEL,
    source: 'fallback',
    ...(pin ? { ignored: pin } : {}),
    ...(session ? { sessionIgnored: { provider: session.provider, model: session.model } } : {}),
  }
}
