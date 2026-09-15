# 大 Diff 阅读与取消

Changes 和独立历史 Diff tab 共用分级读取。超过 1 MiB Patch、10,000 行或单行 64 KiB 时，先显示路径、比较基准和“加载 Diff”。摘要没有可写 snapshot ID、Patch 或 Hunk，不计入 Review。小 Patch 即使位于较大的原文件中，也直接打开。

主动加载仍受 8 MiB Patch、100,000 行上限保护；Worktree 文件原有 32 MiB 读取上限保留。达到硬上限后显示原因，不把未加载解释为无变化。摘要上的整文件 Stage 使用原有路径选择和 Index 校验流程。普通 Commit 预览单独列出无法统计 Review 的文件；Strict Review 在实际写入前重新检查并拒绝这些文件。

用户切换文件或点击“取消读取”时，只取消本窗口拥有的一次只读请求。Tauri 先登记票据、再单次领取；取消先于分发时，票据不能复活。作用域仅允许文件读取、Commit/Branch 比较，不能用于 Stage、Commit 或 Hook 生命周期。Unix 上，当前请求的并行 Git 读取继承取消标记，其自有进程组被回收。Windows 的后代进程退出行为仍需原生验证。

后台刷新按文件版本处理。所选文件版本未变时，其他文件更新不会取消用户主动加载的大 Diff。关闭再打开历史 tab 时，过大的正文会释放，只保存比较 OID、路径、源行和行内偏移；恢复期间根据实际行高校准，用户的滚轮、指针和导航键可立即中止。

## 容量

| 层 | 上限 | 说明 |
| --- | --- | --- |
| Core 可写快照 | 64 项且 64 MiB 内容容量 | 统计所存克隆的字符串和数组 capacity，释放相关 context |
| Changes 展示缓存 | 24 项、16 MiB 内容估算 | 可单独保留当前一个大项目，其大小仍受读取上限约束 |
| 每个历史 tab 展示缓存 | 64 项、8 MiB 内容估算 | 过大的正文不入缓存，tab 隐藏时释放；位置书签最多 64 项 |

这里的容量不等于进程 RSS，不包含 WebView、分配器及所有短暂对象，不能替代完整 NFR 内存测量。

## 验证

完整 Rust 回归 205 项通过，2 项 opt-in 未执行；前端单元 35 项、完整界面 47 项通过。最后补充导航键中止校准后，历史 Diff 与桌面快捷键定向 4 项通过；原生状态注入参数收敛后，桌面 6 项通过。类型、Rust 格式、全 workspace/all-target Clippy 与相关 Prettier 检查通过。

真实 Git 测试验证了 51,000 行全量替换：可预览并普通 Commit，Strict Review 拒绝且 HEAD/Index 保持。另验证大单行、小改动大原文件、历史只读、快照容量回收及取消后仍可正常 Stage。界面覆盖显式加载、不因其他文件刷新退回摘要、取消按钮、未知覆盖标识和大历史 Diff 重建；源行恢复严格比较行标识和像素偏移，连续三轮通过。

自有 1,003 个变化文件夹具 `.artifacts/large-diff-native-01/manifest.json` 的一次 Core/NDJSON 诊断中，默认摘要约 297 字节，主动加载结果约 5.20 MB。这是单次链路诊断，不是原生界面响应时间、P95 或内存预算结果。

完整 UI 的真实 Git 用例通过测试 NDJSON transport 调用当前 Release Core，验证实时保存、Branch、选择 Hunk Commit、Amend、Commit all 和数据删除后的 Git 字节保持；它不代表 Tauri IPC。评审见 [CODE-REVIEW-17.md](CODE-REVIEW-17.md)。

当前 Release 另通过隔离 macOS 应用的真实 Tauri IPC 验收：1,003 文件仓库中的大 Diff 默认摘要、主动加载、取消、取消后切换文件，以及选择大文件 Stage/Commit 均成功。实际 Commit 仅包含 `generated.js`，剩余 1,002 个未暂存文件、全部 Worktree 文件内容和 Git 配置保持；SQLite 中 Review marks/events 均为 0。随后从 History 打开的独立 Diff 正确比较 `1c2b7106` → `8e377ca9`，也经过摘要/加载两步。

受控 Git 原本等待 20 秒；点击取消后提前退出，采样从读取标记出现到进程回收为约 5.09 秒，其中包含点击前的操作时间，不能当作取消处理延迟。进程组为空。证据位于 `.artifacts/large-diff-native-01/native-acceptance.json`、`cancel-lifetime.json`、`commit-result.json`。验收副本只增加独立 bundle ID、固定夹具环境启动器并重新签名，源码构建指纹与发行候选相同。CUA getApp 的 1,330.7 秒初始化等待单独记录，不计入应用启动测量。

## 设计依据

参考 [GitKraken Desktop Diff 文档](https://help.gitkraken.com/gitkraken-desktop/diff/)的文件阅读结构，以及 [Fork Mac 的 Load diff 使用反馈](https://github.com/fork-dev/Tracker/issues/2651)。[Kepler 的大 Diff 主动加载](https://help.gitkraken.com/kepler/review-changes/)仅作为另一产品的交互参考。上述产品的阈值不作为 Proof 的性能结论；Proof 的边界由自有夹具验证。
