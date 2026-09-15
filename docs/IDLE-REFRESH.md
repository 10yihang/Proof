# 空闲刷新与原生资源诊断

## 基线

在 macOS M5 Pro / 24 GiB、AC 电源、固定大 Diff Release 构建的隔离测试应用中，打开 1,002 个变化文件的仓库，静置 300 秒后采样约 60.76 秒。主进程平均 CPU 为单核 2.14%，已回收的 Git 子进程 / 后代为 6.65%，合计下界 8.79%。Worktree 全部文件、Index 和 HEAD 引用保持。

记录位于 `.artifacts/idle-profile/before.json`。这里只测主进程及已退出后代的累计 CPU，不含 WebKit XPC；主进程最大采样 RSS 约 89.7 MiB。它足以暴露当前场景的空闲开销，但不构成完整 UI 进程树、PRD 标准/压力维度或 16 GiB 参考机验收。

采样器用 SDK 的 `proc_pid_rusage` 结构与 `mach_timebase_info` 换算，经本进程 100 ms CPU 和已回收子进程校准。首次错误的时间单位假设被校准拒绝，未用于应用测量。方法及原始记录保留在 `.artifacts/idle-profile/method.md`。

## 修改

此前即使文件监听正常，前端仍每 1.2 秒完整读取 Changes。现在只有监听不可用时保持这个频率；监听正常时，由文件事件触发刷新，30 秒检查一次遗漏事件及观察目录以外的配置变化。

- Native 只排队一个 dirty 信号，按固定 100 ms 窗口合并；连续写入不会无限延迟，最后一次事件不会被简单限流丢弃。错误单独锁存，不因队列满而丢失。
- 运行期监听失败携带工作区和注册代次。前端保留失败状态，迟到的 ready 不能覆盖；同时恢复轮询并显示原因。
- UI 以固定 120 ms 窗口响应事件。读取期间继续发生的事件、Git 操作忙碌或窗口隐藏时的 dirty 都会保留；回到窗口时立即核对。
- 暂时忙碌后 250 ms 重试，读取失败后 1.2 秒重试。失败的当前文件缓存（包含大 Diff 摘要）会清除，避免缓存阻止恢复；用户取消、旧文件/工作区回复不触发自动恢复读取。
- 关闭 Diff 后的延迟回焦点只在焦点仍属于关闭动作时生效，不覆盖用户随后用方向键选择的其他 tab。

Git 写入的实际校验、Index 锁、Review 内容身份和 Agent 观察权限未改变。

## 当前证据

前端 40 个单元、完整 UI 52 项通过，UI 启用了真实 Core/Git；桌面 8 项通过，包含实际保存/原子替换、持续写入与错误合并。类型、格式及全 workspace/all-target Clippy 通过，164 个构建输入核对一致。

两个单事件读取失败、健康监听仍轮询、运行故障未降级均有 red/green 回归。关闭 tab 的焦点竞争在完整回归中暴露，修复后完整 52 项通过。评审见 `CODE-REVIEW-18.md`。

隔离应用 `.artifacts/idle-native-01/Proof Idle Check.app` 已完成真实 Tauri 的普通保存和原子替换刷新，未点击手动刷新；所有夹具文件、Index、HEAD 和配置恢复并核对一致。随后静置 300 秒，采样 60.66 秒：主进程 0.117%、已回收子进程 0.269%，合计 CPU 下界 **0.386% 单核**，相同测量范围的旧构建为 8.786%。主进程最大采样 RSS 为 83,148,800 字节。报告为 `.artifacts/idle-native-01/native-acceptance.json` 与 `.artifacts/idle-profile/after.json`。

这组前后结果证明该固定夹具和已测进程范围的改善，**不包含 WebKit XPC，不构成完整 NFR-07 通过**。测量对象是空闲刷新候选（原源码二进制 `e2b81f…`），不自动套用于随后增加 Full file 的新二进制。

可试用候选另行归档于 `.artifacts/builds/52aaf2a-idle-refresh-candidate-worktree/Proof-macOS-arm64-candidate.zip`，SHA-256 为 `3b04b691b4c70308095f89a55912e8e2d3b8f55fafd07fc785cbbe77ab620479`。164 个输入、严格签名、ZIP CRC 与来源二进制一致性已验证；同目录 `build-record.json` 明确记录 `candidate-pending-native-verification`，未替换已核验包指针。它仍为 ad-hoc、未公证的本地 Alpha。

浏览器在 PRD 最小桌面尺寸 1024×720 下检查了 Changes 文件树与 Diff 工具栏，Context 自动收起；随后已恢复原预览尺寸。这项检查不替代原生窗口或完整文字缩放矩阵。

后测脚本要求明确传入 `--build`，并核对该记录的二进制哈希及被采样 PID 的执行路径，避免错误沿用旧构建元数据。旧脚本保留为 `.artifacts/idle-profile/measure-before.py`，原始基线报告未改写。归档包的构建记录保留当时待验收状态，后续原生证据以独立验收记录补充。
