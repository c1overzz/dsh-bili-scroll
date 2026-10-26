import { createPathLayout } from './path-layout.mjs'

/**
 * Build the stable status projection consumed by the settings UI and HTTP API.
 *
 * This is deliberately a read-only adapter: persistence and domain services
 * stay behind callbacks, while the entry point only wires those callbacks.
 */
export function createStatusService({
  stateDir,
  outDir,
  logFile,
  getConfig,
  refreshConfig = () => {},
  readState = () => ({}),
  dayKey = () => new Date().toISOString().slice(0, 10),
  windows = {},
  countPickedToday = () => 0,
  ownerInfo = () => ({}),
  hasCredential = () => false,
  getDmUid = () => 0,
  getVersion = () => '',
  getPersonaFromWorkspace = () => '',
  getNotSynced = () => [],
  getDshCli = () => '',
  getInstallStatus = () => ({}),
  asrModelReady = () => false,
}) {
  if (typeof getConfig !== 'function') throw new TypeError('createStatusService requires getConfig()')
  const layout = createPathLayout(stateDir, { outDir })

  const getStatus = () => {
    refreshConfig()
    const cfg = getConfig() || {}
    const state = readState() || {}
    const today = dayKey()
    return {
      ok: true,
      home: stateDir,
      config: cfg,
      windows,
      today,
      ranToday: state.day === today ? Number(state.count || 0) : 0,
      pickedToday: countPickedToday(),
      lastRunAt: state.lastRunAt || null,
      lastWhy: state.lastWhy || null,
      ownerInfo: ownerInfo(),
      loggedIn: hasCredential(),
      version: getVersion(),
      dmUidResolved: Number(cfg.dmUid) || getDmUid() || 0,
      personaFromWs: getPersonaFromWorkspace(cfg),
      notSynced: getNotSynced(),
      dshCli: getDshCli(),
      ...getInstallStatus(),
      asrModelReady: asrModelReady(),
      report: layout.reportFile(today),
      log: logFile,
    }
  }

  return { getStatus }
}

