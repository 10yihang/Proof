# Proof

<img src="src-tauri/icons/128x128@2x.png" width="80" height="80" alt="Proof icon" />

面向 AI 编码场景、以人工 Diff / Code Review 为核心的本地 Git 客户端。

**当前版本：0.1.4。** [下载 macOS Apple Silicon 版本](https://github.com/10yihang/Proof/releases/tag/v0.1.4)。其他平台和完整性能验收仍在推进。

- Local changes、文件树、Stage、Commit / Amend、History graph 与独立 Diff tabs。
- 使用只读 Monaco 查看统一或并排 Diff，支持上下文展开、全文、搜索和独立窗口。
- 通过本机 Codex CLI / Claude Code（安装后也可使用 Codewiz）主动发起 AI 分组与 Review，使用 CLI 的现有登录和额度，不要求配置 API Key。
- Review 评论支持行范围、采纳 / 不采纳、本地持久化，以及导出修改说明交给 Agent。
- Passive Agent Observer 与主动 AI 调用分离；普通 Git 功能不依赖 Agent。

软件更新位于「设置 → 软件更新」，支持手动检查、下载签名更新包、安装并重启。发布流程见 [RELEASING.md](docs/RELEASING.md)。

## 运行

最新本地构建信息见 `.artifacts/latest-build.json`。界面已迁移到 Tailwind CSS 4、shadcn / Base UI 和只读 Monaco，支持统一控件、面板拖动、Diff tab 排序及逻辑分组拖动。实现与验证范围见 [UI 迁移](docs/UI-MIGRATION.md)。

需要 macOS、Rust、系统 Git，以及 Node.js 20 或更高版本；本轮使用 Node 24 完成构建。

```sh
npm ci
npm run desktop
```

`npm run dev` 仅启动浏览器界面。浏览器不能执行本地 Git，可手动进入带有持续提示的虚构演示工作区。桌面端使用 Rust/Tauri IPC，绝不在真实仓库读取失败后返回演示数据。

```sh
npm run typecheck
npm test
cargo test -p proof-core
npm run tauri -- build --debug --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

发布构建：`npm run release:build`，使用本机已有的 updater 签名密钥。普通开发构建可按上面的命令关闭更新包生成，不需要签名私钥。版本与发布说明见 [0.1.4](docs/releases/0.1.4.md)。

当前 macOS 包使用 ad-hoc 签名，尚未进行 Developer ID 签名与 Apple 公证。签名方式依据 [Tauri 官方说明](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing)。

## 结构

- `crates/proof-core`：Git 查询、受校验的写操作、恢复点、文件 Blame、内容绑定的 Review 和 SQLite。
- `src-tauri`：原生窗口与受限 IPC。前端没有通用 shell 或文件系统入口。
- `src`：Changes、Repository、Diff、丢弃/恢复确认、文件历史、提交预览、设置和可关闭的证据面板。
- `docs`：完整 PRD、实施记录、设计约定和验收证据。
- `scripts/create-demo-repo.py`：创建一次性的真实验收仓库，不覆盖既有目录。

源码仓库与 Proof 的本地数据库分离。测试运行可通过 `PROOF_DATA_DIR` 指定独立数据目录；普通运行使用系统应用数据目录。原始 PRD 中的“品牌待定”是保留的源文档表述。

诊断导出、默认排除项与存储故障入口见 [DIAGNOSTICS.md](docs/DIAGNOSTICS.md)。

Context 支持手动关联会话、本地备注、解除与撤销，原始 Hook 证据保留。交互与数据边界见 [CONTEXT-ASSOCIATIONS.md](docs/CONTEXT-ASSOCIATIONS.md)。

桌面界面采用独立仓库工具栏、页面与 Diff tabs，以及紧凑文件树和提交图。macOS 合并标题栏并保留原生红黄绿；菜单快捷键、弹窗和草稿的交互边界见 [DESKTOP-CHROME.md](docs/DESKTOP-CHROME.md)。新版需要重启原生 App；原生窗口操作仍待解锁后的实机验收。
