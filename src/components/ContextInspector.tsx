import { RealContext } from "./RealContext";
import {
  Fingerprint,
  ShieldCheck,
  Terminal,
  X,
  ClockCounterClockwise,
  FileCode,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import type { FileDiff } from "../types";
import { shouldDismissDrawer } from "./panel-focus";

export function ContextInspector({
  diff,
  demo,
  onClose,
  onSettings,
  drawer = false,
  closeDisabled = false,
  onLeave,
}: {
  diff: FileDiff | null;
  demo: boolean;
  drawer?: boolean;
  closeDisabled?: boolean;
  onLeave?: () => void;
  onClose: () => void;
  onSettings: () => void;
}) {
  return (
    <aside
      id="context-panel"
      className={`context-panel ${drawer ? "context-drawer" : ""}`}
      aria-label="上下文与证据"
      onBlurCapture={(event) => {
        if (drawer && shouldDismissDrawer(event)) onLeave?.();
      }}
    >
      <header className="context-header">
        <strong>Change context</strong>
        <button
          className="icon-button"
          title="收起上下文"
          aria-label="收起上下文"
          onClick={onClose}
          disabled={closeDisabled}
        >
          <X size={16} />
        </button>
      </header>
      <div className="context-body">
        {demo && diff && diff.path !== "README.md" ? (
          <DemoContext path={diff.path} />
        ) : (
          <RealContext diff={diff} demo={demo} onSettings={onSettings} />
        )}
        {diff && (
          <div className="context-section snapshot-info">
            <div className="section-title">
              <ClockCounterClockwise size={16} />
              <h3>Diff details</h3>
            </div>
            <dl>
              <dt>比较范围</dt>
              <dd>
                {diff.side === "staged" ? "HEAD → Index" : "Index → Worktree"}
              </dd>
              <dt>更新时间</dt>
              <dd>
                {new Date(diff.capturedAt).toLocaleTimeString("zh-CN", {
                  hour12: false,
                })}
              </dd>
              <dt>基准提交</dt>
              <dd>
                <code>{diff.base.split(":")[0].slice(0, 8)}</code>
              </dd>
            </dl>
            <p className="snapshot-note">文件保存后自动更新 Diff。</p>
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
