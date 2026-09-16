import { ContextActivity } from "./ContextActivity";
import { Button } from "./ui/controls";
import { uiMessage, t } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { asError, useRequest } from "../api";
import {
  type ContextEvents,
  type ContextEventCursor,
  type ContextSession,
} from "./context-types";

export function ContextSessionEvents({
  workspaceId,
  session,
  path,
  onSettings,
}: {
  workspaceId: string;
  session: ContextSession;
  path: string;
  onSettings: () => void;
}) {
  const request = useRequest();
  const [allEvents, setAllEvents] = useState(false);
  const [page, setPage] = useState<
    (ContextEvents & { locallyExpired?: boolean }) | null
  >(null);
  const [loadedCount, setLoadedCount] = useState(session.eventCount);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  async function load(before: ContextEventCursor | null = null) {
    const n = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await request<ContextEvents>("context_session_events", {
        workspaceId,
        sessionId: session.id,
        path: allEvents ? null : path,
        before,
      });
      if (n === generation.current) {
        setPage((previous) => ({
          ...result,
          expiry: before
            ? { ...previous?.expiry, ...result.expiry }
            : result.expiry,
          taskContext: before
            ? [
                ...(previous?.taskContext ?? []),
                ...(result.taskContext ?? []),
              ].filter(
                (event, index, list) =>
                  list.findIndex((other) => other.id === event.id) === index,
              )
            : result.taskContext,
          events: before
            ? [...(previous?.events ?? []), ...result.events]
            : result.events,
        }));
        if (!before) setLoadedCount(session.eventCount);
      }
    } catch (cause) {
      if (n === generation.current) setError(asError(cause).message);
    } finally {
      if (n === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    setPage(null);
    void load();
    return () => {
      ++generation.current;
    };
  }, [workspaceId, session.id, path, allEvents]);
  useEffect(() => {
    // Each fetched page carries server retention deadlines. Expire cached bytes
    // even when the event count stays unchanged, without resetting other pages.
    const expire = () =>
      setPage((previous) => {
        if (!previous) return previous;
        const now = Date.now();
        let changed = false;
        const expireEvent = (event: ContextEvents["events"][number]) => {
          const deadline = previous.expiry?.[event.id];
          if (deadline && deadline.expiresAt <= now) {
            changed = true;
            return [];
          }
          if (
            deadline &&
            deadline.contentExpiresAt <= now &&
            event.output !== null
          ) {
            changed = true;
            return [
              {
                ...event,
                output: null,
                fieldStatus: { ...event.fieldStatus, output: "expired" },
              },
            ];
          }
          return [event];
        };
        const events = previous.events.flatMap(expireEvent);
        const taskContext = previous.taskContext?.flatMap(expireEvent);
        return changed
          ? { ...previous, events, taskContext, locallyExpired: true }
          : previous;
      });
    const timer = setInterval(expire, 1000);
    window.addEventListener("focus", expire);
    document.addEventListener("visibilitychange", expire);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", expire);
      document.removeEventListener("visibilitychange", expire);
    };
  }, []);
  return (
    <div className="observer-events" aria-label={t("会话原始记录")}>
      <div
        className="activity-scope-toggle"
        role="group"
        aria-label={t("活动范围")}
      >
        <Button aria-pressed={!allEvents} onClick={() => setAllEvents(false)}>
          {t("当前文件")}
        </Button>
        <Button aria-pressed={allEvents} onClick={() => setAllEvents(true)}>
          {t("完整会话")}
        </Button>
      </div>
      <div className="context-event-heading">
        <span>
          {allEvents
            ? t("会话活动")
            : t("{v0} 条文件相关记录", { v0: page?.fileEventCount ?? 0 })}
        </span>
        <Button
          className="text-button"
          disabled={loading}
          onClick={() => void load()}
        >
          {page && session.eventCount > loadedCount
            ? t("读取最新记录")
            : t("刷新记录")}
        </Button>
      </div>
      {page && session.eventCount > loadedCount && (
        <p className="inline-help" role="status">
          {t("有新记录；当前已展开的记录保持不变。")}
        </p>
      )}
      {page?.locallyExpired && (
        <p className="inline-help">{t("部分原始内容已到期清理。")}</p>
      )}
      <p className="inline-help">
        {t(
          "按已捕获的活动整理；命令退出码和 Agent 回执不代表当前 Diff 已验证。",
        )}
      </p>
      {error && (
        <p role="alert" className="data-warning">
          {uiMessage(error)}
        </p>
      )}
      {page?.cleared && <p>{t("原始会话已清理。")}</p>}
      {page && !loading && !page.events.length && !page.cleared && (
        <p className="activity-empty">
          {t("没有明确引用此文件的活动。可切换到完整会话查看其他记录。")}
        </p>
      )}
      {page &&
        page.events.some(
          (event) =>
            event.fieldStatus?.command === "not_authorized" ||
            event.fieldStatus?.output === "not_authorized",
        ) && (
          <div className="activity-availability">
            <p>
              {t(
                "部分操作只记录了名称，命令或输出未开启采集。已有记录无法补回。",
              )}
            </p>
            <Button className="text-button" onClick={onSettings}>
              {t("调整 Hook 记录内容")}
            </Button>
          </div>
        )}
      {page && <ContextActivity page={page} path={path} />}
      {loading && <p role="status">{t("读取记录中…")}</p>}
      {page?.next && (
        <Button
          className="button compact"
          disabled={loading}
          onClick={() => void load(page.next)}
        >
          {t("加载更早的记录")}
        </Button>
      )}
    </div>
  );
}
