# Proof 桌面界面与窗口

## 当前构建与原生复验

当前本地包为 `.artifacts/builds/52aaf2a-large-diff-worktree/Proof-macOS-arm64.zip`，SHA-256 为 `25c6587011dd6684b1ea411f73efdd190df13191b63dac09cc1e60f9e70e83ed`。162 个输入在构建、打包及原生验收后核对一致，签名和 ZIP CRC 通过；仍为未公证的本地 Alpha。

Mac 解锁后，在先前并发读取包中实际验证了独立标题栏隐藏、系统窗口控件、Cmd+3、History→独立 Diff、Cmd+W 仅关闭当前 Diff、全屏进出及 About 面板关闭。证据为 `.artifacts/desktop-chrome-native-verified.json`。当前 Release 隔离副本另完成大 Diff、取消与后续 Stage/Commit、历史比较的真实 Tauri IPC 验收，见 `LARGE-DIFF.md`。精确交通灯几何、拖动/最小化矩阵及完整资源预算仍未关闭。

用户于 2026-09-14 再次要求参考 Fork / GitKraken 改善外观和交互，并去掉 macOS 外层原生标题栏。这次调整直接作用于现有产品，保留 Changes、独立 Commit 和独立 Diff tabs 的职责。

## 参考与选择

核对 [Fork 官方 Mac 主界面](https://fork.dev/images/carousel/carousel_mainMac.jpg)、[并排 Diff 示例](https://fork.dev/images/carousel/carousel_commitviewMac2.jpg)及 [GitKraken 的界面指南](https://help.gitkraken.com/gitkraken-desktop/interface/)。参考页面的版本和截图仅代表官方示例。

| 参考交互 | Proof 的处理 |
| --- | --- |
| 仓库操作、导航和内容各有固定位置 | 仓库工具栏 48px、页面与比较 tabs 38px；打开 Diff 不挤压仓库入口或触发临时换行 |
| 紧凑的引用树与连续提交线 | Commit 行 32px、文件行 28px，虚拟列表与图形坐标同步 |
| Diff 以文件和代码为中心 | 比较对象、Parent 与返回按钮合并为一条工具栏，去掉重复的比较标题 |
| 桌面 tab 的键盘与鼠标操作 | Cmd/Ctrl+1–4 切页、Cmd/Ctrl+W 关闭当前 Diff、中键关闭；左右键移动导航焦点，Enter 激活 |
| 搜索属于当前页面 | Diff 内 Cmd/Ctrl+P 聚焦该比较的文件过滤，不再聚焦隐藏 Changes |

## 视觉规则

中性灰阶划分窗口、导航与代码表面；蓝色突出当前选择。深色六个主要值为代码底色 `#1b1c20`、面板 `#222328`、窗口 `#27292f`、分隔 `#34363e`、正文 `#e7e8ed`、强调 `#8bb8fa`。浅色对应白色代码区、`#f5f5f6` 面板、`#eeeef0` 窗口、`#dedfe3` 分隔、`#25272c` 正文和 `#326dca` 强调。

系统 UI 字体承担导航、文件名与正文；SF Mono / Menlo / Consolas 承担代码和短 Commit ID，保留用户代码字号。动画用于按钮反馈、面板开合与页面切换，并保留 reduced-motion。没有新增网络字体或位图装饰。

本次本地设计检索仍返回 FAQ 落地页、霓虹配色和滚动入场，不适合 Git GUI，未采用。以上选择依据实际参考和用户工作流。

## macOS 窗口

采用 Tauri 的 `titleBarStyle: Overlay`、`hiddenTitle: true`，页面绘制到原标题栏区域。系统红黄绿按钮保留，配置位置为 `{x:16,y:18}`；仅 macOS Desktop 的工具栏预留左侧 88px。它们仍由系统处理关闭、最小化和全屏。

只有工具栏背景与明确的空白区标记 `data-tauri-drag-region`。按钮、Branch 选择器、输入框和 tabs 不标记拖动。窗口权限新增 `core:window:allow-start-dragging` 和 `core:window:allow-close`，仅限 main 窗口；双击行为由 Tauri 的原生窗口实现处理。参考 [Tauri 窗口定制](https://v2.tauri.app/learn/window-customization/)。Windows 保留原生窗口装饰。

Tauri 默认 macOS 菜单会在 WebView 之前消费 Cmd+W，并直接调用 AppKit `performClose:`。因此 macOS 采用原生 File 菜单转发关闭事件：有活动 Diff 时关闭该 tab，其余页面关闭窗口；Cmd+Shift+W 保留显式关闭整个窗口。原生红黄绿、Quit、隐藏、编辑、全屏及 Window 菜单功能保留。打开 HTML 弹窗时不把关闭事件或页面快捷键传给底层页面；普通 Commit 输入中的页面快捷键仍可用。非 macOS 继续处理 WebView 的 Ctrl+W。

## 验证边界

浏览器可以验证样式、几何留白、键盘导航、tab 生命周期和真实 Git 工作流；不能代替原生窗口的拖动、全屏及交通灯实际位置验收。当前 Computer Use 返回 Mac 锁定，原生交互需解锁后继续。测试截图使用明确的测试仓库数据，截图中左上角留白不是绘制的模拟窗口按钮。


## 本次交付

本地 Release 包：`.artifacts/builds/52aaf2a-desktop-chrome-worktree/Proof-macOS-arm64.zip`。149 个构建输入在构建前后逐项核对，App 签名及 ZIP CRC 已验证。使用 ad-hoc 签名，未公证；未提交的源码以 base Commit 和输入哈希单独记录。构建记录为同目录 `build-record.json`，当前指针为 `.artifacts/latest-build.json`。

最终完整界面回归 38 项通过，包含真实 Git 路径和原生菜单事件的前端处理；前端单元 29 项、完整 Rust 190 项（2 条 opt-in 跳过）及菜单代码更新后的桌面测试 3 项通过。尚缺上节列出的实际 AppKit 窗口操作验证。

## 后续核验与打包

浏览器实操发现演示 Merge Commit 的 Diff 起点错误显示为 Empty tree；已按所选 Parent 解析起点，实际切换 Parent 1 / 2 后分别显示 `ec48c90d` / `736ae249`，仍在独立 tab 内阅读。此次只有 `HistoryDiff.tsx` 的演示起点和对应 effect dependency 改动，真实仓库比较仍走原 API。类型和格式检查、Release 构建通过。

新包为 `.artifacts/builds/52aaf2a-desktop-chrome-followup-worktree/Proof-macOS-arm64.zip`，SHA-256 为 `af0c48026bf0271088162a94eebddc6a6dbac7da742a7e92d400c8a368e1a6c9`。149 个输入在构建及打包后核对一致；构建记录区分此前完整回归与本次浏览器补丁核验。仍为未公证的 ad-hoc 包，原生窗口点击因 Mac 锁定待完成。

标准仓库 30 次计时已完成，内容保持断言通过，但 7 个写入场景的 P95 超过 500 ms。结果及 Core / UI 的测量边界见 `PERFORMANCE.md`。

## 单文件读取与版本修复后的更新包

当前包为 `.artifacts/builds/52aaf2a-git-capture-worktree/Proof-macOS-arm64.zip`，SHA-256 `ca93b8952aef25e11d360923373ae086cab3cb6704e918670a00e743531870ae`；包含本页桌面调整、演示 Parent 修复及后续单文件捕获 / Review 回复一致性修复。149 个构建输入、严格签名和 ZIP CRC 校验通过，旧包保留。当前完整 UI 40 项、前端单元 30 项、proof-core 160 项通过（2 项 opt-in 未执行）。

浏览器再次查看了浅色 History 与已有独立 Diff tab；最终回归生成的深色 History 截图也已检查。macOS 原生桌面仍锁定，标题栏实际拖动 / 全屏及菜单点击尚未通过验收。当前包为本地 ad-hoc Alpha，未公证。

## 独立读取并发后的当前包

当前包更新为 `.artifacts/builds/52aaf2a-parallel-reads-worktree/Proof-macOS-arm64.zip`，SHA-256 `1825c6d093fb548a179e5aa7bf9438c83da04f7d8dc1db976127dbd271f143a5`。桌面前端输入与上轮一致，新增 Core 并发读取及其故障回归；163 项 Core、真实 Git UI 流程、标准计时与资源采样已完成，详见 `CODE-REVIEW-16.md` 和 `PERFORMANCE.md`。构建输入、签名及归档核验通过；实际原生窗口验收仍因锁屏待完成。
