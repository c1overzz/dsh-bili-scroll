import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prefix = join(process.env.DSH_TEST_TMP || tmpdir(), 'bili-native-')
const home = mkdtempSync(prefix)
try {
  const profile = join(home, 'profiles', 'bili-settings-check')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  symlinkSync(root, join(profile, 'node_modules', 'dsh-bili-scroll'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'bili-native-check', private: true, dependencies: { 'dsh-bili-scroll': 'file:' + root },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-bili-scroll'] } },
  }))
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { insert: [{ id: 'native-settings-fixture', name: pathToFileURL(join(root, 'tools', 'native-settings-fixture.mjs')).href }] },
    { id: 'hmr', disabled: true },
  ]))
  for (const phase of ['save', 'reload']) {
    // A direct executable + CLI entry avoids cmd.exe quoting for desktop installs.
    const executable = process.env.DSH_NATIVE_EXECUTABLE || 'dsh'
    const args = [...(process.env.DSH_NATIVE_CLI ? ['--expose-internals', process.env.DSH_NATIVE_CLI] : []),
      '--profile', 'bili-settings-check']
    const result = spawnSync(executable, args, {
      env: { ...process.env, DSH_HOME: home, DSH_NATIVE_PHASE: phase,
        ...(process.env.DSH_NATIVE_CLI ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    })
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    if (result.error) throw result.error
    assert.equal(result.status, 0, 'native settings ' + phase + ' failed')
  }
} finally {
  assert.ok(resolve(home).startsWith(resolve(prefix)))
  rmSync(home, { recursive: true, force: true })
}
