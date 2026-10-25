#!/usr/bin/env node
/**
 * 本机补丁 · asr.py（转写链路）
 * =====================================================================
 * 为什么需要它：插件的转写走 lib/asr.py → 家目录 asr.py，而那份文件用 yt-dlp
 * 解析 B站网页；2026-10-22 起 B站把 `window.__INITIAL_STATE__` 改成「先赋值再读」
 * 的写法，yt-dlp 所有版本都报 `Unable to extract initial state`，转写全废。
 * 我们改成用已登录的 bilibili_api 走 playurl 取 DASH 音频（不解析网页）。
 *
 * ⚠️ 每次 `pnpm add` / 升级插件都会把 lib/asr.py 覆盖回去，所以：
 *   ① 这个脚本在 `preinstall` 钩子里跑（见 package-patch.mjs），把家目录那份重新补上；
 *   ② 顺手把 lib/asr.py 也补上，免得插件再往家目录复制时又盖回旧版。
 *
 * 幂等：已经补过的文件里有 _fetch_audio_bili_api 标记，直接跳过。
 * 用法：node patch-asr.mjs [--dry] [--force]
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const DRY = process.argv.includes('--dry')
const FORCE = process.argv.includes('--force')
// 干净的上游 asr.py（用于"把旧补丁重置回原样再重打"）。仓库里就是 lib/asr.py 的上游版本：
//   优先用仓库里的 git 版本；找不到就让用户手动准备 —— 绝不拿"已打过补丁的文件"当原件。
const UPSTREAM_SNAPSHOT = process.env.BILI_ASR_UPSTREAM || join(HERE, 'asr.upstream.py')

// 家目录：插件家 = ~/.dsh/bili-duty；若本脚本被复制到别处，允许环境变量覆盖
const HOME_DIR = process.env.BILI_DUTY_HOME || join(homedir(), '.dsh', 'bili-duty')

const MARK = '_fetch_audio_bili_api'
// ⭐ 版本戳：光看 MARK 会把"老补丁"也当成"已补过" ⇒ 补丁内容升级后无法覆盖到已补过的文件。
//   2026-10-25 踩过：加了 backup_url 重试后，两个旧补丁文件被判定"已补过"跳过，实际还是旧逻辑。
const MARK_VER = '# [patch-asr v2 backup_url]'
const ANCHOR = 'def fetch_audio(url: str, tmp: str, tag: str) -> str:'

/** preinstall 里的 runner：调本脚本；补丁失败绝不让安装失败 */
const HOOK_SOURCE = `#!/usr/bin/env node
// 本机补丁 · preinstall 入口（由 patch-asr.mjs 安装，插件升级后会被重新装回）
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
try {
  const r = spawnSync(process.execPath, [join(HERE, 'patch-asr.mjs')], {
    cwd: HERE, stdio: 'inherit', timeout: 30000, env: process.env,
  })
  if (r.error || r.status !== 0) {
    console.log('[patch-asr] 钩子未成功（不影响安装）：' + ((r.error && r.error.message) || 'exit ' + r.status))
  }
} catch (e) {
  console.log('[patch-asr] 钩子异常（不影响安装）：' + e.message)
}
process.exit(0)
`

/** 取插件源码里那份 lib/asr.py（本脚本的上一级目录） */
function upstreamAsr() {
  const p = join(HERE, 'lib', 'asr.py')
  return existsSync(p) ? p : null
}

const NEW_FETCH = `${MARK_VER}
def _fetch_audio_bili_api(url: str, tmp: str, tag: str) -> str:
    """[本机补丁] 用已登录的 bilibili_api 取 DASH 音频流并下载。

    为什么不再依赖 yt-dlp：2026-10-22 起 B站 把网页里的 window.__INITIAL_STATE__
    改成了「先赋值再读」的写法，yt-dlp 全部版本（实测到 2026.10.21）都报
    "Unable to extract initial state" 直接放弃。我们有凭证、有 bilibili_api，
    走 playurl API 就能拿到音频，不需要解析网页。

    依赖：bilibili-api-python + aiohttp（已装进 .venv-asr）。
    """
    import importlib
    import json

    from bilibili_api import Credential, register_client, video

    # [本机补丁] bilibili_api 17.4.2 的 __register_all_clients 有 bug：
    #   curl_cffi / aiohttp / httpx 都不在时，异常被吞，一个请求客户端都没注册 ⇒
    #   任何 API 调用都报「尚未安装第三方请求库或未注册自定义第三方请求库」。
    _registered = False
    for _mod, _name in (('AioHTTPClient', 'AioHTTPClient'), ('HTTPXClient', 'HTTPXClient')):
        try:
            _m = importlib.import_module('bilibili_api.clients.' + _mod)
            register_client(_name, getattr(_m, _name), {})
            _registered = True
            break
        except Exception:
            continue
    if not _registered:
        raise RuntimeError('bilibili_api 没有可用的请求客户端（asr 环境里 aiohttp / httpx 都没装）')

    cred_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bili_credential.json')
    cred = None
    if os.path.exists(cred_file):
        try:
            with open(cred_file, encoding='utf-8') as f:
                c = json.load(f)
            cred = Credential(
                sessdata=c.get('sessdata', ''),
                bili_jct=c.get('bili_jct', ''),
                buvid3=c.get('buvid3') or '',
                dedeuserid=c.get('dedeuserid', ''),
            )
        except Exception:
            cred = None

    m = re.search(r'(BV[0-9A-Za-z]{10})', url)
    if not m:
        raise RuntimeError('不是 B站 视频链接，拿不到 BV 号：' + url)
    bvid = m.group(1)

    async def _get_urls() -> list:
        v = video.Video(bvid=bvid, credential=cred)
        info = await v.get_info()
        cid = info.get('cid') or (info.get('pages') or [{}])[0].get('cid')
        if not cid:
            raise RuntimeError('取不到 cid')
        data = await v.get_download_url(cid=int(cid))
        audios = ((data or {}).get('dash') or {}).get('audio') or []
        if not audios:
            raise RuntimeError('这条视频没有 DASH 音频流（可能是纯图文/互动视频）')
        best = max(audios, key=lambda a: a.get('bandwidth') or 0)
        # [本机补丁 · 2.2.0] playurl 每条流除了 base_url 还有 backup_url（2~3 个备用 CDN 域名）。
        #   CDN 域名是**每次随机分配**的，某个节点连不上（实测 809ak83l.edge.mountaintoys.cn:4483
        #   直接 signal timeout）时，换 backup_url 里的域名通常就能下 ⇒ 全部收集起来挨个试。
        urls = []
        for u in [best.get('base_url')] + list(best.get('backup_url') or []):
            if u and u not in urls:
                urls.append(u)
        return urls

    stream_urls = asyncio.run(_get_urls())
    out = os.path.join(tmp, tag + '.m4s')
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                      '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com',
    }

    # [本机补丁] 音频 CDN 是 mcdn.bilivideo.cn:8082 这类带端口的镜像，
    #   urllib 在本机会 SSL: UNEXPECTED_EOF_WHILE_READING；实测 aiohttp 同 URL 200 ⇒ 主用 aiohttp。
    def _dl_aiohttp(u: str) -> None:
        import aiohttp

        async def _run():
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=180)) as s:
                async with s.get(u, headers=headers) as r:
                    if r.status != 200:
                        raise RuntimeError('CDN 返回 %s' % r.status)
                    with open(out, 'wb') as f:
                        async for chunk in r.content.iter_chunked(1 << 16):
                            f.write(chunk)

        asyncio.run(_run())

    def _dl_urllib(u: str) -> None:
        import urllib.request
        req = urllib.request.Request(u, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as resp, open(out, 'wb') as f:
            while True:
                chunk = resp.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)

    last_err = None
    for su in stream_urls:
        done = False
        for dl in (_dl_aiohttp, _dl_urllib):
            try:
                dl(su)
                last_err = None
                done = True
                break
            except Exception as e:
                last_err = e
                print('[asr] 下载失败（%s: %s），换下一种方式…'
                      % (type(e).__name__, str(e)[:120]), file=sys.stderr)
        if done:
            break
        print('[asr] 这个 CDN 域名不通，换 backup_url 里的下一个…', file=sys.stderr)
    if last_err is not None:
        raise last_err
    if not os.path.exists(out) or os.path.getsize(out) < 1024:
        raise RuntimeError('音频流下下来是空的（风控？）')
    return out


def fetch_audio(url: str, tmp: str, tag: str) -> str:
    """把 B站 视频的音频拉下来。

    ① 优先走 bilibili_api（凭证 + playurl，不解析网页，不受前端改版影响）
    ② 失败才退回 yt-dlp（老路径留作保险）
    """
    try:
        return _fetch_audio_bili_api(url, tmp, tag)
    except Exception as e:
        print('[asr] bilibili_api 取音频失败（%s: %s），退回 yt-dlp…'
              % (type(e).__name__, str(e)[:200]), file=sys.stderr)

    # ② 老路径：yt-dlp（B站改版后大概率失败，留着当保险）
    import subprocess
    os.makedirs(tmp, exist_ok=True)
    out = os.path.join(tmp, tag + '.m4a')
    if os.path.exists(out) and os.path.getsize(out) > 1024:
        return out
    cmd = [
        sys.executable, '-m', 'yt_dlp', '-f', 'bestaudio/best',
        '--no-playlist', '--no-warnings', '-o', out, url,
    ]
    try:
        subprocess.run(cmd, check=True, timeout=180,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except Exception as e:
        raise RuntimeError('取音频彻底失败（bilibili_api 与 yt-dlp 都没成）：%s' % e)
    if not os.path.exists(out):
        raise RuntimeError('yt-dlp 说成功但没落文件')
    return out
`

const OLD_TRANSCRIBE = `        model = WhisperModel(args.model, device='cpu', compute_type='int8')
        print('[asr] 开始转写…', file=sys.stderr)
        segments, _info = model.transcribe(
            src,`

const NEW_TRANSCRIBE = `        # [本机补丁] 显式解码成 16k 单声道再喂给 Whisper（.m4s 后缀它按扩展名不认）
        audio_input = src
        try:
            import av
            import numpy as np
            container = av.open(src)
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
            chunks = [rf.to_ndarray().reshape(-1)
                      for frame in container.decode(stream)
                      for rf in resampler.resample(frame)]
            container.close()
            audio_input = np.concatenate(chunks).astype(np.float32) / 32768.0
            print('[asr] 音频 %.1f 秒' % (len(audio_input) / 16000.0), file=sys.stderr)
        except Exception as e:
            print('[asr] PyAV 解码失败（%s: %s），交给 faster-whisper 处理'
                  % (type(e).__name__, str(e)[:120]), file=sys.stderr)

        segments, _info = model.transcribe(
            audio_input,
`

function patchOne(file) {
  if (!existsSync(file)) return { file, skipped: '不存在' }
  let s = readFileSync(file, 'utf8')
  // 已是最新版才跳过；老补丁（只有 MARK 没有 MARK_VER）要重打 ⇒ 先还原成上游再补
  if (s.includes(MARK) && s.includes(MARK_VER) && !FORCE) return { file, skipped: '已补过（最新版）' }
  if (s.includes(MARK) && !s.includes(MARK_VER)) {
    // 老补丁：用包内干净的上游副本覆盖回去，再走一遍完整补丁流程
    const clean = UPSTREAM_SNAPSHOT
    if (clean && existsSync(clean)) {
      copyFileSync(clean, file)
      s = readFileSync(file, 'utf8')
      console.log(`[patch-asr] ${file} 是旧版补丁，已用上游原件重置后重打`)
    } else {
      return { file, skipped: '是旧版补丁，但找不到上游原件可重置（请手动从 git 取 lib/asr.py 再跑）' }
    }
  }

  let changed = false
  // ① 换 fetch_audio
  if (!s.includes('asyncio.run(_get_url())')) {
    const i = s.indexOf(ANCHOR)
    if (i < 0) return { file, skipped: '找不到 fetch_audio 锚点（上游可能改结构了）' }
    // [本机补丁 · 修正] 原实现直接跳到 `def main(`，把 fetch_audio 与 main 之间的
    //   transcribe 段一起吞掉了（补丁 ② 因此永远匹配不到）。⇒ 只砍到 fetch_audio 的
    //   下一个顶层 `def ` 之前，中段原样保留。
    const rest = s.slice(i)
    const nextTopDef = rest.slice(1).search(/\ndef |\nasync def /)
    if (nextTopDef < 0) return { file, skipped: '找不到 fetch_audio 的下一个顶层 def' }
    s = s.slice(0, i) + NEW_FETCH + rest.slice(nextTopDef + 1)
    changed = true
  }
  // ② 换 transcribe 入参
  // [本机补丁 · 修正1] 原正则 /segments, _info = model\.transcribe\(\s*\n\s*src,/ 会把
  //   `src` 前面的缩进一并吃进匹配，替换后 NEW_TRANSCRIBE 的缩进叠在行首 ⇒ IndentationError。
  // [本机补丁 · 修正2] 上游 asr.py 是 **CRLF** 换行，纯 '\n' 锚点永远匹配不到
  //   （2026-10-25 实测：整段 ② 静默不生效）。⇒ 锚点按 \r?\n 写，或用归一化后的文本做判断。
  const legacyTranscribe = /segments, _info = model\.transcribe\(\r?\n {12}src,/
  if (legacyTranscribe.test(s) && !s.includes('audio_input = src')) {
    s = s.replace(legacyTranscribe, NEW_TRANSCRIBE)
    changed = true
  }
  // ③ 补 import asyncio
  if (!/^import asyncio$/m.test(s)) {
    s = s.replace(/^import argparse$/m, 'import argparse\nimport asyncio')
    changed = true
  }
  if (!changed) return { file, skipped: '结构对不上，未改' }
  // ④ 换行归一：上游是 CRLF、补丁模板是 LF，混用会让 diff 很难看。
  //    原来就是 CRLF 的文件统一回 CRLF。
  if (s.includes('\r\n')) s = s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  if (!DRY) writeFileSync(file, s, 'utf8')
  return { file, patched: true }
}

/**
 * 2.2.0 直接把本脚本追加到包目录并写 preinstall，把"升级后补丁还在"这件事焊死。
 * - patch-asr.mjs 本体放进包里（已打补丁就不再改动，幂等）
 * - runner（package-patch.mjs）由本脚本生成
 * - 不碰 index.js / cordis.patch.yml，插件本身逻辑一行不改
 */
function ensureHookAt(dir) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return '（包目录里没有 package.json，跳过）'
  try {
    const runFile = join(dir, 'package-patch.mjs')
    const selfFile = join(dir, 'patch-asr.mjs')
    const selfHere = fileURLToPath(import.meta.url)
    if (!DRY) {
      if (!existsSync(runFile)) writeFileSync(runFile, HOOK_SOURCE, 'utf8')
      // 自己不在包目录里（从家目录被调起）就复制一份进去，浏览器更新插件时才能自动补回
      if (!existsSync(selfFile)) writeFileSync(selfFile, readFileSync(selfHere, 'utf8'), 'utf8')
    }
    // lib/asr.py 需要打补丁但本次 targets 可能没包含它（脚本从家目录跑时）
    const libAsr = join(dir, 'lib', 'asr.py')
    if (existsSync(libAsr) && !readFileSync(libAsr, 'utf8').includes(MARK)) {
      const r = patchOne(libAsr)
      if (r.patched) console.log('[patch-asr] 已补：' + libAsr)
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.scripts && pkg.scripts.preinstall) return '已有 preinstall'
    pkg.scripts = Object.assign({}, pkg.scripts || {}, { preinstall: 'node package-patch.mjs' })
    if (!DRY) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    return '已写入 preinstall'
  } catch (e) {
    return '写钩子失败：' + e.message
  }
}

const targets = []
const homeAsr = join(HOME_DIR, 'asr.py')
if (existsSync(homeAsr)) targets.push(homeAsr)
const up = upstreamAsr()
if (up) targets.push(up)
// 兜底：从家目录被调起时，按 pnpm 的布局往上找包目录
//   （家目录是 ~/.dsh/bili-duty，profile 里的包在 ~/.dsh/profiles/web/node_modules/…）
const profileGuess = join(HERE, '..', 'node_modules', 'dsh-bili-scroll', 'lib', 'asr.py')
if (!up && existsSync(profileGuess)) targets.push(profileGuess)

// 2.2.0 起：钩子焊在包目录里（家目录 / 包目录 / 各 profile 三种位置都认）
const pkgDirCandidates = [
  HERE,
  join(HERE, '..', 'node_modules', 'dsh-bili-scroll'),
  join(HERE, '..', 'profiles', 'web', 'node_modules', 'dsh-bili-scroll'),
  ...(existsSync(join(HERE, '..', 'profiles'))
    ? readdirSync(join(HERE, '..', 'profiles')).map((p) =>
        join(HERE, '..', 'profiles', p, 'node_modules', 'dsh-bili-scroll'))
    : []),
]
const pkgDir = pkgDirCandidates.find((d) => existsSync(join(d, 'index.js')) && existsSync(join(d, 'package.json')))
const libAsrOfPkg = pkgDir ? join(pkgDir, 'lib', 'asr.py') : null
if (libAsrOfPkg && existsSync(libAsrOfPkg) && !targets.includes(libAsrOfPkg)) targets.push(libAsrOfPkg)

if (!targets.length && !pkgDir) {
  console.error('[patch-asr] 没找到 asr.py，也没找到插件包目录')
  process.exit(0)
}

let ok = 0
for (const t of targets) {
  const r = patchOne(t)
  if (r.patched) { console.log('[patch-asr] 已补：' + t + (DRY ? '（dry）' : '')); ok++ }
  else console.log('[patch-asr] 跳过：' + t + ' —— ' + r.skipped)
}
console.log(`[patch-asr] 完成：${ok} 个文件被补丁`)
// [2026-10-25 决策] 钩子不再默认写入。
//   原因：allowBuilds 不放行 dsh-bili-scroll 时，写进包内的 preinstall 会让 pnpm 报
//   ERR_PNPM_IGNORED_BUILDS；放行又得每次安装批准。两害相权，**保持包干净**，
//   升级后手动跑一次本脚本（一行命令），比在 profile 里埋钩子更可控。
//   仍可用 --hook 显式写回（给确实想要永久自动补的人）。
if (process.argv.includes('--hook') && pkgDir) {
  console.log('[patch-asr] 钩子（' + pkgDir + '）：' + ensureHookAt(pkgDir))
}
