import { Segmented } from "./ui/segmented";
import { Button } from "./ui/controls";
import { t, getLanguage } from "../i18n";
import type { ReactNode } from "react";
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
  activeTab = "context",
  onTab,
  aiPanel,
  onClose,
  onSettings,
  onError,
  drawer = false,
  closeDisabled = false,
  onLeave,
}: {
  activeTab?: "context" | "ai";
  onTab?: (tab: "context" | "ai") => void;
  aiPanel?: ReactNode;
  diff: FileDiff | null;
  demo: boolean;
  drawer?: boolean;
  closeDisabled?: boolean;
  onLeave?: () => void;
  onClose: () => void;
  onSettings: () => void;
  onError: (error: unknown) => void;
}) {
  return (
    <aside
      id="context-panel"
      className={`context-panel ${drawer ? "context-drawer" : ""}`}
      aria-label={t("上下文与证据")}
      onBlurCapture={(event) => {
        if (drawer && shouldDismissDrawer(event)) onLeave?.();
      }}
    >
      <header className="context-header">
        {aiPanel ? (
          <Segmented
            value={activeTab}
            onChange={(value) => onTab?.(value)}
            label={t("Inspector")}
            className="inspector-tabs"
            items={[
              { value: "context", label: t("Context") },
              { value: "ai", label: t("AI Review") },
            ]}
          />
        ) : (
          <strong>{t("Change context")}</strong>
        )}
        <Button
          className="icon-button"
          title={t("收起上下文")}
          aria-label={t("收起上下文")}
          onClick={onClose}
          disabled={closeDisabled}
        >
          <X size={16} />
        </Button>
      </header>
      <div className="context-body">
        {activeTab === "ai" && aiPanel ? (
          aiPanel
        ) : (
          <>
            {demo && diff && diff.path !== "README.md" ? (
              <DemoContext path={diff.path} />
            ) : (
              <RealContext
                key={`${diff?.workspaceId}:${diff?.path}`}
                diff={diff}
                demo={demo}
                onSettings={onSettings}
                onError={onError}
              />
            )}
            {diff && (
              <div className="context-section snapshot-info">
                <div className="section-title">
                  <ClockCounterClockwise size={16} />
                  <h3>{t("Diff details")}</h3>
                </div>
                <dl>
                  <dt>{t("比较范围")}</dt>
                  <dd>
                    {diff.side === "staged"
                      ? t("HEAD → Index")
                      : t("Index → Worktree")}
                  </dd>
                  <dt>{t("更新时间")}</dt>
                  <dd>
                    {new Date(diff.capturedAt).toLocaleTimeString(
                      getLanguage(),
                      {
                        hour12: false,
                      },
                    )}
                  </dd>
                  <dt>{t("基准提交")}</dt>
                  <dd>
                    <code>{diff.base.split(":")[0].slice(0, 8)}</code>
                  </dd>
                </dl>
                <p className="snapshot-note">
                  {t("文件保存后自动更新 Diff。")}
                </p>
              </div>
            )}
          </>
        )}
      </div>
      <footer className="context-footer">
        <ShieldCheck size={14} />
        {t("本地保存 · 按需授权")}
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
          <strong>{t("Claude Code")}</strong>
          <span>{t("演示会话")}</span>
        </div>
        <span className="tag">{t("示例")}</span>
      </div>
      <section className="context-section">
        <div className="section-title">
          <Fingerprint size={15} />
          <h3>{t("任务背景")}</h3>
        </div>
        <p className="context-task">
          {t("为请求接口增加输入校验，统一错误响应，并保留现有调用方式。")}
        </p>
        <span className="context-source-note">
          {t("虚构任务，用于展示审查界面")}
        </span>
      </section>
      <section className="context-section">
        <div className="section-title">
          <FileCode size={15} />
          <h3>{t("当前文件")}</h3>
        </div>
        <code className="context-path">{path}</code>
        <p>{t("核对输入约束、错误分支以及调用方是否仍能正确处理响应。")}</p>
        <span className="evidence-label">
          <span className="status-dot neutral" />
          {t("相关会话 · 示例关联")}
        </span>
      </section>
      <section className="context-section">
        <div className="section-title">
          <ClockCounterClockwise size={15} />
          <h3>{t("活动示例")}</h3>
        </div>
        <div className="context-timeline">
          <div>
            <time>14:31</time>
            <FileCode size={13} />
            <span>
              {t("读取 ")}
              <code>{file}</code>
            </span>
          </div>
          <div>
            <time>14:32</time>
            <MagnifyingGlass size={13} />
            <span>{t("查找请求处理入口")}</span>
          </div>
          <div>
            <time>14:33</time>
            <FileCode size={13} />
            <span>{t("更新输入校验")}</span>
          </div>
          <div>
            <time>14:35</time>
            <Terminal size={13} />
            <span>
              <code>{t("npm test")}</code>
            </span>
          </div>
        </div>
      </section>
      <section className="context-section">
        <div className="section-title">
          <ShieldCheck size={15} />
          <h3>{t("验证记录")}</h3>
        </div>
        <div className="context-verification">
          <span>{t("示例命令退出码")}</span>
          <code>0</code>
        </div>
        <p>
          {t(
            "此处演示命令记录的呈现方式。未确认它对应当前代码，也未展示结构化测试结果。",
          )}
        </p>
      </section>
    </>
  );
}
