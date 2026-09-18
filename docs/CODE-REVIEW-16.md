# Git 独立读取并发复核

本增量从上一包的工作区状态开始；原始文件位于 `.artifacts/git-parallel-profile/before/`，补丁为同目录的 `review.patch`。上一版 Release driver SHA-256 为 `299e1e3a388490afe8842196832719e785528aae9b03aee99b41460b4bb21bbc`，当前为 `39f081e55cf6ab8a53d581452c98994d54207cdb128f19fd4ea568a7595212f3`。源码没有提交到 main。

## Standards

独立 reviewer 检查以下边界，硬问题 0、判断项 0：

- 文件 guard 的物理仓库发现仍先完成；随后才重叠 refs / Index / 文件内容与配置 / attributes 的只读采集。指纹字段顺序及空值编码保持。
- Changes 在原有 HEAD / Branch / Index / status 读取后，才并行采集 environment 与 Git 版本 / 文件元数据。结果仍按照原文件顺序计算 token 和 fileVersions。
- 配置和 attributes 的读取独立完成后再共同生成 environment 指纹。`read_pair` 在正常和 `Result` 错误路径均 join 后返回；scoped 生命周期防止辅助线程逃逸。
- 当前调用结构每请求最多两个辅助线程、三个直接 Git 子进程。原有进程期限、输出限额与进程组回收逻辑未改变。Git 指定的外部过滤器等仍受原有信任和进程边界约束。
- 事务及全部写操作保持原顺序。最终 guard 成功后才发布 private Index，读取错误不会越过发布点。

## Spec

独立 Spec reviewer 未发现新增阻断项。File Diff base 仍来自同次 HEAD / Branch；Review 内容身份、文件两侧语义和捕获前后 guard 保持，符合当前 DIFF-01、REV-02、GIT-01 / 04 的实现边界。

两位 reviewer 阅读源码及回归日志，未自行运行测试或测量。评审关闭不等于 NFR 达标。标准规模和 UI 端到端性能分别验收，不能用小夹具的中位数代替 P95。

## 诊断与回归

`.artifacts/git-parallel-profile/before.json` 是本轮修改前的真实 Git 转发诊断，完成内容与 Index 校验。File Diff 仍为 13 次 Git 调用、Reviewed Stage / Unstage 为 35 次、批量路径为 29 次。该探针额外启动进程，仅用于归因；原来的各子进程时间总和在并发后不能代表关键路径，因此没有用它估算并发版的剩余 SQLite 耗时。

第一步只调整文件 guard 的读取顺序，5 次无探针单文件诊断为 `.artifacts/git-parallel-profile/capture-pair-minimal.json`。Stage P50 / P95 为 333.19 / 378.44 ms，Unstage 为 341.55 / 346.45 ms；与上一检查点约 449 ms 的 Stage 中位数相比有改善。这个结果不是标准规模预算证明，随后才调整 Changes 与 environment 的并发。

最终当前 Core 全量 163 项通过、0 失败、2 项 opt-in 未执行，日志 `core-tests.log`。新增回归覆盖：

- 一路读取失败后，另一路仍须收尾完成才返回。
- 真实 Git 在生成 Diff 后改变 included config 或 info attributes，捕获及旧快照 Stage 均被拒绝，源码、Index 和 HEAD 保持。
- private apply 已成功后，最终 guard 的 config 读取失败；实际仓库 Index 和 Worktree 未被改写，自有 index.lock 已释放。

Core 全 target Clippy、Rust 格式通过，日志分别为 `clippy.log`、`format.log`，都在 `.artifacts/git-parallel-profile/`。完整标准规模结果和硬件 / 测量范围记录于 `PERFORMANCE.md`。

最终资源采样版 `.artifacts/git-standard-parallel-reads-02.json` 完成每场景 30 次计时及每次写入的内容校验，8 个写入场景 P95 全部通过 500 ms 门禁。3,353 个资源样本的最大采样 RSS 约 35.8 MiB，最大观察进程数 4，符合本次 Core 及后代的采样范围；未据此关闭完整 UI / NFR 预算。第一次运行的计时也通过，但 `ps` 权限不足，资源数据缺失；两份结果均保留。

`.artifacts/git-parallel-profile/real-git-ui.log` 的实际 Git 界面回归通过，包含实时保存、Branch、选中 Hunk Commit、Amend、Commit all 和记录删除后的源码保持。最终夹具 HEAD 为 `11d5b7826f5d86bb37786deef75f5930a217072b`、status clean；使用测试 NDJSON transport，不能替代 Tauri IPC 或原生窗口验证。前端源码相对上轮 30 项单元 / 40 项完整 UI 回归没有变化，本轮未重复运行那些 mock 页面用例。
