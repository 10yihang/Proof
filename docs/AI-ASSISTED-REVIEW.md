# AI Change Grouping / AI-assisted Review

2026-09-14。主动 AI 是核心功能；普通 Git 和人工 Review 不依赖 Agent。对应 PRD AI-01—05。

## 使用方式

打开 **Settings → AI Agents**，配置默认 Agent、Codex / Claude Code / 已安装 Codewiz 的 CLI 路径以及可选模型。路径留空自动查找；模型作为本次 CLI 的 `--model` 参数传入，不改变终端配置。**Test CLI** 只检测版本、只读参数和本地登录状态，不调用模型、不验证服务端额度。保存后已有 Review 面板会刷新默认选择。它与 **Agent 观察** 是两个独立入口。


- Local changes 左侧 **AI Group Changes** 根据当前 Diff 生成逻辑分组。没有现有分组时应用结果；已有分组时显示 **Apply groups**。文件侧的选择框可移到其他组、新组或 Ungrouped，组标题旁提供 Rename / Ungroup，顶部支持 Ungroup all。
- 右侧 **Context / AI Review** 切换。选择本机 Coding Agent 后点击 **Review Current Change** 或 **Review All Changes**。Current 对应选中文件所在组；未分组时只分析当前文件。
- 独立 Diff tab 和窗口支持 AI 分组与 AI Review，分析该视图冻结的 base / target；分组独立保存，可手动调整。All 仅覆盖此比较；Current 仅覆盖当前文件。不会把历史比较替换成 Local changes。
- 报告包含 Summary、Overall Risk、Findings、Behavior changes、Missing tests、Review priority。点击 Finding 定位并突出显示对应 Diff 行。AI 输出不触发 `mark_reviewed` / `mark_comparison_reviewed`。
- 每次用户点击才调用 CLI。打开页面、检测安装、刷新 Git、切换文件和收到 Observer 事件都不运行模型。点击动作旁显示 CLI、范围和额度归属，不提供聊天框或 API Key 表单。

## 架构与执行

`crates/proof-core/src/ai` 独立于 `observer`、`adapter`、Hook transport 和会话关联。`agents.rs` 的 `AgentAdapter` 统一登记主动 Provider、程序发现与 Hook 能力，设置页不维护另一份 Agent 列表。`AgentProvider` 的实现是 `CodexProvider` / `ClaudeCodeProvider` / `CodewizProvider`；`PreparedAiTask` 捕获输入，`AgentProgram` 封装来源、身份、信任和 data epoch 校验。Native `run_ai_task` 复用窗口拥有的一次性取消 ticket，在释放 Git 核心 mutex 后运行。

输入是任务说明、Scope、结构化结果要求、真实项目目录和辅助范围清单，通过 stdin 传入。CLI 的 cwd 直接使用真实项目目录，可按需读取项目全部上下文。`input.rs` 只保存 manifest.json 与选定 Diff 的 canonical patches，不复制、过滤或截断项目目录。Agent 使用 git show 查询 HEAD / Index / 固定历史 OID，避免把工作区文件误当成对应版本。Observer Session 不作为输入；CLI 的临时日志可能包含本次输入，因此目录权限为 0700，结束后清理。临时目录保存输出 schema 和 CLI 本次运行的临时文件、状态库、日志；CLI 退出后先将本次新建会话保留到对应 Agent，再回收运行目录。Codex 子进程的运行时目录、`sqlite_home` / `log_dir` 显式指向此处；Claude 使用 `CLAUDE_CODE_TMPDIR`，不会使用其他 Session 的 `/tmp/claude-{uid}`。

本机 CLI 参数依据安装版本 Codex **0.153.4** / Claude Code **2.1.236** 的 `--help` 核对。Proof 不直接调用模型 API，不读取或保存 API Key，也不安装 CLI。沿用本机 CLI 的正常登录；不传 `resume`、`continue`、Session ID，也不修改全局配置。

Codex 调用结构：

```text
codex exec --ignore-user-config --ignore-rules
  --skip-git-repo-check --sandbox danger-full-access --json --color never
  --output-schema <owned-job>/schema.json
  -c features.shell_snapshot=false -c features.hooks=false
  -c features.plugins=false -c features.apps=false
  -c features.multi_agent=false -c features.multi_agent_v2=false
  -c features.memories=false -c features.chronicle=false
  -c features.browser_use=false -c features.browser_use_external=false
  -c features.computer_use=false -c features.image_generation=false
  -c features.in_app_browser=false -c features.in_app_local_automation=false
  -c features.workspace_dependencies=false -c features.skill_mcp_dependency_install=false
  -c features.skill_search=false -c analytics.enabled=false
  -c approval_policy="never" -c web_search="disabled" -c mcp_servers={}
  -c project_doc_max_bytes=0 -c notify=[]
  -c sqlite_home="<owned-job>/state" -c log_dir="<owned-job>/logs" -
```

`danger-full-access` 只在 Proof 已强制施加进程级只读沙箱时使用，避免 macOS 拒绝对子进程再次 sandbox_apply。该参数不代表可修改文件，不能脱离 reading_command 单独调用；真实 CLI 回归验证同一次工具调用可读项目、不可写项目或 Git。探测仍使用无工具子进程环境。

参数逐项传递给 `Command`，不是 shell 字符串。CLI `item.completed` 中最后的 `agent_message` 提供 JSON，必须见到 `turn.completed`；中间解说不是最终结果。配置与能力含义可见 [Codex configuration reference](https://developers.openai.com/codex/config-reference/)。

Claude Code 调用结构：

```text
claude --print --safe-mode --output-format stream-json --verbose
  --tools "Read,Grep,Glob,Bash" --allowedTools "Read,Grep,Glob,Bash"
  --permission-mode plan --disable-slash-commands
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --setting-sources "" --settings '{"disableAllHooks":true}' --no-chrome
  --add-dir <owned-evidence-directory> --json-schema <schema-json>
```

优先解析成功 result 的 `structured_output`，兼容 `result` 中纯 JSON，失败结果不会变成“无 Findings”。`--safe-mode` 保留正常登录且禁用用户扩展，未使用会跳过 OAuth 的 `--bare`。见 [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)。

## 只读与隔离

首个经过验证的执行平台为 macOS 原生 CLI。外层 sandbox-exec 禁止所有文件写入，仅允许本任务私有运行目录和 /dev/null；辅助范围证据位于另一个临时目录，CLI 与子进程都不能修改。原仓库、Git 元数据、其他 Agent 配置 / Session 同样禁止写入。允许 CLI self-exec、系统认证辅助程序和受控的 Shell、读取、搜索、Git 查询可执行文件；用户 Hooks / MCP / Plugins 等扩展仍禁用。取消只终止自有进程组。

不再复制 base / index / workspace 项目视图；ignored 文件、关联文档和超过 4 MiB 的文件仍可由 Agent 按需读取。原项目快照的 256 MiB / 100,000 路径限制已移除。辅助 canonical patches 最多 128 MiB / 20,000 文件侧，现有单文件 Diff 读取保护保留。清单只限定审查对象，不限定项目上下文。历史版本通过固定 Git OID 查询；实时文件可变化，报告附带说明并保留原 Diff token 过期保护。临时范围证据和 CLI 运行目录在任务回收时删除。

搜索固定安装位置 `/opt/homebrew/bin`、`/usr/local/bin` 以及用户 `.local/bin`、`.cargo/bin`、`.npm-global/bin`，不使用仓库内 PATH、shell alias 或 function。解析所有符号链接来源及最终程序目录，复用 `trusted_program_workspace` 检查；启动前和结果返回前核对信任、程序身份及 data epoch。程序身份检测不构成发布者认证。

未知平台、不支持所需参数的 CLI、无法在沙箱下启动的安装、检测到受管理配置时拒绝主动 AI，不绕过策略运行。CLI 缺失、未登录、启动权限、网络、额度限制、参数配置、输出无效、超限、取消、超时都有独立错误，普通 Git 仍正常工作。错误面板可直接进入 AI Agents 设置。

## 数据与校验

- 不再把全部 Patch 塞进提示词，不再使用 500 文件 / 1 MiB 输入门槛。范围证据资源上限见上文；现有单文件 Diff 读取上限继续适用。流式 stdout 最多 32 MiB，没有固定推理时限。stderr 有界，不保存原始日志；Failure details 只展示限长、经过凭据脱敏的错误摘要，包含 Provider、执行阶段和退出码。Bun 的大段源码栈不会进入界面。
- Grouping 输出 `title / summary / files / risk / reviewPriority`。原始结果要求所有 changed path 恰好出现一次；未知路径、重复、遗漏、非法枚举、过长文本拒绝。用户编辑可以留下 Ungrouped 文件。
- Codewiz 的 JSONL 事件流允许夹杂普通 CLI 日志、空白行、CRLF，以及事件行外层的 BOM / ANSI 控制符；分组、Review 和进度展示共用事件行解析。只识别行首 JSON 对象，不从日志正文中提取 JSON；损坏的事件仍拒绝，并仅报告输出行号、JSON 错误类别与列号，不回显原始内容。仍须收到最终 `step_finish(reason=stop)`，随后执行完整的分析状态、分组覆盖和 Finding 校验。
- 分组保存在 SQLite `change_groups`，schema 7；每个 workspace 一份，使用 revision CAS，删除 workspace 后级联删除。无 CLI 仍可编辑分组。过期风险不作为新版本结论，手动保存过期分组时风险改为 unknown。
- Review 输出 `summary / overallRisk / findings / behaviorChanges / missingTests / reviewPriority`。每个 Finding 的 file、Staged / Unstaged 侧、old / new 侧及闭区间 `line..endLine` 的每一行必须在此次原始 Hunk 中验证；不允许跨越未捕获的行。单行可以 start=end，兼容旧结果缺省 endLine 时回退为 line。priority 中的文件也必须属于输入。
- Local 每次读取的 UUID 会改变，比较版本使用 `FileDiff.token`（原始 Patch 与 Git guard 指纹），不能比较新旧 UUID。定位要求 token、path、file side 相同。历史比较额外使用冻结 OID 产生的稳定 comparison ID，避免换 base 后误定位。
- 报告通过已验证任务的 `finish` 写入 SQLite `ai_review_reports`，没有接受前端原始报告的 IPC。写入在事务内重新校验数据 epoch / 仓库信任和任务取消状态；迟到结果不能恢复已删除数据。表为兼容 schema 7 的附加 DDL。
- 以 workspace + local 或冻结的 base / target 查询历史，进入视图恢复最近报告，Review history 可切换此前报告。完整报告按需读取。报告和处理状态保留 180 天，删除仓库本地数据时通过 FK 清理，删除预览计入 Review records。
- `decisions[index]` 是报告内稳定的 Finding 处理状态，值为 pending / accepted / dismissed。报告 ID + index 确定意见，revision CAS 防止多窗口覆盖；同范围窗口事件仅使缓存失效，最终状态重新从 SQLite 读取。采纳不是修复，不改变源码、Git、人工 Reviewed 或 Observer。
- Local changes 和历史 Diff 共用 `DiffView` 内联气泡，显示 old / new 范围，支持折叠、采纳、不采纳、撤销；右侧报告保持相同状态。气泡纳入虚拟列表行高测量，Split 显示于引用行侧。过期报告可读取和记录意向，但不向新代码附着气泡或定位。
- Monaco 会将离屏 view zone 设为 display:none。只测量连接到页面且可见、正高度的评论，保留离屏前的有效尺寸；否则零高度会移除 zone 和 React portal target，导致滚回原位置后评论消失。浏览器回归覆盖单栏与并排滚动恢复和处理状态。
- “导出给 Agent”默认勾选已采纳的 Findings，允许为本次导出重新选择。`review-export.ts` 生成与当前界面语言一致的 Markdown；复制和保存使用同一份预览，保留原始 Finding 文本、文件和行范围。Local changes 标明 staged / unstaged 与 old / new，历史比较标明冻结的 base / target OID。过期结果附带重新核对提示；报告级未选建议不加入任务。
- 文件保存通过 `save_review_instructions` 原生命令：输出路径只来自 Save 对话框，打开对话框前后验证 data epoch、报告归属与 revision；临时文件完整写入后原子替换用户确认的目标。取消返回 null，失败保留预览。复制/导出不运行 CLI，不改变处理状态、Reviewed、Observer 或 Git。
- 退出 / 重启、切视图不会启动模型。只有用户点击 Review 再产生新报告；关闭视图、数据删除的取消与 generation gate 仍拒绝迟到回复。

## 验证范围

自动测试不运行真实模型。两个 Provider 使用本地编译的假 CLI 验证实际进程调用、stdin、JSON 输出与错误脱敏；另有真实 macOS 沙箱测试，验证禁止写源码、index、HEAD、其他 Session 文件以及禁止终止无关进程。真实 Git 夹具覆盖分组完整性、非法 Finding、Current 的稳定指纹、历史 OID、分组 CAS / 持久化、来源信任和删除后的失效。

UI 覆盖显式触发、改名 / 移动 / 新建 / 取消分组、已有分组不被覆盖、报告定位 / 过期、独立历史比较以及缺失 CLI 降级；截图验证中心 Diff 和右侧报告布局。具体运行结果见 `.artifacts/ai-core/` 与 `IMPLEMENTATION.md`。真实模型质量、用户现有登录下的在线推理未在自动测试中验证，也未消耗模型额度。

## 全量回归发现的 Git 修复

既有文件级 Stage 将 index 复制到临时目录时赋予新 mtime，可能把相同长度 / 缓存时间戳的修改误当未变化。复现夹具先证明 staged blob 仍为旧内容（`stage-red.log`），修复为保留真实 index 的 mtime，保留 Git 的内容复核条件；`stage-green.log` 验证新内容被正确 Stage。此规则与 [Git racy-stat 文档](https://git-scm.com/docs/racy-git) 一致。修改只涉及私有 index 的时间戳，不改变用户文件内容。

## 2026-09-14 真实 CLI 启动修复

原始实际启动在 Codex 0.153.4 返回 `failed to initialize in-process app-server client: Operation not permitted`；Claude 2.1.236 首先因 `/tmp/claude-502` 创建被拒绝，再因 `security` 启动被拒绝而失败。根因是把 CLI 自身的运行时初始化和模型工具权限混在了一起，之前的假 CLI 不能暴露这两类原生依赖。

已将 Codex 状态库 / 日志、Claude 专用临时文件隔离到本次 job，并允许 Claude 的系统认证辅助程序。保留用户目录、项目和 Git 状态的文件写入限制及模型工具禁用。参考 [Codex runtime directory options](https://developers.openai.com/codex/config-reference/) 和 [Claude Code temporary directory](https://code.claude.com/docs/en/env-vars)。

增加真实 CLI 的可选回归：版本 / 本地登录检测，以及在 OS 禁止 IP 联网时启动真实 Codex，验证其在私有目录创建运行时 SQLite。此次两个真实 CLI 测试已显式运行通过：Codex 本地登录为 true，Claude Code 为 false。未执行在线模型推理。UI 覆盖设置保存 / 重读、默认选择刷新、无模型登录检测，以及错误详情到设置的跳转。结果位于 `.artifacts/ai-settings/`。


## 2026-09-14：完整初始化修复与版本兼容

用户实际报错是 Codex `analysis` 阶段的 app-server 初始化权限错误。之前仅验证 SQLite 创建的断网测试不够：Codex 后续会以读写方式打开安装身份文件，见 [Codex installation_id 实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/installation_id.rs)。

现在每个主动任务为 Codex 子进程配置独立的 `<job>/codex` 运行时目录。共享 CLI 目录中的 `auth.json` 仅通过符号链接供 CLI 读取；Proof 不读取、复制或记录凭据内容。沙箱解析链接后的真实路径，仍禁止修改共享登录文件、配置、Session 和 Git。父进程环境不改变，任务退出时删除私有目录。Codex 仅使用 Keychain 存储且没有 `auth.json` 的登录暂不支持该隔离方式；Test CLI 通过同一运行环境检查。CLI 如果需要刷新登录文件，应先在终端完成登录刷新，不放开共享目录写权限。

主动调用没有固定版本号白名单，缺失必要参数时列出具体参数。可选功能使用 `-c features.<name>=false`，避免 `--disable` 遇到该版本不存在的功能名直接退出。Passive Hook 的版本策略独立，见 OBSERVATION.md。

新增 opt-in 回归运行真实已安装 Codex：合成共享目录复现旧方式失败，私有运行时完整启动，通过 loopback 模拟响应返回最终结构化 JSON；禁止远程 IP 网络且不提供用户凭据。另有真实 sandbox 测试验证登录链接可读但不可写，其他 Session/config/installation_id 不变，目录清理不会删除源登录文件。分组栏现在直接显示 Failure details，无需切到 AI Review。


## 2026-09-15：按需读取与真实活动

两个 Provider 统一输出准备、启动、读取、搜索、Git 查询、命令运行和结果校验活动。Codex 从 JSONL item 事件提取；Claude 从 stream-json tool_use / tool_result 提取。内部 reasoning、自然语言思考、原始命令 / 参数及工具输出不发到 UI。流按块增量解析，单个事件超过 2 MiB 不用于进度展示；最终结果仍独立验证，不能用进度判断成功。

桌面向发起窗口发送 proof://ai-progress，携带原生一次性 read ticket。前端先监听后启动，按 ticket 和 data generation 过滤，完成 / 失败 / 取消解除监听。分组、Review 和独立 Diff 共用 AiTaskProgress，显示当前操作、路径、运行时长、最近 40 条活动以及取消状态。15 秒无事件只提示等待，不假报进度或宣告卡死。

回归包含 >1 MiB 真实 Patch、分离的 staged / unstaged Patch、根 Commit、ignored 与大文件上下文可读、外部编辑实时可见且 canonical patches 保持稳定、工具输出在进程结束前触发取消，以及窗口 / 任务事件隔离。真实 Codex 使用回环模型协议夹具验证原生工具读取和写入拒绝，不使用用户凭据、远程模型或额度。

项目上下文由 Agent 在真实目录中按需读取，Proof 不再预先枚举并复制完整项目。所选 Diff 的 canonical patches 保留原始文件路径、侧和行号，供最终结果验证。


## 2026-09-15：Code Mode host 与分析结果状态

保留 Codex 的 Code Mode / host 默认能力。当前部分模型在内置目录中标为 code_mode_only，即使关闭 code_mode 开关仍会通过 exec 使用 host；不得把这些运行依赖当作用户扩展禁用。只允许启动所选 CLI 同一安装目录中的 codex-code-mode-host，核对程序身份并拒绝跳出安装目录的符号链接；CLI、host 和工具仍受同一个进程级只读沙箱约束。

回归同时覆盖原有直接 Shell 模式和使用本机 gpt-6-astra 目录元数据的 Code Mode exec → exec_command → manifest.json 读取。该测试使用本机模拟响应、合成快照和禁止远程网络的运行环境；没有访问真实模型或使用用户凭据。原来的 proof-fixture 模型名使用 fallback 工具元数据，不能覆盖 Code Mode-only 模型，这项证据限制已补齐。

主动 Grouping / Review 的最终结构化输出必须包含 analysisStatus（completed / blocked）和 blockers。无法读取 manifest 或 canonical patches 时必须返回 blocked；后端返回 AI_ANALYSIS_BLOCKED，不保存为空的成功 Review、不应用分组。缺少状态或 completed 携带 blockers 都视为无效输出。CLI 流中已明确报告 Code Mode 不可用时，即使后续 turn.completed 也返回 AI_TOOL_UNAVAILABLE。历史报告结构不变。

`AgentReadContext` 明确区分真实项目目录、不可写的任务证据目录与选定路径。Claude 仅为本次任务传入 `--add-dir`，Codewiz 仅允许该证据路径的 external_directory 读取；其他目录保持默认拒绝，macOS 沙箱对项目和证据的写入拒绝不变。真实 Codewiz 回归使用 Read 工具读取项目外的辅助清单、Bash 读取项目文件并尝试写入，同时在项目内放置可观察的插件，确认主动分析不会加载它。


## 2026-09-16：个性化 Prompt、AI Commit 与原生会话

Settings → AI Agents 为 Grouping、Review、Commit 各提供独立 Prompt。三项共用现有设置 revision CAS，旧配置默认空字符串、旧客户端保存时不清空新字段。留空使用内置规则；可单独恢复默认。每项最多 16,000 UTF-8 bytes，支持多行，拒绝无效控制字符。保存和切换任务不会运行模型；任务准备时捕获已保存的 Prompt，不受生成期间再次修改设置影响。自定义语言、风格和重点可覆盖默认表达方式，但不改变只读权限、Git 范围和输出 schema。

Commit 页的 **AI Commit** 仅生成 message：正常模式仅使用完整 Index 的 Staged Diff，未 Stage 时提示先选择提交内容；Amend 则结合固定 HEAD 的原始 Commit 与 Staged 增量，允许仅重写已有 Commit 的说明。返回 `{analysisStatus, blockers, message}`，不 Stage、不 Commit、不改变 Review 状态。空且未改动的草稿直接填入；已有草稿或生成期间手动输入的内容保留，点击“使用此说明”才替换。支持活动、取消、失败详情与模型选择。原生返回时重新核对 Git token；前端范围切换或刷新也取消并丢弃迟到结果。

每次模型调用仍新建独立会话，但不再传 Codex `--ephemeral`、`history.persistence=none` 或 Claude `--no-session-persistence`。Agent 推理过程仍在同一个只读沙箱内，其他终端的 Session 不可写。退出后由宿主将本次原生会话交付给对应 CLI：

- Codex：原子、不覆盖地保存自己的 rollout JSONL，并将自己的 thread row 添加到原生 SQLite 索引，不复制私有库的 Project / Sidebar ID。保存的后续执行策略规范为 `read-only` / `on-request`，防止外层沙箱使用的内部 bypass 参数在普通 CLI resume 时泄漏成权限。
- Claude Code：为本次运行使用私有 `CLAUDE_CONFIG_DIR`；本地凭据文件只读链接，并通过原有 `CLAUDE_SECURESTORAGE_CONFIG_DIR` 命名空间保持 Keychain 登录，避免私有 `CLAUDE_CONFIG_DIR` 改变凭据服务名。结束后仅复制这次 Session 的 JSONL，不复制凭据。可使用明确 Session ID 继续。
- Codewiz：调用原生 `export <sessionID>` / `import <file>`。导入过程断网，日志、配置和缓存仍私有，只允许其原生 SQLite 与 journal / WAL 文件写入；已有 ID 拒绝覆盖，导入后读取数据库确认；不把依赖外层沙箱的临时 Bash 权限带入后续普通 CLI 会话。不是直接拼接用户的 Session 数据库。

结果提供复制 CLI 恢复命令的入口。原生 CLI 管理这些会话；清除 Proof 数据不会删除它们。Codex 默认 picker 可能需 `--include-non-interactive`；Claude 的 print 会话按原生规则通过 `--resume <session-id>` 继续，而不一定出现在默认 picker，见 [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) 和 [Claude sessions](https://code.claude.com/docs/en/sessions)。

本机 Codewiz 0.1.99 的原生 export 曾在退出前只向管道写出 1024 bytes。主动分析和 export 现在使用权限 0600 的专用文件作为 stdout，由同一个受限进程循环持续读取；保留实时活动、输出上限与取消，退出后读完最后一个事件。真实回环测试覆盖 32 KB 最终结果、完整会话导入以及已有 ID 防覆盖，不使用公司模型或额度。
