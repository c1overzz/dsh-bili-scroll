import test from 'node:test'
import assert from 'node:assert/strict'

import { createStatusService } from '../lib/status-service.mjs'

test('status service builds the UI projection from current callbacks', () => {
  let refreshed = 0
  const service = createStatusService({
    stateDir: '/home/bili-duty',
    outDir: '/home/bili-duty/out',
    logFile: '/home/bili-duty/duty.log',
    dutyStateFile: '/home/bili-duty/state.json',
    getConfig: () => ({ dmUid: 0, workspace: '/workspace' }),
    refreshConfig: () => { refreshed++ },
    readState: () => ({ day: '2026-10-24', count: 2, lastRunAt: 'now', lastWhy: 'manual' }),
    dayKey: () => '2026-10-24',
    windows: { noon: true },
    countPickedToday: () => 4,
    ownerInfo: () => ({ uid: 9 }),
    hasCredential: () => true,
    getDmUid: () => 9,
    getVersion: () => '2.1.0',
    getPersonaFromWorkspace: () => 'persona',
    getNotSynced: () => ['dmWatch'],
    getDshCli: () => '/opt/dsh/bin.js',
    getInstallStatus: () => ({ venvReady: true }),
    asrModelReady: () => true,
  })
  const status = service.getStatus()
  assert.equal(refreshed, 1)
  assert.equal(status.ranToday, 2)
  assert.equal(status.pickedToday, 4)
  assert.equal(status.dmUidResolved, 9)
  assert.equal(status.report, '/home/bili-duty/out/2026-10-24.md')
  assert.equal(status.venvReady, true)
})

test('status service resets stale daily counters', () => {
  const service = createStatusService({
    stateDir: '/tmp',
    outDir: '/tmp/out',
    logFile: '/tmp/duty.log',
    getConfig: () => ({ dmUid: 5 }),
    readState: () => ({ day: 'yesterday', count: 99 }),
    dayKey: () => 'today',
    getDmUid: () => 7,
  })
  const status = service.getStatus()
  assert.equal(status.ranToday, 0)
  assert.equal(status.dmUidResolved, 5)
})
