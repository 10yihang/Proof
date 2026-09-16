import { t, getLanguage } from "../i18n";
import {
  PencilLine,
  FileText,
  MagnifyingGlass,
  CheckCircle,
  Terminal,
  DotsThree,
} from "@phosphor-icons/react";
import {
  activityTasks,
  outputExcerpt,
  type ActivityItem,
} from "../context-activity";
import {
  fieldState,
  type ContextEvent,
  type ContextEvents,
} from "./context-types";
import { useState } from "react";

function EventEvidence({ event }: { event: ContextEvent }) {
  return (
    <div className="activity-evidence">
      {event.toolName && (
        <p className="context-path">
          {event.toolName} ·{" "}
          {new Date(event.receivedAt).toLocaleString(getLanguage())}
        </p>
      )}{" "}
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
    </div>
  );
}
const labels = {
  edit: "修改文件",
  read: "读取文件",
  search: "搜索代码",
  check: "运行验证",
  command: "执行命令",
  other: "工具操作",
} as const;
const icons = {
  edit: PencilLine,
  read: FileText,
  search: MagnifyingGlass,
  check: CheckCircle,
  command: Terminal,
  other: DotsThree,
};
function ActivityRow({ item, path }: { item: ActivityItem; path: string }) {
  const event = item.event,
    Icon = icons[item.kind];
  const firstLine = item.command.trim().split("\n").find(Boolean);
  const title =
    item.kind === "edit"
      ? `${t("修改文件")}${event.paths.length ? ` · ${(event.paths.includes(path) ? [path] : event.paths.slice(0, 2)).map((file) => file.split("/").pop()).join(", ")}` : ""}`
      : firstLine ||
        (item.kind === "other" && event.toolName
          ? `${t(labels[item.kind])} · ${event.toolName}`
          : t(labels[item.kind]));
  const preview = outputExcerpt(event.output);
  const hasContent = item.records.some(
    (record) =>
      !!(record.command || record.output || record.prompt || record.reply),
  );
  return (
    <article className={`activity-row ${item.failed ? "is-failure" : ""}`}>
      <Icon size={15} aria-hidden="true" />
      <div className="activity-row-body">
        <div className="activity-row-title">
          <strong title={title}>{title}</strong>
          {item.records.length > 1 && (
            <span className="activity-repeat">×{item.records.length}</span>
          )}
        </div>
        <div className="activity-row-meta">
          <span>
            {event.toolName && event.toolName !== "Bash"
              ? event.toolName
              : t(labels[item.kind])}
          </span>
          {item.failed ? (
            <span className="activity-status failed">
              {t("执行失败")}
              {event.exitCode !== null ? ` · Exit ${event.exitCode}` : ""}
            </span>
          ) : event.exitCode !== null ? (
            <span className="activity-status">Exit {event.exitCode}</span>
          ) : item.kind === "check" ? (
            <span>{t("退出状态未知")}</span>
          ) : null}
          {!hasContent && (
            <span>
              {item.kind === "edit" && event.paths.length
                ? t("仅包含文件路径")
                : fieldState(event.fieldStatus?.command ?? "not_provided")}
            </span>
          )}
        </div>
        {preview && <pre className="activity-output-preview">{preview}</pre>}
        {hasContent && (
          <details className="activity-detail">
            <summary>{t("详细记录")}</summary>
            <EventEvidence event={event} />
            {item.records.length > 1 && (
              <div className="activity-repeats">
                <p>{t("相同操作的记录")}</p>
                {item.records.map((record) => (
                  <details key={record.id}>
                    <summary>
                      {new Date(record.receivedAt).toLocaleTimeString(
                        getLanguage(),
                        { hour12: false },
                      )}
                    </summary>
                    <EventEvidence event={record} />
                  </details>
                ))}
              </div>
            )}
          </details>
        )}
      </div>
    </article>
  );
}
export function ContextActivity({
  page,
  path,
}: {
  page: ContextEvents;
  path: string;
}) {
  const tasks = activityTasks(page.events, page.taskContext),
    [showAll, setShowAll] = useState(false);
  return (
    <div className="context-activity-list">
      {(showAll ? tasks : tasks.slice(0, 4)).map((task) => {
        const important = task.items
          .filter(
            (item) => item.failed || ["edit", "check"].includes(item.kind),
          )
          .sort(
            (a, b) =>
              Number(b.failed) - Number(a.failed) ||
              b.event.receivedAt - a.event.receivedAt,
          );
        const routine = task.items.filter((item) => !important.includes(item));
        return (
          <article className="activity-task" key={task.id}>
            <header>
              <strong>
                {task.prompt?.prompt ||
                  t(task.turnId ? "相关任务" : "文件活动")}
              </strong>
              <time
                title={new Date(task.receivedAt).toLocaleString(getLanguage())}
              >
                {new Date(task.receivedAt).toLocaleTimeString(getLanguage(), {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </time>
            </header>
            <div className="activity-task-stats">
              {t("{v0} 条活动记录", { v0: task.records })}
              {!task.turnId && <span> · {t("无任务编号")}</span>}
            </div>
            <div className="activity-key-events">
              {important.slice(0, 6).map((item) => (
                <ActivityRow key={item.id} item={item} path={path} />
              ))}
            </div>
            {important.length > 6 && (
              <details className="activity-routine">
                <summary>
                  {t("更多修改与验证 · {v0}", { v0: important.length - 6 })}
                </summary>
                {important.slice(6).map((item) => (
                  <ActivityRow key={item.id} item={item} path={path} />
                ))}
              </details>
            )}
            {!!routine.length && (
              <details className="activity-routine">
                <summary>
                  {t("读取、搜索与其他操作 · {v0} 条", {
                    v0: routine.reduce(
                      (sum, item) => sum + item.records.length,
                      0,
                    ),
                  })}
                </summary>
                {routine.map((item) => (
                  <ActivityRow key={item.id} item={item} path={path} />
                ))}
              </details>
            )}
            {task.reply?.reply && (
              <div className="activity-reply">
                <span>{t("Agent 回执")}</span>
                <p>{task.reply.reply}</p>
                <details>
                  <summary>{t("完整回执")}</summary>
                  <EventEvidence event={task.reply} />
                </details>
              </div>
            )}
          </article>
        );
      })}
      {tasks.length > 4 && (
        <button className="text-button" onClick={() => setShowAll(!showAll)}>
          {showAll
            ? t("收起较早任务")
            : t("查看较早任务 · {v0}", { v0: tasks.length - 4 })}
        </button>
      )}
    </div>
  );
}
