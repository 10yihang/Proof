# Git workflow review · 2026-09-13

固定比较点：`0e4c5e7ccb3cb80a9ce3b2ab0c58a99eeae130cb`。使用 `git diff 0e4c5e7 --` 并独立读取新增文件。需求为用户六项明确反馈，完整范围见 `GIT-WORKFLOW.md`；最新要求覆盖旧 PRD 的冻结阅读默认、提交弹层和 Amend P1。两个独立评审使用临时源码/仓库，不操作用户窗口和已有验收夹具。

## Standards

初评 3 项，定向复核补充 2 项；全部关闭，最终硬问题 0、判断项 0。

1. 批量 Stage 对两侧无条件携带 rename old_path，可能把旧路径新建文件纳入。现在按 side 解析 rename，并只在当前 R 动作纳入必要源路径。
2. .gitattributes 与 Git 配置变化不使缓存失效。现在有效 config（含 include）与 `check-attr --all` 参与版本和原生 guard；不把配置明文送入前端。
3. 前端 24 个缓存不保证核心 64 个快照仍存活。捕获过期后按 snapshot ID 驱逐并重新读，等待用户再次操作，不重放 Git/Review 写入。
4. 反向 Unstage 遇到原路径已被目录占用，restore 仍可能移除未选 Index entry。现在发布前比对所有未选精确路径的 Index 记录，任何额外变化拒绝为 `INDEX_SCOPE_CHANGED`。
5. 过期恢复中，旧 Worktree 的晚到上下文错误会影响新 Worktree。现在副作用前与 await 后核对请求 epoch、workspace、snapshot、选择代次；只驱逐对应 snapshot，不影响新缓存。

真实 Git 原反例均转绿。隔离 UI 验证 A 的晚到错误不影响 B 同路径缓存；正常过期恢复仍有效，未自动重放动作。

## Spec

初评 6 项，全部关闭；Rename 问题复核扩展到反向 Unstage，一并关闭。

1. Stage/Unstage 选择范围：同上，真实 Index 验证未选 entry 保留。
2. 整文件 Review 确认目标被后台刷新替换：弹层固定原 snapshot，当前内容改变则禁确认。
3. 属性/过滤器依赖未更新缓存：同上，实际 Patch 与缓存版本共同变化，旧 guard 拒绝 Review。
4. IME Enter 触发 Branch 切换：所有相关 keydown 排除 composing 和 keyCode 229。
5. 原生快照过期后持续缓存命中：Stage/Review/Discard/context 均重新读取，显式重试使用新 snapshot。
6. 术语机械拼接：“个已Stage file”等改为完整自然文案，保留 Worktree、Stage、Commit、Amend。

独立验证正常 tracking branch、失败保留草稿、Amend 开关恢复草稿、Split Index 和双父 Amend。无新增范围扩张。以上不包含 macOS 原生点击验收。
