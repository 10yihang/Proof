# Git 操作性能测量

## 范围

`scripts/measure-git-baseline.py` 通过真实 Release Core 的测试 NDJSON 驱动测量 Changes、无 Core 缓存的 File Diff，以及 Stage / Unstage。计时从写出请求到完整解析响应，包含传输与 JSON；不包含 WebView、点击处理、操作后的界面刷新或绘制。

夹具只由脚本在新的临时目录创建，不接受用户仓库路径。标准规模为 10,000 个 tracked 文件、100,000 个线性 Commit、100 个变化路径和累计 10,000 行文本增删。历史 Commit 共用初始 tree，因此这套夹具不证明 History 图或历史 Diff 的压力表现。变化覆盖普通修改、mixed staged/unstaged、staged rename 和 untracked。首个文件有两个间隔开的 Hunk。

每个场景至少 30 个样本，P50 / P95 使用 nearest-rank。初始完整 Worktree 校验会预热操作系统文件缓存；Changes 的重复读取不是首次进入页面或冷启动。`uncachedFileDiff` 表示 Core 重新生成 Diff，不能代替 UI 缓存命中或首次绘制的验收。

## 操作与校验

| 场景 | 执行动作 | 计时外的结果校验 |
| --- | --- | --- |
| 整文件 | Stage 两个 Hunk，随后 Unstage | 精确完整 Index entries、完整目标 blob、两个 Hunk；Unstage 恢复初始 Index entries |
| 单 Hunk | 只 Stage 第一个 Hunk，再 Unstage | Index 只包含首个 25 行修改；第二个 Hunk 保持在 Worktree；其余 Index entries 不变 |
| 选定文件 | 两个普通修改、一个 mixed 文件、一个 untracked 文件 | 对选择范围建立独立预期 blob；未选中的 Index entries 不变 |
| All | Stage 99 个 Unstaged 路径，再 Unstage 所有 100 个 Staged 路径 | 完整 Index 预期；Unstage 包括 rename 原路径并最终等于 HEAD tree |

每次写请求返回后、任何夹具恢复之前都核对完整 Worktree 的路径、类型、权限和文件内容，符号链接仅检查链接本身，不遍历目标。Git 元数据另行核对。批量 Unstage 会按用户动作移除原本已暂存的 mixed / rename 内容，因此在计时外恢复自有夹具的初始 Index，让下一轮从相同状态开始。

`--reviewed` 标记源 Hunk，并检查整文件与单 Hunk 两侧观察到的 Review 状态。重复夹具可能已经存在目标 Review 标记，所以报告明确 `migrationProven: false`；它只测量 Reviewed 路径，不独立证明迁移算法正确性。迁移正确性依赖隔离的 Core 集成回归，批量 Review 状态不在该脚本断言范围内。

脚本和 Core 子进程清理继承的 `GIT_*` 路由/配置变量，关闭外部全局配置、系统属性及夹具 Hook，防止测试写入被导向其他仓库。测量阶段的进程退出、请求失败或计时超限仍保留报告与夹具；只对自身启动的 driver 执行超时终止与回收。输出文件不覆盖已有报告。

## 最新：2026-09-14 并发读取标准规模结果

最终证据为 `.artifacts/git-standard-parallel-reads-02.json`，Release driver SHA-256 为 `39f081e55cf6ab8a53d581452c98994d54207cdb128f19fd4ea568a7595212f3`，冻结脚本仍为 `1b2e8611ffc58319016b7375f1732f386b962eeb0450045f008450b3f4996564`。标准夹具规模及检查不变，每场景 30 次。下表单位 ms；前次列对应下一节单文件捕获版本 `299e1e3a…`。

| 操作 | 前次 P95 | 当前 P50 | 当前 P95 | 当前最大值 |
| --- | ---: | ---: | ---: | ---: |
| Changes 重复读取 | 117.10 | 87.39 | 92.14 | 93.81 |
| File Diff 重新读取 | 196.93 | 140.02 | 146.33 | 146.70 |
| Reviewed 整文件 Stage | 534.84 | 378.62 | 394.83 | 395.35 |
| Reviewed 整文件 Unstage | 514.11 | 374.82 | 392.82 | 459.48 |
| Reviewed 单 Hunk Stage | 509.16 | 374.29 | 408.94 | 423.41 |
| Reviewed 单 Hunk Unstage | 533.61 | 377.75 | 397.27 | 409.42 |
| Stage 选定 4 个文件 | 503.43 | 404.04 | 450.27 | 476.62 |
| Unstage 选定 4 个文件 | 482.30 | 394.67 | 425.50 | 444.07 |
| Stage All | 544.04 | 435.52 | 475.89 | 624.16 |
| Unstage All | 542.70 | 422.49 | 470.17 | 538.16 |

功能与内容保持断言全部通过；8 个写入场景的 P95 均低于 500 ms，`--enforce-budget` 成功退出。All 仍出现超过 500 ms 的单次请求，不能把 P95 合格解释成每次都满足这个时间。这里通过的是该脚本测量的 Core 请求门禁，原生点击、IPC、UI 刷新与绘制仍不在范围内，不能据此关闭完整 NFR-04 或全量 P0。

资源采样成功取得 3,353 次观察，最大采样进程树 RSS 为 37,502,976 bytes（约 35.8 MiB），最多同时观察到 4 个进程，包括 Core driver 和可见后代。仍是每 200 ms 的采样最大值，非精确峰值；不含 WebView 和独立采集器。硬件记录为 Apple M5 Pro、24 GiB、macOS 26.5.1 ARM64、AC 电源，与 PRD 的 16 GiB 参考配置有差异。

第一次同版本运行 `.artifacts/git-standard-parallel-reads-01.json` 也完成 30 次计时与全部内容校验，8 个写入场景的 P95 合格，但资源采样因沙箱 `PermissionError` 为 0 个样本、RSS 为 null。保留该原始结果；第二次仅补齐进程信息访问权限，没有改代码、脚本、预算或夹具参数。两个运行之间的差异不能全归因为实现变化。

本次只把独立读取并发执行：guard 在物理发现后重叠 refs / Index / 文件内容与 environment；Changes 在 status 后重叠 environment 与 Git 版本 / 文件元数据；配置和 attributes 也并行读取。指纹字段顺序及全部写入校验保持。两轴复核、故障注入和 163 项 Core 回归见 `CODE-REVIEW-16.md`。

## 此前：2026-09-14 单文件捕获优化后的标准规模结果

当前证据为 `.artifacts/git-standard-file-capture-01.json`，原始日志为同名 `.log`；Release driver SHA-256 为 `299e1e3a388490afe8842196832719e785528aae9b03aee99b41460b4bb21bbc`。优化前为 `.artifacts/git-standard-reviewed-final-01.json`，driver SHA-256 为 `08df1a1c17c083307f8080ccbbae34c78bd36986c77a5e36c5d8d7fe0de9df29`。两次使用相同硬件、夹具参数和脚本 SHA-256 `1b2e8611ffc58319016b7375f1732f386b962eeb0450045f008450b3f4996564`；脚本副本为 `.artifacts/measure-git-baseline-reviewed-final.py`。这是各一次完整运行的比较，没有给出置信区间。

每行均为 30 个样本，单位 ms；不是原生 UI 时间。

| 操作 | 优化前 P95 | 当前 P50 | 当前 P95 |
| --- | ---: | ---: | ---: |
| Changes 重复读取 | 129.26 | 110.26 | 117.10 |
| File Diff 重新读取 | 273.75 | 183.36 | 196.93 |
| Reviewed 整文件 Stage | 604.20 | 487.75 | 534.84 |
| Reviewed 整文件 Unstage | 598.55 | 490.98 | 514.11 |
| Reviewed 单 Hunk Stage | 589.01 | 482.81 | 509.16 |
| Reviewed 单 Hunk Unstage | 585.25 | 482.62 | 533.61 |
| Stage 选定 4 个文件 | 533.05 | 471.62 | 503.43 |
| Unstage 选定 4 个文件 | 491.07 | 460.85 | 482.30 |
| Stage All | 569.34 | 500.76 | 544.04 |
| Unstage All | 529.69 | 483.64 | 542.70 |

所有功能与内容保持断言通过，测量完整结束。7 条写入路径的 P95 超过 500 ms，`--enforce-budget` 因此以非零状态退出，未放宽预算。当前不能关闭 Stage / Unstage 的性能目标。

资源采样成功取得 3,509 次观察，Core 及可见后代的最大采样 RSS 为 24,903,680 bytes（约 23.75 MiB），最多同时观察到 2 个进程。该数字的范围与限制见下一节。

早前 `.artifacts/git-standard-baseline-*.json`、`git-standard-reviewed-01.json` 使用不同的脚本或中间实现，不能与本表作严格的同条件百分比比较。

当前另做 5 次单文件 / 单 Commit 的诊断测量（`.artifacts/git-query-profile/minimal-file-capture.json`），Stage P50 / P95 为 448.81 / 472.03 ms，Unstage 为 435.30 / 461.38 ms，源码、Index、HEAD 与配置保持。它不是 30 次标准基准，不能用它关闭标准规模预算或宣称相同幅度的 UI 加速。

独立 Git 转发探针显示，单次 File Diff 的 Git 调用数从 18 降为 13；Reviewed Stage / Unstage 从 40 降为 35。全量 Changes 和批量写入调用数没有改变。证据在 `.artifacts/git-query-profile/before.json` 与 `after-file-capture.json`；探针会增加进程开销，绝对时间不作为 NFR 数据。探针和日志仅保留在忽略的调试目录，产品代码没有加入计时日志。

## 资源和硬件

当前实机为 Apple M5 Pro、15 个逻辑核心、24 GiB 内存、AC 电源。它不同于 PRD 的 16 GiB 参考配置。每份报告记录平台、Git 版本、电源、脚本和 Release driver 的 SHA-256。

每 200 ms 采样 Core driver 及当时可见后代的 RSS，报告为 `maxObservedTreeRssBytes`，不是精确峰值；短命子进程可能落在采样间隔内。范围不含 WebView 或独立采集器，也没有测量原生 UI 进程树 CPU。因此不能据此宣称 NFR-07 / 08 已通过。

## 当前实现与未完成项

当前 Core 在没有 Reviewed 单元时跳过迁移目标读取，已执行 Git 后仅按需要重新读取状态；保留写前校验、独立 Index、原子发布和写后校验。进程读取器只在所有管道已关闭、等待进程退出时使用 1 ms poll；保留原有期限和进程清理边界，不在普通路径新增全局信号处理器。

单文件捕获现在只解析全局 porcelain status 中的目标记录，不再生成整个 Changes 页的文件版本和 Git 版本信息。全局 status 保留 rename 来源及两侧语义。File Diff 的 base 从同一次校验捕获的 HEAD / Branch 构建，并核对捕获前后 guard，避免外部分支切换造成内容与基准不一致。Index、配置 / 属性、文件字节和物理仓库身份检查均保留；没有减少 Stage 写入前后的校验。正确性反例及复核见 `CODE-REVIEW-15.md`。

完整的冷启动、首次 Changes、UI 缓存与绘制、原生 Stage 点击到刷新、压力仓库和空闲 CPU/内存验收仍需单独进行。性能脚本的 `complete` 只表示该次测量与功能校验完成；是否超过预算见独立的 `budgetFailures`，不能等同于完整 PRD P0 完成。
