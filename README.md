# Proof

面向 AI 编码场景、以人工 Diff / Code Review 为核心的本地 Git 客户端。

**当前状态：正在实现的 v0.1 Alpha，尚未达到 PRD 的发布完成条件。** Git 与 Review 核心已有真实仓库测试及 macOS 原生流程证据。安全丢弃/恢复点、文件历史与 Blame 已接入，新增原生交互仍待复验；Codex 0.153.4 / macOS Hook 已完成隔离真实会话与原生安装验证。History 支持选择 Commit/Branch 后打开独立 Diff tab，Commit/Amend 独立成页；其他 Agent/平台、诊断与完整性能验收仍在推进。

## 运行

需要 macOS、Rust、系统 Git，以及 Node.js（本机使用 Node 22.19.0 安装依赖，Node 18.20.7 也已完成前端构建）。

```sh
npm ci
npm run desktop
```

`npm run dev` 仅启动浏览器界面。浏览器不能执行本地 Git，可手动进入带有持续提示的虚构演示工作区。桌面端使用 Rust/Tauri IPC，绝不在真实仓库读取失败后返回演示数据。

```sh
npm run typecheck
npm test
cargo test -p proof-core
npm run tauri -- build --debug --bundles app
```

完整构建：`npm run bundle`。在签名、兼容性、性能及隐私验收完成前，不作为公开发行版发布。

当前 macOS Alpha 使用本地 ad-hoc 签名，尚未进行 Developer ID 签名与公证。签名方式依据 [Tauri 官方说明](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing)。

## 结构

- `crates/proof-core`：Git 查询、受校验的写操作、恢复点、文件 Blame、内容绑定的 Review 和 SQLite。
- `src-tauri`：原生窗口与受限 IPC。前端没有通用 shell 或文件系统入口。
- `src`：Changes、Repository、Diff、丢弃/恢复确认、文件历史、提交预览、设置和可关闭的证据面板。
- `docs`：完整 PRD、实施记录、设计约定和验收证据。
- `scripts/create-demo-repo.py`：创建一次性的真实验收仓库，不覆盖既有目录。

源码仓库与 Proof 的本地数据库分离。测试运行可通过 `PROOF_DATA_DIR` 指定独立数据目录；普通运行使用系统应用数据目录。产品名由用户确认为 **Proof**；原始 PRD 中的“品牌待定”是保留的源文档表述。商业模式、许可证与公开仓库尚未决定。
