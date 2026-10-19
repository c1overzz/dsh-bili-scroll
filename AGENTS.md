# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-bili-scroll`（中文名「**刷B站**」）：每天替用户刷一轮 B 站 —— 搜、**读字幕原文**判断、写一份日报，特别值得的会发一条评论 **@ 用户**。

## 帮用户安装时，按这个顺序

1. **前提**：机器上有 `Python 3.10+` **或** `uv`（有一个即可）。
   两个都没有**也不用让用户先装** —— 插件点「装依赖」时会**自己下一份 `uv` 到自己的家目录**（免管理员、不用 PATH）；
   只有它自己也下不动时（网络到不了 GitHub / 加速代理 / PyPI 镜像），才需要引导用户手动装。
   · 它是**直连 GitHub → 国内加速代理 → PyPI 镜像**依次试的，并且会**核对官方 sha256** ✓
   · ⚠️ 若用户机器上的**杀软拦了这次下载**：让他把 `%USERPROFILE%\.dsh\bili-duty\bin\` 加白，或干脆自己装 uv / Python 3.10+ ✓
   · ⭐ **万一下载链路都不通**（有用户反馈"桌面版上这条链路经常不通"）：**手动放一份 `uv.exe` 到 `<家目录>\bin\` 就行**
     —— 插件会**用那一份、跳过下载** ✓（他 `PATH` 里本来就有 `uv` 的话，直接用那个 ✓）
2. `dsh plugin --profile web add dsh-bili-scroll`（npm，推荐）
   · 备选：`dsh plugin --profile web add github:c1overzz/dsh-bili-scroll`
   · ⚠️ **升级旧版**：如果用户在设置页看到的按钮叫「**重装依赖**」（不是「**重装主依赖**」），
     说明装的还是 **0.1.0** —— 那一版建 Python 环境时缺一个参数，**依赖装不上、二维码也画不出来**。
     让用户重跑一次上面那条 `add` 就是升级（然后再重启一次）。
3. ⚠️ **提醒用户重启一次 dsh**（必须，bundle 层要重启才组装）。
4. 让用户进 **设置 → 刷B站**：点「**装主依赖**」→ 点「**扫码登录**」（手机扫码，选"记住我 / 长期"）。
   · 装完可以用设置页的「**测一下**」自检：它真跑一次登录检查 + 一次搜索，直接回答"能不能用"。
5. **别擅自打开「自动评论并 @ 你」** —— 那是拿用户的号说话；要用得让用户自己填「要 @ 谁」。

## 荐片模式（0.2.0 新增，装完后可选开）

- 跟「刷B站」共用同一套**主依赖 + 扫码登录**；先按上面第 4 步把环境弄好，再用荐片。
- 开启位置：**设置 → 荐片** —— 打开「荐片总开关」→ 填每天跑的时间点（1–3 个，默认 21:00）→ 选每批条数（默认 4）与深度（默认「中」）。
  - 深度三档：轻（不读字幕）/ 中（入选者才读字幕）/ 深（候选中段都读）；越深越准、越贵。
- 看推荐：**左侧栏底部的 🐟 按钮** → 右侧滑出「荐片」面板；卡片上的 👍/👎/已看过 会进下一轮画像。
- **不要替用户配手机推送**（Server酱³ / ntfy / 企业微信 / webhook 的 URL 里有 key）：让用户自己在「设置 → 荐片」里选通道并粘贴；
  配好后可以用页面里的「发条测试」验证，别拿真推荐去试探。
- **隐私**：浏览历史、兴趣画像、反馈只落在 `<DSH_HOME>/bili-duty/feed/`，不上传；面板与推送里也不会出现账号 / UID / 路径。
- 手动来一批：面板里「现在来一批」，或让 Agent 调 `bili_feed_run`；状态看 `bili_feed_status`，画像看/改 `bili_feed_profile`。
- ⚠️ 一轮荐片要读历史、跑多路召回、精读几条字幕 —— 比「刷B站」一轮贵；建议先只开一个时间点、深度先用「中」。

## ⚠️ 已知环境差异（有用户反馈）

- ⭐⭐ **桌面版 DSH（NEXT）/ 0.2.x 装不起来 —— 已知真 bug，0.1.4 起已修**：0.1.3 及以前装到桌面版上，
  设置页里**根本不出现「刷B站」**，DSH 只留一句 `warning: 1 entry did not activate … failed to import` ✓
  （根因：宿主半 import 的 `@deepseek-ai/schemastery` / `dsh-tools` 是 *optional peer*，而桌面版 profile 是
  `autoInstallPeers: false` ⇒ pnpm 永远不装；`dsh-tools` 自己还带 4 个 peer，光装它也救不回来 ✗）。
  ⇒ **遇到桌面版用户：先让他升级到 0.1.4+**（修法是：不再裸 import `@deepseek-ai/*` ——
  `lib/hostdeps.mjs` 先找宿主那棵树、再退到自己依赖里那份，`defineTool` 拿不到就用**本地等价实现**；
  `schemastery` 也正式进了 `dependencies` ✓）。升级后还不行，要 `duty.log` 里那几行
  （里面会写"宿主依赖是从哪儿取的" ✓）。
- ⭐⭐ **桌面版（Electron / 不是 npm 全局安装）上"跑一轮 0.17 秒就结束、code=0、什么都没干" —— 0.1.6 起已修**
  （issue #5 / #6 / #7，三个人报的）：根因是 Electron 里 spawn 的 node 少了 `ELECTRON_RUN_AS_NODE=1`，
  而且 `dsh` CLI 在桌面版里不在 PATH 上。现在会带那个环境变量、并去应用目录里找 dsh；
  **还找不到就在 `duty.log` 里明说"请在设置里把 dsh 路径指过去"**（不再静默失败）。
  ⇒ 遇到桌面版用户：**先让他升到 0.1.6+**；还跑不起来，就要 `duty.log` 里那几行。
- **桌面版上"自动跑会卡"**：跑那一轮用的是 `dsh --profile headless --patch <overlay> <prompt>` ——
  有用户反馈桌面版上会卡在那儿。**先确认 dsh 版本与 profile**，别硬跑；跑不起来就先只用手动「现在跑一轮」。
- **别让用户自己去装环境** ✗：插件自带一份 uv 与依赖安装能力，先照上面第 1 条处理。

## 仓库结构（改代码时看这里）

- `index.js` —— host 半端：15 个工具（11 个刷B站 + 4 个荐片）+ 谷时定时器 + **荐片定时器** + HTTP 接口（`/api/bili-duty/*` 与 `/api/bili-feed/*`）+ 配置（`config.json` 与 DSH 原生设置页**逐字段对账**：见 `loadCfg` / `saveCfgHost`）+ 两套工具白名单（`mcpWhitelist` 刷B站 / `FEED_TOOLS` 荐片 → `BILI_MCP_TOOLS`）
- `client.js` —— 浏览器半端：两个设置页 section（刷B站 / 荐片）+ **左侧栏 🐟 按钮 + `shell.overlay` 荐片面板**
- `lib/` —— 状态目录与家目录 / 极小的 MCP stdio 客户端 / 扫码登录 / **`hostdeps.mjs`（从宿主树取 `@deepseek-ai/*`，拿不到就退到自己依赖 / 本地等价实现）** / **`verify.mjs`（评论发出后复核）** / **`feed.mjs`（荐片的数据层：历史→摘要/信号、画像、batch 校验、提示词）** / **`push.mjs`（手机推送四通道）**
- `prompts/duty.md` —— 刷B站一轮要做的事（判定口径 + 红线，**用户可以改**）；升级规矩见 `lib/state.mjs` 的 `ensureCharter`（用户改过 ⇒ 保留他那份、新版落 `duty.md.new`）
- `prompts/feed.md` —— 荐片一轮的章程（画像 → 召回 → 精读 → batch JSON；不支持用户改写，升级即覆盖）
- `vendor/bilibili-mcp/` —— 内置的 Python MCP（MIT，AGI_Ananas）+ 本插件补的 6 个荐片召回工具
- `selfcheck.mjs` + `tools/` —— 本地预检：`node selfcheck.mjs`（**现在不用解析钩子了**；`tools/register.mjs` 那条还留着当备份）；荐片另有：`tools/feed-unit.mjs`（纯函数）、`tools/feed-host-test.mjs`（路由/配置）、`tools/feed-e2e-test.mjs`（假 MCP + 假 dsh 的整轮冒烟）、`tools/feed-mcp-smoke.py`（MCP 白名单与字段映射）

## 约定

- 配置与运行数据都在用户的 `$DSH_HOME/bili-duty/`，**不写进插件包目录**
- 谷时窗口按 DeepSeek 官方口径：工作日 9–12 / 14–18 是高峰，其余（含周末）都是谷时
