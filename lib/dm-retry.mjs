/**
 * lib/dm-retry.mjs —— 「私信回复失败后，还允不允许自己重试一次」。
 *
 * ⭐ 2026-10-29（评审第 7 条之二）：退出登录会把私信回复的子进程 kill 掉，
 *   而 kill ⇒ 退出码非 0 ⇒ 触发"续会话失败，立刻重试"那条分支 ⇒ 800ms 后
 *   又把自己拉起来，拿着**已经删掉的凭证**继续跑。
 *
 * 用法：每次 runDmReply 开头记下当时的 epoch；退出登录时把 epoch 加一。
 * 重试前用这个函数判一次：代次变了就不许重试。
 */

/**
 * @param {number} epochAtSpawn  发起这次私信回复时的代次
 * @param {number} epochNow      当前代次
 * @returns {boolean}            相同 = 允许重试；不同 = 这一代已经作废
 */
export function dmRetryAllowed(epochAtSpawn, epochNow) {
  return Number(epochAtSpawn) === Number(epochNow)
}
