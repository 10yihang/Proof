# 单文件捕获与 Diff 版本一致性复核

本增量基于 `52aaf2afe20a777b7bfa25cf2521e436d0f80c97` 加此前已复核的工作区内容；比较副本位于 `.artifacts/git-query-review-base/`。Core 与前端补丁分别保存在 `.artifacts/git-query-profile/file-capture-review.patch`、`ui-base-review.patch`。本轮没有提交到 main。

范围为减少文件切换和 Reviewed Stage 的重复 Git 读取，以及确保页面、Diff 与 Review 回复使用一致的版本。Changes / Commit / History / 独立 Diff tab 的职责不变。

## Standards

独立 reviewer 核对 Core 单文件读取仍使用全局 porcelain status，保留 rename 来源与 staged / unstaged 语义；`guard` 的内容、编码顺序及原有空值不变。新的捕获结果额外携带同次 HEAD / Branch 的 base。Stage 的三次校验、独立 Index、原子发布与写后检查保持。

前端回复首先通过现有 Workspace、请求代次和文件版本校验，再检查 base。缓存拒绝不匹配 base 的回复，而且拒绝发生在删除有效缓存之前。Mark 回复还校验请求发起时的文件版本与文件存在性，不把旧 Diff 绑定到回复时的新 Changes。

最终限定范围内硬问题 0、判断项 0。评审读取了源码和 red / green 证据，没有把静态判断称为独立运行测试。

## Spec

本轮关闭三条版本不一致路径：

- 外部 Branch 在 status 期间切换，旧实现把旧 Changes 的 base 绑定到新内容。真实 Git wrapper 在自有夹具的 status 返回后切换 symbolic HEAD，得到实际失败；base 改为来自受验证的捕获后通过。后续 Review / Stage 与实际 HEAD / Branch 相符。
- Core 返回的 Diff 来自更新的 Branch，而 Changes 页还没有刷新。页面现在清除不匹配内容，发起仓库刷新，匹配后才显示 Diff 并开放操作。原失败页面中旧 Branch 与新 Diff 同时存在；修复后的 App 回归验证等待与恢复。
- Review 请求已接受但回复延迟，期间同一 HEAD / Branch 的文件被修改并经 Command 刷新。旧实现把旧回复写入新版本缓存，切换文件再返回可持续看到旧代码和“已审查”。现在比较发起时的文件版本、base 与存在性，失配只移除同 ID 的旧快照，保留当前内容，必要时重新读取。

两位 reviewer 对最后一条追加修复均已复核关闭，当前限定范围无新阻断项。它不代表全部并发组合或整份 P0 已通过。

## 验证证据

- `base-race-red-02.log` / `base-race-green.log`：真实 Git Branch 切换反例与修复；首版 wrapper 的工作目录错误另有记录，不作为产品反例。
- `ui-base-race-red.log` / `ui-base-race-green-02.log`：真实 App 加受控 transport 的 Branch 等待 / 恢复；绿色日志编号 02 修正了“按钮隐藏”应等于“没有可用操作”的断言。
- `cache-base-red.log` / `cache-base-green.log`：晚到旧 Branch 回复不能驱逐新 Branch 缓存。
- `review-version-race-red.log` / `review-version-race-green.log`：同一 Branch 的晚到 Review 回复，在新内容已显示后切换文件再返回的回归。
- `core-regression.log`：本轮完整 proof-core 160 项通过、0 失败、2 项 opt-in 未执行；不是本轮全 Rust workspace 计数。
- `clippy.log`：proof-core 全 target Clippy 通过。
- `ui-unit.log`：前端 30 项单元测试通过。
- `full-ui-final.log`：包含最后一条 Review 版本修复的完整 40 项界面回归通过，实际 Git 流程已启用；`typecheck-final.log`、`format-final.log` 分别为最终类型和修改文件格式检查。
- `real-git-ui-unrestricted.log`：新 Release driver 经浏览器完成实际 Git / SQLite 流程，包括自动刷新、选中 Hunk Commit、Amend、Commit all 和数据删除；使用测试 NDJSON transport，不是 Tauri IPC。此前沙箱 localhost EPERM 未执行到产品流程，记录单独保留。

上述日志除另行说明外均位于 `.artifacts/git-query-profile/`。标准规模每场景 30 次的完整结果见 `PERFORMANCE.md`，内容保持检查通过，但 7 个写入场景仍超出 500 ms。原生 titlebar / 菜单的点击验收仍受锁屏影响，不能以浏览器代替。
