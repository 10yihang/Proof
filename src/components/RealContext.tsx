import { useEffect, useState } from "react";
import { ClockCounterClockwise, Plug, Terminal } from "@phosphor-icons/react";
import { asError, useRequest } from "../api";
import type { FileDiff } from "../types";
interface Event {
  id: string;
  sessionId: string;
  nativeSessionId: string | null;
  agent: string;
  kind: string;
  toolName: string | null;
  receivedAt: number;
  paths: string[];
  prompt: string | null;
  command: string | null;
  reply: string | null;
  output: string | null;
  exitCode: number | null;
  commandState: string;
  fieldStatus: Record<string, string>;
  truncated: boolean;
  possiblyDuplicate: boolean;
}
export function RealContext({
  diff,
  demo,
  onSettings,
}: {
  diff: FileDiff | null;
  demo: boolean;
  onSettings: () => void;
}) {
  const request = useRequest();
  const [events, setEvents] = useState<Event[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    setEvents([]);
    setError("");
    if (demo || !diff) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await request<Event[]>("observer_file_context", {
          workspaceId: diff!.workspaceId,
          path: diff!.path,
        });
        if (active) {
          setEvents(data);
          setError("");
        }
      } catch (e) {
        if (active) setError(asError(e).message);
      } finally {
        if (active) timer = setTimeout(poll, 2500);
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [demo, diff?.workspaceId, diff?.path]);
  const sessions = [...new Set(events.map((e) => e.sessionId))];
  return (
    <>
      {error && (
        <p role="alert" className="data-warning">
          {error}
        </p>
      )}
      {events.length ? (
        <>
          <section className="context-section">
            <div className="section-title">
              <Terminal size={16} />
              <h3>相关 Agent 会话</h3>
            </div>
            <p>
              {sessions.length}{" "}
              个会话记录过此文件的活动。文件级关联不代表全部改动均由该 Agent
              完成。
            </p>
          </section>
          {sessions.map((session) => {
            const rows = events.filter((e) => e.sessionId === session),
              prompt = rows.find((e) => e.prompt),
              last = rows[0];
            return (
              <section className="context-section" key={session}>
                <div className="context-session">
                  <Terminal size={18} />
                  <strong>
                    {last.agent === "codex" ? "Codex" : "Claude Code"}
                  </strong>
                  <span className="tag">{rows.length} events</span>
                </div>
                <code
                  className="context-path"
                  title={last.nativeSessionId ?? session}
                >
                  {(last.nativeSessionId ?? session).slice(0, 18)}
                </code>
                {prompt ? (
                  <p className="context-task">{prompt.prompt}</p>
                ) : (
                  <p className="muted">此会话没有可用的 Prompt 记录。</p>
                )}
                <div className="observer-events">
                  {[...rows].reverse().map((event) => (
                    <details key={event.id}>
                      <summary>
                        <time>
                          {new Date(event.receivedAt).toLocaleTimeString(
                            "zh-CN",
                            { hour12: false },
                          )}
                        </time>
                        <span>{event.toolName ?? event.kind}</span>
                      </summary>
                      {event.truncated && (
                        <p className="data-warning">
                          此事件内容已截断，记录并不完整。
                        </p>
                      )}
                      {event.possiblyDuplicate && (
                        <p className="data-warning">
                          此事件可能重复，不能据此判断执行次数。
                        </p>
                      )}
                      {Object.entries(event.fieldStatus ?? {})
                        .filter(([, value]) =>
                          [
                            "truncated",
                            "expired",
                            "redacted",
                            "limited_or_outside_scope",
                          ].includes(value),
                        )
                        .map(([key, value]) => (
                          <p className="inline-help" key={key}>
                            {key} ·{" "}
                            {
                              (
                                {
                                  truncated: "已截断",
                                  expired: "已到期",
                                  redacted: "已隐藏",
                                  limited_or_outside_scope: "超出采集范围",
                                } as Record<string, string>
                              )[value]
                            }
                          </p>
                        ))}
                      {event.paths.length > 0 && (
                        <p className="context-path">{event.paths.join(", ")}</p>
                      )}
                      {event.command && <pre>{event.command}</pre>}
                      {event.commandState !== "not_applicable" && (
                        <p className="muted">
                          {event.exitCode === null
                            ? "退出状态未知"
                            : `Exit ${event.exitCode}`}{" "}
                          · 未关联结构化测试报告
                        </p>
                      )}
                      {event.output && <pre>{event.output}</pre>}
                      {event.reply && <p>{event.reply}</p>}
                      {event.prompt && <p>{event.prompt}</p>}
                    </details>
                  ))}
                </div>
              </section>
            );
          })}
          {events.length === 100 && (
            <p className="inline-help">显示最近 100 条相关事件。</p>
          )}
        </>
      ) : (
        <section className="context-section">
          <div className="section-title">
            <ClockCounterClockwise size={16} />
            <h3>Agent activity</h3>
          </div>
          <div className="observer-empty">
            <Terminal size={26} />
            <strong>暂无相关记录</strong>
            <p>开启 Agent Hook 后，查看与此文件有关的任务、命令和工具输出。</p>
          </div>
        </section>
      )}
      <button className="button compact" onClick={onSettings}>
        <Plug size={14} />
        管理 Agent Hook
      </button>
    </>
  );
}
