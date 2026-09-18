# 文件历史重试增量评审

范围为 `.artifacts/file-history-retry/before/` 至当前 `FileHistory.tsx` 与对应 UI 用例。需求依据：HIS-02、SET-05 及第 29 章错误恢复。无新增提交。

原按钮只设置路径和 offset；相同值不会触发读取 effect。真实组件回归中，第一次历史 Blame 失败后再次点“读取”，界面始终没有恢复内容，见 `ui-red.log`。现在显式重读有独立触发值；Worktree Blame、历史列表分别提供重试，两个请求的错误各自保留，不因另一侧重读而消失。重复忙状态中的同目标读取受保护。

## Standards

硬问题 0，判断项 0。评审确认相同目标可重读，专用 Blame 重试保持分页 offset，旧目标回复及旧数据代次继续被拒绝。

## Spec

无具体新增问题。评审确认相同版本/路径恢复、独立错误状态、旧版本回复丢弃符合本轮需求。

两名评审均只读核对代码和聚焦 2/2 通过日志，未自行运行 UI。根任务先复现原失败，再确认同一用例通过；额外覆盖历史列表与当前 Worktree Blame 分别失败、分别恢复。初次组合故障夹具只拒绝首个请求，会被开发模式的 effect 重建消耗；调整为在测试明确解除前持续失败，保留真实重试后的请求增量断言。

随后完整 UI 70 条通过，包含实际 Release Core/Git；类型、格式、Release 构建通过。新版隔离 macOS 应用通过真实 FILE_MISSING 故障恢复，并在第二页读取失败后重试保留 401–500 的分页位置。原生结果和 Git/SQLite 保持断言见 `.artifacts/file-history-native-01/native-acceptance.json`。
