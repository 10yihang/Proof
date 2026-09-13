# History 与 Diff tabs

依据用户 2026-09-13 的明确设计要求：在 History 中选择比较对象，结果打开在新的 Diff tab。入口不要求填写 Base/Target 表单。Changes 阅读 Worktree/Index Diff；Commit 独立负责 Stage、Commit 和 Amend。

- History 单击选择 Commit；双击、右键“查看此 Commit 的变化”或详情按钮打开它的 Diff tab。
- Shift、Cmd 或 Ctrl 加点击另一条 Commit，立即打开两者的 Diff。默认按图中的拓扑顺序从较早到较晚比较，可在结果中交换方向。比较是两个文件树之间的净差异。
- Branch 列表支持右键与当前/所选 Branch 比较，也可在 History 的分支侧栏多选。相同 Commit 上的不同 Branch 可以得到空比较。
- History 的选择与滚动位置保留。Diff tabs 可关闭；相同比较重新打开时更新明确指定的 Parent 和浅克隆可用状态。单次提交的 Merge Parent 可以在结果内选择。
- 每个 Diff tab 包含文件树、文件过滤、Unified/Split、行内差异、搜索、换行与原始 Patch。没有 Review、Stage、Discard 或 Commit 动作。变更到另一个 Worktree 时关闭前一个 Worktree 的 Diff tabs。

## 读取边界

`compare_refs` 将两个引用解析为固定的完整 Commit OID；之后文件读取不追随 Branch 更新。`compare_commit` 按原始对象字节解析 parent headers，不要求 Commit message 是 UTF-8。Root 使用 `diff-tree --root`；浅克隆缺失的父对象不当作空树。Git replace 不参与该比较。

文件列表按 NUL 分隔读取，最多 20,000 个文件。单文件使用明确的 literal pathspec，排除路径变成目录后的后代，防止 Rename 文件混入其他新增文件。外部 diff/textconv 禁用；多个文件 section 或非 UTF-8 文本不能被错误拼成一个文本 Diff，而会明确报错。Binary 展示变更状态。读取仍受核心输出大小和时限限制。

快照不加入 Git 写操作的快照表；即使将其 ID 送入 Stage，核心也会拒绝。所有界面结果都有请求代次；旧文件响应不能替换当前比较。

## 设计参考

核对了 [Fork 的提交列表双选比较](https://fork.dev/releasenoteswin) 与 [GitKraken 从图选择 Commit 后查看 Diff](https://support.gitkraken.com/working-with-commits/diff/)。Proof 按用户要求将结果放入独立 tab，History 保留导航位置。
