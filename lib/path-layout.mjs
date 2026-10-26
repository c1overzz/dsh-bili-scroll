import { join } from 'node:path'

/**
 * Names of every runtime-owned file and directory under the plugin home.
 * Keeping this contract in one place makes it harder for a service to
 * accidentally write state beside the installed package.
 */
export function createPathLayout(stateDir, { outDir = join(stateDir, 'out') } = {}) {
  if (!stateDir) throw new TypeError('createPathLayout requires stateDir')
  const path = (name) => join(stateDir, name)
  return Object.freeze({
    root: stateDir,
    outDir,
    reportFile: (day) => join(outDir, `${String(day)}.md`),
    configFile: path('config.json'),
    migration200Marker: path('.mig-2.0.0'),
    localOverrideFile: path('local-override.json'),
    logFile: path('duty.log'),
    installLogFile: path('install.log'),
    asrInstallLogFile: path('asr-install.log'),
    venvDir: path('.venv'),
    asrVenvDir: path('.venv-asr'),
    asrTmpDir: join(stateDir, 'tmp', 'asr'),
    uvBinDir: path('bin'),
    uvCacheDir: path('uv-cache'),
    uvToolsDir: path('uv-tools'),
    uvPythonDir: path('uv-python'),
    hfCacheDir: path('.hf-cache'),
    mcpServerFile: path('mcp_server.py'),
    asrFile: path('asr.py'),
    favopsFile: path('favops.py'),
    dutyFile: path('duty.md'),
    dutyFileNew: path('duty.md.new'),
    charterLedgerFile: path('charter.sha256'),
    credentialFile: path('bili_credential.json'),
    qrFile: path('qrcode_login.png'),
    seenFile: path('seen.md'),
    commentsFile: path('comments.md'),
    stateFile: path('state.json'),
    seenArchiveDir: path('seen'),
    digestDir: path('digest'),
    notesDir: path('reports'),
    verifyStateFile: path('verify-state.json'),
    overlayFile: path('headless-overlay.yml'),
    dmSeenFile: path('dm-seen.json'),
    dmQuotaFile: path('dm-quota.json'),
    dmLockFile: path('dm-lock.json'),
    dmOthersFile: path('dm-others.json'),
    dmSessionFile: path('dm-session.json'),
    uidCacheFile: path('uid-cache.json'),
    runLockFile: path('run-lock.json'),
  })
}

