# External editor review · 2026-09-13

固定比较点：`48abd06fdcbb89696fb50fea878e1ab18fee6f20`。对当前差异及全部新增文件分别进行 Standards / Spec 评审，依据 PRD DIFF-02、SET-01、SEC-02 和 `EXTERNAL-EDITOR.md`。两位评审使用隔离源码和临时仓库，未操作用户编辑器或原生验收夹具。

## Standards

3 项发现全部修复，最后定向复核未发现新问题。

1. Info.plist 的符号链接目标可能位于 bundle 内的另一个未信任仓库；仅检查链接来源不足。现在将元数据最终父目录也纳入已登记 Worktree 的身份与信任检查。原反例被拒绝。
2. History 中的 Command 可能打开后台隐藏的 Changes 文件。现在仅 Changes 提供此命令，菜单打开时捕获并显示文件目标，后台选择变化不能重定向已有命令。两个隔离 UI 用例验证 History 无 handoff、Changes 仍打开所显示的原目标。
3. 小型 binary plist 可通过共享引用放大完整 Value 的解码内存。现在流式提取所需顶层字段，并限制事件数、深度及累计解码量。原 1328 字节放大夹具被拒绝，正常 XML/binary 均可读取。

实际本机枚举发现 Zed 含重复的文件类型与权限描述；重复键拒绝规则随后收窄至 5 个应用身份字段，其他字段仍完整消耗同一资源预算。独立复核 4/4 通过：无关重复兼容、嵌套名称不覆盖顶层、身份字段重复仍拒绝、大量重复及原放大夹具仍受限。本机 Zed、Code、IntelliJ IDEA、TextEdit 均恢复识别；未启动应用。

## Spec

未发现需求偏离。评审覆盖显式配置与点击、应用默认/仓库覆盖、linked Worktree 与独立 clone、当前 Worktree 文件语义、配置保存不启动、失败与跨工作区晚到响应、信任撤销及应用变化后拒绝。隔离增量核心 11/11 和 Command UI 2/2 通过，之前跨工作区 UI 2/2 通过。

本记录不包含真实编辑器窗口、原生文件选择器或 Windows 验收；handoff 测试使用受控回调。macOS 锁屏造成的点击验收缺口保留在验收记录中，不以评审通过替代。
