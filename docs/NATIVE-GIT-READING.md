# macOS 原生 Git 阅读与恢复验收

2026-09-14，在隔离的 `Proof Context Review Check 2` 应用及自建 500 行仓库执行。来源为 `52aaf2a-context-review-worktree` Release，主程序 SHA-256 为 `86aac2d0f9c7f3b7e5de79c5c96fd03b5c425069a69c5be9b2bfeac10f0f0803`。测试应用仅改 bundle 身份、隔离配置入口及签名。

## 文件历史与 Blame

当前 Worktree 的第 20、420 行显示未提交变化，不指定作者。选中最新 Commit 后，第 20 行恢复为该提交内的 baseline 内容；第 10 行显示已提交修改和真实 Git 作者。选择重命名前的 Commit 后，填写旧路径 `src/source.ts` 能读取原版本，第 10 行也是原始内容。分页从 1–400 切到 401–500，第 420 行的未提交状态保持正确。

关闭弹窗后返回同一文件的 Full file 搜索，`baseline-250` 仍为 1/1；原生截图确认第 250 行位于可见代码区中部。阅读过程不改文件、Index、HEAD、配置或 Review。

## 丢弃与恢复

预览第一个 Hunk 后，SQLite 已有 `prepared` 恢复点，保存的原内容指纹等于文件原指纹。执行丢弃仅移除第 20 行修改，第 420 行保持；状态变为 `applied`。从恢复点确认撤销后，文件逐字节恢复，状态为 `undone`。

第二次丢弃后，在外部把第 420 行改成新内容，再从原生窗口确认恢复，返回 `STALE_CONTENT`。新文件内容及原恢复点均保持。清理这次受控测试编辑后，通过正常恢复入口完成撤销，两个恢复点最终均为 `undone`。

## 外部编辑器

首次点击“在外部编辑器打开”进入对应设置。通过 macOS 原生文件选择器选择 `/System/Applications/TextEdit.app`；保存时 TextEdit 仍未启动。随后点击 Diff 的打开入口，系统启动 TextEdit，窗口 URL 明确为测试仓库的 `src/history.ts`。

在 TextEdit 修改第 20 行并保存，Proof 自动显示新 Diff，没有点击刷新。撤销该编辑并保存后，原文件指纹恢复，TextEdit 已退出。所有步骤的 Index、HEAD、Git 配置和 Review 记录保持不变。只在隔离 Proof 数据中保存了测试编辑器配置。

## 证据与剩余范围

原生结果及 Git/SQLite 检查点在 `.artifacts/native-git-reading-01/native-acceptance.json` 和同目录 JSON。`checkpoint.py` 对比精确文件内容、Index、HEAD 引用、Git 配置、Review 表和事件表；恢复前后内容和状态也单独记录。

本次补齐的是 macOS 正常路径、Blame 基准/分页/导航和新修改保护的原生证据。Windows、完整键盘/200% 缩放、故障注入全矩阵及完整 NFR 仍未完成。随后发现并修复的文件历史重试问题另见 `CODE-REVIEW-21.md`，不把此前包的原生证据冒充该修复的运行结果。
