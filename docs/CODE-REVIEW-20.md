# Local changes 与历史 Review 增量评审

范围为 `.artifacts/context-review/before/` 至当前源码，需求依据为用户本轮的 ±1 上下文按钮、独立 Full file、Local changes 命名与 AI Commit 不代表 Review。没有新增提交。

## Standards

发现并关闭 3 条实质并发/缓存问题：整份 Review 保存回复迟到时覆盖撤销；不同 Parent/比较方向缓存未失效；刷新 Review 时切走小 Diff tab，返回后保留旧标记。当前硬问题 0、判断项 0。

## Spec

发现并关闭 1 条实质问题：同一冻结范围的两份 Diff tab 中，晚到的保存回复会恢复已经撤销的 Review。与 Standards 第一项相同。当前无剩余具体 P1/P2。

两名评审只读复核代码，没有自行运行 UI。根任务随后执行的 6 条交互回归全部通过，包含迟到保存/读取、跨方向缓存、读取中隐藏 tab 和失败重试。最初竞态夹具把新读取完成断言放在旧 Promise 释放之前，与已有读取队列约束冲突；修正释放顺序后保留最终状态断言。
