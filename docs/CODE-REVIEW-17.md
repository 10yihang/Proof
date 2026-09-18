# 大 Diff 与只读取消复核

增量基线为 `.artifacts/large-diff-baseline/`，补丁为 `.artifacts/large-diff-review.patch`。本次沿用未提交的工作区，不在 main 创建提交。

## Standards

独立 reviewer 发现并关闭以下问题：

- 主动加载时后台刷新命中旧摘要，取消同一文件版本的完整请求。现保留显式加载意图，可继续加载的摘要不能抢占它。
- 普通 Commit 预览因 Review 扫描的 Diff 硬上限报错。现单独记录未知覆盖；普通 Commit 保留，Strict Review 在写入前拒绝。
- 新的多帧位置校准遗漏普通键盘滚动中止。方向键、翻页键、Home/End、空格现会中止校准，并保留原生默认行为。

读票据由运行时窗口归属校验，单次领取；仅四类只读命令可领取。取消上下文只传给当前请求及其并行读取，不修改全局采集器关闭状态。等待 Core 锁和运行 Git 时均检查取消。容量使用实际存储克隆计算，过期回收同步更新计数。最终 Standards 无遗留发现。

## Spec

独立 reviewer 除 Commit 预览问题外，指出历史大 Diff 卸载后不能以旧绝对 top 代替源行恢复。实际页面回归复现软换行下的漂移；最终以可见 DOM 行记录位置，重建时有界校准实际行高，同一实例保留绝对位置。三个重复轮次均严格恢复相同行标识与行内偏移。

摘要不生成 Review 单元，Changes 与历史比较均保留独立阅读入口。普通 Commit 不被未知覆盖误判为全部已审查。最终本增量 Spec 无遗留发现；DIFF-05 的这个恢复场景关闭，不代表整个 PRD 或全部压力验收完成。

## 证据与边界

- `.artifacts/large-diff-full-rust-final.log`：205 通过、0 失败、2 opt-in；最后参数收敛后的 `.artifacts/large-diff-desktop-final-02.log` 为 6 通过。
- `.artifacts/large-diff-full-unit.log`：35 通过；`.artifacts/large-diff-full-ui.log`：47 通过，启用了真实 Core/Git。
- `.artifacts/large-diff-position-stability-02.log`：两类位置场景各重复三次，6 通过。导航键修正后的 `.artifacts/large-diff-keyboard-ui.log`：4 通过。
- `.artifacts/large-diff-final-clippy-02.log`：完整 workspace/all-target Clippy 通过；构建还会重新运行类型检查。

Chrome 启动被系统终止和默认 Playwright 浏览器缺失的两轮日志没有到达行为断言。改用已安装的官方 headless shell 1234 后才完成页面验收。第一次取消按钮回归发现旧样式 `pointer-events:none`，已恢复按钮命中并移除加载时的重叠空状态。一次重建用例在虚拟行尚未挂载时读取 undefined，测试改为等待行挂载，最终位置精度要求没有降低。

受限沙箱内的桌面文件监听用例超时；同一源码在具备 FSEvents 访问的环境中通过。两位 reviewer 只读检查源码和日志，未自行运行测试。Windows、完整原生 UI 内存/响应预算及其余 P0 验收仍保留。

评审后的当前 Release 原生验收已完成本轮大 Diff、取消、随后单文件 Stage/Commit 与独立 History Diff 流程；没有进一步修改产品源码。`.artifacts/large-diff-native-01/native-acceptance.json` 记录真实 Tauri IPC、隔离副本差异及磁盘校验。该结果不覆盖完整性能矩阵。
