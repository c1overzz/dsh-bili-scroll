/**
 * lib/mention-env.mjs —— 「怎么 @ 你」这套配置 → MCP 环境变量。
 *
 * ⭐ 为什么要单独一个文件：这套配置有**两条入口**——
 *   ① 值班轮：写进 headless-overlay.yml 的 env
 *   ② 插件自己起的内部 MCP（宿主工具 bili_reply 走它）
 * 以前只有 ① 传了，② 什么都没传 ⇒ Python 那边 `_MENTION_NESTED` 默认 False，
 * **评论闸门在宿主这条路上根本不执行**。
 *
 * 现在两条入口都调用这个函数，并且它是个纯函数（不碰 cfg 闭包），
 * 所以可以直接拿真值跑测试。
 */

/**
 * @param {object} cfg            插件配置
 * @param {number} dmUidCache     按昵称查出来的 UID 缓存（cfg.dmUid 没填时才用）
 * @returns {{BILI_MENTION_MODE:string,BILI_MENTION_NAME:string,BILI_MENTION_UID:string,BILI_MENTION_NESTED:string}}
 */
export function mentionEnvFrom(cfg = {}, dmUidCache = 0) {
  const uid = Number(cfg.dmUid) > 0
    ? Number(cfg.dmUid)
    : (Number(dmUidCache) > 0 ? Number(dmUidCache) : 0)
  return {
    BILI_MENTION_MODE: String(cfg.mentionMode || 'top'),
    BILI_MENTION_NAME: String(cfg.mentionName || ''),
    BILI_MENTION_UID: uid > 0 ? String(uid) : '',
    // 开关关着 / 每轮 0 条 ⇒ 空串（Python 侧按 falsy 处理）
    BILI_MENTION_NESTED: (cfg.nestedMention && Number(cfg.nestedPerRound) > 0) ? '1' : '',
  }
}
