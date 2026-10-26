import { createPathLayout } from './path-layout.mjs'

/**
 * One-shot configuration migrations kept outside the host composition root.
 *
 * A migration is intentionally conservative: only values that still match a
 * known old default are changed, while an explicit user choice is preserved.
 */
export function createConfigMigrations({
  stateDir,
  readJson,
  markerExists = () => false,
  writeMarker,
  persistConfig,
  log = () => {},
  now = () => Date.now(),
}) {
  if (typeof readJson !== 'function') throw new TypeError('createConfigMigrations requires readJson()')
  if (typeof writeMarker !== 'function') throw new TypeError('createConfigMigrations requires writeMarker()')
  if (typeof persistConfig !== 'function') throw new TypeError('createConfigMigrations requires persistConfig()')
  const layout = createPathLayout(stateDir)

  const migrate200 = () => {
    const marker = layout.migration200Marker
    try {
      if (markerExists(marker)) return false
      const saved = readJson(layout.configFile, {}) || {}
      const oldInterval = Number(saved.dmWatchMinutes) === 5
        && Number(saved.dmReplyPerDay) === 3
      if (oldInterval) {
        Promise.resolve(persistConfig({ dmWatchMinutes: 1, dmReplyPerDay: 0 }))
          .then(() => log('已把私信间隔/条数迁到 2.0 的默认（每 1 分钟、不限条数）；开关按你自己的设置保持不变'))
          .catch((error) => log('迁移私信默认值失败（不影响使用）：' + String(error?.message ?? error)))
      }
      writeMarker(marker, String(now()))
      return true
    } catch (error) {
      log('迁移检查出错（不影响使用）：' + String(error?.message ?? error))
      return false
    }
  }

  return { migrate200 }
}

