import {
  Fingerprint,
  Info,
  Plug,
  ShieldCheck,
  Terminal,
  X,
  ClockCounterClockwise,
  FileCode,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import type { FileDiff } from "../types";

export function ContextInspector({
  diff,
  demo,
  onClose,
  onSettings,
  drawer = false,
}: {
  diff: FileDiff | null;
  demo: boolean;
  drawer?: boolean;
  onClose: () => void;
  onSettings: () => void;
}) {
  return (
    <aside
      className={`context-panel ${drawer ? "context-drawer" : ""}`}
      aria-label="上下文与证据"
    >
      <header className="context-header">
        <strong>修改上下文</strong>
        <button
          className="icon-button"
          title="收起上下文"
          aria-label="收起上下文"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="context-body">
        {demo && diff && diff.path !== "README.md" ? (
          <DemoContext path={diff.path} />
        ) : (
          <>
            <div className="context-section">
              <div className="section-title">
                <Fingerprint size={16} />
                <h3>修改来源</h3>
              </div>
              <span className="evidence-label">
                <span className="status-dot neutral" />
                来源未知
              </span>
              <p>尚无可核对的会话记录，无法确认这份修改的来源。</p>
              <div className="context-explanation">
                <Info size={14} />
                <span>文件变化本身不能证明由 Agent 或人工完成。</span>
              </div>
            </div>
            <div className="context-section">
              <div className="section-title">
                <Terminal size={16} />
                <h3>任务与执行记录</h3>
              </div>
              <div className="observer-empty">
                <div className="observer-illustration">
                  <Terminal size={23} />
                  <span className="connection-line" />
                  <Plug size={23} />
                </div>
                <strong>
                  {demo ? "演示中未接入 Agent" : "尚未接入 Agent"}
                </strong>
                <p>
                  继续在终端使用你喜欢的
                  Agent。授权观察后，在这里核对相关任务和执行记录。
                </p>
                <button className="button compact" onClick={onSettings}>
                  <Plug size={14} />
                  查看观察设置
                </button>
              </div>
            </div>
            <div className="context-section">
              <div className="section-title">
                <ShieldCheck size={16} />
                <h3>验证记录</h3>
              </div>
              <div className="evidence-value">未观察到结果</div>
              <p>命令成功、测试通过与代码版本关系会分别显示。</p>
            </div>
          </>
        )}
        {diff && (
          <div className="context-section snapshot-info">
            <div className="section-title">
              <ClockCounterClockwise size={16} />
              <h3>阅读快照</h3>
            </div>
            <dl>
              <dt>比较范围</dt>
              <dd>
                {diff.side === "staged" ? "HEAD → Index" : "Index → 工作树"}
              </dd>
              <dt>捕获时间</dt>
              <dd>
                {new Date(diff.capturedAt).toLocaleTimeString("zh-CN", {
                  hour12: false,
                })}
              </dd>
              <dt>基准提交</dt>
              <dd>
                <code>{diff.base.split(":")[0].slice(0, 8)}</code>
              </dd>
              <dt>关联粒度</dt>
              <dd>
                {demo && diff.path !== "README.md" ? "文件级示例" : "暂无证据"}
              </dd>
            </dl>
            <p className="snapshot-note">
              外部变化会提示更新，当前阅读位置保持稳定。
            </p>
          </div>
        )}
      </div>
      <footer className="context-footer">
        <ShieldCheck size={14} />
        本地保存 · 按需授权
      </footer>
    </aside>
  );
}

function DemoContext({ path }: { path: string }) {
  const file = path.split("/").pop();
  return (
    <>
      <div className="context-session">
        <div className="context-session-icon">
          <Terminal size={21} />
        </div>
        <div>
          <strong>Claude Code</strong>
          <span>演示会话</span>
        </div>
        <span className="tag">示例</span>
      </div>
      <section className="context-section">
        <div className="section-title">
          <Fingerprint size={15} />
          <h3>任务背景</h3>
        </div>
        <p className="context-task">
          为请求接口增加输入校验，统一错误响应，并保留现有调用方式。
        </p>
        <span className="context-source-note">虚构任务，用于展示审查界面</span>
      </section>
      <section className="context-section">
        <div className="section-title">
          <FileCode size={15} />
          <h3>当前文件</h3>
        </div>
        <code className="context-path">{path}</code>
        <p>核对输入约束、错误分支以及调用方是否仍能正确处理响应。</p>
        <span className="evidence-label">
          <span className="status-dot neutral" />
          相关会话 · 示例关联
        </span>
      </section>
      <section className="context-section">
        <div className="section-title">
          <ClockCounterClockwise size={15} />
          <h3>活动示例</h3>
        </div>
        <div className="context-timeline">
          <div>
            <time>14:31</time>
            <FileCode size={13} />
            <span>
              读取 <code>{file}</code>
            </span>
          </div>
          <div>
            <time>14:32</time>
            <MagnifyingGlass size={13} />
            <span>查找请求处理入口</span>
          </div>
          <div>
            <time>14:33</time>
            <FileCode size={13} />
            <span>更新输入校验</span>
          </div>
          <div>
            <time>14:35</time>
            <Terminal size={13} />
            <span>
              <code>npm test</code>
            </span>
          </div>
        </div>
      </section>
      <section className="context-section">
        <div className="section-title">
          <ShieldCheck size={15} />
          <h3>验证记录</h3>
        </div>
        <div className="context-verification">
          <span>示例命令退出码</span>
          <code>0</code>
        </div>
        <p>
          此处演示命令记录的呈现方式。未确认它对应当前代码，也未展示结构化测试结果。
        </p>
      </section>
    </>
  );
}
