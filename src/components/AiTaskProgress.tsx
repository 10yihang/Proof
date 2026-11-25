import { useEffect, useState } from "react";
import { CircleNotch, Circle, CaretDown } from "@phosphor-icons/react";
import { Button } from "./ui/controls";
import { t } from "../i18n";
import type { AiActivity, AiRunProgress } from "../ai-progress";

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
    ocr_capture: "正在固定审查版本",
    ocr_selecting: "OCR 正在筛选审查文件",
    ocr_scope: "OCR 已确定审查范围",
    ocr_reviewing: "OCR 正在审查",
    ocr_reading: "OCR 正在读取代码",
    ocr_searching: "OCR 正在查找相关代码",
    ocr_plan_done: "OCR 已完成审查计划",
    ocr_filtering: "OCR 正在复核意见",
    ocr_subtask_failed: "OCR 有审查分组未完成",
    validating: "正在校验分析结果",
  } as const;
  return t(labels[event.phase] ?? "Agent 正在分析");
}
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function AiTaskProgress({
  ai,
  isOcr = false,
}: {
  ai: {
    pending: "grouping" | "review" | "commit" | null;
    progress: AiRunProgress | null;
    cancel: () => void;
  };
  isOcr?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!ai.pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ai.pending]);
  const state = ai.progress;
  if (!ai.pending || !state) return null;
  const quiet = now - state.lastEventAt > 15_000;
  const lastActivity = Math.floor((now - state.lastEventAt) / 1000);
  const coverage = state.ocrScope
    ? t("纳入 {v0} 个文件 · 跳过 {v1} 个", {
        v0: state.ocrScope.eligible,
        v1: state.ocrScope.excluded,
      })
    : "";
  return (
    <section
      className={`ai-task-progress${isOcr ? " ai-task-progress--ocr" : ""}`}
      aria-label={t("Agent 活动")}
      aria-busy="true"
      tabIndex={isOcr ? -1 : undefined}
    >
      <header>
        <CircleNotch size={15} className="ai-task-spinner" aria-hidden="true" />
        <strong>
          {ai.pending === "commit"
            ? t("正在生成 Commit message…")
            : ai.pending === "grouping"
              ? t("Grouping changes…")
              : t(isOcr ? "OpenCodeReview 正在审查" : "Reviewing diff…")}
        </strong>
        <time aria-label={t("运行时长")}>
          {duration(now - state.startedAt)}
        </time>
      </header>
      {isOcr && state.reviewTarget && (
        <div className="ocr-progress-target">
          <span>{t("审查目标")}</span>
          <strong title={state.reviewTarget}>{state.reviewTarget}</strong>
        </div>
      )}
      <div className="ai-task-current">
        <div
          className="ai-task-phase"
          role="status"
          title={
            isOcr && quiet && !state.cancelling
              ? t("最近活动在 {v0} 秒前，任务仍在运行。", { v0: lastActivity })
              : undefined
          }
        >
          {state.cancelling
            ? t("正在取消…")
            : isOcr && quiet
              ? t("等待 OCR 新活动")
              : label(state.activity)}
        </div>
        {isOcr ? (
          <span className="ocr-current-path" title={state.recentPath}>
            {state.recentPath}
          </span>
        ) : (
          state.activity.path && (
            <span title={state.activity.path}>{state.activity.path}</span>
          )
        )}
        {isOcr && <small className="ocr-progress-coverage">{coverage}</small>}
        {!isOcr &&
          state.activity.total != null &&
          state.activity.completed != null && (
            <small>
              {state.activity.completed ?? 0} / {state.activity.total}{" "}
              {t("Files")}
            </small>
          )}
      </div>
      {!isOcr && quiet && !state.cancelling && (
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
              <li
                key={
                  isOcr
                    ? `${event.phase}:${event.path ?? ""}:${event.firstAt}`
                    : `${event.at}:${index}`
                }
              >
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
