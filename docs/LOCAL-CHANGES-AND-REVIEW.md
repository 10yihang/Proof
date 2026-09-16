# Local changes、上下文按钮与 Review

本轮按用户要求调整现有 Diff 阅读器。未提交页面命名为 **Local changes**；Commit/Amend 保持独立页面，历史比较仍从 History 选择后打开独立 Diff tab。

Commit 工作区左栏组合文件树与紧凑的提交表单，右侧直接查看与 Stage 当前 Diff。它与 Local changes 共用已挂载的 Diff 阅读器、文件选择和缓存，切页不重新创建编辑器；提交草稿独立保存。普通点击仅查看文件，勾选、⌘/Ctrl 点击和 Shift 范围选择用于批量操作。底部操作栏保留固定高度，选择和清除不会推动文件树。

这次交互参考用户提供的 Fork 文件树截图，以及 [GitKraken 的文件 Stage 工作流](https://help.gitkraken.com/gitkraken-desktop/staging/)：文件、Hunk 操作与提交说明同时可达。

## 阅读交互

上下文按钮常驻 Diff 工具栏：`−`、当前行数、`+`，每次一行；默认 3，最少 0。独立 `Full file` 按钮显示完整内容，再次点击恢复此前行数。在全文状态点击增减则基于此前行数调整一行。范围读取中禁用重复操作，失败或取消保留实际已加载范围。

0–2 行在原快照中裁剪未变化行；更大的范围只补入未变化上下文。原始 Hunk ID、变化行和可执行 Patch 保持，Stage 不会因为显示全文而扩大范围。Local changes 和 Commit/Branch Diff 共用此行为。

已直接查看本机 Fork 的 Diff 工具栏：`Decrease number of visible lines`、`Increase number of visible lines` 与 `Show entire file` 相邻；其未提交入口标为 `Local Changes`。本次只读取参考界面，没有修改参考仓库。

## Review 语义

Commit 的存在、AI 生成提交说明、Commit 和 Amend 均不产生 Review 结论。历史 Diff 默认 Unreviewed，用户可以按 Hunk 或文件主动标记、撤销；Binary/权限等非文本变化具有独立的文件 Review 单元。

历史标记按 Workspace、冻结的 base/target OID、路径和实际 Patch 身份保存。反向比较、其他比较范围和 Local changes 不继承该标记。保存前再次验证比较身份；历史结果不登记为可 Stage/Discard 的快照。Review 仅写入 Proof SQLite 的用户来源记录。

保存回复不携带整份 Review 状态。它只使对应范围、路径的缓存失效；当前页面通过带序号和取消能力的读取刷新，全部 Hunk 状态来自一次 SQLite 查询。重读期间保留代码并禁用重复操作。切走、切 Parent/方向、失败与迟到回复不会把旧标记作为当前状态恢复；失败显示重试入口。

## 验证范围

完整 Rust 213 条通过，2 条 opt-in 未执行；前端单元 41 条、完整 UI 68 条通过，包含真实 Release Core/Git。针对交互和缓存边界的 6 条用例在其中。类型、格式和 workspace/all-target Clippy 通过。

隔离 macOS Release 实测逐行增减、Local changes 与历史全文搜索第 250 行、Review 0/2 → 1/2 → 0/2。数据库仅有用户来源的显式标记/撤销；文件、Index、HEAD、Git 配置指纹保持。原生发现搜索输入会被 macOS 更正大小写，已禁用自动更正、自动首字母大写和拼写检查；此最后三项输入属性另有 8 条定向 UI、构建类型检查和最终原生输入/失焦验证。

本轮日志在 `.artifacts/context-review/`，原生记录在 `.artifacts/context-review-native-01/native-increment.json` 和 `.artifacts/context-review-native-02/native-acceptance.json`。包为 `.artifacts/builds/52aaf2a-context-review-worktree/Proof-macOS-arm64.zip`，仍是 ad-hoc 签名的未提交 Alpha。该增量不构成完整 P0 或全平台性能验收。
