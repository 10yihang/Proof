# 空闲刷新增量复核

基线为 `.artifacts/idle-profile/before/`，补丁为同目录上级的 `review.patch`，当前候选输入为 `build-inputs.json`。源码仍是未提交的工作区。两位 reviewer 均只读检查源码及日志，没有代跑测试。

## Standards

独立 reviewer 未发现遗留硬问题或判断项。工作区/数据代次继续拒绝旧回复；调度关闭后不再发起读取。watch 注册的异步清理、失败锁存和代次校验保持。Native 队列固定单槽，失败不被覆盖；worker 的 stop+wakeup 能唤醒空队列与合并等待，当前 notify/Tauri 调用链未发现新增 join 互等。

后续追加检查确认：done/busy/failed 区分了已完成、暂时忙碌和需要恢复的失败；用户取消与旧请求不重启读取。关闭 tab 的 RAF 在回焦点前检查实际焦点，保留随后键盘操作。

## Spec

独立 reviewer 发现一个 P2：最后一次事件后的 Changes/File Diff 失败被按成功消费，健康监听下可能空白到 30 秒检查。已修正为有界重试，且驱逐失败的当前文件缓存（包括可加载摘要）。两种单事件失败及大文件摘要边界均有回归，问题关闭。

连续写入、busy/hidden 保留和错误合并没有新增阻断项。评审只关闭当前行为缺陷，原生 CPU 后测和完整 NFR-07 仍待完成。

## 验证记录

- `ui-red.log`：健康监听仍产生周期性 Changes，运行期失败没有降级提示，两项失败。
- `retry-red.log`：只有一个事件时，Changes 与 File Diff 的一次失败不能恢复，两项失败。
- `retry-ui-02.log`：上述恢复、大文件摘要缓存、Desktop chrome 四项通过。
- `final-unit.log`：40 通过；`final-ui.log`：52 通过，真实 Git 工作流已启用。
- `desktop-tests.log`：8 通过；`clippy.log`：完整 workspace/all-target 通过；`build.log`：当前 Release 构建通过。

上述日志均位于 `.artifacts/idle-profile/`。初次完整 UI 中出现的关闭 tab 焦点竞争已修正，最终完整回归通过。当前 Core/Observer 源码与上一轮 205 项完整 Rust 回归一致；本轮重跑改动所在的桌面模块，不把之前结果冒充新一轮全 workspace 执行。
