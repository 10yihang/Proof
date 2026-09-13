# Git workflow refinement · 2026-09-13

本轮依据用户的六项明确要求：保留 Worktree 等 Git 术语；顶部 Branch 下拉直接切换；减少文件切换等待；文件保存后自动刷新；可跳过 Review、按文件/部分改动或全部内容 Commit/Amend；变化列表提供文件树。此要求更新了 PRD 中默认保留阅读快照、提交弹层和 Amend P1 的旧范围。Review 仍为独立记录，默认不约束 Git 提交。

## 交互

- 顶部 Branch 打开就地搜索面板，支持切换本地 Branch、创建 Branch、从本地已有 Remote ref 建立 tracking branch。不会自动 fetch、stash 或 force checkout；失败保留当前文件和草稿。
- Changes 默认嵌套文件树，可折叠、搜索和切换 List。按 Unstaged/Staged 分组，勾选多文件或对文件/目录直接 Stage/Unstage。过滤时目录和组动作只包含当前匹配文件。
- 独立 Commit tab 中提供文件 Stage/Unstage、Commit message、Amend 和 Commit。Changes 只保留 Diff 阅读与相关文件操作。无 Staged 文件时主按钮明确为 Stage all & Commit；更多操作中可显式把全部 Unstaged 加入。Amend 载入上一条说明，可只改说明，也可包含所选 Index 内容。未暂存的 Hunk 保留在 Worktree。
- 用户点击 Commit 后，核心捕获并校验 Index；普通入口无需弹出 Review 步骤。原有完整提交预览保留在 Command，设置中的 strict Review 仍只约束本应用。
- 缓存最多保留 24 个 Diff，并合并同版本的并发读取。文件版本由 HEAD、Branch、Index、操作/信任状态、有效 Git 配置/attributes 和该路径（含当前 side 的重命名旧路径）的文件元数据确定。不同文件的普通保存不会清空全部缓存。缓存不是写授权，Stage/Review/Discard 的原生快照仍做内容核验。
- 原生 notify 监听当前 Worktree 及其实际 Git/common 目录；事件合并后触发检查，1200 ms 定时检查与窗口聚焦兜底。当前文件自动更新，同文件保留阅读锚点；无法唯一对应原行时已有定位提示。监听失败显示降级并继续定时检查。浏览器 Demo 不执行本地 Git。

## 原生操作边界

批量 Stage 使用用户明确选中的真实 ChangedFile 列表，字面 NUL 分隔 pathspec，保留 rename 的旧路径。持有真实 index.lock，在私有 Index 上执行，再核对所选 Worktree 内容与仓库状态，发布前逐条核对未选择的 Index entry 保持不变，再整体发布一次。无效/过期列表不产生部分暂存。冲突、Submodule 和超过现有读取上限的内容明确拒绝，不自动处理。

Commit all 先得到批量 Stage 的实际状态 token，再用这个 token 捕获提交；外部 Stage/checkout 不应被静默纳入。Commit 继续使用原有私有 Index、Hooks/签名以及实际 tree/ref 核对。Amend 的父提交取被替换提交的父集合，根提交没有父节点；准备后 HEAD 改变时拒绝。上述 Git 提交操作不触发 Push、模型调用或 Agent 配置写入。

本轮 Hook 管理使 SQLite schema 升级到 6；Git 工作流本身不新增 Git 元数据。新增 notify 8.2.0 及其平台监听依赖，原有 lockfile 版本保留。

History → 新 Diff tab 的最终交互与边界见 [HISTORY-DIFF.md](HISTORY-DIFF.md)。

## 此前 Git 工作流验证记录

- UI 复现用例在修改前分别失败：返回已加载文件 300 ms 内仍显示前一文件；外部编辑 5500 ms 后当前 Diff 仍旧。修改后两项均通过，虚构 IPC 只用于 UI 路径验证。
- 核心 Git 集成：59 条通过，另 1 条延迟样本显式 opt-in。覆盖批量字面路径、全部或选中 Stage/Unstage、unborn、部分 Hunk Commit、根提交/说明-only Amend、过期 HEAD 拒绝、远程 tracking 与失败保留。
- 同机 debug 小夹具的 10 次原生 file_diff 调用：修改前 312–373 ms，最终修改后 319–400 ms；不足以声称冷读取性能改善。已加载文件的等待由缓存消除。完整大仓库 NFR 仍未完成。
- 完整 Rust 127 项通过（core 106、desktop 2、配置规划 11、传输 8），另 2 项 opt-in 默认跳过。macOS 文件保存/原子替换的真实 FSEvents 测试通过；执行环境需允许系统文件事件，默认沙箱中该用例曾超时。
- 前端模型 21 项通过；9 项 UI 回归与 1 项真实 Git 前后端流程通过，包含跨 Worktree 的晚到上下文隔离。真实 Git UI 用测试 NDJSON 替代 Tauri IPC，源于相同 Proof 核心：核对只提交第一 Hunk、未选 Hunk/文件保留、Amend 不改变父集合、Commit all 后 Index/Worktree clean。真实流程最终 HEAD `5dd4b32ea0dae01d6da41ba2ffe93bbc9c87b643`；临时仓库已清理。
- 两轴独立评审全部关闭，见 `CODE-REVIEW-08.md`。Clippy、类型检查、格式检查与前端/Tauri 构建通过。生产主 JS chunk 500.18 kB（gzip 146.30 kB），构建有体积提示；没有通过放宽阈值隐藏提示。
- Mac 已锁定，工具要求手动解锁，因此本轮原生桌面点击验收尚未完成。独立验证应用和夹具已创建，已有旧夹具保留。不能把无头浏览器流程说成 Tauri 原生验收。

运行：先 `cargo build -p proof-core --example ui-fixture-driver`，再设置 `PROOF_UI_CORE_BINARY` 为生成的可执行文件，执行 `npm run test:e2e`。可选 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向已有 Chromium。没有指定核心驱动时，真实 Git UI 用例显式跳过。
