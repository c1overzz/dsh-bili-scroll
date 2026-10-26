/**
 * Shared configuration contract for the host, HTTP API and settings client.
 *
 * Keeping the defaults and normalization rules here prevents the host entry
 * from becoming the second source of truth for configuration. The DSH schema
 * is still built lazily because schemastery is an optional host dependency.
 */

export const CONFIG_DEFAULTS = Object.freeze({
  dmWatch: true,
  dmWatchMinutes: 1,
  dmReplyPerDay: 0,
  dmOwnerUid: 0,
  personaPrompt: '',
  perDay: 5,
  peakValley: false,
  noon: true,
  night: true,
  autoComment: false,
  transcribe: false,
  asrModel: 'small',
  dmMode: 'only',
  dmUid: 0,
  keywords: Object.freeze([]),
  commentPerRound: 1,
  mentionName: '',
  pythonPath: 'python',
  dshBin: '',
  headlessProfile: 'bili-duty',
  overlayMcp: true,
  workspace: '',
  reportLevel: 'full',
  replyToComments: false,
  replyPerRound: 1,
  favFolderId: 0,
})

export const CONFIG_KEYS = Object.freeze(Object.keys(CONFIG_DEFAULTS))

const FIELD_KINDS = Object.freeze({
  perDay: 'natural',
  peakValley: 'boolean',
  noon: 'boolean',
  night: 'boolean',
  autoComment: 'boolean',
  dmMode: 'string',
  dmUid: 'natural',
  transcribe: 'boolean',
  asrModel: 'string',
  commentPerRound: 'natural',
  mentionName: 'string',
  keywords: 'strings',
  pythonPath: 'string',
  dshBin: 'string',
  headlessProfile: 'string',
  overlayMcp: 'boolean',
  personaPrompt: 'string',
  dmWatch: 'boolean',
  dmWatchMinutes: 'natural',
  dmReplyPerDay: 'natural',
  dmOwnerUid: 'natural',
  workspace: 'string',
  reportLevel: 'string',
  replyToComments: 'boolean',
  replyPerRound: 'number',
  favFolderId: 'number',
})

/** Build the optional DSH schema while keeping defaults in this module. */
export function createConfigSchema(z) {
  if (!z) return undefined
  const shape = {}
  for (const key of CONFIG_KEYS) {
    const kind = FIELD_KINDS[key]
    if (!kind) continue
    let schema
    if (kind === 'boolean') schema = z.boolean()
    else if (kind === 'natural') schema = z.natural()
    else if (kind === 'number') schema = z.number()
    else if (kind === 'strings') schema = z.array(z.string())
    else schema = z.string()
    const defaultValue = Array.isArray(CONFIG_DEFAULTS[key]) ? [...CONFIG_DEFAULTS[key]] : CONFIG_DEFAULTS[key]
    shape[key] = schema.default(defaultValue).extra('volatile', true)
  }
  return z.object(shape)
}

/** Normalize unknown input to the config contract without throwing. */
export function normalizeConfig(src, base = CONFIG_DEFAULTS) {
  const out = { ...base }
  for (const key of CONFIG_KEYS) {
    if (Array.isArray(base[key])) out[key] = [...base[key]]
  }
  for (const key of CONFIG_KEYS) {
    const fallback = base[key]
    const value = src?.[key]
    if (value === undefined || value === null) continue
    if (Array.isArray(fallback)) {
      if (Array.isArray(value)) out[key] = value.filter((item) => typeof item === 'string')
    } else if (typeof fallback === 'number') {
      const number = Number(value)
      if (Number.isFinite(number)) out[key] = number
    } else if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') out[key] = value
    } else if (typeof fallback === 'string') {
      if (typeof value === 'string') out[key] = value
    }
  }
  return out
}

/** Apply the runtime limits shared by every write and read path. */
export function clampConfig(patch, { log = () => {} } = {}) {
  const out = {}
  for (const key of CONFIG_KEYS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key]
  }
  if ('perDay' in out) out.perDay = Math.max(0, Math.min(Number(out.perDay) || 0, 50))
  if ('reportLevel' in out) {
    out.reportLevel = ['full', 'brief', 'off'].includes(String(out.reportLevel))
      ? String(out.reportLevel)
      : 'full'
  }
  if ('personaPrompt' in out) {
    const raw = String(out.personaPrompt || '')
    const limit = 60_000
    if (raw.length > limit) {
      log(`⚠️ 人设提示词 ${raw.length} 字符，超过保存上限 ${limit} ⇒ 只存前 ${limit}（截掉 ${raw.length - limit} 字）`)
      out.personaPrompt = raw.slice(0, limit)
    } else {
      out.personaPrompt = raw
    }
  }
  if ('dmWatch' in out) out.dmWatch = Boolean(out.dmWatch)
  if ('dmWatchMinutes' in out) out.dmWatchMinutes = Math.max(1, Math.min(120, Number(out.dmWatchMinutes) || 1))
  if ('dmReplyPerDay' in out) out.dmReplyPerDay = Math.max(0, Math.min(20, Number(out.dmReplyPerDay) || 0))
  if ('dmOwnerUid' in out) {
    out.dmOwnerUid = Math.max(0, Math.min(Math.floor(Number(out.dmOwnerUid) || 0), Number.MAX_SAFE_INTEGER))
  }
  if ('dmMode' in out) {
    out.dmMode = ['off', 'only', 'both'].includes(String(out.dmMode)) ? String(out.dmMode) : 'off'
  }
  if ('dmUid' in out) {
    out.dmUid = Math.max(0, Math.min(Number(out.dmUid) || 0, Number.MAX_SAFE_INTEGER))
  }
  if ('replyToComments' in out) out.replyToComments = Boolean(out.replyToComments)
  if ('replyPerRound' in out) out.replyPerRound = Math.max(1, Math.min(Math.floor(Number(out.replyPerRound) || 1), 10))
  if ('favFolderId' in out) out.favFolderId = Math.max(0, Math.floor(Number(out.favFolderId) || 0))
  if ('commentPerRound' in out) out.commentPerRound = Math.max(0, Math.min(Math.floor(Number(out.commentPerRound) || 0), 20))
  return out
}
