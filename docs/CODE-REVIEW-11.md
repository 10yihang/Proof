# Hook、Commit 与 History Diff 复核

基线：e1d1acbc566fb485af917c21260c8ffd9699da7c。范围以用户最终明确的三个流程为准：可实际接入 Codex Hook；Changes 专注 Diff、Commit 独立；在 History 选择比较对象，在新 Diff tab 展示结果。

两位独立 reviewer 按 Standards 与 Spec 复核实现，并在隔离副本建立反例。已关闭的实质问题包括：卸载后的晚到安装、配置父目录替换、配置临时副本的中断清理、Helper 重新启动的完整性检查、数据删除预览过期及卸载后的部分失败、Rename 路径被目录复用造成串入其他文件、过期文件响应与空结果、非 UTF-8 Commit message、双选焦点引用，以及已有 Diff tab 忽略明确 Parent 选择。

最后的增量复核均为零剩余硬问题。此结论只覆盖本次改动，不代表整份 PRD 的 P0 全部完成。其他 Agent/平台兼容、人工关联修正与诊断导出等仍需继续实现。

验证记录与构建证据写入 ACCEPTANCE.md 和 .artifacts。实际 Agent 兼容测试与界面 mock、真实 Git + NDJSON 测试分别标识。
