# Proof 实施与验收记录


## 2026-09-15｜UI 组件迁移

采用 Tailwind CSS 4、shadcn / Base UI 统一控件、主题、菜单、弹窗和通知；只读 Monaco 接入 Local changes 与历史 Diff 共用工作区。面板使用 react-resizable-panels，逻辑分组和 Diff tab 使用 dnd kit，窗口 UI 状态使用 Zustand，快捷键与微动画分别接入 react-hotkeys-hook 和 Motion。

Git 原始 Hunk、Stage / Commit / Amend 与 Review 数据仍由原有核心管理。修复了模型初始化覆盖阅读书签、浮层点击/尺寸、复合控件继承禁用状态，以及拖动排序与窗口状态不同步的问题。完整 UI 98、前端单元 60、Rust 255、重复位置恢复 30、生产 CSP 1 项通过；lint、typecheck、cargo check、Clippy 和 macOS release 构建通过。5 项既有 Rust opt-in 测试未执行。当前包未启动原生 GUI，不能把 headless 验证当作本轮 WebView/OS 实机验收。详情见 `UI-MIGRATION.md`，构建记录见 `.artifacts/latest-build.json`。

## 当前推进 · 2026-09-14 Agent 启动修复与设置

真实 CLI 复现确认：Codex 状态库初始化被只读边界拦截；Claude 的专用临时目录和系统钥匙串读取辅助程序受限。已修复运行时隔离，补充 Settings → AI Agents（默认 Provider、CLI 路径、模型、Test CLI），失败详情按权限 / 登录 / 网络 / 额度 / 参数分类并脱敏，提供直达设置入口。

真实 Codex / Claude 版本和本地登录探测，以及禁止 IP 联网下的 Codex 初始化回归已通过。当前检测 Codex 已有本地登录，Claude 未登录；没有执行模型推理。原生和 UI 证据见 `.artifacts/ai-settings/`，详细行为见 `AI-ASSISTED-REVIEW.md`。

## 当前推进 · 2026-09-14 主动 AI 分组与辅助审查

已接入本机 Codex / Claude Code 的统一 AgentProvider、只读沙箱、分组编辑与 CAS、All / Current Review、基于真实 Diff 指纹的 Findings 定位与过期提示。独立 Diff tab 保持冻结比较范围。Passive Observer、人工 Reviewed、Git 写动作保持独立；无 CLI 仍可人工分组和使用普通 Git。PRD AI-01—05 已提升为 P0 核心功能。实现、调用参数和验证边界见 `AI-ASSISTED-REVIEW.md`。

新增测试先揭示并修复 Current Review / Finding 错用易变 UUID 的问题；来源检查包含符号链接经过的未信任仓库；切仓库重置保存中状态。全量 Git 回归另外稳定复现了私有 index 时间戳引起的 Stage 漏改，已保留源 index mtime 并加回归。

## 当前推进 · 2026-09-14 原生 Git 阅读与失败重试

已用隔离 macOS Release 验证文件历史/Blame 的 Worktree、指定 Commit、重命名前路径、分页和返回全文第 250 行；真实 TextEdit 选择、打开、保存后自动刷新；单 Hunk 丢弃/恢复与存在新编辑时的拒绝。逐步骤文件、Index、HEAD、Git 配置和 Review 记录核对见 `NATIVE-GIT-READING.md`。

修复文件历史同版本/同路径失败后点“读取”不触发请求的问题，补齐独立历史/Blame 错误与重试。聚焦红/绿回归、完整 UI 70 条、类型和格式通过，两轴无剩余发现。新版原生应用通过真实 FILE_MISSING 恢复和第二页失败后保留 401–500 行位置。见 `CODE-REVIEW-21.md` 与 `.artifacts/file-history-native-01/native-acceptance.json`。

更新包为 `.artifacts/builds/52aaf2a-file-history-retry-worktree/Proof-macOS-arm64.zip`，仅 2 个构建输入变化。Rust、模型和 Clippy 输入未变，沿用上一轮验证；本轮没有重复声称运行它们。完整 P0、Windows、全键盘/200% 缩放及完整 NFR 仍未完成。

## 当前推进 · 2026-09-14 Local changes 与显式 Review

Changes 更名 Local changes；上下文改为每次一行的 − / +，Full file 单独常驻。历史 Commit/Branch Diff 可按 Hunk/文件显式 Review 和撤销；Commit/Amend、生成提交说明不会产生 Review 结论。多 tab 迟到回复、跨比较方向缓存、读取期间隐藏 tab 三项复核发现关闭。见 `LOCAL-CHANGES-AND-REVIEW.md` 和 `CODE-REVIEW-20.md`。

完整 Rust 213、前端 41、完整 UI 68 条通过，2 条 Rust opt-in 未执行。最终原生验收发现并修复 macOS 自动更正代码搜索词，额外 8 条阅读 UI 和实际输入/失焦复验通过。隔离原生窗口验证全文搜索、上下文行数、历史 Review/撤销；Git 文件、Index、HEAD 和配置保持。构建包归档于 `.artifacts/builds/52aaf2a-context-review-worktree/`，来源和验证范围见 `.artifacts/latest-build.json`。完整 P0 和全资源预算仍未完成。

此前空闲候选现已完成原生后测：主进程与已回收子进程 CPU 下界由 8.79% 降至 0.386% 单核，且真实文件保存/原子替换能自动刷新。它不包含 WebKit XPC 等单独归属进程，也不自动适用于后续二进制，详情见 `IDLE-REFRESH.md`。

## 当前推进 · 2026-09-14 完整文件阅读

Changes 与独立历史 Diff 已接入 Full file 范围及搜索；上下文有界读取、取消、原 Hunk 保持、全文范围和源行书签恢复均已补齐。完整 Rust 211、前端 40、完整 UI 62 项通过，实际 Git 工作流已启用，两轴发现关闭。见 `FULL-FILE-READING.md` 与 `CODE-REVIEW-19.md`。本轮原生全文与 Release 构建验收仍在推进，完整 P0 保持未完成。

## 当前推进 · 2026-09-14 空闲刷新

实际旧 Release 在 1,002 变化文件夹具静置后测到 CPU 下界 8.79% 单核，主要来自周期性 Git 查询。已改为健康监听触发刷新、30 秒核对遗漏，监听失败时恢复 1.2 秒轮询，并补齐连续事件、busy/hidden、瞬时失败恢复和标签关闭焦点边界。前端 40、UI 52、桌面 8 项通过，候选构建完成。Mac 再次锁屏，原生后测尚未执行，不能宣称 CPU 改善幅度或 NFR-07 达标。见 `IDLE-REFRESH.md` 和 `CODE-REVIEW-18.md`；已交付包仍为上一轮大 Diff 构建。

候选现已单独归档为 `.artifacts/builds/52aaf2a-idle-refresh-candidate-worktree/Proof-macOS-arm64-candidate.zip`，164 个输入、签名及 ZIP CRC 核对通过。元数据明确标记等待原生验收，已核验构建指针保持上一轮大 Diff。

## 最新检查点 · 2026-09-14 大 Diff 与读取取消

已实现摘要/主动加载、内容容量回收、单次只读取消、后台刷新保留加载意图和大历史 Diff 源行恢复；普通 Commit 预览可以包含 Review 未知的超限文件，Strict Review 保持拦截。完整 Rust 205、前端单元 35、完整 UI 47 项通过，最终小补丁另有定向复验。新版隔离 macOS 应用通过真实 Tauri IPC 的大 Diff、取消、后续 Stage/Commit 和历史比较验收，1,003 文件夹具内容及未选择文件保持。见 `LARGE-DIFF.md`、`CODE-REVIEW-17.md`。完整资源压力与其余 P0 验收继续保留；旧标准性能数字仅属于此前构建。

## 最新检查点 · 2026-09-14 独立 Git 读取并发

只读采集按依赖关系并发执行，统一 join 后返回；物理身份、指纹字段与事务发布顺序保持。当前完整 Core 163 项通过，2 项 opt-in 未执行，Core Clippy / 格式及真实 Git UI 回归通过，两轴复核见 `CODE-REVIEW-16.md`。

标准规模每场景 30 次测量的 8 个写入 P95 均通过 500 ms 门禁；File Diff 为 146.33 ms，整文件 Stage 为 394.83 ms，Stage All 为 475.89 ms。采样 Core 进程树最大约 35.8 MiB，范围和单次尾延迟见 `PERFORMANCE.md`。这里不包含原生 UI 点击到绘制，完整 NFR 尚未关闭。

更新包位于 `.artifacts/builds/52aaf2a-parallel-reads-worktree/Proof-macOS-arm64.zip`，149 个构建输入、签名及 ZIP CRC 已核对，构建记录更新于 `.artifacts/latest-build.json`。Mac 仍锁定；下一步继续实现大文件摘要 / 主动加载、容量缓存和只读取消，再完成对应压力与界面验证。

## 最新检查点 · 2026-09-14 单文件捕获与回复版本

File Diff 改为直接取得目标 status 记录，并从同次 guard 获取比较 base；不再生成全量 Changes 的附加信息。保留全局 status 的 rename 语义及原有写入校验。前端补齐 Branch 不匹配时的刷新，以及 Review 回复与发起时文件版本的绑定，避免新内容被旧回复覆盖。真实 Git 与真实 App 调用路径均有 red / green 回归；两轴复核关闭，见 `CODE-REVIEW-15.md`。

同一标准脚本下 File Diff P95 从 273.75 降为 196.93 ms，Reviewed 整文件 Stage 降为 534.84 ms；7 个写入场景仍未满足 500 ms，不能关闭性能目标。完整 Core 160、前端单元 30、最终 UI 40 项通过，UI 含实际 Release Core / Git。详细范围见 `PERFORMANCE.md` 与 `ACCEPTANCE.md`。

当前 macOS 原生窗口验收仍受锁屏影响；后续继续处理性能与完整 P0 缺口。

本地 Release 包已更新为 `.artifacts/builds/52aaf2a-git-capture-worktree/Proof-macOS-arm64.zip`。149 个构建输入核对一致，签名及 ZIP CRC 通过；来源与本轮 / 此前回归的区分记录于 `.artifacts/latest-build.json`。仍为未提交、未公证的 Alpha。

## 最新检查点 · 2026-09-14 标准计时与演示 Parent 修正

标准规模每场景 30 次 Core 计时及逐次内容校验已完成，File Diff P95 为 273.75 ms；7 个 Stage / Unstage 场景仍超过 500 ms。测试脚本扩展并补齐 Index、Worktree、异常回收断言，4 项回归与两轴复核通过。详见 `PERFORMANCE.md`；下一步仍需缩短 Git 读取和写后刷新的等待，不把 Core 数据替代完整界面响应。

演示 Merge Diff 已按所选 Parent 显示起点，浏览器验证两个 Parent 的切换。类型、格式、Release 构建与打包校验通过，新包为 `.artifacts/builds/52aaf2a-desktop-chrome-followup-worktree/Proof-macOS-arm64.zip`。原生窗口受 Mac 锁定影响仍待验收，完整 P0 未完成。

## 最新检查点 · 2026-09-14 Desktop chrome

按用户再次提出的 Fork / GitKraken 参考要求，整理中性灰主题、仓库工具栏与固定 tabs、紧凑文件树和提交图；Diff 继续独立打开，合并重复标题，增加页面快捷键、中键关闭及当前比较的文件搜索。详见 `DESKTOP-CHROME.md`。

macOS 使用 Overlay + hiddenTitle，把系统红黄绿保留在应用顶栏；增加明确拖动区域。原生 File 菜单接管 Cmd+W，活动 Diff 只关闭 tab；原生 About 等面板关闭时不会误作用于后台主窗口。独立弹窗和普通 Commit 输入的快捷键边界均有回归，两轴复核见 `CODE-REVIEW-14.md`。

完整 Rust 190 通过、2 项 opt-in 未执行；最终菜单版本桌面 3 项通过；前端单元 29 通过、最终完整 UI 38 通过（真实 Git 工作流已启用）；类型、Clippy 和格式检查通过。受限沙箱中的一次 FSEvents 失败已在具备文件事件访问的同一测试中通过，不归因为产品修复。

Computer Use 仍检测到 Mac 锁定。原生按钮位置、拖动、全屏、About 与真实菜单快捷键仍待解锁验收；浏览器和菜单事件模拟不能替代它们。Stage 重复读取/退出等待优化已通过功能回归，但最终标准仓库全路径及原生 UI 性能尚未完成。完整 P0 目标保持不变。

## 最新检查点 · 2026-09-14 Context 人工关联修正

已接入 CTX-04：当前文件内管理同 Worktree 的会话关联、备注、解除、恢复和可撤销历史，标注用户来源，保留原始证据。摘要与按需事件分页分开；候选按稳定登记时间使用游标，新活动不吞掉未读候选或已读事件页。缓存按照后端保留期限逐条清理。修正版本覆盖清理和 ABA，All 删除后无需重启。详见 `CONTEXT-ASSOCIATIONS.md`、`CODE-REVIEW-13.md`。

完整 Rust 185/185、前端单元 29/29、UI 36/36 通过，另有 2 条 opt-in 未执行；类型、Clippy、格式与 Release 构建通过。真实 Git/SQLite UI 流程验证关联/备注/撤销及文件、Index、HEAD、配置不变。双轴评审 5 项发现全部关闭。

macOS 安装包已归档于 `.artifacts/builds/52aaf2a-context-worktree/`，构建指纹见 `.artifacts/latest-build.json`。原生点击验收因 Computer Use 服务启动失败尚未完成；隔离应用进程和数据初始化已核对，不能据此宣称原生流程通过。完整 PRD P0 仍需继续，代码和安装包均明确标识未提交的 worktree 状态。

## 此前检查点 · 2026-09-13 本地诊断与存储故障入口

SET-03 已接入设置：默认固定字段的 JSON 诊断、附加类别逐项确认、内存预览与原生 Save 对话框。普通报告绑定原数据代次并在保存期间保护删除顺序；实际只读连接不能绕过保护。Core 无法初始化时仍显示窗口，并可导出不含本地记录的 application_only 报告。详见 `DIAGNOSTICS.md`，独立双轴复核见 `CODE-REVIEW-12.md`。

本轮完整验证：Rust 173 通过、0 失败、2 项 opt-in 未执行；前端单元 29 通过；完整 UI 31 通过，实际 Git 工作流已启用。两组原生调试窗口分别验证正常保存及 Core 初始化失败后的导出，均核对文件内容、权限及源数据保持。独立 Diff tab 另补窄窗口/窗口缩放时完整显示关闭按钮，关闭后返回 History 焦点。

这些结果证明当前增量，不构成完整 PRD 或全平台/完整性能预算的完成声明。

## 最新检查点 · 2026-09-13 Hook、Commit 与 History Diff tabs

按用户最终要求：Changes 专注文件 Diff；Commit/Amend 独立成页；History 选择单个/两个 Commit 或 Branch，在新的可关闭 Diff tab 中阅读文件差异，不要求再次填写比较表单。History 的选择与滚动位置保留，Merge Parent 和比较方向可以调整。详见 `HISTORY-DIFF.md`。

Codex 0.153.4 / macOS 的安装预览、字段/Worktree 授权、暂停、卸载、GUI 生命周期与稳定 Helper 已接入。schema 为 6。Context 显示实际相关会话及截断/重复/退出状态降级；删除记录与 Hook 卸载共用可恢复回执。两轴独立评审已关闭本轮发现，见 `CODE-REVIEW-11.md`。

最终完整 Rust：161 通过、0 失败、2 条 opt-in 跳过；前端模型 29 通过；完整 UI 27 通过，其中 1 条以测试 NDJSON 驱动实际核心/Git，覆盖实时保存、选中 Hunk Commit、Amend、Commit all、History→Diff tab 和本地记录删除。此前桥接启动计时波动这次未复现，但不宣称其根因已修复。

打包后的 Release 应用使用固定隔离启动配置完成原生安装、暂停、卸载；实际 Codex 在 27.333 秒内完成测试，answer.py 从 41 改为 42，App 自动刷新并显示 7 条真实事件。用户 Codex 配置指纹保持不变，临时登录凭据与测试 Hook 凭据已删除，7 条观察记录保留。原生 History 选中两个 Commit 后打开独立 Split Diff，准确显示 40→41，Worktree 的 42 没有混入该比较。证据为 `.artifacts/hook-native-02/model-result.json` 与 `native-acceptance.json`；原生截图已在任务中查看。

类型检查、Clippy、Rust/Prettier 格式与构建通过。最终原生验证后仅移除一处过时的 Context 关联粒度文字，再次完成全量 UI 验收与打包。包使用 ad-hoc 签名，未公证；版本与输入指纹记录于 `.artifacts/latest-build.json`。此检查点不等于整份 PRD 的发布完成：其他 Agent/平台、人工关联修正、诊断导出及完整 NFR 仍需继续。


## 此前实现检查点 · 2026-09-13 Local data

本地数据管理已接入暂停观察、隐藏最近项目、按仓库删除（覆盖 linked Worktree、隔离 clone）及全局清理。schema 升至 5；恢复副本、临时 Index、WAL 和采集运行文件使用可重试清理流程。旧请求、排队设置与跨窗口草稿写入不能重建已删记录。详见 `DATA-MANAGEMENT.md`、`CODE-REVIEW-10.md`。

原生独立应用已验证仓库删除及重新打开：隐藏入口不删记录，确认框仅含 main/linked，删除后 clone 保留，旧 Diff/草稿清空，重新登记的身份未继承信任/Review。SQLite 和三个测试仓库的文件、Index、HEAD、配置核对一致。原生全部记录删除、Windows 清理和诊断导出仍待验收或实现；完整 P0 未完成。

完整 Rust 150 项通过、1 项既有 Observer 启动计时失败、2 条 opt-in 跳过；失败测得总耗时 548.722125 ms，原二进制定向重试通过，但未关闭原因。前端模型 29 项、页面流程 23 项通过，含实际 core/Git 的 Commit、Amend、全部提交和记录删除。类型检查、Clippy、格式检查和前端/Tauri 构建通过；新包是独立 ad-hoc 调试包，构建输入和来源归档于 `.artifacts/latest-build.json`，不是公证发布包。

## 此前实现检查点 · 2026-09-13 External editor

Diff 工具栏及 Command 已接入外部编辑器，设置支持应用默认和仓库覆盖；只在用户点击打开时交给所选应用，打开当前 Worktree 文件。linked Worktree 共享覆盖，独立 clone 隔离，保存后沿用自动刷新。新增 9 条核心与 5 条 UI 回归，两轴评审已关闭，详见 `EXTERNAL-EDITOR.md`、`CODE-REVIEW-09.md`。

完整 Rust 本次为 135 项通过、1 项既有 Observer 计时失败、2 条 opt-in 跳过；失败项定向重试通过但原因未关闭。前端模型 21 项、UI 14 项及实际 Git 流程 1 项通过。Mac 锁屏使实际编辑器窗口与原生选择器待验收；Windows 路径仅有代码实现。本次不是完整 P0 交付。

## 此前实现检查点 · 2026-09-13 Git workflow

顶部 Branch 下拉、Changes 文件树/勾选/批量 Stage、常驻 Commit/Amend、按文件缓存与自动刷新已接入。完整 Rust 127 项、前端模型 21 项及真实 Git 前后端流程通过；两轴评审已关闭。macOS 原生点击验收因锁屏待完成，Windows/大仓库 NFR 未因此闭环。详见 `GIT-WORKFLOW.md`、`CODE-REVIEW-08.md`。这只是产品的当前检查点，完整 P0 仍有下列缺口。

需求基线：`PRD-v1.0.md`（用户于 2026-09-12 确认产品名 Proof）。交付目标保持为 PRD 的完整 v0.1 P0；P1/P2 保留为后续范围，不用原型替代交付。

## 推进顺序

1. M0：真实 Git 查询、不可变 Diff、受校验的 patch、Review 内容绑定；观察协议的版本可行性。
2. M1：Changes / Repository 桌面工作台，提交预览、专注阅读、深浅主题、键盘及错误状态。
3. M2：Git / Review Alpha，真实仓库的 AT-01—15。
4. M3：可选观察安装、独立采集服务、字段授权、证据关联、数据管理；AT-16—28。
5. M4：完整回归、资源测量、macOS 安装包、Windows 原型验证、用户测试与发布证据。

## 当前证据

最新检查点（2026-09-13，仓库布局）：面板支持拖动、键盘和设置输入，按本地仓库记忆；linked worktree 共用、独立 clone 隔离，窄窗不覆盖保存意图。原生验证了保存、失败回滚/重试、重启和恢复默认；Git/Review 数据核对不变。修复取消竞态、失败提示遗漏和抽屉遮挡焦点。完整 Rust 116 项、前端 17 项通过，历史桥接计时波动仍未定位。schema 升至 4，范围与证据见 `LAYOUT.md`、`CODE-REVIEW-07.md`、`ACCEPTANCE.md`。

此前检查点（2026-09-13，Diff 阅读）：新增行内高亮、空白显示/折叠、原快照约束的上下文扩展、搜索跳转、显示切换锚点与并排独立横向滚动；修复偏好初始化/保存竞态、密集高亮资源问题，以及隐藏/换行/字号变化后的阅读位置。两轴评审的全部定向发现已关闭；core 93、前端 13 条通过。独立原生验证应用已完成上下文展开、隐藏、第一 Hunk 审查/暂存与真实图谱双父提交 Diff，磁盘和 SQLite 结果一致。完整回归又出现既有桥接 515 ms 计时失败，定向重跑通过但原因未关闭。范围和证据见 `DIFF-READING.md`、`CODE-REVIEW-06.md`、`ACCEPTANCE.md`。

上一检查点（2026-09-13）：按用户提供的参考图重做单层导航、炭灰深色与浅色主题、紧凑 Diff 顶栏和交互动效；新增真实 Git History Graph。图支持全部/当前/具名引用、冻结 tip 的 100 条分页、分叉/合并、标签、保留拓扑的搜索、键盘选择与父提交 Diff。浅克隆/改写历史有明确边界，Changes / History / Branches 保留已加载的阅读状态。完整 Rust 108 项与前端 6 项通过；两轴评审见 `CODE-REVIEW-05.md`。浏览器已检查 1440×900 和 1024×720，末段 Mac 锁定使新包原生交互待复验。以下条目保留此前各阶段的证据时间线。

- 工作目录起始为空，尚无实现或既有测试。
- 开发机：macOS Apple Silicon；Git 2.50.1；Rust 1.98.0；本地可用 Node 18.20.7 / 22.19.0。
- 本地可执行版本：Codex CLI 0.153.4、Claude Code 2.1.236。仅证明存在，不代表观察兼容性已经验证。
- 已建立 Tauri/React 桌面、独立 Rust 核心、SQLite、真实 Git/Review 测试、隔离原生验收仓库。
- 前端类型检查和生产构建通过；16 个真实 Git 用例通过。原生 GUI 已完成打开仓库、审查一个 Hunk、暂存、预览和提交，磁盘/SQLite 核对见 `ACCEPTANCE.md`。
- 已完成首次两轴代码评审与定向修复，过程及范围见 `CODE-REVIEW-01.md`。新增回归覆盖 index 事务、Hook 改变目标分支、文件权限与类型切换；当前测试文件共 25 个真实 Git 用例。
- 首个原生验收进程已停止（旧包）。Mac 当前锁定，更新包的交互复验需要解锁。后台构建与核心测试可继续，不构成整个任务的阻塞。
- 已接入文件/Hunk 安全丢弃、持久化恢复点、普通撤销与独立的空路径重建确认。SQLite 先保存内容，再使用同卷排他文件替换；当前 Git 索引不随丢弃改动。恢复点按 7 天 / 256 MiB 管理，跨工作区容量预留使用事务。
- 已接入基础文件历史与每页 400 行的 Blame，未提交行不指定作者，历史窗口保留当前 Diff。重命名无法定位旧路径时允许填写该版本路径；当前工作树经过内容过滤、无法逐行对应时明确拒绝该 Blame 范围。
- 已增加实际 Git 目录身份校验；`.git` 被替换后旧工作区信任与旧动作失效。当前累计 49 个 Git 集成、3 个文件系统并发、2 个前端呈现测试通过。第二轮评审见 `CODE-REVIEW-02.md`。
- 已实现独立观察桥接/采集器的 Unix 传输、接收时授权代次、字段筛选、原生 ID 去重、真实工作区边界与 Post-only 验证降级。底层链路使用夹具验证，未安装真实 Agent Hook，也未将版本标为正式兼容。详见 `OBSERVATION.md`。
- 已接入设置页“本地数据”：观察记录用量、固定保留规则、暂停并清理此工作区、WAL 清理未完成与数据库回收状态。取消/到期恢复点的数据库副本清理也纳入持久化清理代次。
- 当前 core 累计 72 项测试通过：49 个 Git 集成、17 个观察/数据测试、3 个文件系统并发、1 个继承管道与 2 个数据维护并发测试。8 个独立观察传输测试、2 个前端呈现测试通过；本地数据页浏览器演示入口可见，真实数据清理的原生交互仍待 Mac 解锁。两轴评审及修复见 `CODE-REVIEW-03.md`。
- 已增加 Agent 接入前版本检测：仅用户点击时执行固定 `--version`，程序执行期限 2 秒，运行期间释放 Git 核心锁。程序路径与各级符号链接经过的已打开工作区遵守实际身份和信任检查；版本号不提升真实兼容性、不授予采集权限。本机 Codex 0.153.4、Claude Code 2.1.236 仍是待验证候选。
- 已增加保留 JSON 原始格式的纯配置规划器，覆盖幂等安装、升级前冲突检查和按所有权卸载；没有落盘安装。当前 core 79 项、配置规划 11 项、原生 dispatch 1 项、前端 2 项测试通过，Clippy/类型检查/前端构建通过。传输独立串行 8 项通过，但两次全量运行仍出现 500 ms 启动耗时断言超限；定向复测和 30 组调试测量未复现，原因未关闭。不得宣布全量回归或 NFR 全部通过。见 `CODE-REVIEW-04.md`、`ACCEPTANCE.md`。

## 验收状态

逐项状态见 `ACCEPTANCE.md`。当前只有部分 AT 有真实证据，尚未完成完整 P0。不得把编译通过、演示数据或单个测试替代用例完整要求。

## 接下来的实现缺口

1. 完成 Git/Review 验证：特殊文件与过滤器完整矩阵、完整选择/阅读位置专项、严格并发压力。macOS 丢弃/恢复/Blame 的正常路径和新修改保护已有原生证据，故障全矩阵仍需补齐。
2. 完成阅读体验与设置：完整选择/滚动持久化、外部编辑器 Windows 验收、大文件压力、所有设置的应用/仓库层级、200% 缩放与全键盘覆盖。完整文件搜索、大文件主动加载、macOS 编辑器正常链路已完成当前增量验证。
3. 继续观察产品的剩余范围：其他 Agent/平台的真实兼容矩阵、完整证据级别、完整性与验证时效；人工关联修正已实现，原生点击仍待验收。Codex/macOS 安装及真实会话已有独立证据。
4. 完成本地管理：原生全局清理、Windows 路径与跨版本升级/卸载验证。macOS Codex 安装卸载、仓库删除、移除最近及诊断导出已有原生证据。
5. 完成发布证据：AT-01—30 全矩阵、NFR 基线和压力、macOS 安装包与更新校验、Windows 原型、真实 Agent 事件和用户研究。

## 未冻结事项

- Agent 支持组合须经用户在原终端的真实事件验证；不会擅自启动模型或消耗 token。
- 最低系统版本、Windows 结果、Monaco 与自有虚拟化 Diff 取舍、性能预算和用户研究尚待验证。
- 品牌名已确认；开源、收费和商业模式仍未决定。


## 2026-09-14：Codex 完整启动与 Hook 版本策略修复

实际桌面错误定位为 Codex 在 analysis 阶段创建 app-server 的权限失败。只把 SQLite / log_dir 定向到临时目录没有覆盖 installation_id 的读写打开。主动 Codex 改为每次独立运行时，通过沙箱保护的只读 auth.json 符号链接复用已有登录；不复制凭据，不改共享配置或 Session。分组栏可直接展开 Failure details。必要 CLI 能力缺失显示具体参数，可选功能使用配置项关闭，避免未知 feature 名阻止启动。

Passive Codex Hook 删除 0.153.4 白名单；新版本可预览 / 安装 / 检查桥接，仍区分协议候选与收到真实事件。预览到安装保留严格程序身份校验，安装后允许正常 CLI 更新，来源信任、程序权限、Helper 和配置检查不变。现有旧 Helper 的升级仍沿用卸载 / 重新安装流程，新安装使用本次修复的 Helper。

验证：Rust workspace 234 项通过；默认忽略 5 项中的 3 个真实 CLI 测试已显式运行通过（另 2 项原有 opt-in 不在本轮范围）。其中完整启动回归使用真实 Codex + loopback 模拟响应，旧运行方式复现失败，私有运行时成功返回最终 JSON，合成共享状态不变；无真实凭据 / 源码进入模拟服务，也无远程模型调用。现有 Codex 登录检测为 true，Claude Code 为 false。lint、typecheck、44 项前端单测、cargo check、workspace Clippy 均通过。UI 和桌面打包记录见 `.artifacts/ai-runtime/`，最终构建见 `.artifacts/latest-build.json`。


## 2026-09-14：统一 Diff 工作台

历史 Diff 加入 AI 分组与手动编辑，使用独立的比较分组存储；Local changes / 历史 Diff / 独立窗口复用文件栏、ResizableWorkbench 和 DiffView。新增固定内部 URL 的原生 Diff 窗口，传递冻结比较或本地文件侧；监听、取消、数据刷新按窗口隔离。Prism 增强语法高亮，保留多行上下文、搜索和行内差异，缓存有界且随数据清理失效。详见 DIFF-WORKSPACE.md。

本轮 lint、typecheck、47 项前端单测、236 项 Rust 测试、81 项 UI 测试、cargo check、workspace Clippy 与 macOS release build 通过。默认忽略的 5 项中，3 项既有真实 CLI 无模型测试显式通过；另外 2 项原有 opt-in 未运行。原生窗口创建尚未手工实机验收，先前自动审批要求明确运行授权；未退出用户旧窗口。证据在 `.artifacts/diff-workspace/`。
