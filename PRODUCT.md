# Product

<!-- impeccable:product-schema 1 -->

产品定位与平台范围于 2026-10-04 经用户确认。以下能力和约束依据现有仓库说明记录；需求文档与局部测试不代表所有能力已经完成发布验收。

## Platform

web

## Users

主要用户是在 AI 编程过程中承担最终审查与提交责任的开发者。他们继续使用自己的 IDE、终端和 Coding Agent，需要在提交前理解真实代码变化、检查相关证据，并明确哪些内容经过人工审查。

普通人工编码和混合编码流程同样适用。基础 Git 与人工审查流程可以独立使用，不要求接入 Agent、模型服务或账号。

## Product Purpose

Proof 是面向 AI 编程场景、以人工审查为中心的 Git 客户端。它把真实 Git Diff、人工审查状态、可选的任务上下文和显式发起的 AI 审查放在同一个工作空间，帮助用户决定哪些变化可以进入提交。

成功意味着用户能理解修改内容和比较基线，分清未读、已审查与已失效的结果，并准确完成自己选择范围内的暂存和提交。AI 结果与运行证据提供参考，最终判断由人完成。

## Positioning

核心机制是将内容版本与人工审查状态绑定，并在真实 Git 工作流中呈现可追溯的辅助上下文。用户无需把编程过程迁入 Proof，也无需让 AI 替自己批准或改写代码。

Proof 的主定位不是 Agent 运行平台、聊天产品或企业 AI 人力管理系统。不宣称替代所有通用 Git 客户端能力，也不把审查记录表述为代码正确性或合规保证。

## Operating Context

- macOS 桌面优先。现有界面使用 React/TypeScript，运行于 Tauri WebView；本地真实 Git 操作由 Rust/Tauri 原生层执行。这里的 `web` 是界面技术分类，不表示浏览器是正式产品交付目标。
- 浏览器用于演示。开发服务和显式 demo 模式提供模拟数据；演示操作不执行真实 Git，原生读取失败不能静默回退为演示数据。
- 用户主要以键盘和鼠标操作本地仓库及 worktree，配合外部 IDE、终端和 Agent CLI。仓库、worktree 和不同克隆的状态需要正确隔离。
- 常用流程：打开仓库 → 查看未暂存/已暂存变化 → 阅读文件与 Hunk → 人工审查 → 暂存选定范围 → 检查 Commit/Amend 内容 → 显式提交。
- Commit 使用独立页面。History 支持选择提交和分支；比较结果进入独立 Diff 标签页。界面需要保留长时间阅读代码时的位置与上下文。
- AI 分组、AI 审查和提交信息生成由用户显式发起。被动 Observer 另行授权，未启用时普通 Git 工作流仍然完整可用。

## Capabilities and Constraints

### Existing capabilities

- Changes 文件树、筛选与搜索；统一/左右对比的只读 Monaco Diff；Hunk 导航、上下文展开、完整文件与原始 Patch 阅读。
- Stage/Unstage、Commit/Amend、History 图与分支比较，以及仓库说明中记录的网络操作和 Stash 工作流。具体支持范围以对应功能文档和当前实现为准。
- 手动或 AI 辅助的逻辑变更分组只管理审查元数据，不改写源码、Git index 或提交；同一路径的已暂存与未暂存版本分别处理。
- AI finding 绑定代码快照和位置范围。“采纳/不采纳”记录用户意图，不能表示问题已经修复；导出给 Agent 的指令不等于 Proof 自动修改代码。
- 分组、审查、提交信息使用相互独立的提示词。原生会话由对应 Agent 管理，可通过提供的 CLI 恢复命令继续，不接管或覆盖其他会话；默认会话列表的可见性遵循各 CLI 的规则。
- 上下文支持手动关联、备注、解除和撤销；用户标签与原始证据分别保留。

### Durable constraints

- Git 状态与内容是真实修改的依据。显示 Diff 的算法结果不能直接成为可执行 Patch 的权威来源。
- Reviewed、Stage、Commit、Push、命令成功和测试证据是不同状态。分组或 AI 审查不能自动标记人工 Reviewed；“没有 finding”不能表示代码正确。
- 内容、相关上下文或比较基线无法严格匹配时，受影响的人工标记转为待复核；可严格证明一致的局部记录可以保留，相关工作区变化仍需重核整体结论。AI 报告与输入快照不匹配时标为过期。保留阅读上下文，但拒绝基于过期状态的写操作。
- Git 写操作必须明确目标和范围，检查信任、基线与内容，并读取实际结果。丢弃修改需要可理解的预览和恢复边界；恢复不能覆盖更新的内容。
- 不为方便而静默修改 `safe.directory`、全局 Git 配置或用户 hook；不通过隐式 stash/reset/覆盖或自动重试绕过写操作保护。
- AI 使用用户已安装并正常认证的本地 CLI。Proof 不要求配置模型 API Key；AI 不能自行修改源码、index、提交或人工审查状态。
- Observer 按 Agent、仓库与采集字段显式授权，接入过程需要预览、所有权和备份边界，并保留用户已有 hook。它不能改写 Agent 的工具执行或权限决定。
- 上下文关联不证明某个 Agent 独占文件或 Hunk 作者身份。未知、缺失、过期和采集间隙需要可见；命令退出成功、结构化测试结果与 Agent 自述分别呈现，并注明适用快照与范围。
- Proof 的本地审查记录与源码仓库、Agent 原始记录分开管理。删除 Proof 元数据不能删除源码或 Agent 原始历史；前端不暴露通用 shell/文件系统执行桥。
- 诊断导出需要预览及用户显式保存或分享，默认排除源码、提示词、原始输出、私有路径、远端地址与秘密。不宣称数据库加密、完全脱敏或合规认证。

### Open decisions

- 商业模式、定价和对外许可承诺尚未确认。
- Windows/Linux 正式发行范围、最低系统要求及发布时间尚未确认。
- 完整浏览器产品不在本轮确认范围内；如将来扩展，需要重新确认真实 Git 与数据访问边界。

## Brand Commitments

保留产品名称 Proof 和已有应用资产（`src-tauri/icons/`）。现有应用描述为“看清变化，认真审查。”产品语言应清楚表达动作、范围和状态，对未知信息保持诚实。

现有视觉系统由 [docs/DESIGN.md](docs/DESIGN.md) 记录；本文件不定义配色、字体、组件或动画方案。

## Evidence on Hand

- [README.md](README.md)：现有能力说明、启动方式与浏览器演示边界；版本文字不能单独作为发布证明。
- [docs/PRD-v1.0.md](docs/PRD-v1.0.md)：产品需求及后续补充。早期范围可能已被后续条款更新，应结合当前功能文档与实现判断。
- [docs/GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md)、[docs/HISTORY-DIFF.md](docs/HISTORY-DIFF.md)、[docs/HISTORY-ACTIONS.md](docs/HISTORY-ACTIONS.md)：Git 操作、比较与 History 契约。
- [docs/AI-ASSISTED-REVIEW.md](docs/AI-ASSISTED-REVIEW.md)、[docs/CONTEXT-ASSOCIATIONS.md](docs/CONTEXT-ASSOCIATIONS.md)：AI 和上下文能力及其边界。
- [docs/DATA-MANAGEMENT.md](docs/DATA-MANAGEMENT.md)、[docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md)：本地数据管理与诊断导出契约。
- [docs/DESKTOP-CHROME.md](docs/DESKTOP-CHROME.md)、[docs/PERFORMANCE.md](docs/PERFORMANCE.md)、[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)：桌面行为、性能方法与验收范围。
- `src/demo.ts`、`src/graph-demo.ts` 提供虚构演示素材；`tests/ui/` 和核心测试提供各自范围内的证据。浏览器结果不证明原生 Git、真实 Observer 链路或桌面性能已通过验收。

尚无在本轮确认的客户证言、市场唯一性、对外性能保证或完整发布验收结论，后续文案不得自行补造。

## Product Principles

1. 先让用户看清真实代码和比较基线，再提供辅助解释。
2. 人工决定始终明确；状态、范围和失效原因能够追溯。
3. 尊重用户现有编程流程，AI 与 Observer 都是可选能力。
4. 并发变化时维持阅读稳定性，安全拒绝过期写操作。
5. 本地数据与证据边界清楚，验证结论不超出实际证明范围。

## Accessibility & Inclusion

现有产品要求包括完整的键盘操作路径、可见焦点、正确的焦点恢复与输入法行为；拖拽和右键菜单不能成为唯一入口。关键控件需要可理解的辅助技术标签，状态不能只靠颜色表达。

界面需要支持文本缩放与 200% 缩放检查、明暗主题中的可读性，以及系统减少动态效果偏好。这些是持续验收要求，本记录不宣称所有页面已经完成无障碍审计。
