# Shared Diff workspace

2026-09-14。

Local changes、历史 Diff tab 和独立 Diff 窗口共用 `DiffFilePane`、`ResizableWorkbench`、`DiffView`。独立窗口也复用 App 的阅读、设置和人工 Review 流程。Local changes 的 Stage / Discard 操作仍只针对本地变化；历史比较不提供 Git 写操作。

## 使用

- Diff 文件栏可切换 Files / Change groups；AI Group Changes 只分析此 tab 的两个固定 Commit。支持改名、移动文件、创建分组、Ungroup 和 Ungroup all。
- 左侧关闭按钮 / 顶栏 Files 按钮收起和恢复文件栏；右侧 AI Review / Close 控制审查面板。分隔线可拖动，也支持方向键、Enter 收起。Cmd/Ctrl P 恢复文件搜索；专注阅读可用 Escape 退出。
- 历史 Diff 顶栏 Open in Window、本地 Diff 工具栏的独立窗口按钮，分别打开当前比较或当前文件侧。历史窗口固定 base / target OID；本地窗口继续监听 Worktree。原窗口保留。
- 同一比较的分组保存在 `comparison_change_groups`，键为 workspace ID / base OID / target OID，与 Local changes 的 `change_groups` 分开。表采用附加 DDL，保留现有 schema 7 最低兼容标记和 Observer 表格式。Revision CAS 拒绝迟到的覆盖；删除 Workspace 时由外键清理。通知仅触发重新读取，Git / SQLite 决定最终状态。

## 窗口生命周期

Rust 创建固定内部 URL 的 Webview，URL 不包含路径或 Git refs。窗口的选择范围保存在进程内的窗口注册表，读取上下文时按实际窗口 label 查找并重新校验工作区和文件。比较必须是不可变 OID；最多 8 个窗口，关闭后移除注册。

读取取消票据、文件监听均按窗口归属清理。关闭一个 Diff 窗口不停止其他窗口的监听和 Observer；最后一个窗口关闭才停止前台 Observer 循环。分组、比较 Review 和数据清理在窗口间发失效通知；每个窗口通过核心重读，数据 epoch 变化会丢弃旧回调和语法缓存。

## 高亮

Prism 按文件语言解析 TypeScript / TSX / JSX、JavaScript、Go、Rust、Python、JSON、YAML、TOML、Shell、C / C++、Java、SQL、Markdown、HTML / XML / CSS 等。函数、类型、数字、常量、属性和标签有独立颜色。每个 Hunk 的旧 / 新侧分别解析多行注释和字符串。

输出为文本区间，React 渲染文本，不插入高亮 HTML。语法颜色、行内差异、搜索和可见空白共存；语法复杂时优先保留 Diff / 搜索标记。单块最多 50,000 字符，每次预解析预算 100,000 字符；大文件回退到可见行解析。缓存按字节与条数限制，数据清理时清空；原文不裁剪。

## 验证与参考

Rust 覆盖历史全量分组、分组内 Review、比较 OID 固定、Local changes 隔离、revision 冲突、重启读取和删除后的清理；窗口选择拒绝外部 URL。浏览器覆盖共享分组、侧栏关闭 / 恢复、独立窗口请求与初始视图、快捷键、语法高亮和原文保留。

原生窗口创建的代码已构建；实际 macOS 新窗口的手工验收仍需运行本地构建的授权，不以浏览器夹具代替原生验收。日志和截图在 `.artifacts/diff-workspace/`。

交互参考用户提供的 Fork 截图，以及 [Fork release notes](https://git-fork.com/releasenotes) 中的独立 revision details window 与提交比较流程；[GitKraken Diff](https://help.gitkraken.com/gitkraken-desktop/diff/) 说明提交比较与语法着色。语法解析依据 [Prism token stream](https://prismjs.com/extending.html)。
