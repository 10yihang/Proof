import { Button } from "./ui/controls";
import { t } from "../i18n";
import { useEffect, useState } from "react";
import {
  ClockCounterClockwise,
  Link,
  Plug,
  Terminal,
  PencilLine,
  ShieldCheck,
} from "@phosphor-icons/react";
import { asError, useRequest } from "../api";
import type { FileDiff } from "../types";
import { ContextAssociations } from "./ContextAssociations";
import { ContextSessionEvents } from "./ContextSessionEvents";
import { startContextRefresh } from "../context-refresh";
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
  active = true,
}: {
  diff: FileDiff | null;
  demo: boolean;
  onSettings: () => void;
  onError: (error: unknown) => void;
  active?: boolean;
}) {
  const request = useRequest();
  const [receivedOverview, setOverview] = useState<ContextOverview | null>(
      null,
    ),
    [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [manager, setManager] = useState<{
    link?: ContextLink;
    history?: boolean;
  } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showMore, setShowMore] = useState(false);
  useEffect(() => {
    setExpanded({});
    setManager(null);
    setShowMore(false);
    setError("");
  }, [demo, diff?.workspaceId, diff?.path]);
  useEffect(() => {
    if (!active || demo || !diff) return;
    return startContextRefresh({
      workspaceId: diff.workspaceId,
      read: () =>
        request<ContextOverview>("context_overview", {
          workspaceId: diff.workspaceId,
          path: diff.path,
        }),
      receive: (data) => {
        setOverview(data);
        setError("");
      },
      onError: (cause) => setError(asError(cause).message),
    });
  }, [
    active,
    demo,
    diff?.workspaceId,
    diff?.path,
    diff?.id,
    revision,
    request,
  ]);
  const overview =
    receivedOverview?.workspaceId === diff?.workspaceId &&
    receivedOverview?.path === diff?.path
      ? receivedOverview
      : null;
  const links = overview?.links ?? [];
  return (
    <>
      {error && (
        <p role="alert" className="data-warning">
          {error}
        </p>
      )}
      <section className="context-section context-evidence-summary">
        <div className="section-title">
          <ShieldCheck size={16} />
          <h3>{t("验证状态")}</h3>
        </div>
        <p>{t("尚未确认此 Diff 的验证结果。")}</p>
        <p className="inline-help">
          {t("命令记录需在文件活动中核对，不代表当前 Diff 已验证。")}
        </p>
      </section>
      <section className="context-section context-session-heading">
        <div className="section-title">
          <Terminal size={16} />
          <h3>{t("相关会话")}</h3>
        </div>
        {!links.length && (
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
            <Button
              className="button compact"
              title={t("关联已有会话")}
              aria-label={t("关联已有会话")}
              onClick={() => setManager({})}
            >
              <Link size={14} />
              {t("关联已有会话")}
            </Button>
            <Button
              className="button compact subtle"
              title={t("修改记录")}
              aria-label={t("修改记录")}
              onClick={() => setManager({ history: true })}
            >
              <ClockCounterClockwise size={14} />
              {t("修改记录")}
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
      {(showMore ? links : links.slice(0, 3)).map((link) => (
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
            <Button
              className="icon-button context-edit-link"
              title={t("编辑关联")}
              aria-label={t("编辑关联")}
              onClick={() => setManager({ link })}
            >
              <PencilLine size={14} />
            </Button>
          </div>
          <p className="context-association-summary">
            {link.originalEvidence.matchedAtCapture && (
              <>{t("捕获时有内容匹配")} · </>
            )}
            {t("未确认与当前 Diff 相同")}
          </p>
          {!expanded[link.session.id] && (
            <>
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
            </>
          )}
          {link.userOverride?.note && (
            <div className="context-local-note">
              <strong>{t("本地备注")}</strong>
              <p>{link.userOverride.note}</p>
            </div>
          )}
          <details className="context-reason">
            <summary>{t("会话信息与关联依据")}</summary>
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
                ? t("收起文件活动")
                : t("查看文件活动 · {v0}", {
                    v0: link.originalEvidence.pathEventCount,
                  })}
            </Button>
          )}
          {diff && expanded[link.session.id] && !link.session.cleared && (
            <ContextSessionEvents
              key={`${diff.workspaceId}:${diff.path}:${link.session.id}`}
              path={diff.path}
              onSettings={onSettings}
              workspaceId={diff.workspaceId}
              session={link.session}
            />
          )}
        </section>
      ))}
      {links.length > 3 && (
        <Button
          className="text-button context-more-sessions"
          onClick={() => setShowMore(!showMore)}
        >
          {showMore
            ? t("收起较早会话")
            : t("更多相关会话 · {v0}", { v0: links.length - 3 })}
        </Button>
      )}
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
