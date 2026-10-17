# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-bili-scroll`（中文名「**刷B站**」）：每天替用户刷一轮 B 站 —— 搜、**读字幕原文**判断、写一份日报，特别值得的会发一条评论 **@ 用户**。

## 帮用户安装时，按这个顺序

1. **前提**：机器上有 `Python 3.10+` **或** `uv`（有一个即可）。
   两个都没有**也不用让用户先装** —— 插件点「装依赖」时会**自己下一份 `uv` 到自己的数据目录**（免管理员、不用 PATH）；
   只有它自己也下不动时（网络到不了 GitHub / 加速代理 / PyPI 镜像），才需要引导用户手动装。
   · 它是**直连 GitHub → 国内加速代理 → PyPI 镜像**依次试的，并且会**核对官方 sha256** ✓
   · ⚠️ **Windows** 上若杀软拦了这次下载：让他把 `%USERPROFILE%\.dsh\bili-duty\bin\` 加白，或干脆自己装 uv / Python 3.10+ ✓
   · ⭐ **万一下载链路都不通**（有用户反馈"桌面版上这条链路经常不通"）：**手动放一份 uv 到 `<数据目录>/bin/` 就行**
     （Windows 是 `uv.exe`，Linux / macOS 是 `uv`）
     —— 插件会**优先用那里那一份**，跳过下载 ✓
2. `dsh plugin --profile web add dsh-bili-scroll`（npm，推荐）
   · 备选：`dsh plugin --profile web add github:c1overzz/dsh-bili-scroll`
   · ⚠️ **升级旧版**：如果用户在设置页看到的按钮叫「**重装依赖**」（不是「**重装主依赖**」），
     说明装的还是 **0.1.0** —— 那一版建 Python 环境时缺一个参数，**依赖装不上、二维码也画不出来**。
     让用户重跑一次上面那条 `add` 就是升级（然后再重启一次）。
3. ⚠️ **提醒用户重启一次 dsh**（必须，bundle 层要重启才组装）。
4. 让用户进 **设置 → 刷B站**：点「**装主依赖**」→ 点「**扫码登录**」（手机扫码，选"记住我 / 长期"）。
   · 装完可以用设置页的「**测一下**」自检：它真跑一次登录检查 + 一次搜索，直接回答"能不能用"。
5. **别擅自打开「自动评论并 @ 你」** —— 那是拿用户的号说话；要用得让用户自己填「要 @ 谁」。

## ⚠️ 已知环境差异（有用户反馈）

- ⭐⭐ **桌面版 DSH（NEXT）/ 0.2.x 装不起来 —— 已知真 bug，0.1.4 起已修**：0.1.3 及以前装到桌面版上，
  设置页里**根本不出现「刷B站」**，DSH 只留一句 `warning: 1 entry did not activate … failed to import` ✓
  （根因：宿主半 import 的 `@deepseek-ai/schemastery` / `dsh-tools` 是 *optional peer*，而桌面版 profile 是
  `autoInstallPeers: false` ⇒ pnpm 永远不装；`dsh-tools` 自己还带 4 个 peer，光装它也救不回来 ✗）。
  ⇒ **遇到桌面版用户：先让他升级到 0.1.4+**（修法是：不再裸 import `@deepseek-ai/*` ——
  `lib/hostdeps.mjs` 先找宿主那棵树、再退到自己依赖里那份，`defineTool` 拿不到就用**本地等价实现**；
  `schemastery` 也正式进了 `dependencies` ✓）。升级后还不行，要 `duty.log` 里那几行
  （里面会写"宿主依赖是从哪儿取的" ✓）。
- **桌面版上"自动跑会卡"**：跑那一轮用的是 `dsh --profile headless --patch <overlay> <prompt>` ——
  有用户反馈桌面版上会卡在那儿。**先确认 dsh 版本与 profile**，别硬跑；跑不起来就先只用手动「现在跑一轮」。
- **别让用户自己去装环境** ✗：插件自带一份 uv 与依赖安装能力，先照上面第 1 条处理。

## 仓库结构（改代码时看这里）

- `index.js` —— host 半端：12 个工具 + 时段定时器 + HTTP 接口 + 设置命名空间
  · 里面有一节「跨平台的那点基础设施」（`whichSync` / `asCommand` / `resolvePy`），**改命令之前先读它**
- `client.js` —— 浏览器半端：设置页（注册在 `settings.section`），四个标签
  `设置 / 报告 / 人格 / 调试`
  · ⭐ 「人格」页是**唯一那个人格文件的编辑器**（看 + 改 + 存），下面再摊开
    「每轮真发出去的话」分成哪两段。数据来自 `GET/POST /api/bili-duty/persona`
    与 `GET /api/bili-duty/prompt` —— 提示词是插件行为的全部依据，**不该让人猜** ✗
- `lib/` —— 数据目录（`stateDir`，配置 / 报告 / 凭证都在这儿）/ 极小的 MCP stdio 客户端 / 扫码登录 / **`hostdeps.mjs`（从宿主树取 `@deepseek-ai/*`，拿不到就退到自己依赖 / 本地等价实现）** / **`verify.mjs`（评论发出后复核）**
- `prompts/duty.md` —— 一轮要做的事（判定口径 + 红线，**用户可以改**）
  · 🔴 **这份只写业务，一个字都不许写性格** ✗ —— 人格只有一个人格文件（见下）。
    （2026-10-18 踩过：把「可爱 + 颜文字」那节当成"漏发"补进仓库，实际那是使用者
    **只要自己用**的口味，等于强加给每一个装插件的人 ✗。）
- `vendor/bilibili-mcp/` —— 内置的 Python MCP（MIT，AGI_Ananas）
- `selfcheck.mjs` + `tools/` —— 本地预检：`node selfcheck.mjs`（**现在不用解析钩子了**；`tools/register.mjs` 那条还留着当备份）
- `window-smoke.mjs` / `route-smoke.mjs` —— 时段工具的单测、以及把宿主端那几条 HTTP 路由**真调一遍**
  · ⭐ **接缝也要验**：`DUMP_FILES=<路径> node route-smoke.mjs` 把真响应写出来，
    再 `FILES_JSON=<那份> node ui-smoke.mjs client.js` 让前端吃**真数据** ——
    光验前端（假夹具）+ 光验后端（真路由）是不够的 ✗

## 跨平台（**这个插件两头都要能用**）

它一开始是照着 Windows 上的 dsh 写的，到 Linux 上出过**整条路走不通**的事故，所以：

- 🔴 **别写死某一个平台的命令**。典型翻车：`python`（Linux 多数发行版**只有 `python3`**，
  直接写 `python` ⇒ 二维码画不出来、内部 MCP 起不来）；`cmd.exe /c`（升级流程在 Linux 上必然失败）。
- 找可执行文件用 `resolveDsh()`：它按 **设置 → `process.argv[1]`（宿主进程自己）→ PATH 扫描
  → 从 node 位置推** 的顺序来，**不猜安装布局**（nvm / `.npm-global` / `%APPDATA%\npm` 都能命中）。
- 找 Python 用 `resolvePy()`（异步）/ `pyPathSync()`（同步那把）：设置里写的 → 自己建的 venv → `python3` → `python`。
- 起进程一律**别自己拼 `shell`**：把 `shell` 交给 `spawn`（它自己知道该用 `cmd.exe` 还是 `/bin/sh`），
  `.cmd` / `.bat` 必须走 shell、`.exe` 直接 exec、其余用 `node <它>`（见 `asCommand`）。
- 「打开文件夹」这类**只有桌面才存在**的功能：有桌面就调系统程序，**没有桌面（服务器 / NAS）
  就把目录列在设置页里**（`/files` → `/file` → `/download` 三个接口）—— 不许只回一句"做不到" ✗。
  ⚠️ 那条路径读接口**只认单层安全文件名**（`safeName` 挡 `../`、绝对路径、盘符），改之前先想清楚。

## 约定

- 配置与运行数据都在用户的 `$DSH_HOME/bili-duty/`，**不写进插件包目录**
- ⭐⭐ **人格只能有一个来源**（2026-10-18 定）：**唯一那个 md 文件** ——
  默认 `<数据目录>/persona.md`，位置由 `cfg.personaFile` 指定（设置页里可填、可直接编辑）。
  · 🔴 **不许再把性格写进 `index.js` / 章程 / 别的地方** ✗。曾经散在三处
    （代码里写死一段、章程里一节、还会去读工作区的 `AGENTS.md`），
    改一处漏一处，而且**装插件的人会拿到别人写的性格** ✗。
  · 文件不存在或为空 ⇒ 这一轮**就没有人格设定**（插件自身**不带**任何性格）——
    这时提示词里一个性格词都不该有 ✓（`route-smoke` 有断言钉着）。
  · 其余提示词一律**只为业务服务**：讲清这一轮要干什么、有哪些约束就够了 ✓
  · ⚠️ 「别套用你默认的人格」那句只在**真有人格文件时**才说 —— 没有文件时说这句
    本身就是一句性格指令 ✗
- 时段（`cfg.windows`，`"HH:MM-HH:MM"` 字符串数组）：**非空就接管**，空了才回落到内置的 noon / night。
  内置那两组按 DeepSeek 官方口径：工作日 9–12 / 14–18 是高峰，其余（含周末）都是谷时。
  ⚠️ 「这一场跑过没有」按**覆盖块**记（`windowBlocks` + `blockAt`，见 `lib/state.mjs` 里那段长注释）：
  互相重叠的时段算同一场、跨零点的算作开始那天那一场 —— 否则重叠会一小时刷两轮 ✗
