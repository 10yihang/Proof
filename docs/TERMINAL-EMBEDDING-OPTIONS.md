# Proof 嵌入式终端（Terminal）低内存实现方案调研

> 调研日期：2026-09-21。所有关键结论均附一手来源。体积数字为实际下载 npm tarball 实测（非官方标注值，标注为"实测"）。

---

## 1. 结论摘要

**推荐方案 A（主力，风险最低）：`@xterm/xterm` v6（DOM renderer，不加载 WebGL/Canvas addon）+ Rust 侧 `portable-pty` 自封装 Tauri 命令/事件通道。**

理由：
- xterm.js 项目 2026 年高度活跃（v6.0.0 发布于 2025-12-22，6.1.0-beta 持续更新至 2026-08-30，主仓库最近提交 2026-09-13）；VS Code 同款，生态与文档最完善。
- DOM renderer 是 v6 核心内置的默认渲染器，只为**可视行**创建 DOM 节点；内存大头在 scrollback buffer（每单元格 12 字节，见 §4），可用 `scrollback` 选项直接封顶。不引入 GPU 资源，天然规避 WebGL 上下文数量上限与 GPU 内存泄漏历史问题。
- `portable-pty`（wezterm 出品，1600 万+ 下载）是唯一同时覆盖 macOS/Linux/Windows（ConPTY）的成熟 Rust PTY crate；Tauri 官方生态中唯一的 PTY 插件 `tauri-plugin-pty` 本质就是对它的薄封装，自行封装成本约一两百行，更可控。
- 该组合（Tauri 2 + xterm.js + portable-pty）正是当前主流 Tauri 终端工具的实际架构（见 §3.3 的 kerminal 等项目）。

**备选方案 B（观望/可试点）：`ghostty-web`（Ghostty VT 核心编译为 WASM + 自带 Canvas2D 渲染器）+ `portable-pty`。**

理由：终端状态（含 scrollback 单元格）存放在 WASM 线性内存中，而非 JS 堆，理论上是"无 xterm.js"方案中内存模型最优的；且提供 xterm.js 兼容 API，迁移成本低。但项目 2025-11 才创建，当前仅 0.4.0，API 兼容性官方自述为"aims to be"（争取中），bundle 反而比 xterm.js 核心更大（见 §3.2），addon 生态（fit/search/serialize）不健全。适合作为中期演进方向——值得注意的是 xterm.js 官方团队自己也在评估迁移到 libghostty（issue #5686）。

---

## 2. 方案对比表

### 渲染层（前端 webview）

| 方案 | 当前版本（核实日期） | 维护状态 | 体积（实测 gzip） | 运行时内存特征 | 接入难度 |
|---|---|---|---|---|---|
| `@xterm/xterm` DOM renderer（默认） | 6.0.0（2025-12-22） | 非常活跃 | 核心 .mjs ≈ 88 KB（UMD ≈ 118 KB） | scrollback 每单元格 12 B（Uint32Array×3），可视行为 DOM 节点；内存随 scrollback 线性增长，可封顶 | 低 |
| `@xterm/xterm` + `addon-webgl` | addon 0.19.0（beta 0.20 至 2026-08） | 活跃 | +≈ 67 KB | 减少 DOM 节点，但每实例一个 WebGL2 上下文 + 字形图集纹理；有 GPU 内存泄漏修复史（#3889）；浏览器单页 WebGL 上下文数有上限（~8–16，平台相关） | 中（需处理 context loss） |
| ~~`@xterm/addon-canvas`~~ | 0.7.0（2024-07 后无更新） | **已在 v6 移除**（issue #4779，master 分支 addons 目录已无 canvas） | — | — | 不推荐 |
| `ghostty-web` | 0.4.0（2025-12-09），next 至 2026-06 | 活跃但年轻（仓库 2025-11 创建，~2.9k stars） | JS ≈ 194 KB + `ghostty-vt.wasm` ≈ 124 KB，合计 ≈ 318 KB | 终端缓冲区在 WASM 线性内存；Canvas2D 渲染 + dirty-line 优化；无 DOM 行节点 | 中（API 兼容但不完备，addon 生态缺失） |
| 自绘 canvas + `wezterm` term 编译 wasm | 无发布产物 | **不确定** | — | — | 高（见 §3.4） |
| Rust 侧模拟（`alacritty_terminal`）+ 自绘前端 | crate 0.26.0（2026-04，活跃） | 活跃 | 前端可极简 | 终端状态在 Rust 进程内存，前端只持有可视网格 | 高（需自研前端渲染与输入链路） |

### PTY 层（Rust 后端）

| crate | 版本/更新时间 | 维护状态 | 平台 | 依赖体量 | 接入难度 |
|---|---|---|---|---|---|
| `portable-pty` | 0.9.0（2025-02-11；所属 wezterm 仓库 2026-09 仍活跃，pty 目录 2026-08/09 有提交） | 活跃（wezterm 子项目，1600 万+ 下载） | macOS/Linux（openpty）+ Windows（ConPTY） | 中等：libc/nix/filedescriptor + futures/smol + Windows 侧 winapi→windows-sys（迁移中） | 低 |
| `pty-process` | 0.5.3（2025-07-12） | 活跃（500 万+ 下载） | **仅 Unix**（rustix pty），不支持 Windows | 轻：rustix + 可选 tokio | 低（但 Windows 不可用） |
| `tauri-plugin-pty`（Tnze） | 0.3.1（2026-07-08） | 半活跃，个人项目（22 stars），README 自述 "Developing!" | 同 portable-pty（它就是薄封装） | 即 portable-pty + tauri | 低，但成熟度存疑 |

---

## 3. 各方案详述

### 3.1 xterm.js（`@xterm/xterm`）

**版本与维护状态（已核实）**
- 当前稳定版 **6.0.0**，发布于 2025-12-22；beta 线 6.1.0-beta.304 更新至 2026-08-30；仓库最近 push 2026-09-13，21.2k stars。来源：<https://github.com/xtermjs/xterm.js>、<https://github.com/xtermjs/xterm.js/releases>、npm registry。
- v6 重要变化：Canvas renderer addon 已被移除（[issue #4779](https://github.com/xtermjs/xterm.js/issues/4779)："remove the canvas renderer in the next major version"；master 分支 `addons/` 目录已无 `addon-canvas`；npm 上 `@xterm/addon-canvas` 停留在 2024-07 的 0.7.0/0.8.0-beta.48）。即 **v6 只有两种渲染器：核心内置 DOM renderer（默认）+ `@xterm/addon-webgl`（WebGL2）**。
- v6 集成 VS Code 滚动条组件、ESM 构建（esbuild）、ligature、synchronized output（DEC 2026）等（[6.0.0 release notes](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)）。

**体积（本次实测 npm tarball）**
- `@xterm/xterm@6.0.0`：`xterm.mjs` 345 KB 原始 / **≈88 KB gzip**；`xterm.js`（UMD）489 KB 原始 / ≈118 KB gzip。
- `@xterm/addon-webgl@0.19.0`：247 KB 原始 / **≈67 KB gzip**。
- `@xterm/addon-fit@0.11.0`、`@xterm/addon-serialize@0.14.0` 均为几 KB 级。
- 均支持 ESM，Vite 下可 tree-shake + 动态 import 按需加载。

**渲染器对比（内存视角）**
- **DOM renderer（默认）**：只为视口内可见行维护 DOM 节点，屏幕渲染开销恒定；内存大头是 scrollback 的 `BufferLine`。
- **WebGL addon**：字形图集（texture atlas）+ GPU 上下文。优势在高吞吐输出时的帧率；代价是每实例一个 WebGL2 上下文（浏览器对单页面活跃 WebGL 上下文数有上限，超出会强制丢上下文）以及字形图集 GPU 内存。官方 README 明确要求处理 `onContextLoss`（<https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/README.md>）。
- 相关内存 issue 史（均 closed，说明在持续修，但也说明多实例场景容易踩）：[#3889 webgl addon 泄漏 GPU 内存](https://github.com/xtermjs/xterm.js/issues/3889)、[#4935/#4936 CoreBrowserService 泄漏](https://github.com/xtermjs/xterm.js/issues/4935)、[#4645/#4655 API facade 泄漏](https://github.com/xtermjs/xterm.js/issues/4645)、[#4185 一批内存驻留问题](https://github.com/xtermjs/xterm.js/issues/4185)、[#5818 dispose 注册缺口导致 Terminal 实例泄漏](https://github.com/xtermjs/xterm.js/issues/5818)。**结论：xterm.js 实例必须成对 `dispose()`，多开/频繁开关终端是它历史上内存问题的主要来源。**

**scrollback 内存模型（关键数据，有官方来源）**
- `BufferLine._data` 为 `Uint32Array`，**每列 3 个 uint32 = 12 字节/单元格**（[issue #4800 "more compact BufferLine data structure"](https://github.com/xtermjs/xterm.js/issues/4800)，该提案至今 open，说明现状未改）。
- 默认 `scrollback: 1000`（[OptionsService 源码](https://github.com/xtermjs/xterm.js/blob/master/src/common/services/OptionsService.ts)）。
- 推算（含每行一个 JS 对象的额外开销，以下为单元格数据下限）：
  - 80 列 × 1000 行 ≈ 0.96 MB/实例（默认值，可接受）；
  - 120 列 × 10000 行 ≈ 14.4 MB/实例；
  - 200 列 × 50000 行 ≈ 120 MB/实例（失控场景）。
- **因此低内存的核心手段就是把 `scrollback` 显式限制在 1000–5000，并在多个终端实例并存时乘上实例数评估。**

### 3.2 ghostty-web（更轻量替代？）

- 仓库：<https://github.com/coder/ghostty-web>（**Coder 组织项目**，基于 Mitchell Hashimoto 的 Ghostty/libghostty 工作）。创建于 2025-11-10，~2.9k stars，最近提交 2026-06/07，活跃；MIT。
- npm `ghostty-web@0.4.0`（2025-12-09），next 预发布持续到 2026-06。
- 架构（[README](https://github.com/coder/ghostty-web) + [源码](https://github.com/coder/ghostty-web/tree/main/lib)核实）：Ghostty 的 VT 解析器/终端核心（Zig）编译为 `ghostty-vt.wasm`（实测 423 KB 原始 / ≈124 KB gzip）；前端自带 **Canvas2D 渲染器**（`lib/renderer.ts`，dirty-line 优化，60 FPS 目标）；提供 xterm.js 兼容 API（`init()` + `new Terminal()`），零运行时依赖。
- 实测包体：JS ≈ 194 KB gzip + wasm ≈ 124 KB gzip ≈ **318 KB gzip**——**线上体积反而比 xterm.js 核心（88 KB gzip）大**。它的"省"不在下载体积，而在**运行时内存模型**：终端缓冲区/scrollback 单元格存放在 WASM 线性内存中，不占用 JS 堆、不触发 JS GC 压力（其 `buffer.ts` 直接查询 WASM 侧终端状态）。
- 风险：版本 0.4.0，README 自述 API 兼容为"aims to be"；无 xterm.js 那样丰富的 addon 生态（fit/search/serialize/web-links 等需其自带实现或缺失）；构建链需要 Zig+Bun（仅自行构建 wasm 时）。
- 重要旁证：xterm.js 核心维护者 2026-02 开了 [issue #5686 "Explore adopting libghostty"](https://github.com/xtermjs/xterm.js/issues/5686)，认为 JS 解析路径已到性能上限、考虑用 libghostty 替换解析层——说明 ghostty 系 WASM 路线被主流认可，中期值得关注。

### 3.3 Tauri 生态参考实现

GitHub 搜索（2026-09-21 实测）"tauri terminal xterm" 头部项目：

| 项目 | stars | 最近活跃 | 技术栈（已核实其 package.json / Cargo.toml） |
|---|---|---|---|
| [klpod221/kerminal](https://github.com/klpod221/kerminal) | 460 | 2026-04 | Tauri 2 + `@xterm/xterm@5.5` + `addon-webgl` + fit/search/unicode11/web-links/image + **`portable-pty = "0.9"`**（本地 shell）+ russh（SSH） |
| [nyakang/nyaterm](https://github.com/nyakang/nyaterm) | 1656 | 2026-09 | 远程终端工作台（Tauri + xterm 系） |
| [yandanp/Connexio](https://github.com/yandanp/Connexio) | 674 | 2026-08 | 项目制终端管理器 |
| [iewnfod/lumina-terminal](https://github.com/iewnfod/lumina-terminal) | 12 | 2026-09 | Tauri + React + xterm.js（与 Proof 技术栈最接近的最小参考） |

`tauri-plugin-pty`（[crates.io](https://crates.io/crates/tauri-plugin-pty)、[GitHub Tnze/tauri-plugin-pty](https://github.com/Tnze/tauri-plugin-pty)）：
- 真实存在，Tauri 2 插件，v0.3.1（2026-07-08），4.8 万下载，22 stars，MIT。
- 已核实其 `Cargo.toml`：**依赖 `portable-pty = 0.9.0`** + tauri 2，是对 portable-pty 的薄封装；前端配套 npm 包 `tauri-pty`，README 示例仍用旧 `xterm` 包名，自述 "Developing!"。
- 结论：可用但成熟度一般；**更推荐直接参考它的源码自行封装 portable-pty**（自己的协议可以走 Tauri Channel 传二进制，避免插件的字符串事件开销），社区主流项目（如 kerminal）也都是直接依赖 portable-pty。

### 3.4 "无 xterm.js" 自绘 + wasm 核心的可行性

- **wezterm 的 term/mux crate 编译 wasm**：`wezterm-term` 等 **未发布到 crates.io**（已核实，查询返回不存在），只能 git 依赖 vendoring；wezterm 的 term 与 GUI/mux 耦合较深，无现成的 wasm 构建目标。**结论：理论上可行但无公开先例与资料，工作量大，标注为不确定，不建议。**
- **`alacritty_terminal` crate**（0.26.0，2026-04 更新，活跃）：可放在 **Rust 后端**做终端模拟（PTY → alacritty_terminal grid → 只把可视网格/差量推到前端自绘 canvas）。这把终端状态移出 webview，前端内存极省，但要自研渲染/选区/输入法链路，接入成本高。仅在对内存极端敏感且愿意自研时考虑。
- **`vtparse`**（0.7.0，2025-04，2200 万下载）只是解析器，不含屏幕缓冲区模型，单独用它仍需自写 buffer。
- 现实折中就是 ghostty-web：别人已经把"wasm 终端核心 + 自绘 canvas"做完了。

---

## 4. 内存占用数据汇总（含可信度标注）

| 数据点 | 数值 | 来源/可信度 |
|---|---|---|
| xterm.js 单元格内存 | 12 B/列（Uint32Array×3） | [issue #4800](https://github.com/xtermjs/xterm.js/issues/4800)，官方代码现状，高可信 |
| xterm.js 默认 scrollback | 1000 行 | [OptionsService 源码](https://github.com/xtermjs/xterm.js/blob/master/src/common/services/OptionsService.ts)，高可信 |
| xterm.js 核心体积 | mjs ≈ 88 KB gzip | 本次实测 npm tarball |
| addon-webgl 体积 | ≈ 67 KB gzip | 本次实测 npm tarball |
| ghostty-web 体积 | JS ≈194 KB + wasm ≈124 KB gzip | 本次实测 npm tarball |
| WebGL vs DOM 运行时内存差 | **无公开权威基准**；定性判断：DOM renderer 内存 ≈ scrollback 数据 + 视口 DOM（几十~几百个节点）；WebGL 额外持有字形图集纹理与 GL 上下文（每实例一份），多实例时 GPU 资源增长更快，且有上下文总数上限 | 定性判断 + [webgl README context loss 章节](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/README.md) |
| Tauri webview 基线内存 | **无公开权威数字**；定性判断：Tauri 使用系统 webview（macOS WKWebView / Windows WebView2 / Linux WebKitGTK），运行时为系统共享组件，基线显著低于每应用捆绑整套 Chromium 的 Electron；Proof 当前已加载 monaco（重），新增终端的边际成本主要在 xterm 实例与 PTY 输出流本身 | 定性判断 |
| 多实例 WebGL 上下文上限 | 浏览器单页面活跃 WebGL 上下文约 8–16 个（超出强制回收最旧上下文） | 平台级常识，无单一权威文档，定性标注 |

---

## 5. 低内存实践清单（懒加载 / 资源回收）

**前端**
1. **动态 import**：`const { Terminal } = await import('@xterm/xterm')`，首次打开终端面板才加载核心与 CSS（xterm 6 为 ESM，Vite 天然分包）。addon（fit/serialize/webgl）同样按需动态加载。
2. **优先 DOM renderer**：Proof 终端是辅助功能而非主界面，DOM renderer 帧率足够；只有实测滚动/高吞吐输出卡顿再按需 `loadAddon(new WebglAddon())`，并实现 `onContextLoss → dispose()` 降级回 DOM。
3. **封顶 scrollback**：`new Terminal({ scrollback: 1000~5000 })`；需要回看长输出时，用 `@xterm/addon-serialize` 落盘/写文件，而不是无限 scrollback。
4. **成对 dispose**：终端面板关闭/切换时 `term.dispose()` 并断开 PTY 事件监听（多实例泄漏是 xterm.js 历史 issue 重灾区，见 §3.1）。
5. **二进制写入**：用 `term.write(Uint8Array)` 而非字符串，避免解码开销；配合 Tauri Channel 直接收字节。
6. **多实例策略**：复用同一 webview 内的多个 xterm 实例（不要为终端开新 Tauri 窗口）；后台标签页可只保留 buffer、销毁渲染器（`open()` 可再次调用恢复），或干脆 serialize 后整体销毁。

**Rust / PTY 侧**
7. **PTY 懒启动**：首次需要时才 `portable_pty::native_pty_system().openpty()` + spawn shell；面板关闭即 kill child、关闭 reader，释放 fd 与线程。
8. **空闲回收**：可选——空闲 N 分钟且无 scrollback 保留需求时 kill 会话；恢复时重开 shell。
9. **reader 线程聚合写**：PTY reader 线程把输出攒批（如 8–16 KB 或 8 ms 窗口）再通过一个 Tauri Channel 推给前端，避免高频小事件打爆 IPC（IPC 序列化本身也是 CPU/内存来源）。
10. **resize 同步**：前端 `FitAddon` 得到 cols/rows 后调用 `pty.resize()`，保证 reflow 正确，间接减少异常 buffer 增长。

---

## 6. 风险与开放问题

1. **ghostty-web 成熟度**：0.4.0、API 兼容为"争取中"、addon 生态缺失；作为方案 B 需先做 spike 验证（中文宽字符、resize、alt screen、OSC52、选中复制）。
2. **tauri-plugin-pty 单点风险**：个人维护、早期阶段；若采用需 fork 兜底。自封装 portable-pty 的工作量与风险都更低，推荐后者。
3. **Tauri IPC 吞吐**：高频终端输出下，`emit` JSON 字符串事件开销大；应使用 Tauri v2 的 Channel/字节负载。此点需要在做方案 A 时以实测确认（`yes` 命令冲刷测试）。
4. **Windows 链路未实测**：portable-pty 的 ConPTY 路径与 WebView2 下 xterm.js DOM/WebGL 表现需在 Windows 真机验证；WebKitGTK（Linux）下 WebGL2 可用性历史上有坑，DOM renderer 不受影响——这也是默认推荐 DOM renderer 的原因之一。
5. **scrollback 数值与内存的权威基准缺失**：§4 中 12 B/单元格之外的"每行对象开销""WebGL 纹理占用"无官方数字，建议接入后用 webview 的 devtools heap snapshot 实测一次作为回归基线。
6. **wezterm term→wasm、alacritty_terminal+自绘前端**两条路线均标注为不确定/高成本，仅作信息备查。
7. **xterm.js 官方可能迁移 libghostty**（[#5686](https://github.com/xtermjs/xterm.js/issues/5686)，open）：若落地，方案 A 与方案 B 长期可能合流，选型时保持渲染层与 PTY 层的解耦（中间只隔"字节流 + resize + 生命周期"协议）即可低成本切换。

---

## 附：本次核实过的一手来源清单

- xterm.js 仓库与 releases：<https://github.com/xtermjs/xterm.js>、<https://github.com/xtermjs/xterm.js/releases/tag/6.0.0>
- xterm.js 内存/渲染相关 issues：[#4800](https://github.com/xtermjs/xterm.js/issues/4800)、[#4779](https://github.com/xtermjs/xterm.js/issues/4779)、[#3889](https://github.com/xtermjs/xterm.js/issues/3889)、[#4185](https://github.com/xtermjs/xterm.js/issues/4185)、[#4935](https://github.com/xtermjs/xterm.js/issues/4935)、[#4645](https://github.com/xtermjs/xterm.js/issues/4645)、[#5818](https://github.com/xtermjs/xterm.js/issues/5818)、[#5686](https://github.com/xtermjs/xterm.js/issues/5686)
- webgl addon README：<https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/README.md>
- ghostty-web：<https://github.com/coder/ghostty-web>、npm `ghostty-web@0.4.0` tarball 实测
- portable-pty：<https://crates.io/crates/portable-pty>、<https://github.com/wezterm/wezterm>（pty 目录提交记录）
- pty-process：<https://crates.io/crates/pty-process>、<https://git.tozt.net/pty-process>（README/Cargo.toml）
- tauri-plugin-pty：<https://crates.io/crates/tauri-plugin-pty>、<https://github.com/Tnze/tauri-plugin-pty>
- 参考项目：<https://github.com/klpod221/kerminal>（package.json、src-tauri/Cargo.toml 已核实）、<https://github.com/nyakang/nyaterm>、<https://github.com/yandanp/Connexio>、<https://github.com/iewnfod/lumina-terminal>
- alacritty_terminal：<https://crates.io/crates/alacritty_terminal>
