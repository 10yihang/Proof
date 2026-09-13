# External editor · 2026-09-13

依据 PRD DIFF-02、SET-01、SEC-02。Proof 的代码视图保持只读；用户点击工具栏或 Command 中的“在外部编辑器打开”后，显式将当前 Worktree 文件交给所配置应用。该功能不创建临时可编辑的 Index/历史版本，也不把打开文件记录成 Review 或测试通过。

## 产品流程

设置 → 外部编辑器，可选择应用默认或此仓库覆盖。仓库继承默认、独立指定编辑器或禁用均有明确显示；linked Worktree 共享 repository UUID，独立 clone 不共享覆盖值。设置读取已安装应用位置并允许原生文件选择器/绝对路径。保存只写 Proof 的设置，不启动应用；没有有效配置时，打开入口引导到设置。

Changes 的 Diff 工具栏和 Command 都有入口，Command 固定显示其文件目标；History 中不启用这个入口。Staged Diff 的入口仍打开当前 Worktree 文件；保存后使用已有自动刷新。删除的文件、符号链接、硬链接和 Git 内部路径会明确拒绝。未信任的 Worktree 不能将文件交给可能运行扩展的外部应用。

## 配置与执行

- 设置在现有 SQLite `settings` 表中使用 `editor:application`、`editor:repository:<UUID>`、`editor:revision` 命名空间。读取在同一事务中完成，写入采用 revision CAS；保存失败保留草稿，关闭设置后才到达的失败也报告。schema 仍为 4。未来全产品删除需清除此命名空间，不能只清观察数据。
- macOS 选择 .app。原生层读取限长的 Info.plist。流式解析只提取必要的顶层字符串，最多 16384 个事件、32 层、1 MiB 累计解码量；不构建可指数展开的完整 Value，只拒绝重复的应用身份字段，兼容真实应用中重复的其他元数据。使用精确锁定的 plist 1.10.1 stream API。要求 APPL、单文件名的 CFBundleExecutable，应用元数据与实际程序都必须位于规范化 bundle 内。程序必须是具有执行权限、非 group/world writable 的普通文件。允许配置是用户选定的应用路径，元数据身份检查不代表发布者签名认证。
- 程序路径及各级符号链接来源复用已有程序检查；若来自已登记 Worktree，必须核对当前仓库身份和信任。原 Observer 的协议与错误行为保留。
- 打开请求从原生持有的 Diff snapshot 得到 workspace/path，检查实际 Worktree 目录和目标文件。Unix 逐级 openat/no-follow，持有只读文件句柄避免 inode 被复用。读取当前文件内容不要求与旧 Diff 相同，但排队期间文件被替换、应用变更、设置或信任撤销时拒绝。
- 运行在 Git mutex 之外。macOS 固定调用 `/usr/bin/open -a <application> <absolute-file-path>`，不经过 shell，不使用默认文件关联，不传 `--args` 或等待编辑器退出。返回成功仅代表系统接受 handoff，不声称编辑器已显示文件。固定 launcher 有 10 秒限时。
- 这是路径 handoff；第三方编辑器在最后检查后自行解析路径，并控制后续编辑和扩展行为。不能宣称 Proof 锁定了外部编辑器的全部文件访问。Windows 有 .exe 直接参数传递分支，尚未原生验证，不能作为 Windows 交付证据；其他平台明确不支持。

## 当前证据

9 条核心定向测试已通过，涵盖应用/仓库设置与 linked/clone 隔离、revision/存储失败、当前 Worktree 与 Staged 的区别、字面特殊路径、排队后的设置/信任/程序/目标变化，以及 symlink/hardlink/删除/内部路径拒绝和元数据解析边界。测试 handoff 使用本地受控回调，未启动用户编辑器。

共享程序模块的 7 条 Observer 回归通过，真实 CLI --version opt-in 仍跳过。5 条新增 UI 回归通过：配置不会启动及仓库覆盖；冲突保留草稿及关闭后错误可见；同文件后台更新后启动失败仍可见；History 禁用 Command；菜单固定文件目标。

本机只读枚举已确认可识别 Code（Visual Studio Code）、IntelliJ IDEA、TextEdit、Zed，未启动这些应用。

完整 Rust 135 项通过、1 项既有桥接计时失败、2 条 opt-in 跳过；失败项定向重试通过但原因仍未关闭。前端模型 21 项、UI 14 项及实际 Git 流程 1 项通过。两轴评审已关闭，见 `CODE-REVIEW-09.md`。实际原生编辑器窗口与选择器验收尚未完成：当前 Mac 锁定，CUA 要求手动解锁。没有安装 Agent Hook 或执行模型。

前端及 Tauri 调试构建通过。新可执行文件放入未改资源的独立 bundle 副本，ad-hoc 签名与严格完整性检查通过；未覆盖正在使用的旧应用。114 个构建输入逐项核对，构建来源与应用位置记录在 `.artifacts/latest-build.json`。该包未公证；主 JS 509.17 kB（gzip 148.59 kB）的构建体积警告保留，未将其视为大仓库性能验收。
