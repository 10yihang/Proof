# Proof 验收记录

## 最新检查点 · 2026-09-14 原生阅读、恢复与重试

原生 macOS 验证了指定版本/Worktree Blame、旧路径、分页、返回第 250 行；原生应用选择器与真实 TextEdit 保存后自动刷新；单 Hunk 丢弃/恢复及新编辑后的 `STALE_CONTENT` 拒绝。文件、Index、HEAD、配置和 Review 前后断言保留于 `.artifacts/native-git-reading-01/`，详见 `NATIVE-GIT-READING.md`。

另修复同版本/路径的读取失败无法重试，完整 UI 70 条通过。最新应用以暂时移出并恢复自建文件的方式触发真实 FILE_MISSING，显式重试恢复 500 行；第二页失败重试保留 401–500 范围。当前原生报告为 `.artifacts/file-history-native-01/native-acceptance.json`。源码相对上一包只改 FileHistory 及 UI 用例，未重复运行未变化的 Rust/模型测试。本轮不是完整 P0 或全平台/NFR 完成声明。

## 最新检查点 · 2026-09-14 大 Diff 与读取取消

本地新包 `.artifacts/builds/52aaf2a-large-diff-worktree/Proof-macOS-arm64.zip` 已完成 162 项输入、签名、ZIP CRC 核验，当前构建记录为 `.artifacts/latest-build.json`。使用 ad-hoc 签名，未公证；源码仍是未提交的工作区。

Changes / 独立历史 tab 已接入摘要、主动加载和有界取消；Core、Changes 与历史缓存按内容容量回收。普通 Commit 预览对无法统计的 Review 明确标为未知，Strict Review 保持写入前拦截。后台刷新不再取消同文件版本的显式加载；大历史 Diff 重建按实际源行恢复。见 `LARGE-DIFF.md` 与双轴 `CODE-REVIEW-17.md`。

完整 Rust 205 通过、2 opt-in，前端单元 35、完整 UI 47 通过；最后的原生状态参数和导航键补丁分别完成桌面 6 项与 UI 4 项定向复验。原生旧并发读取包已实际验证 Cmd+3、History→独立 Diff、Cmd+W 只关闭 Diff、全屏进出和 About 面板关闭。

新版隔离 Release 应用已通过真实 Tauri IPC 的大 Diff 摘要/加载、读取取消和后续文件切换、单文件 Stage/Commit、History→独立大 Diff 验收。测试 Commit 仅含 `generated.js`，另外 1,002 个未暂存文件保持，Review marks/events 均为 0。20 秒受控进程在取消后提前回收且无残留进程组。详见 `.artifacts/large-diff-native-01/native-acceptance.json`；进程生存期包含点击前时间，未作为取消延迟或完整 NFR 预算。

## 最新检查点 · 2026-09-14 独立 Git 读取并发

文件 guard、Changes 元数据及 config / attributes 的独立读取已并发执行，每请求最多两个辅助线程、三个直接 Git 子进程。捕获身份、全部写入校验、Index 锁与发布顺序保持。完整 Core 163 项通过、0 失败、2 项 opt-in 未执行；新增环境变动和读取失败回归均核对源码 / Index 保持，两轴复核关闭，见 `CODE-REVIEW-16.md`。

最终标准规模测量 `.artifacts/git-standard-parallel-reads-02.json` 每场景 30 次，8 个写入场景的 P95 全部低于 500 ms。File Diff 146.33 ms，Reviewed 整文件 Stage / Unstage 394.83 / 392.82 ms，Stage All / Unstage All 475.89 / 470.17 ms。All 的单次最大值仍超过 500 ms，完整内容断言通过。3,353 个资源样本观察到最大进程树 RSS 约 35.8 MiB、最多 4 个进程；范围不含 WebView / 独立采集器，也不是完整 UI 或 16 GiB 参考机 NFR 验收。

真实 Git 界面回归通过，涵盖自动刷新、部分提交、Amend、Commit all 与数据删除后的源文件保持。前端源码相对上轮完整 40 项 UI / 30 项单元回归没有变化，本轮单独复验了新 Core 的实际 Git 链路。Core Clippy、格式、前端生产构建、Release 构建通过。

新包为 `.artifacts/builds/52aaf2a-parallel-reads-worktree/Proof-macOS-arm64.zip`，SHA-256 `1825c6d093fb548a179e5aa7bf9438c83da04f7d8dc1db976127dbd271f143a5`。149 个输入在构建及归档后逐项核对一致，严格签名和 ZIP CRC 通过，来源见 `.artifacts/latest-build.json`。仍为未提交、未公证的 ad-hoc Alpha。Computer Use 再次确认 Mac 锁定，原生窗口 / IPC 与剩余 P0 继续保留。

## 最新检查点 · 2026-09-14 单文件捕获与回复版本

单文件 Diff 不再生成整个 Changes 页的附加信息；仍从全局 status 解析 rename 与两侧状态，保留所有 guard。base 从同次受验证的 HEAD / Branch 捕获，真实 Git 回归验证了 status 期间切换 Branch 后内容与基准一致。前端等待 Branch 匹配后展示 Diff；同 Branch 内晚到的 Review 回复也不能覆盖已刷新文件的内容和 Review 状态。三条路径都有失败反例及通过回归，两轴复核见 `CODE-REVIEW-15.md`。

标准规模同脚本重新测得 File Diff P95 196.93 ms（前次 273.75 ms），Reviewed 整文件 Stage / Unstage 为 534.84 / 514.11 ms。完整 Index / Worktree 校验通过，仍有 7 个写入场景超出 500 ms。资源采样仅覆盖 Core 及可见后代，不是原生 UI 或完整 NFR 通过，详见 `PERFORMANCE.md`。

本轮完整 proof-core 160 通过、0 失败、2 项 opt-in 未执行；前端单元 30 通过；最终完整 UI 40 通过，实际 Release Core / Git 流程已启用。类型、修改文件格式及 Core Clippy 通过。浏览器重看了浅色 History 与现有独立 Diff tab；新界面回归生成的 1440×900 深色 History 截图也已查看。它们使用明确的测试 / 演示数据，不能证明实际 macOS 交通灯位置。

Computer Use 再次返回 Mac 锁定；已有操作授权不变，原生拖动、全屏、About 和菜单点击仍待可用桌面。完整 P0 保持未完成。

更新的 macOS ARM64 Release 包为 `.artifacts/builds/52aaf2a-git-capture-worktree/Proof-macOS-arm64.zip`，SHA-256 `ca93b8952aef25e11d360923373ae086cab3cb6704e918670a00e743531870ae`。149 个输入在构建前捕获、构建及打包后核对一致；ad-hoc 签名和 ZIP CRC 通过。JS 主包 589.36 kB（gzip 170.56 kB）的体积提示保留。新包包含本轮 Core 和回复版本修复，旧包均保留；未提交、未公证，构建记录见 `.artifacts/latest-build.json`。

## 最新检查点 · 2026-09-14 标准计时与演示 Parent 修正

标准 10,000 文件 / 100,000 Commit 夹具完成每场景 30 次测量，逐次核对完整 Index 和 Worktree。Core File Diff P95 为 273.75 ms，Reviewed 整文件 Stage / Unstage 为 604.20 / 598.55 ms；共 7 个写入场景超过 500 ms，性能门禁按原预算失败。脚本 4 项回归及两轴复核完成。详见 `PERFORMANCE.md`，不是原生 UI / 全部 NFR 通过。

浏览器发现并修正演示 Merge Diff 起点的 Empty tree 错误，Parent 1 / 2 切换实际显示对应 Commit。类型、格式及 Release 构建通过；149 个构建输入核对一致，只有演示 Parent 解析相对此前完整回归发生变化。新包位于 `.artifacts/builds/52aaf2a-desktop-chrome-followup-worktree/`。Mac 仍锁定，原生窗口验收及完整 P0 继续保留。

## 最新检查点 · 2026-09-14 Desktop chrome

按用户再次提出的 Fork / GitKraken 参考要求，整理中性灰主题、仓库工具栏与固定 tabs、紧凑文件树和提交图；Diff 继续独立打开，合并重复标题，增加页面快捷键、中键关闭及当前比较的文件搜索。详见 `DESKTOP-CHROME.md`。

macOS 使用 Overlay + hiddenTitle，把系统红黄绿保留在应用顶栏；增加明确拖动区域。原生 File 菜单接管 Cmd+W，活动 Diff 只关闭 tab；原生 About 等面板关闭时不会误作用于后台主窗口。独立弹窗和普通 Commit 输入的快捷键边界均有回归，两轴复核见 `CODE-REVIEW-14.md`。

完整 Rust 190 通过、2 项 opt-in 未执行；最终菜单版本桌面 3 项通过；前端单元 29 通过、最终完整 UI 38 通过（真实 Git 工作流已启用）；类型、Clippy 和格式检查通过。受限沙箱中的一次 FSEvents 失败已在具备文件事件访问的同一测试中通过，不归因为产品修复。

Computer Use 仍检测到 Mac 锁定。原生按钮位置、拖动、全屏、About 与真实菜单快捷键仍待解锁验收；浏览器和菜单事件模拟不能替代它们。Stage 重复读取/退出等待优化已通过功能回归，但最终标准仓库全路径及原生 UI 性能尚未完成。完整 P0 目标保持不变。

## 最新检查点 · 2026-09-14 Context 人工关联修正

CTX-04 的文件级关联、解除、备注、恢复原始关联与追加式撤销历史已接入。Context 默认显示摘要，原始记录按会话分页展开；候选限定同 Worktree，使用稳定游标，字段缺失与到期原因明确。后台新增事件保留已读页，后端提供的保留期限用于逐条清理已加载缓存。保留期结束后旧编辑版本不会复活，All 删除后同一进程可重新使用。见 `CONTEXT-ASSOCIATIONS.md` 与独立双轴 `CODE-REVIEW-13.md`。

最终完整回归：Rust 185 通过、0 失败、2 项 opt-in 未执行；前端单元 29 通过；完整 UI 36 通过。新增 12 条 Context 核心测试、5 条 Context 页面测试。核心测试核对原始事件与 Git 字节不变；实际 Git/SQLite UI 流程增加关联、备注持久化与撤销，并核对源码、Index、HEAD、配置保持。最初页面全套出现保存状态 locator 与加载状态歧义，改为具名保存状态后完整复验通过。类型检查、Clippy、Rust/Prettier 格式、生产构建通过。JS 主包 570.17 kB（gzip 166.09 kB），体积警告保留。

macOS ARM64 Release 构建与 ZIP 完整性、ad-hoc 签名校验通过。131 项构建输入在构建前捕获，并在构建后及验收工具失败后验证无漂移。安装包为 `.artifacts/builds/52aaf2a-context-worktree/Proof-macOS-arm64.zip`；源、安装包、主程序和 Helper 的指纹记录于 `.artifacts/latest-build.json`。本地改动尚未提交，包明确标为 worktree 构建；未公证。

原生点击验收未完成。Computer Use 选择新隔离应用时返回 `Sky Computer Use service startup request failed`，工具报告耗时 6903.457 秒；这不是应用启动耗时，也没有产生窗口点击结果。随后使用固定隔离配置启动应用，确认进程存在、Context 数据版本已初始化，源码/Index/HEAD/配置及 2 条原始夹具事件一致，关联修改数仍为 0。证据在 `.artifacts/context-native-01/acceptance-pending.json`。不能以进程启动替代原生 UI 验收，也不把模拟 Hook 输入称为新一轮真实 Agent 测试。

完整 P0 仍未结束：本轮原生点击、其他 Agent/平台、完整证据级别与验证时效、NFR/兼容性和其余 AT 矩阵继续保留。

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


## 此前验收检查点 · 2026-09-13 Local data

本地数据管理已接入暂停观察、隐藏最近项目、按仓库删除（覆盖 linked Worktree、隔离 clone）及全局清理。schema 升至 5；恢复副本、临时 Index、WAL 和采集运行文件使用可重试清理流程。旧请求、排队设置与跨窗口草稿写入不能重建已删记录。详见 `DATA-MANAGEMENT.md`、`CODE-REVIEW-10.md`。

原生独立应用已验证仓库删除及重新打开：隐藏入口不删记录，确认框仅含 main/linked，删除后 clone 保留，旧 Diff/草稿清空，重新登记的身份未继承信任/Review。SQLite 和三个测试仓库的文件、Index、HEAD、配置核对一致。原生全部记录删除、Windows 清理和诊断导出仍待验收或实现；完整 P0 未完成。

完整 Rust 150 项通过、1 项既有 Observer 启动计时失败、2 条 opt-in 跳过；失败测得总耗时 548.722125 ms，原二进制定向重试通过，但未关闭原因。前端模型 29 项、页面流程 23 项通过，含实际 core/Git 的 Commit、Amend、全部提交和记录删除。类型检查、Clippy、格式检查和前端/Tauri 构建通过；新包是独立 ad-hoc 调试包，构建输入和来源归档于 `.artifacts/latest-build.json`，不是公证发布包。

## 此前验收检查点 · 2026-09-13 External editor

Changes Diff 工具栏及 Command 可将当前 Worktree 文件交给用户配置的外部编辑器；设置支持应用默认、仓库继承/覆盖/禁用，保存不会启动应用。文件目标从原生 snapshot 确定；应用、设置、信任或文件身份在排队后改变则拒绝。History 禁用该命令；已有菜单中的文件目标不跟随后台选择变化。实现边界见 `EXTERNAL-EDITOR.md`。

9 条新增核心测试覆盖 SQLite 设置继承/持久化/失败、linked Worktree 与 clone、Staged 仍打开当前 Worktree、特殊字面路径、排队失效、符号/硬链接及内部路径拒绝。流式 Info.plist 解析拒绝放大、超深、超多事件和重复身份字段，同时兼容 Zed 的无关重复元数据。本机只读枚举识别 Zed、Code、IntelliJ IDEA、TextEdit，未启动它们。两轴评审发现全部关闭，见 `CODE-REVIEW-09.md`。

完整 Rust 135 项通过（core 115、桌面 2、配置规划 11、传输 7）、1 项失败、2 条 opt-in 跳过。既有 `bridge_bounds_never_closed_stdin_and_missing_service` 测得总耗时 570.134292 ms、spawn 982.292 µs，超过 500 ms；同一测试二进制定向复测通过，未放宽阈值，原因仍未关闭。桌面实际文件保存/atomic rename 通知测试通过。类型检查、Clippy、格式检查和前端模型 21 项通过。

Playwright 15/15 通过：14 条 UI 回归含 5 条新增编辑器流程；另 1 条通过测试 NDJSON 驱动真实 core/Git，完成自动刷新、Branch 切换、选定 Hunk Commit、Amend、全部提交，最终 HEAD 为 `bf6d3f4f2c4d94d92f20f91fb61f5a9fc7565375`，status clean。它不是 Tauri IPC 证据，临时仓库已由测试清理。编辑器 handoff 使用受控回调，未启动真实编辑器。

macOS 仍锁屏，CUA 明确要求手动解锁；实际编辑器窗口及原生选择器尚未验证。旧应用与验收夹具保留，Windows 原生实现也未验收。不把这些自动化结果称为完整 P0 或完整 NFR 通过。

前端及 Tauri `--debug --no-bundle` 构建通过；将新可执行文件放入已核对资源不变的独立 bundle 副本后，ad-hoc 签名与 `codesign --verify --deep --strict` 通过。114 个源码/构建输入与构建时一致，来源见 `.artifacts/latest-build.json`。主 JS 509.17 kB（gzip 148.59 kB）仍有体积警告；该包不是公证发行包。

## 此前验收检查点 · 2026-09-13 Git workflow

顶部 Branch 下拉、Changes 文件树/勾选/批量 Stage、常驻 Commit/Amend、按文件缓存与自动刷新已接入。完整 Rust 127 项、前端模型 21 项及真实 Git 前后端流程通过；两轴评审已关闭。macOS 原生点击验收因锁屏待完成，Windows/大仓库 NFR 未因此闭环。详见 `GIT-WORKFLOW.md`、`CODE-REVIEW-08.md`。这只是产品的当前检查点，完整 P0 仍有下列缺口。

本记录描述当前已有证据，不代表 v0.1 已完成。完整范围保持为 PRD 的全部 P0。

## 2026-09-13：仓库布局与面板交互

默认 240px / 300px，可拖动、用方向键或设置输入调整；宽度和 Context 覆盖按本地 repository ID 保存，linked worktree 共用、独立 clone 隔离。小窗口只临时适配，不覆盖保存宽度。窄窗侧栏使用抽屉；焦点离开抽屉时收起，进入模态窗口时保留返回位置。细节见 `LAYOUT.md`。

新增 3 条真实 Git/SQLite 测试覆盖共享与隔离、重启、默认恢复保留非默认应用偏好/Review/Git/Agent 文件、非法宽度、失败写入、仓库身份替换和 schema 3→4。完整 Rust 116 项通过（core 96、桌面 1、配置规划 11、传输 8），1 条 CLI opt-in 跳过；前端新增 4 条布局模型回归，累计 17 项。Clippy、类型、构建与格式检查通过。既有桥接启动计时波动仍未定位，本次通过不能代替 NFR 验收。

浏览器检查了左右键与 Shift 调整、仓库覆盖显示、512×360 CSS 视口的抽屉与纵向滚动、Cmd/Ctrl+P 搜索/选择后的焦点，以及大字号软换行下的连续调整。26px 字号、25 行上下文、文件栏 250→350px 时，Diff 顶部仍是同一源行，行内偏移约 16.8→17.2px。独立组件进一步检查开合和宽→窄→宽，源行及 80px 行内偏移保持不变。这里只把 26px 称为默认代码字号的 200%，没有将等效小视口检查宣称为所有平台完整 200% 缩放验收。

原生验收使用独立 `Proof Layout Check.app` 和 `.artifacts/layout-native/data`，三个真实仓库位于 `.artifacts/layout-fixture`。它们由旧历史夹具复制产生，主仓库 HEAD 为 `d8539e6ee4f46d8bfa57057420a6e3b916d41512`。通过原生 UI 核对：

- 主仓库保存 320px / 400px 并收起 Context，linked worktree 继承相同布局；独立 clone 初始保持 240px / 300px。
- clone 单独保存 220px 后，注入仅针对该 clone 的 SQLite 更新失败。尝试 240px 时界面显示失败并回到 220px；移除故障后成功保存 260px。故障触发器已删除。
- 原生进程正常退出后重新启动，重新打开 linked worktree，界面和设置均显示 320px / 400px、Context 收起。
- 从 linked worktree 恢复默认后，主仓库和它都恢复 240px / 300px / 跟随应用默认，clone 仍为 260px。设置范围没有越过 repository ID。
- 全程没有使用 Git 写入口。主夹具 index、源码、Git 配置字节未变；Review 标记、Review 事件、Git 操作均为 0。非零 Review 与自定义应用偏好的恢复保留由上述真实核心回归另外证明。

记录位于 `.artifacts/layout-native/native-acceptance.json`，预期文件在 `.artifacts/layout-fixture/expected.json`。原始 Git/Review 与历史夹具保持不变。原生编译候选 SHA-256 为 `b27c1030e87f579eab037a02c536e5b93091105828990d76f418a55d11848f61`；构建使用 Tauri `--no-bundle`，拷贝未改资源、替换可执行文件、赋予独立测试 bundle ID 后 ad-hoc 签名。最终检查点来源记录在 `.artifacts/latest-build.json`。

schema 3 原位迁到 4；旧 Alpha 的版本保护会拒绝重新打开升级后的数据。本轮始终使用独立验证数据，没有替换用户正在运行的旧 bundle。两轴评审 3 项发现全部修复并复验，见 `CODE-REVIEW-07.md`。完整设置层级、完整缩放/键盘矩阵及完整 P0 仍待推进。

## 2026-09-13：Diff 阅读扩展

已提供行内差异、空白符显示、配对空白替换折叠、3/10/25/100 行上下文、搜索前后跳转及显示切换锚点。上下文结果与原快照/完整 Patch 核对，宽 Git Hunk 不合并原来的审查单元；真实增删计数和 Review 状态不随隐藏改变。原始 Patch 始终使用完整原文。范围与缓存/资源限制见 `DIFF-READING.md`。

5 条真实 Git 回归覆盖扩展不改原 Patch/Hunk ID/index、扩展后仍只暂存所选 Hunk、外部变化与已捕获上下文、staged/unstaged 基准、CRLF/无 EOF 换行/带特殊字符重命名、参数限制和旧设置兼容。core 累计 93 项通过。前端新增 7 条阅读回归，累计 13 项通过；独立组件回归进一步核对偏好加载/保存竞态、DOM 与真实 Selection、raw 刷新定位和高亮限额。

浏览器已检查 1440×900 浅色上下文/行内高亮、1024×720 深色折叠提示和完整计数、隐藏时 Hunk/文件 Review 禁用、搜索 1/5→2/5、raw 入口的准确状态，以及统一/并排首行保持 old 15 / new 17。并排长行追加左右独立横向滚动，右栏达到最大 186px 时左栏为 0；字号缩小、隐藏恢复、换行行内偏移与测量资源上限均已完成独立增量回归，详见评审记录。

本轮原生验收使用 `scripts/create-reading-repo.py` 生成的独立真实仓库 `.artifacts/reading-fixture/demo-service`，HEAD 为 `39532009f28c238286568cbac72a75ac2b0b801e`。通过原生 UI 展开 25 行上下文、隐藏空白、显式审查第一块、只暂存第一块；磁盘及 SQLite 核对如下：

- 纯阅读阶段 index 与工作树字节未变，Review 标记和事件均为 0。
- 暂存后 index 的 `src/reading.ts` 只有 `original`→`reviewed`，缩进变化留在工作树；原有 README 暂存内容保留，HEAD 未变，无遗留 index.lock。
- SQLite 记录一条用户审查和对应 `stage_migration`，空白 Hunk 未被审查；界面继续禁用其新增 Review。
- 原生 History 显示 15 条真实提交和分支/合并连线。搜索 `c3537dc3` 后，父提交 1 `a43e7b69` 显示 requests/validation，父提交 2 `10ef3bd8` 显示 request-id/response；内容分别与 Git 期望一致。
- 记录在 `.artifacts/reading-fixture/read-only-check.json`、`native-acceptance.json`。原历史夹具 HEAD/index/全部已跟踪文件和首次 Git/Review 夹具 HEAD 核对未变。

验收时既有 Proof 正由用户使用，因此运行独立 `Proof Reading Check.app`，使用独立 bundle ID 和 `.artifacts/reading-native/data`。执行 `npm run tauri -- build --debug --no-bundle`，在既有未改资源的 bundle 副本替换本轮可执行文件、改验证标识并 ad-hoc 签名，严格签名检查通过。验收候选编译文件 SHA-256 为 `1eb1d876a17e9784efbf49725c23dd2ec511587e93b67d716771d924af8c335d`，构建详情在 `.artifacts/reading-native/build.json`。这证明本轮代码的原生路径，不是公开签名发行包的安装验收。

原生验收后仅补正空白提示：没有实际折叠时说明“当前文件没有被折叠的变化”，有折叠时只要求审查隐藏内容前恢复显示。最终文案已在浏览器重载后验证；本次重载后的采集日志没有警告或错误。正式本地检查点的独立应用路径、提交及哈希记录于 `.artifacts/latest-build.json`，不覆盖正在使用的旧包。

本轮完整 Rust 运行并非全绿：112 项通过、1 项传输计时失败、1 条 opt-in 跳过。桥接总耗时 515.021292 ms（spawn 635.625 µs），超过未改动的 500 ms 断言；同一测试二进制定向重试通过。这是已登记的间歇问题再次出现，不认定已修复。类型检查、前端构建、Clippy 与格式检查通过。两轴评审及定向修复见 `CODE-REVIEW-06.md`。

当前新增能力不代表 DIFF-02/05 或 AT-29 全部完成：完整源码搜索、外部编辑器、大文件/缓存切换与发布压力、完整选择持久化、200% 缩放仍待补充。

## 2026-09-13：界面与 History Graph

按用户参考图及 Fork / GitKraken 的官方界面资料改进单层导航、深浅主题、代码区密度和短时动效。浏览器演示检查覆盖：1440×900 炭灰三栏、1024×720 自适应顶栏与右栏收起、深浅提交图、搜索匹配跳转、Changes / History / Branches 切换后保留所选文件/提交、观察状态按钮直达 Agent 观察设置。两种视口中页面宽度与视口一致，没有全页横向溢出。

图只连接真实 parent OID，100 条分页以捕获 tip 和引用标签为基准；具名分支刷新重新读取当前 tip。9 条新增真实 Git 回归覆盖多分支拓扑/分页、引用移动后的旧页面稳定、祖先标签、1100 条单分支、空仓库/非法游标、具名引用刷新、浅边界/replace/graft 降级、详情快照形态和不执行仓库签名程序。前端 4 条图布局回归覆盖分叉/合并/多父提交、断开的历史和分页前缀稳定。

主工作区完整运行 `cargo test -p proof-observer -p proof-core -p proof-desktop -- --test-threads=4`：108 项通过，1 条本机 CLI opt-in 默认跳过。`npm test` 6 项通过；类型检查、生产构建、三 crate Clippy、Rust 格式及 diff 空白检查通过。前一检查点的桥接启动间歇计时失败仍保留为未定位问题，不以本次单次通过认定 NFR 达标。

独立评审已修复退出动画取消后误提交、虚拟列表活动节点丢失、历史形态变化后旧图与新 Diff 混用等问题，详见 `CODE-REVIEW-05.md`。演示 Context 是明确标注的虚构会话；没有据此认定真实 Agent 证据关联完成。

另创建独立 `.artifacts/history-fixture/demo-service`：14 条真实提交、4 个本地分支、2 次合并、1 个 annotated tag 和本地 origin/main 引用，生成器为 `scripts/create-history-repo.py`。其 HEAD 为 `c3537dc32204225182d75b693bc7a399337c30a4`，期望父提交/原始 Patch/索引和文件哈希写入该夹具的 `expected.json`。该夹具尚待新包原生窗口验收；本轮末段 Mac 再次锁定。原始 `.artifacts/demo-service` 的 Git/Review 验收内容保持不变。

当前界面代码已通过 `npm run tauri -- build --debug --bundles app` 打包，`codesign --verify --deep --strict --verbose=1 target/debug/bundle/macos/Proof.app` 通过。产物仍是本地 ad-hoc 签名的调试 Alpha，不是公证发行包；完整构建来源记录保存在本机 `.artifacts/latest-build.json`。

## 2026-09-12：Git / Review 首次原生验证

构建命令：`npm run tauri -- build --debug --bundles app`。产物：`target/debug/bundle/macos/Proof.app`，调试构建，内嵌前端资源。前端构建成功；Rust 核心 `cargo test -p proof-core --test git_review -- --test-threads=4` 为 16/16 通过。

原生流程使用 `scripts/create-demo-repo.py` 创建的真实、隔离仓库 `.artifacts/demo-service`，数据库为 `.artifacts/desktop-data`。通过原生 UI 完成打开、受限查看、信任测试仓库、审查一个 Hunk、暂存该 Hunk、提交预览和确认提交。不是通过 UI mock 执行 Git。

独立磁盘核对结果：

- 第一个 Hunk 进入 index，第二个 Hunk 仅留在工作树。
- 审查标记经过完整基准与 patch 核对迁移到 staged，SQLite 有 `stage_migration` 证据。
- 实际提交 `6051b381a5358d7a651edcdc1583b1ebd6ce4b0e` 包含 README.md 与 src/api/requests.ts。
- HEAD 文件包含 `validateRequest(payload)`，保留原来的错误处理；工作树保留未提交的 `status: 400` 修改。
- 提交后 index 无待提交变化，自有 index.lock 已释放，SQLite 操作记录的提交 ID 与 HEAD 一致。
- 原始核对 JSON：`.artifacts/native-acceptance.json`（本地忽略文件，供本机复查）。

原生首次后台窗口曾显示空白；激活并打开检查器后页面加载正常，后续原生流程可执行。未发现可复现的资源或脚本错误，不能据此宣称首次启动可靠性已经关闭。

## 同日：阶段评审后的修复

两轴评审与修复见 `CODE-REVIEW-01.md`。新增用例已经分别证实失败并在修复后通过：重复上下文并发暂存、Hook 切换/重命名分支、文本暂存夹带执行位、正文伪装文件元数据、普通文件转符号链接。还增加 split-index + linked worktree 的暂存/撤销暂存验证。

原生流程记录对应首次应用包，之后的安全修复由真实仓库回归验证。Mac 在后续工作中锁定，因此修复后的原生 GUI 重跑仍待解锁；不得把先前的原生结果当成新包完整交互验证。

浏览器人工检查已确认深色主题可读，1024×720 有效视口默认收起右栏且能重新打开为覆盖面板。前端 2 个测试验证统一/并排呈现不丢失代码、行号或创建假的对应行；不涉及真实 Git 写入。

当前检查点完整运行 `cargo test -p proof-core`：25 个真实 Git 集成用例通过；`npm test`：2 个呈现模型用例通过；前端生产构建、`cargo clippy -p proof-core --all-targets -- -D warnings` 与 Rust 格式检查通过。没有将这些检查扩展宣称为 AT-01—30 全部通过。

更新的 macOS Alpha 已重新打包。最初仅有链接器签名，严格 bundle 校验失败；配置 Tauri 的本地 ad-hoc 签名后重新构建，`codesign --verify --deep --strict --verbose=1 target/debug/bundle/macos/Proof.app` 返回 0，Info.plist 与资源已封装校验。此证据仅为本地包完整性，不是 Developer ID 公证或公开发行验收。

## 按 AT 编号的当前覆盖

本次新增 GIT-02 / HIS-02 实现及第二轮两轴评审。完整核心回归为 49 个真实 Git 集成 + 3 个文件系统并发测试通过，前端 2 个呈现测试及生产构建通过。新增界面已接入 Tauri IPC；Mac 仍处于锁定状态，新增原生交互未执行。浏览器演示仅检查入口与禁用说明，未用于证明真实 Git 写入。

新增证据包括：两个 Hunk 只丢弃一个、文件级回到实际 index、保留 staged 内容、撤销跨重启、7 个持久化/替换中断边界、普通撤销不重建外部删除、独立空路径重建、恢复存储失败、跨工作区容量竞争、捕获 inode 后续写入、取消失败后重试、到期内容清理、CRLF/末尾无换行、smudge 过滤器、macOS 扩展属性保留。恢复副本若被持有旧 FD 的外部编辑器继续增大，保留其数据并把实际大小计入后续容量检查；不会为满足容量限制截断外部编辑内容。

Blame 证据包括：未跟踪/已暂存新增行不指定作者、真实提交作者与指定版本、923 行分页、中文/换行/前导横线文件名、`--follow` 重命名历史、旧版本路径手动定位，以及内容过滤导致工作树行无法对应时的明确降级。重命名追溯仍采用 Git 的能力，不承诺自动定位所有旧路径。

| 用例 | 当前证据与缺口 |
| --- | --- |
| AT-01 | 原生 Git 闭环通过；物理断网、无模型环境的专项演练待做 |
| AT-02 | 真实 Git 测试覆盖同文件混合暂存，原生界面分别展示比较面 |
| AT-03 | 真实测试与原生操作均核对 index 只包含所选 Hunk |
| AT-04 | 同 Hunk 外部修改后拒绝旧暂存，index 字节不变 |
| AT-05 | 内容变化使 Review 待复核，重启从 SQLite 重校验 |
| AT-06 | 行号与完整上下文参与身份；重复片段/位置移动专项待补 |
| AT-07 | 切换分支不继承完成状态，严格基准相同才迁移比较面 |
| AT-08 | 已有文件范围提示、配对空白折叠与真实计数、隐藏时禁止相关 Review；原生验证阅读不改 index/Review，显式暂存只含所选 Hunk；完整过滤组合仍待验收 |
| AT-09 | 拒绝提交的 Hook 测试通过；签名失败与弹层内错误反馈待补 |
| AT-10 | 外部 index 改变拒绝旧预览；已有锁不删除；并发压力测试待补 |
| AT-11 | 恢复点、精确丢弃、撤销新编辑保护、中断恢复及存储/容量故障回归通过；macOS 原生单 Hunk 丢弃/恢复与新编辑拒绝已核对实际文件、Index 和恢复点。完整故障矩阵仍保留 |
| AT-12 | 中文、空格、换行、前导短横线文件名的真实暂存测试通过 |
| AT-13 | 模式/类型切换、CRLF、无末尾换行、过滤器丢弃及 Blame 降级有回归；暂存过滤器与完整特殊文件矩阵待补 |
| AT-14 | 二进制等摘要/禁用规则初步实现；完整特殊文件矩阵待补 |
| AT-15 | SQLite 事务与重启覆盖；磁盘满、崩溃注入待补 |
| AT-16—28 | Agent 观察、完整数据生命周期、证据关联和安全专项尚未完成 |
| AT-29 | 已检查统一/并排、深浅主题、逐块标记、可键盘调整面板、窄窗焦点及 26px 代码字号；完整平台缩放/键盘矩阵待补 |
| AT-30 | 已有标准规模每场景 30 次 Core 计时、逐操作 Index / Worktree 校验与采样 RSS；部分写入预算未达标。原生 UI、完整压力与桥接突发负载仍待完成，见 PERFORMANCE.md |

## 发布门槛尚未满足

两类 Agent 的真实支持组合、Windows 原型验证、用户研究、安装/卸载/升级回滚、数据管理、恢复点原生交互与压力测试，以及 NFR-01—09 均仍需实现或验证。不能以当前应用包或上述测试代替这些门槛。

## 同日：观察传输与本地数据检查点

已有 17 条真实 Git/SQLite 观察测试：L0/L1 未授权字段不进入数据库与 WAL、文本预算、命令状态不提升测试结论、原生 ID 去重、两个 clone 隔离、嵌套仓库及自定义 Git 元数据目录排除、前台租约/后台授权、授权代次、防止排队事件取得后来的权限、7/30/180 天保留、旧 reader 阻止 WAL 清理时的 pending、取消恢复预览源码副本清理、SQLite 空闲页回收后恢复采集及限额状态一致性。完整 49 条 Git 回归与 6 条 core 单元测试也通过；其中新增 2 条单元测试固定了 checkpoint 确认与另一次删除的交错，以及 health 文件并发改名时的容量统计。

传输测试使用真实 Unix socket 和本次创建的独立采集器。覆盖无输出转交、stdin 不关闭、服务缺失、慢接收、超大输入压力、错误文件权限、活动 socket 排他租约、暂停/租约空档排队、授权内容落库及阻塞 Git 时 SIGTERM 收尾。该证据是本地桥接/服务链路，不是模型或 Agent CLI 的端到端兼容证明。

本地数据入口已接 Tauri IPC。浏览器演示检查确认入口、说明与演示限制可见；当前 Mac 仍锁定，尚未通过原生 UI 执行本次数据清理。没有修改真实 Agent 配置或运行模型。

AT-18/19/21/23/25/28 取得部分底层证据，配置安装/卸载、真实 Agent 支持矩阵、Context 页面与人工修正、诊断导出、全部产品记录删除仍未完成。持续吞吐、P50/P95、内存与 CPU 等 AT-30/NFR 预算仍待测量。完整观察实现与边界见 `OBSERVATION.md`。

## 同日：接入前版本检测与配置规划

设置页新增 Claude Code / Codex 程序路径与版本检测入口；浏览器演示显示不可执行原因。真实 `--version` 查询确认本机仍为 2.1.236 / 0.153.4，两者均标为 `candidate_unverified`。没有安装 Hook、授权采集或启动模型。纯配置规划器在内存中保留已有 JSON 字节与其他条目，尚不能作为实际安装/卸载完成的证据。

新增 7 条核心回归覆盖版本不提升权限、原始输出隔离、超时、旧仓库身份失效、新身份重新授权、信任撤销、目录/末级/链式符号链接来源、准备后程序替换和链接环。核心累计 79 项通过。配置规划 11 项与原生 dispatch 1 项通过；原生测试确认慢版本程序执行期间仍能取得 Git mutex。两轴独立评审与修复见 `CODE-REVIEW-04.md`。

完整 Rust 回归已执行，但仍有计时失败：默认并行全量运行有 2 条桥接耗时超过 500 ms，随后串行全量运行有 1 条超限。没有放宽阈值；断言现补充进程启动与总耗时，以便后续定位。独立串行 8 条传输回归以及同依赖组合的失败项定向复测通过，不足以关闭上述间歇超时。

另对当前调试构建做 30 组本地诊断：纯版本查询 P95 12.35 ms，stdin 保持打开的桥接 P95 76.86 ms，服务缺失的桥接 P95 9.69 ms；三组均未超过 500 ms，桥接保持 exit 0 且 stdout/stderr 为空。这里测量的是父进程观察到的完整启动至退出时间，包含 Python 等待轮询的时间误差；不是主入口后的 50 ms 精确测量，也不是发布构建 NFR 验收。原始数据保存在本机忽略文件 `.artifacts/observer-startup-diagnostic.json`。

类型检查、前端生产构建、2 条前端呈现测试、三 crate Clippy 与格式检查通过。新增版本检测按钮的原生交互、实际配置文件的备份/原子更新/并发保护、管理策略检测、helper 安装与完整生命周期仍待完成。
