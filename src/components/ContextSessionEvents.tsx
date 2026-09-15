import { Button } from "./ui/controls";
import { uiMessage, t, getLanguage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { asError, useRequest } from "../api";
import {
  fieldState,
  type ContextEvents,
  type ContextEventCursor,
  type ContextSession,
} from "./context-types";

export function ContextSessionEvents({
  workspaceId,
  session,
}: {
  workspaceId: string;
  session: ContextSession;
}) {
  const request = useRequest();
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
        before,
      });
      if (n === generation.current) {
        setPage((previous) => ({
          ...result,
          expiry: before
            ? { ...previous?.expiry, ...result.expiry }
            : result.expiry,
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
    void load();
    return () => {
      ++generation.current;
    };
  }, [workspaceId, session.id]);
  useEffect(() => {
    // Each fetched page carries server retention deadlines. Expire cached bytes
    // even when the event count stays unchanged, without resetting other pages.
    const expire = () =>
      setPage((previous) => {
        if (!previous) return previous;
        const now = Date.now();
        let changed = false;
        const events = previous.events.flatMap((event) => {
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
        });
        return changed
          ? { ...previous, events, locallyExpired: true }
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
      <div className="context-event-heading">
        <strong>{t("原始记录")}</strong>
        <Button
          className="button compact"
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
        {t("以下是此会话的 Hook 记录；命令结果与当前 Diff 的版本关系未确认。")}
      </p>
      {error && (
        <p role="alert" className="data-warning">
          {uiMessage(error)}
        </p>
      )}
      {page?.cleared && <p>{t("原始会话已清理。")}</p>}
      {page?.events.map((event) => (
        <details key={event.id}>
          <summary>
            <time>
              {new Date(event.receivedAt).toLocaleString(getLanguage(), {
                hour12: false,
              })}
            </time>
            <span>{event.toolName ?? event.kind}</span>
          </summary>
          {event.truncated && (
            <p className="data-warning">{t("此事件内容已截断。")}</p>
          )}
          {event.possiblyDuplicate && (
            <p className="inline-help">
              {t("事件可能重复，不能据此判断执行次数。")}
            </p>
          )}
          {Object.entries(event.fieldStatus ?? {})
            .filter(([, status]) =>
              [
                "not_authorized",
                "not_provided",
                "expired",
                "truncated",
                "redacted",
                "limited_or_outside_scope",
              ].includes(status),
            )
            .map(([field, status]) => (
              <p className="inline-help" key={field}>
                {(
                  {
                    prompt: "Prompt",
                    command: t("命令"),
                    output: t("工具输出"),
                    reply: t("最终回复"),
                    paths: t("文件路径"),
                  } as Record<string, string>
                )[field] ?? field}{" "}
                · {fieldState(status)}
              </p>
            ))}
          {!!event.paths.length && (
            <p className="context-path">{event.paths.join(", ")}</p>
          )}
          {event.turnId && (
            <p className="context-path">
              {t("Turn · ")}
              {event.turnId}
            </p>
          )}
          {event.toolRef && (
            <p className="context-path">
              {t("Tool call · ")}
              {event.toolRef}
            </p>
          )}
          {event.prompt && (
            <>
              <strong className="context-field-label">{t("任务原文")}</strong>
              <pre>{event.prompt}</pre>
            </>
          )}
          {event.command && (
            <>
              <strong className="context-field-label">{t("命令")}</strong>
              <pre>{event.command}</pre>
            </>
          )}
          {event.commandState !== "not_applicable" && (
            <p className="muted">
              {event.exitCode === null
                ? t("退出状态未知")
                : event.exitCode === 0
                  ? t("命令成功 · Exit 0")
                  : t("命令退出 · Exit {v0}", { v0: event.exitCode })}{" "}
              {t("· 未关联结构化测试报告")}
            </p>
          )}
          {event.output && (
            <>
              <strong className="context-field-label">{t("工具输出")}</strong>
              <pre>{event.output}</pre>
            </>
          )}
          {event.reply && (
            <>
              <strong className="context-field-label">
                {t("Agent 最终回复 · 原文")}
              </strong>
              <pre>{event.reply}</pre>
              <p className="inline-help">
                {t("回复中的验证结论来自 Agent，未作为测试报告验证。")}
              </p>
            </>
          )}
        </details>
      ))}
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
