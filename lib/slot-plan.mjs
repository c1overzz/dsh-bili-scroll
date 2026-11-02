/**
 * lib/slot-plan.mjs —— 「分时计划还能不能接着用」的判据。
 *
 * 为什么要单独一个文件：这两件事**只有一份实现**，宿主和测试都从这里取，
 * 测试跑的就不是"我照着写一遍的仿制品"，而是线上真正执行的那段判断。
 *
 * 背景（2026-10-30，用户问「每个开关都有用吗」时查出来的）：
 *   以前 ensureSlotPlan 只看 `plan.day === today` 就复用旧计划，
 *   但计划是**按当时的条数和窗口开关**排出来的：
 *     · 早上两个窗口都关着 ⇒ 排出 0 个点并存进 slots.json
 *     · 中午用户把「夜间」打开 ⇒ 计划还是那份空的 ⇒ **当天一个点都不会跑** ✗
 *     · 把「每天挑几条」从 5 改成 10 ⇒ 当天还是只排 5 个点 ✗
 *   ⇒ 计划里记下"按什么排的"（sig），对不上就重排。
 */

/**
 * 计划的"按什么排的"指纹。
 * @param {{perDay?: number, noon?: boolean, night?: boolean}} cfg
 * @returns {string} 形如 "5|01"（条数|中午开没开+夜间开没开）
 */
export function planSignature(cfg) {
  // ⚠️ 这里**不能**写 `Number(cfg.perDay || 5)` —— `||` 会把 0 当成 5，
  //    于是「条数 0 → 5」这种改动指纹不变 ⇒ 当天不会重排（用户开了自动刷却一个点都没有）。
  //    只有 undefined / null / 非数字才退回默认 5；0 是一个有意义的取值（= 不自动刷）。
  const raw = cfg?.perDay
  const n = (raw === undefined || raw === null || raw === '') ? 5 : Number(raw)
  const quota = Math.max(1, Math.min(Number.isFinite(n) ? n : 5, 50))
  return `${quota}|${cfg?.noon ? 1 : 0}${cfg?.night ? 1 : 0}`
}

/**
 * 这份旧计划还能不能接着用？
 * @param {object|null} old   slots.json 里那份
 * @param {string} today      今天的 dayKey
 * @param {string} wantSig    现在的指纹（planSignature）
 */
export function planReusable(old, today, wantSig) {
  if (!old || old.day !== today) return false
  if (!Array.isArray(old.times) || !Array.isArray(old.done)) return false
  if (old.times.length !== old.done.length) return false
  // 老计划（没有 sig 字段）一律当作"按旧口径排的"⇒ 重排一次，之后就稳定了
  return old.sig === wantSig
}

/**
 * 重排时把「今天已经跑过的点」带过去 —— 别让用户白跑一轮。
 *
 * 做法：新计划里凡是**早于或等于"最后一次实际跑过的时刻"**的点，都标成已做（不补跑）。
 * 为什么用"最后跑过的时刻"而不是逐个比对：重排出来的时刻跟旧的不可能一样，
 * 逐个比对等于没比；而"过去的时段已经跑过一轮了"这个语义，用时间点比较最稳。
 *
 * @param {number[]} times      新排出来的时刻（毫秒）
 * @param {object|null} old     旧计划
 * @param {string} today        今天的 dayKey
 * @returns {{done: boolean[], ranTimes: number[]}}
 */
export function carryRanSlots(times, old, today) {
  const done = times.map(() => false)
  const ranTimes = []
  if (!old || old.day !== today || !Array.isArray(old.times) || !Array.isArray(old.done)) {
    return { done, ranTimes }
  }
  for (let i = 0; i < old.times.length; i++) {
    if (!old.done[i]) continue
    const t = Number(old.times[i])
    if (Number.isFinite(t)) ranTimes.push(t)
  }
  if (!ranTimes.length) return { done, ranTimes }
  const lastRan = Math.max(...ranTimes)
  for (let i = 0; i < times.length; i++) {
    if (Number(times[i]) <= lastRan) done[i] = true
  }
  return { done, ranTimes }
}
