# Desktop chrome 与 Stage 读取优化复核

基线为 `52aaf2afe20a777b7bfa25cf2521e436d0f80c97` 加上此前已复核的 Diagnostics / Context 工作区内容；独立比较副本为 `.artifacts/performance-review-base/`。本轮未提交到 main。

范围包含用户再次提出的 Fork / GitKraken 风格与交互改进、macOS 去除独立标题栏，以及此前进行中的 Stage 等待优化。设计依据见 `DESKTOP-CHROME.md`。后者仍未完成标准仓库全部路径和原生 UI 的 NFR 验收。

## Standards

两位 reviewer 分别复核，以下是 Standards 轴已关闭的问题：

- 测量脚本继承 `GIT_*` 可能把测试写操作指向其他仓库：统一清理 Git 环境，实际诱饵仓库全文件哈希保持不变；Core 子进程收到的环境也核对通过。
- Core 关闭失败会跳过测量报告：关闭异常单独记录，报告仍写入；双重故障回归通过。
- 初版进程优化将 `wait-timeout` 引入普通读取路径，可能与既有 SIGCHLD handler 冲突：已撤掉该路径，改为无存活管道时 1 ms poll，其余仍为 10 ms；继续使用 try_wait，不新增全局信号处理器。
- Commit 自动聚焦输入框导致数字快捷键无法切走：页面快捷键先于普通输入拦截，仍遵守 IME、已处理事件及真实弹窗边界；草稿往返回归通过。

最终源码复核：未发现新的硬问题或判断项。原生菜单新增权限仅限 main；监听回调读取当前已提交的界面状态，晚到注册与卸载会清理；菜单与 macOS WebView 不重复处理 Cmd+W。

## Spec

Spec 轴已关闭的实质问题：

- 同样发现测量环境逃离自建夹具的问题，已由隔离回归关闭。
- Commit 输入框阻断页面快捷键，已修复并保留草稿。
- 独立 Context 关联弹窗不由 App 的 dialog 状态管理，数字快捷键会切换底层页面：先以实际 App 回归得到失败，再检查真实 `dialog[open]`，备注焦点及底层页面保持。
- 原生 About 在前台时，菜单仍可能操作后台 main：仅 main 为当前键窗口时路由到主界面；其他 AppKit 窗口执行当前键窗口的标准 Close，焦点读取失败不操作。已核对 Tauri/Tao 的主线程菜单分发和 isKeyWindow 语义，尚未作原生点击验收。

最终复核范围内无新增阻断项。没有用单文件 Core 时间替代完整 NFR，没有把 WebView 事件模拟当作 AppKit 实机结果。

## 证据

- `.artifacts/chrome-full-rust.log`：190 通过、0 失败、2 项 opt-in 未执行；覆盖最终 Stage/Review 和进程读取实现。
- `.artifacts/chrome-native-menu-tests-final.log`：最终原生菜单代码的桌面测试。受限沙箱曾使 FSEvents 测试无法收到通知；同一测试获文件事件访问后通过，记录在 `chrome-watcher-unrestricted.log`。
- `.artifacts/chrome-clippy-final.log`：全包、全 target 静态检查。
- `.artifacts/chrome-unit-tests.log`：29 项前端单元测试。
- `.artifacts/chrome-full-ui.log`：菜单接入前完整 37 项 UI 通过；最终菜单版本 `chrome-full-ui-final.log` 为 38 项通过，包含真实 Git 路径。
- `.artifacts/chrome-modal-shortcuts-red.log`、`chrome-final-focused-ui.log`、`chrome-native-menu-ui.log`：弹窗失败反例、修正后重点回归及菜单事件/非 macOS 分支验证。

Computer Use 两次返回 Mac 锁定。用户已授权操作 Proof，当前缺少的是可用的原生桌面状态；标题栏按钮位置、拖动、全屏、About 关闭及真实菜单快捷键仍待原生验收。

## 标准性能脚本后续复核

测量扩展到整文件、单 Hunk、选定文件和 All。Spec 复核补齐了整文件 Stage 的完整 Index / blob 断言，以及每次写操作后的全 Worktree 核对；避免部分 Stage 或中途误写被后续恢复掩盖。Review 声明改为只核对观察到的状态，明确重复目标标记不能独立证明迁移。

Standards 复核补齐自有 driver 的关闭流程：管道错误不跳过回收，超时依次 terminate / kill / wait，最后收尾读取线程和日志。实际 POSIX 回归使用忽略 SIGTERM 后暂停的 driver，验证强杀与回收。脚本最终 4 项测试通过（`.artifacts/perf-script-tests-final-02.log`），两轴限定范围内 finding 均关闭。

最终标准规模 30 次测量的功能校验通过，但 7 个写入场景超过 500 ms；结果和适用边界见 `PERFORMANCE.md`，不把评审关闭称为性能目标完成。
