import { Button } from "./ui/controls";
import { t } from "../i18n";
import { useEffect, useRef, useState } from "react";
import {
  ClockCounterClockwise,
  Link,
  Plug,
  Terminal,
} from "@phosphor-icons/react";
import { asError, useRequest } from "../api";
import type { FileDiff } from "../types";
import { ContextAssociations } from "./ContextAssociations";
import { ContextSessionEvents } from "./ContextSessionEvents";
import {
  agentName,
  associationReason,
  fieldState,
  type ContextLink,
  type ContextOverview,
} from "./context-types";
import "../styles/context.css";

export function RealContext({
  diff,
  demo,
  onSettings,
  onError,
}: {
  diff: FileDiff | null;
  demo: boolean;
  onSettings: () => void;
  onError: (error: unknown) => void;
}) {
  const request = useRequest();
  const [overview, setOverview] = useState<ContextOverview | null>(null),
    [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [manager, setManager] = useState<{
    link?: ContextLink;
    history?: boolean;
  } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const generation = useRef(0);
  useEffect(() => {
    if (demo || !diff) return;
    const n = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await request<ContextOverview>("context_overview", {
          workspaceId: diff!.workspaceId,
          path: diff!.path,
        });
        if (n === generation.current) {
          setOverview(data);
          setError("");
        }
      } catch (cause) {
        if (n === generation.current) setError(asError(cause).message);
      } finally {
        if (n === generation.current) timer = setTimeout(poll, 2500);
      }
    }
    void poll();
    return () => {
      ++generation.current;
      clearTimeout(timer);
    };
  }, [demo, diff?.workspaceId, diff?.path, revision]);
  const links = overview?.links ?? [];
  return (
    <>
      {error && (
        <p role="alert" className="data-warning">
          {error}
        </p>
      )}
      <section className="context-section">
        <div className="section-title">
          <Terminal size={16} />
          <h3>{t("相关会话")}</h3>
        </div>
        {links.length ? (
          <p className="inline-help">
            {t("文件级线索；当前 Diff 的逐行归属未确定。")}
          </p>
        ) : (
          <div className="observer-empty">
            <Terminal size={26} />
            <strong>
              {!overview && !demo && diff && !error
                ? t("读取会话中…")
                : t("暂无相关记录")}
            </strong>
            <p>
              {t("来源未知。可以关联已有会话，或在 Agent Hook 中开启记录。")}
            </p>
          </div>
        )}
        {diff && !demo && (
          <div className="context-link-actions">
            <Button className="button compact" onClick={() => setManager({})}>
              <Link size={14} />
              {t("关联会话")}
            </Button>
            <Button
              className="button compact"
              onClick={() => setManager({ history: true })}
            >
              <ClockCounterClockwise size={14} />
              {t("修改记录")}
              {overview?.historyCount ? ` · ${overview.historyCount}` : ""}
            </Button>
          </div>
        )}
        {!!overview?.excludedCount && (
          <p className="inline-help">
            {t("已手动解除 ")}
            {overview.excludedCount} {t("个会话的关联，可在修改记录中撤销。")}
          </p>
        )}
      </section>
      {links.map((link) => (
        <section
          className="context-section context-linked-session"
          key={link.session.id}
        >
          <div className="context-session">
            <Terminal size={17} />
            <strong>{agentName(link.session)}</strong>
            <span
              className={`tag ${link.userOverride ? "context-user-link" : ""}`}
            >
              {link.userOverride ? t("用户指定") : t("相关会话")}
            </span>
          </div>
          <code
            className="context-path"
            title={link.session.nativeSessionId ?? link.session.id}
          >
            {link.session.nativeSessionId ? "Session" : t("Proof 本地 ID")} ·{" "}
            {(link.session.nativeSessionId ?? link.session.id).slice(0, 24)}
          </code>
          {link.session.nativeAgentId && (
            <p className="context-path">
              {t("Subagent · ")}
              {link.session.nativeAgentId}
            </p>
          )}
          <strong className="context-field-label">
            {t("任务原文 · 摘要")}
          </strong>
          {link.session.promptExcerpt ? (
            <p className="context-task">{link.session.promptExcerpt}</p>
          ) : (
            <p className="inline-help">
              {t("Prompt · ")}
              {fieldState(link.session.promptStatus)}
            </p>
          )}
          {link.userOverride?.note && (
            <div className="context-local-note">
              <strong>{t("本地备注")}</strong>
              <p>{link.userOverride.note}</p>
            </div>
          )}
          <details className="context-reason">
            <summary>{t("关联依据")}</summary>
            <p>
              {associationReason(link.originalEvidence)}
              {link.userOverride && t("此关联由用户指定。")}{" "}
              {t(" 文件级线索不代表本次 Diff 全部由此会话产生。")}
            </p>
          </details>
          {link.session.cleared ? (
            <p className="inline-help">
              {t("原始会话已清理，本地备注保留至自身到期。")}
            </p>
          ) : (
            <Button
              className="button compact"
              aria-expanded={!!expanded[link.session.id]}
              onClick={() =>
                setExpanded((old) => ({
                  ...old,
                  [link.session.id]: !old[link.session.id],
                }))
              }
            >
              {expanded[link.session.id]
                ? t("收起原始记录")
                : t("查看会话 · {v0} events", { v0: link.session.eventCount })}
            </Button>
          )}
          <Button
            className="button compact"
            onClick={() => setManager({ link })}
          >
            {t("编辑关联")}
          </Button>
          {diff && expanded[link.session.id] && !link.session.cleared && (
            <ContextSessionEvents
              workspaceId={diff.workspaceId}
              session={link.session}
            />
          )}
        </section>
      ))}
      {overview?.hasMore && (
        <p className="inline-help">
          {t("仅显示最近 30 个关联会话；在“关联会话”中搜索或加载更多。")}
        </p>
      )}
      <Button className="button compact" onClick={onSettings}>
        <Plug size={14} />
        {t("管理 Agent Hook")}
      </Button>
      {manager && diff && (
        <ContextAssociations
          workspaceId={diff.workspaceId}
          path={diff.path}
          initialLink={manager.link}
          initialHistory={manager.history}
          onClose={() => setManager(null)}
          onChanged={() => setRevision((old) => old + 1)}
          onError={onError}
        />
      )}
    </>
  );
}
