# bili-duty · 值班轮最小权限 profile（模板）

「刷B站」插件的**后台值班轮**专用 profile。原样拷贝到 `%USERPROFILE%\.dsh\profiles\bili-duty\`
（或 `$DSH_HOME/profiles/bili-duty/`），再把插件配置里的 `headlessProfile` 指向 `bili-duty`。

- 组成：`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + 本目录 `cordis.patch.yml` 一层禁用。
- **禁用**：tool-fs / tool-fs-search / tool-working-directory / tool-bash / tool-pwsh / tool-jobs /
  tool-web / web-fetch-http / tool-subagent* / workflow-ptc / tool-workflow / skill / skill-filesystem /
  tool-skill / tool-plugin-manager / plugin-manager / hmr / goal* / command-goal / tool-goal /
  plan-mode / tool-todo / agent-instructions / mcp-resources。
- **补开**：credentials / authorization / deepseek-account（headless 默认关了，值班轮要用账号模型）。
- 这一轮能用的只有：插件的 B站 MCP 工具 + 插件自己注入的值班 IO（duty_state / duty_report_append /
  duty_seen_append / duty_comment_append / duty_digest_append / bili_transcribe）。

> 为什么：DSH 沙箱只限制"写"、不限制"读"。stock headless profile 会把整台电脑（任意读写文件、
  任意命令、任意 URL 抓取、子代理）交给一个无人值守的 agent ⇒ 它能读 `~/.dsh/sessions/**`
  （全部会话记录）和凭证；而插件的 B站 MCP 跑在沙箱外，是现成的外发通道。
  修法不是"叮嘱它别读"，而是**不给它文件系统**，写日报/判重表/归档改走固定路径的窄口 MCP 函数。
  详见仓库 `patches/` 和顶层 README。
