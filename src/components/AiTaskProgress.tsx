import { useEffect, useState } from "react";
import { CircleNotch, Circle, CaretDown } from "@phosphor-icons/react";
import { Button } from "./ui/controls";
import { t } from "../i18n";
import type { AiController } from "../ai";
import type { AiActivity } from "../ai-progress";

function label(event: AiActivity) {
  const labels = {
    preparing: "正在收集变更",
    context: "正在准备项目上下文",
    starting: "正在启动 Agent",
    reading: "正在读取文件",
    searching: "正在搜索代码",
    git: "正在查询 Git",
    tool: "正在执行只读命令",
    tool_failed: "工具未完成，Agent 正在处理",
    analyzing: "Agent 正在分析",
    validating: "正在校验分析结果",
  } as const;
  return t(labels[event.phase] ?? "Agent 正在分析");
}
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function AiTaskProgress({ ai }: { ai: AiController }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!ai.pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ai.pending]);
  const state = ai.progress;
  if (!ai.pending || !state) return null;
  const quiet = now - state.lastEventAt > 15_000;
  return (
    <section
      className="ai-task-progress"
      aria-label={t("Agent 活动")}
      aria-busy="true"
    >
      <header>
        <CircleNotch size={15} className="ai-task-spinner" aria-hidden="true" />
        <strong>
          {ai.pending === "grouping"
            ? t("Grouping changes…")
            : t("Reviewing diff…")}
        </strong>
        <time aria-label={t("运行时长")}>
          {duration(now - state.startedAt)}
        </time>
      </header>
      <div className="ai-task-current" role="status">
        {state.cancelling ? t("正在取消…") : label(state.activity)}
        {state.activity.path && (
          <span title={state.activity.path}>{state.activity.path}</span>
        )}
        {state.activity.total != null && (
          <small>
            {state.activity.completed ?? 0} / {state.activity.total}{" "}
            {t("Files")}
          </small>
        )}
      </div>
      {quiet && !state.cancelling && (
        <p className="ai-task-quiet">
          {t("等待 Agent 新活动，任务仍在运行。")}
        </p>
      )}
      <footer>
        <details>
          <summary>
            <CaretDown size={12} />
            {t("查看活动")}
          </summary>
          <ol aria-label={t("活动记录")}>
            {state.history.map((event, index) => (
              <li key={`${event.at}:${index}`}>
                <Circle size={7} aria-hidden="true" />
                <span>
                  {label(event)}
                  {event.path && <small title={event.path}>{event.path}</small>}
                </span>
                <time>{duration(event.at - state.startedAt)}</time>
              </li>
            ))}
          </ol>
        </details>
        <Button
          className="text-button"
          onClick={ai.cancel}
          disabled={state.cancelling}
        >
          {t("Cancel")}
        </Button>
      </footer>
    </section>
  );
}
