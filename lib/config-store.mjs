import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPathLayout } from './path-layout.mjs'
import { writeJsonAtomic } from './atomic-write.mjs'

import {
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  clampConfig,
  normalizeConfig,
} from './config.mjs'

const SETTINGS_SIGNATURE = ['perDay', 'mentionName', 'replyToComments', 'overlayMcp']

/**
 * Owns the local config file and the optional DSH settings mirror.
 *
 * The store deliberately keeps the local file authoritative for fields saved
 * through this plugin. DSH settings are treated as a best-effort mirror,
 * because some desktop profiles cannot commit volatile settings at runtime.
 */
export function createConfigStore({
  stateDir,
  settings,
  hostConfig,
  readJson = (file, fallback) => {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
  },
  writeJson = (file, value) => writeJsonAtomic(file, value),
  log = () => {},
}) {
  const layout = createPathLayout(stateDir)
  const cfgFile = layout.configFile
  const overrideFile = layout.localOverrideFile
  let hostDiff = []
  let lastDiffSig = ''
  let settingsRow = { at: 0, row: null }

  const raw = readJson(cfgFile, {}) || {}
  const touchedKeys = new Set(Array.isArray(raw._set)
    ? raw._set
    : CONFIG_KEYS.filter((key) => key in raw && JSON.stringify(raw[key]) !== JSON.stringify(CONFIG_DEFAULTS[key])))

  const readOverride = () => {
    const value = readJson(overrideFile, {})
    return value && typeof value === 'object' ? value : {}
  }

  const markOverride = (keys, on = true) => {
    try {
      const current = readOverride()
      for (const key of keys) {
        if (on) current[key] = Date.now()
        else delete current[key]
      }
      writeJson(overrideFile, current)
    } catch (error) {
      log('记 local-override 失败：' + (error?.message ?? error))
    }
  }

  const settingsDesc = (fresh = false) => {
    const now = Date.now()
    if (!fresh && now - settingsRow.at < 3000) return settingsRow.row
    let row = null
    try {
      const rows = settings?.describe?.() || []
      row = rows.find((candidate) => candidate?.value && SETTINGS_SIGNATURE.every((key) => key in candidate.value)) || null
    } catch (error) {
      log(`读 DSH 设置表单失败（不影响跑）：${error?.message ?? error}`)
    }
    settingsRow = { at: now, row }
    return row
  }

  const savedConfig = () => normalizeConfig(readJson(cfgFile, {}), CONFIG_DEFAULTS)
  const clamp = (patch) => clampConfig(patch, { log })

  const load = () => {
    const saved = savedConfig()
    const row = settingsDesc()
    if (!row) return clamp(saved)

    const user = row.user || {}
    const result = normalizeConfig(
      row.value && typeof row.value === 'object' ? row.value : hostConfig,
      CONFIG_DEFAULTS,
    )
    const overrides = readOverride()
    const touched = new Set([
      ...touchedKeys,
      ...Object.keys(overrides),
      'pythonPath',
      ...CONFIG_KEYS.filter((key) => JSON.stringify(saved[key]) !== JSON.stringify(CONFIG_DEFAULTS[key])),
    ])

    const diff = []
    for (const key of CONFIG_KEYS) {
      if (touched.has(key)) result[key] = saved[key]
      else if (user[key] !== undefined) result[key] = user[key]
      else result[key] = saved[key]
    }
    for (const key of touched) {
      if (key in CONFIG_DEFAULTS && user[key] !== undefined && JSON.stringify(user[key]) !== JSON.stringify(result[key])) diff.push(key)
    }
    hostDiff = diff
    const signature = diff.slice().sort().join(',')
    if (signature && signature !== lastDiffSig) {
      lastDiffSig = signature
      log(`这些键以插件面板为准（DSH 原生设置里那份不一样）：${signature}`)
    }
    return clamp(result)
  }

  const saveLocal = (patch, current) => {
    const next = normalizeConfig(patch, current)
    for (const key of Object.keys(patch || {})) if (key in CONFIG_DEFAULTS) touchedKeys.add(key)
    writeJson(cfgFile, { ...next, _set: [...touchedKeys] })
    return next
  }

  const saveHost = async (patch) => {
    const attempt = async (fresh) => {
      const row = settingsDesc(fresh)
      if (!row?.ns || typeof settings?.update !== 'function') {
        throw Object.assign(new Error('DSH 这边没有可写的设置表单（值只落在插件自己的 config.json 里）'), { noForm: true })
      }
      await settings.update(row.ns, patch, row.revision)
      const after = settingsDesc(true)
      const user = after?.user || {}
      const bad = Object.keys(patch).filter((key) => {
        const wanted = patch[key]
        const got = user[key]
        if (Array.isArray(wanted)) return JSON.stringify(wanted) !== JSON.stringify(got)
        if (wanted !== null && typeof wanted === 'object') return true
        return String(got) !== String(wanted)
      })
      if (bad.length) throw Object.assign(new Error('写入没生效（读回来还是旧值）：' + bad.join(', ')), { stale: true })
      return row.ns
    }
    try {
      return { ok: true, ns: await attempt(false) }
    } catch (error) {
      if (!error?.noForm) {
        try { return { ok: true, ns: await attempt(true), retried: true } } catch (retryError) { error = retryError }
      }
      log(`写 DSH 设置失败：${error?.message ?? error}`)
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  const persist = async (patch, current) => {
    const clean = clamp(patch)
    const next = saveLocal(clean, current)
    const host = await saveHost(clean)
    // `local-override.json` is a diagnostic for a failed host mirror, not a
    // second list of every field the plugin has ever touched. Local priority
    // remains tracked by config.json's `_set` marker.
    markOverride(Object.keys(clean), !host.ok)
    if (!host.ok) log('⚠️ 这几项没能同步到 DSH 原生设置，改为以插件自己的值为准：' + Object.keys(clean).join(', ') + '（' + host.error + '）')
    return { clean, next, host }
  }

  return {
    cfgFile,
    overrideFile,
    defaults: CONFIG_DEFAULTS,
    load,
    persist,
    clamp,
    readOverride,
    getHostDiff: () => [...hostDiff],
    getTouchedKeys: () => [...touchedKeys],
    hasLocalConfig: () => existsSync(cfgFile),
  }
}
