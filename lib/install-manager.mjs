/**
 * Python/uv environment lifecycle for the Bilibili plugin.
 *
 * The host entry should only ask this service for readiness, status or an
 * asynchronous install. All filesystem paths, uv discovery, subprocess
 * logging and mirror fallback live here so HTTP/tools do not know how a venv
 * is built.
 */
import { spawn as defaultSpawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'

import { createCommandRunner } from './command-runner.mjs'
import { ensureUv as defaultEnsureUv } from './uvfetch.mjs'
import { createPathLayout } from './path-layout.mjs'

const defaultReadTail = (file, size = 1400) => {
  try { return readFileSync(file, 'utf8').slice(-size) } catch { return '' }
}

const inferOutcome = (tail, successPattern) => {
  const marker = tail.lastIndexOf('=== 结束')
  if (marker < 0) return 'idle'
  return successPattern.test(tail.slice(marker)) ? 'succeeded' : 'failed'
}

export function createInstallManager({
  stateDir,
  pluginDir,
  getConfig,
  persistConfig = async () => ({ host: { ok: false, error: '未提供配置保存器' } }),
  uvEnv = (extra = {}) => ({ ...process.env, ...extra }),
  log = () => {},
  spawn = defaultSpawn,
  commandRunner = null,
  ensureUv = defaultEnsureUv,
  env = process.env,
  platform = process.platform,
  readTail = defaultReadTail,
}) {
  if (typeof getConfig !== 'function') throw new TypeError('createInstallManager requires getConfig()')

  const config = () => getConfig() || {}
  const layout = createPathLayout(stateDir)
  const venvDir = layout.venvDir
  const asrDir = layout.asrVenvDir
  const installLogFile = layout.installLogFile
  const asrLogFile = layout.asrInstallLogFile
  const asrTmp = layout.asrTmpDir
  const paths = {
    venvDir,
    venvPython: platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python'),
    asrDir,
    asrPython: platform === 'win32' ? join(asrDir, 'Scripts', 'python.exe') : join(asrDir, 'bin', 'python'),
    installLogFile,
    asrLogFile,
    asrTmp,
  }

  let installing = false
  let installingAsr = false
  let installController = null
  let asrController = null
  let installState = inferOutcome(readTail(installLogFile, 3000), /exit 0，venvReady=true/)
  let asrState = inferOutcome(readTail(asrLogFile, 3000), /装包 exit 0，模型 exit 0，asrReady=true/)
  let uvOk = null

  const runner = commandRunner || createCommandRunner({ spawn, baseEnv: env, baseCwd: stateDir })
  if (!runner || typeof runner.run !== 'function') {
    throw new TypeError('createInstallManager requires commandRunner.run()')
  }

  try { mkdirSync(asrTmp, { recursive: true }) } catch { /* 启动时建不了，安装时再给出日志 */ }

  const append = (file, value) => {
    try { appendFileSync(file, String(value), 'utf8') } catch { /* 日志写不了不能阻止插件加载 */ }
  }
  const appendInstall = (value) => append(installLogFile, value)
  const appendAsr = (value) => append(asrLogFile, value)

  const sitePkgs = (venvRoot) => {
    const windows = join(venvRoot, 'Lib', 'site-packages')
    if (existsSync(windows)) return windows
    try {
      const lib = join(venvRoot, 'lib')
      for (const name of readdirSync(lib)) {
        if (!name.startsWith('python')) continue
        const candidate = join(lib, name, 'site-packages')
        if (existsSync(candidate)) return candidate
      }
    } catch { /* 环境还没创建 */ }
    return windows
  }

  const hasPkg = (venvRoot, prefix) => {
    try { return readdirSync(sitePkgs(venvRoot)).some((name) => name.startsWith(prefix)) } catch { return false }
  }

  const VENV_DEPS = ['bilibili_api', 'mcp', 'qrcode']
  const missingVenvDeps = () => VENV_DEPS.filter((name) => !hasPkg(venvDir, name))
  const venvReadyNow = () => existsSync(paths.venvPython) && missingVenvDeps().length === 0
  const asrReadyNow = () => existsSync(paths.asrPython) && hasPkg(asrDir, 'faster_whisper')

  const probe = async (cmd, signal) => {
    const result = await runner.run(cmd, ['--version'], {
      cwd: stateDir,
      env,
      stdio: 'ignore',
      capture: false,
      signal,
    })
    return result.code === 0 && !result.error
  }

  const haveUv = async (signal) => {
    if (uvOk) return true
    const ok = await probe('uv', signal)
    if (ok) uvOk = true // 只缓存成功；刚下载的 uv 要能在本轮立即生效
    return ok
  }

  const runLogged = async (cmd, args, { sink = appendInstall, extraEnv = null, signal } = {}) => {
    sink(`\n$ ${cmd} ${args.join(' ')}\n`)
    const result = await runner.run(cmd, args, {
      cwd: stateDir,
      env: uvEnv(extraEnv || {}),
      signal,
      onStdout: (chunk) => sink(chunk),
      onStderr: (chunk) => sink(chunk),
    })
    if (result.error) sink(`起不来：${result.error?.message ?? result.error}\n`)
    sink(`\n--- exit ${result.code ?? 1} ---\n`)
    return result.code === 0 && !result.error ? 0 : (result.code ?? 1)
  }

  const spawnLogged = (cmd, args, options = {}) => runLogged(cmd, args, options)
  const spawnTo = (cmd, args, options = {}) => runLogged(cmd, args, options)

  const resolveUv = async (signal) => {
    const bundled = join(layout.uvBinDir, platform === 'win32' ? 'uv.exe' : 'uv')
    if (signal?.aborted) return null
    if (await haveUv(signal)) return 'uv'
    if (existsSync(bundled)) return bundled
    appendInstall('这台机器上没有 uv —— 我下一份放进插件家目录（单文件、免管理员、约 15MB，只需要一次）…\n')
    const downloaded = await ensureUv({ dir: layout.uvBinDir, log: appendInstall, signal })
    if (downloaded) appendInstall('uv 已就位：' + downloaded + '\n')
    return downloaded
  }

  const runAsrInstall = () => {
    if (installingAsr) return { ok: true, busy: true, log: asrLogFile, hint: '正在装转写依赖，别重复起' }
    installingAsr = true
    const controller = new AbortController()
    asrController = controller
    const signal = controller.signal
    asrState = 'running'
    appendAsr(`\n=== ${new Date().toISOString()} 开始装"本地转写"依赖 ===\n`)
    ;(async () => {
      try {
        const mirror = env.BILI_DUTY_PIP_MIRROR || 'https://pypi.tuna.tsinghua.edu.cn/simple'
        const hf = env.BILI_DUTY_HF_ENDPOINT || 'https://hf-mirror.com'
        const py = paths.asrPython
        const uvCmd = await resolveUv(signal)
        if (signal.aborted) return
        if (!existsSync(py)) {
          if (uvCmd) {
            const spec = String(env.BILI_DUTY_VENV_PYTHON || '3.12').trim()
            let code = await spawnTo(uvCmd, ['venv', '--seed', '--python', spec, asrDir], { sink: appendAsr, signal })
            if (code !== 0 && !signal.aborted) {
              appendAsr(`\n（uv 带 --python ${spec} 没成 —— 退回 uv 默认 Python，能不能装上看运气）\n`)
              await spawnTo(uvCmd, ['venv', '--seed', asrDir], { sink: appendAsr, signal })
            }
          } else {
            await spawnTo(String(config().pythonPath || 'python'), ['-m', 'venv', asrDir], { sink: appendAsr, signal })
          }
        }
        if (signal.aborted) return
        if (!existsSync(py)) {
          const tail = readTail(asrLogFile, 3000)
          if (/Could not acquire lock|uv\\cache\\.lock|os error 5|拒绝访问/.test(tail)) {
            const uvCache = join(env.LOCALAPPDATA || '', 'uv')
            appendAsr('建环境失败 —— 真正的原因：**uv 的缓存目录打不开**（日志里有 "Could not acquire lock"）。\n')
            appendAsr('  照这个做：把 ' + (uvCache || '%LOCALAPPDATA%\\uv') + ' 整个删掉，再点一次「装转写依赖」。\n')
            appendAsr('  （那是上次失败留下的锁文件；删掉会重建，不影响别的东西）\n')
            log('转写：建环境失败 —— uv 缓存目录不可写（已给出具体修法）')
            asrState = 'failed'
            return
          }
          if (/No solution found|ResolutionImpossible|not found in the/.test(tail)) {
            appendAsr('建环境失败 —— 真正的原因：**这个 Python 版本上找不到可装的依赖**（日志里有 "No solution found"）。\n')
            appendAsr('  照这个做：设环境变量 BILI_DUTY_VENV_PYTHON=3.12 后重启 dsh，再点一次。\n')
            log('转写：建环境失败 —— 依赖无解（已给出具体修法）')
            asrState = 'failed'
            return
          }
          appendAsr('建环境失败 —— 可能有两种原因：\n')
          appendAsr('  ① 上面日志里出现 "Could not acquire lock / uv\\cache\\.lock / 拒绝访问" ⇒ 是 uv 缓存目录没权限；\n')
          appendAsr('     装新版（0.1.11+）会把缓存改到插件自己的家目录，就不会再碰 %LOCALAPPDATA%\\uv 了。\n')
          appendAsr('  ② 机器上没有可用的 uv 或 Python ⇒ 先点上面的「装依赖」，把主依赖装好再来。\n')
          log('转写：建环境失败')
          asrState = 'failed'
          return
        }
        appendAsr('装 faster-whisper + yt-dlp（走国内镜像）…\n')
        let code = 1
        const avPin = env.BILI_DUTY_AV_PIN || 'av>=12,<17'
        const mirrors = [mirror, 'https://mirrors.ustc.edu.cn/pypi/simple', 'https://mirrors.aliyun.com/pypi/simple']
        const packages = ['faster-whisper', 'yt-dlp', avPin]
        for (const source of mirrors) {
          if (code === 0) break
          appendAsr(`\n—— 镜像：${source}\n`)
          if (uvCmd) code = await spawnTo(uvCmd, ['pip', 'install', '--python', py, '-i', source, ...packages], { sink: appendAsr, signal })
          if (code !== 0 && !signal.aborted) code = await spawnTo(py, ['-m', 'pip', 'install', '-i', source, ...packages], { sink: appendAsr, signal })
        }
        if (signal.aborted) return
        if (code !== 0) {
          appendAsr('装包失败 —— 看上面的报错\n')
          log('转写：装包失败')
          asrState = 'failed'
          return
        }
        const model = String(config().asrModel || 'small')
        const hfHome = layout.hfCacheDir
        try { mkdirSync(hfHome, { recursive: true }) } catch { /* 后面会给出安装日志 */ }
        appendAsr(`下 Whisper 模型「${model}」（缓存在 ${hfHome}，源 ${hf}，几百 MB，只需要一次）…\n`)
        const modelCode = await spawnTo(py, ['-c',
          'import os,sys;os.environ["HF_HUB_DISABLE_XET"]="1";from faster_whisper import WhisperModel;WhisperModel(sys.argv[1], device="cpu", compute_type="int8");print("模型就绪")',
          model], { sink: appendAsr, signal, extraEnv: { HF_ENDPOINT: hf, HF_HOME: hfHome, HF_HUB_DISABLE_XET: '1' } })
        appendAsr(`=== 结束（装包 exit ${code}，模型 exit ${modelCode}，asrReady=${asrReadyNow()}）===\n`)
        asrState = code === 0 && modelCode === 0 && asrReadyNow() ? 'succeeded' : 'failed'
        log(`装转写依赖结束：exit=${code}/${modelCode}`)
      } catch (error) {
        if (signal.aborted) return
        appendAsr(`装转写依赖崩了：${error?.stack ?? error}\n`)
        log(`装转写依赖崩了：${error?.message ?? error}`)
        asrState = 'failed'
      } finally {
        if (signal.aborted) asrState = 'idle'
        installingAsr = false
        if (asrController === controller) asrController = null
      }
    })()
    return { ok: true, started: true, log: asrLogFile, hint: '正在后台装转写依赖 —— 进度显示在下面（要下几百 MB 模型，慢一点正常）' }
  }

  const runInstall = () => {
    if (installing) return { ok: true, busy: true, log: installLogFile, hint: '正在装，别重复起' }
    installing = true
    const controller = new AbortController()
    installController = controller
    const signal = controller.signal
    installState = 'running'
    appendInstall(`\n=== ${new Date().toISOString()} 开始装依赖 ===\n`)
    ;(async () => {
      try {
        const reqFile = join(pluginDir, 'vendor', 'bilibili-mcp', 'requirements.txt')
        const mirror = env.BILI_DUTY_PIP_MIRROR || 'https://pypi.tuna.tsinghua.edu.cn/simple'
        const py = String(config().pythonPath || 'python')
        const uvCmd = await resolveUv(signal)
        if (signal.aborted) return
        const pythonAvailable = existsSync(paths.venvPython) || Boolean(uvCmd) || await probe(py, signal)
        if (signal.aborted) return
        if (!pythonAvailable) {
          const message = '这台机器上没有 uv，也没有可用的 python（试过 "' + py + '"），而且我自动下 uv 也没成功'
            + '（大概是网络到不了 GitHub / PyPI 镜像）。⇒ 请手动装 uv（单个 exe：https://docs.astral.sh/uv/）'
            + '或 Python 3.10+（安装时勾 Add to PATH），然后回来再点一次「装依赖」。'
          appendInstall(message + '\n')
          log(message)
          installState = 'failed'
          return
        }
        try {
          const pyv = readFileSync(join(venvDir, 'pyvenv.cfg'), 'utf8')
          const match = /version\s*=\s*(\d+)\.(\d+)/.exec(pyv)
          if (match && existsSync(paths.venvPython) && Number(match[2]) >= 14) {
            const tag = `${match[1]}.${match[2]}`
            const bad = join(stateDir, `.venv.bad-${tag}-${Date.now()}`)
            appendInstall(`当前环境是 Python ${tag}（太高，brotli / pyyaml 没有现成的包）⇒ 改名重建 3.12\n`)
            try { renameSync(venvDir, bad) } catch (error) { appendInstall('改名没成功：' + String(error?.message ?? error) + '\n') }
          }
        } catch { /* 没有 pyvenv.cfg 就算了 */ }
        if (!existsSync(paths.venvPython)) {
          if (uvCmd) {
            const spec = String(env.BILI_DUTY_VENV_PYTHON || '3.12').trim()
            let code = await spawnLogged(uvCmd, ['venv', '--seed', '--python', spec, venvDir], { signal })
            if (code !== 0) {
              appendInstall(`\n（uv 带 --python ${spec} 没成 —— 退回 uv 默认 Python）\n`)
              code = await spawnLogged(uvCmd, ['venv', '--seed', venvDir], { signal })
            }
            if (code !== 0 && !signal.aborted) log('建 venv 没成功（两条路都试过）')
          }
          if (!existsSync(paths.venvPython) && !uvCmd) await spawnLogged(py, ['-m', 'venv', venvDir], { signal })
        }
        if (signal.aborted) return
        let code = 1
        const mirrors = [mirror, 'https://mirrors.ustc.edu.cn/pypi/simple', 'https://mirrors.aliyun.com/pypi/simple']
        for (let index = 0; index < mirrors.length && code !== 0; index++) {
          const source = mirrors[index]
          if (index > 0) appendInstall(`\n--- 换个镜像再试：${source} ---\n`)
          if (uvCmd) code = await spawnLogged(uvCmd, ['pip', 'install', '--python', paths.venvPython, '-i', source, '-r', reqFile], { signal })
          if (code !== 0 && !signal.aborted) code = await spawnLogged(paths.venvPython, ['-m', 'pip', 'install', '-i', source, '-r', reqFile], { signal })
        }
        if (signal.aborted) return
        if (code === 0 && !signal.aborted && existsSync(paths.venvPython)) {
          const result = await persistConfig({ pythonPath: paths.venvPython })
          appendInstall(`已把 pythonPath 设为 ${paths.venvPython}（DSH 那边${result?.host?.ok ? '已同步' : '没写成：' + (result?.host?.error || '未知原因')}）\n`)
        }
        const missing = missingVenvDeps()
        appendInstall(`=== 结束（exit ${code}，venvReady=${venvReadyNow()}${missing.length ? '，缺：' + missing.join(' / ') : ''}）===\n`)
        installState = code === 0 && venvReadyNow() ? 'succeeded' : 'failed'
        log(`装依赖结束：exit=${code} venvReady=${venvReadyNow()}${missing.length ? ' 缺：' + missing.join(',') : ''}`)
      } catch (error) {
        if (signal.aborted) return
        appendInstall(`装依赖崩了：${error?.stack ?? error}\n`)
        log(`装依赖崩了：${error?.message ?? error}`)
        installState = 'failed'
      } finally {
        if (signal.aborted) installState = 'idle'
        installing = false
        if (installController === controller) installController = null
      }
    })()
    return { ok: true, started: true, log: installLogFile, hint: '正在后台装依赖 —— 进度就显示在下面（走国内镜像，通常几十秒到一两分钟）' }
  }

  const status = () => ({
    venvReady: venvReadyNow(),
    missingDeps: missingVenvDeps(),
    asrReady: asrReadyNow(),
    asrInstalling: installingAsr,
    asrLog: asrLogFile,
    asrTail: readTail(asrLogFile),
    installLog: installLogFile,
    installTail: readTail(installLogFile),
    installing,
    installState,
    installFailed: installState === 'failed',
    asrState,
    paths: { ...paths },
  })

  return {
    paths,
    appendInstall,
    appendAsr,
    venvPython: () => paths.venvPython,
    asrPython: () => paths.asrPython,
    missingVenvDeps,
    venvReadyNow,
    asrReadyNow,
    runInstall,
    runAsrInstall,
    resolveUv,
    spawnTo,
    status,
    isInstalling: () => installing,
    isInstallingAsr: () => installingAsr,
    stop() {
      const active = Boolean(installController || asrController)
      try { installController?.abort() } catch {}
      try { asrController?.abort() } catch {}
      return active
    },
  }
}

