import { agentName } from "../ai";
import { AiTaskProgress } from "./AiTaskProgress";
import { AiSessionLink } from "./AiSessionLink";
import { useEffect, useRef, useState } from "react";
import { ReviewExport } from "./ReviewExport";
import { Select, Button } from "./ui/controls";
import { uiMessage, t, getLanguage, riskLabel } from "../i18n";
import { FindingActions } from "./FindingActions";
import { findingLocation } from "./InlineReview";
import { OcrReviewFindings } from "./OcrReviewFindings";
import { ocrFileReason } from "../ocr-labels";
import { comparisonRangeLabel } from "../diff-reading";
import { useOcrReviewProgress } from "../ocr-reviews";
import {
  ArrowRight,
  Sparkle,
  WarningCircle,
  GearSix,
  Export,
  GitDiff,
  CheckCircle,
  MinusCircle,
} from "@phosphor-icons/react";
import type { AiController, AiFinding, AiReport } from "../ai";

function OcrTaskProgress({ ai }: { ai: AiController }) {
  const progress = useOcrReviewProgress(ai.workspace?.id, ai.reviewScope);
  return (
    <AiTaskProgress ai={{ ...ai, progress: progress ?? ai.progress }} isOcr />
  );
}

export function AiReviewPanel({
  ai,
  hasDiff,
  demo,
  onFinding,
  onSettings,
}: {
  ai: AiController;
  hasDiff: boolean;
  demo: boolean;
  onFinding: (finding: AiFinding, index: number, contextId?: string) => void;
  onSettings?: (ocr: boolean) => void;
}) {
  const review = ai.report?.review;
  const ocr = ai.report?.ocr;
  const isOcr = ai.ocrRunning || ai.reviewProvider === "ocr";
  const ocrRunning = isOcr && ai.pending === "review";
  const busy = !!ai.pending || ai.decisionSaving || ai.reportLoading;
  const cancelled =
    isOcr &&
    (ai.error?.code === "READ_CANCELLED" || ai.error?.code === "AI_CANCELLED");
  const [exportId, setExportId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusProgress = useRef(false);
  useEffect(() => {
    if (ocrRunning && focusProgress.current) {
      focusProgress.current = false;
      panelRef.current
        ?.querySelector<HTMLElement>(".ai-task-progress--ocr")
        ?.focus({ preventScroll: true });
    }
  }, [ocrRunning]);

  function runReview(all = false) {
    focusProgress.current = isOcr;
    void ai.run("review", all);
  }
  return (
    <div
      className={`ai-review-panel${isOcr || ocr ? " ai-review-panel--ocr" : ""}`}
      ref={panelRef}
    >
      <div className="ai-review-launch">
        {!ocrRunning && (
          <>
            <div className="ai-provider">
              <Sparkle size={16} aria-hidden="true" />
              <Select
                aria-label={t("AI provider")}
                value={ai.providers.length ? ai.reviewProvider : "codex"}
                onChange={(e) =>
                  ai.setReviewProvider(
                    e.target.value as typeof ai.reviewProvider,
                  )
                }
                disabled={!!ai.pending || demo}
              >
                {(ai.providers.length
                  ? ai.providers
                  : [{ id: "codex", name: "Codex", available: false }]
                ).map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.name}
                    {p.available ? "" : t(" · unavailable")}
                  </option>
                ))}
              </Select>
              {!isOcr && <span className="tag">{t("Read-only")}</span>}
              {onSettings && (
                <Button
                  className="icon-button"
                  title={t(isOcr ? "OpenCodeReview 设置" : "Agent settings")}
                  aria-label={t(
                    isOcr ? "OpenCodeReview 设置" : "Agent settings",
                  )}
                  onClick={() => onSettings(isOcr)}
                >
                  <GearSix size={16} />
                </Button>
              )}
            </div>
            <div className={`ai-scope${isOcr ? " ocr-review-scope" : ""}`}>
              <div className="ai-scope-range">
                {isOcr && <GitDiff size={14} aria-hidden="true" />}
                <span>{ai.scopeLabel}</span>
              </div>
              {isOcr && ai.ocrRange && (
                <span className="ocr-worktree-range">{ai.ocrRange}</span>
              )}
              {isOcr && ai.currentGroupName && (
                <span title={ai.currentGroupName}>
                  {t("当前分组 {v0}", { v0: ai.currentGroupName })}
                </span>
              )}
              {!isOcr && ai.currentLabel && (
                <strong title={ai.currentLabel}>{ai.currentLabel}</strong>
              )}
            </div>
            <div
              className={`ai-review-actions${isOcr ? " ocr-review-actions" : ""}`}
            >
              <Button
                className="button primary"
                disabled={!ai.canRunReview}
                onClick={() => runReview(true)}
              >
                {t(isOcr ? "审查此 Diff" : "Review All Changes")}
              </Button>
              <Button
                className="button"
                disabled={!ai.canRunReview || !hasDiff}
                onClick={() => runReview()}
                title={
                  isOcr
                    ? ai.currentLabel
                    : t(
                        "审查当前 Change group；未分组时审查当前文件。可读取完整仓库上下文。",
                      )
                }
              >
                {isOcr
                  ? t(ai.currentGroupName ? "审查分组" : "审查文件")
                  : t("Review Current Change")}
              </Button>
            </div>
            <details className="ai-review-guide">
              <summary>{t("审查说明")}</summary>
              <p className="ai-help">
                {demo
                  ? t("演示模式不调用本机 Agent。")
                  : t(
                      isOcr
                        ? "OCR 从当前 Git 比较读取 Diff 和代码上下文。"
                        : "Agent 可只读检索完整仓库，当前范围决定审查重点。AI 结果不会标记为 Reviewed。",
                    )}
              </p>
            </details>
          </>
        )}
        {ocrRunning && <OcrTaskProgress ai={ai} />}
      </div>
      {!demo &&
        ai.providers.length > 0 &&
        !ai.providers.some((p) => p.available) && (
          <p className="ai-empty">
            {ai.providers
              .map((p) => `${p.name}: ${uiMessage(p.reason)}`)
              .join(" ")}{" "}
            {t(" 普通 Git 功能仍可使用。")}
          </p>
        )}
      {!ocrRunning && <AiTaskProgress ai={ai} />}
      {cancelled && (
        <p className="ai-help" role="status">
          {t("OCR 审查已取消")}
        </p>
      )}
      {ai.error && !cancelled && (
        <div className="ai-error" role="alert">
          <WarningCircle size={16} />
          <span>
            {uiMessage(ai.error.message)}
            <details>
              <summary>
                {t("Failure details · ")}
                {ai.error.code}
              </summary>
              <pre>{ai.error.detail}</pre>
            </details>
            {onSettings && (
              <Button className="text-button" onClick={() => onSettings(isOcr)}>
                {t(isOcr ? "OpenCodeReview 设置" : "Open Agent settings")}
              </Button>
            )}
          </span>
        </div>
      )}
      {ai.reports.length > 0 &&
        (!ocr || ai.reports.length > 1) &&
        !ocrRunning && (
          <label className="ai-report-history">
            {t("Review history")}
            <Select
              aria-label={t("Review history")}
              value={ai.report?.id ?? ""}
              disabled={ai.reportLoading || ai.decisionSaving || !!ai.pending}
              onChange={(e) => void ai.selectReport(e.target.value)}
            >
              {ai.reports.map((record) => (
                <option key={record.id} value={record.id}>
                  {new Date(record.capturedAt).toLocaleString(getLanguage())} ·{" "}
                  {agentName(record.provider)} · {record.summary.slice(0, 60)}
                </option>
              ))}
            </Select>
          </label>
        )}
      {ai.reportLoading && (
        <p className="ai-help" role="status">
          {t("读取 Review 记录…")}
        </p>
      )}
      {review && ocr && ai.report && !ocrRunning && (
        <>
          <OcrReportOverview report={ai.report} />
          {ai.stale && (
            <div className="ai-stale" role="status">
              {t("Diff 已变化，此结果已过期。可定位当前代码，问题仍需复核。")}
            </div>
          )}
          <OcrReviewFindings
            key={ai.report.id}
            report={ai.report}
            busy={busy}
            loading={ai.reportLoading}
            onFinding={onFinding}
            onDecision={(index, value) => void ai.setDecision(index, value)}
            onExport={() => setExportId(ai.report!.id)}
          />
        </>
      )}
      {review && !ocr && !ocrRunning && (
        <>
          <AiSessionLink session={ai.report?.session} />
          <div className="ai-report-meta">
            <span className={`ai-risk ${review.overallRisk}`}>
              {riskLabel(review.overallRisk)}
            </span>
            <span>
              {ai.report ? agentName(ai.report.provider) : ""} ·{" "}
              {new Date(ai.report!.capturedAt).toLocaleTimeString(
                getLanguage(),
                {
                  hour: "2-digit",
                  minute: "2-digit",
                },
              )}
            </span>
          </div>
          {!!review.findings.length && (
            <Button
              className="button compact ai-export-button"
              disabled={ai.reportLoading || ai.decisionSaving || !!ai.pending}
              onClick={() => setExportId(ai.report!.id)}
            >
              <Export size={15} />
              {t("导出给 Agent")}
            </Button>
          )}
          {ai.stale && (
            <div className="ai-stale" role="status">
              {t("Diff 已变化，此结果已过期。可定位当前代码，问题仍需复核。")}
            </div>
          )}
          <p className="ai-help">
            {t(
              "已保存到本机 · 采纳仅记录处理意向，不会修改代码或标记为 Reviewed。",
            )}
          </p>
          <section>
            <h3>{t("Summary")}</h3>
            <p>{review.summary}</p>
          </section>
          <section>
            <h3>
              {t("Findings ")}
              <span>{review.findings.length}</span>
            </h3>
            {review.findings.length === 0 && (
              <p className="ai-help">
                {t("此次分析未提出 Findings，仍需人工 Review。")}
              </p>
            )}
            {review.findings.map((finding, index) => (
              <article className="ai-finding" key={`${ai.report!.id}:${index}`}>
                <span className={`ai-risk ${finding.severity}`}>
                  {riskLabel(finding.severity)}
                </span>
                <Button
                  className="ai-finding-link"
                  title={t(
                    finding.line === 0 ? "打开变更文件" : "定位当前代码",
                  )}
                  disabled={ai.reportLoading}
                  onClick={() => onFinding(finding, index)}
                >
                  <strong>{finding.title}</strong>
                  <ArrowRight size={14} />
                </Button>
                <code className="ai-location">
                  {finding.file} · {findingLocation(finding)} · {finding.side}
                </code>
                <p>{finding.description}</p>
                <p className="ai-suggestion">{finding.suggestion}</p>
                <FindingActions
                  decision={ai.report!.decisions[index] ?? "pending"}
                  disabled={
                    !!ai.pending || ai.decisionSaving || ai.reportLoading
                  }
                  onChange={(value) => void ai.setDecision(index, value)}
                />
              </article>
            ))}
          </section>
          {(
            [
              [t("Behavior changes"), review.behaviorChanges],
              [t("Missing tests"), review.missingTests],
              [t("Review priority"), review.reviewPriority],
            ] as const
          ).map(([title, items]) => (
            <details className="ai-review-extra" key={title}>
              <summary>
                {title}
                <span>{items.length}</span>
              </summary>
              {items.length ? (
                <ol>
                  {items.map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ol>
              ) : (
                <p className="ai-help">{t("此次分析未列出。")}</p>
              )}
            </details>
          ))}
          {ai.report?.limitations.map((text) => (
            <p className="ai-help" key={text}>
              {text}
            </p>
          ))}
        </>
      )}
      {!review && !ai.pending && !ai.reportLoading && !ai.error && (
        <div className="ai-empty">
          {isOcr ? (
            <p>{t("选择范围后启动审查，意见会显示在这里。")}</p>
          ) : (
            <>
              <Sparkle size={24} />
              <strong>{t("Review your diff")}</strong>
              <p>{t("检查风险、Bug、行为变化和遗漏测试。")}</p>
            </>
          )}
        </div>
      )}
      {ai.report && exportId === ai.report.id && ai.workspace && (
        <ReviewExport
          key={exportId}
          report={ai.report}
          context={{
            workspaceName: ai.workspace.name,
            workspacePath: ai.workspace.path,
            branch: ai.branch,
            stale: ai.stale,
          }}
          onClose={() => setExportId(null)}
        />
      )}
    </div>
  );
}

function OcrReportOverview({ report }: { report: AiReport }) {
  const { ocr, review } = report;
  if (!ocr || !review) return null;
  const StatusIcon =
    ocr.status === "partial"
      ? WarningCircle
      : ocr.status === "skipped"
        ? MinusCircle
        : CheckCircle;
  const model = [ocr.provider, ocr.model].filter(Boolean).join(" / ");
  const files = report.scope.kind === "local" ? report.scope.files : null;
  const side = files?.[0]?.side;
  const range = !ocr.pinnedDiff
    ? null
    : report.scope.kind === "comparison"
      ? comparisonRangeLabel(report.scope.base, report.scope.target)
      : side && files?.every((file) => file.side === side)
        ? t(side === "staged" ? "HEAD → Index" : "Index → 工作区")
        : null;
  const groups = [
    { title: t("未完成"), files: ocr.incomplete },
    { title: t("已跳过"), files: ocr.excluded },
  ];
  return (
    <div className="ocr-report-coverage" data-status={ocr.status}>
      <div className="ocr-report-heading">
        <StatusIcon size={16} aria-hidden="true" />
        <strong>
          {t(
            ocr.status === "partial"
              ? "OCR 部分完成"
              : ocr.status === "skipped"
                ? "OCR 跳过"
                : "OCR 审查完成",
          )}
        </strong>
        <time dateTime={new Date(report.capturedAt).toISOString()}>
          {new Date(report.capturedAt).toLocaleTimeString(getLanguage(), {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
      <div className="ocr-report-counts">
        {range && <span>{range}</span>}
        <span>
          {ocr.eligible == null
            ? t("已审 {v0} 个文件", { v0: ocr.reviewed })
            : t("已审 {v0} / {v1} 个文件", {
                v0: ocr.reviewed,
                v1: ocr.eligible,
              })}
        </span>
        {(!!ocr.excluded.length || !!ocr.incomplete.length) && (
          <span>
            {t("跳过 {v0} · 未完成 {v1}", {
              v0: ocr.excluded.length,
              v1: ocr.incomplete.length,
            })}
          </span>
        )}
      </div>
      <details className="ocr-review-evidence">
        <summary>{t("审查覆盖与会话")}</summary>
        {groups
          .filter(({ files }) => files.length)
          .map(({ title, files }) => (
            <div className="ocr-coverage-group" key={title}>
              <strong>{title}</strong>
              <ul>
                {files.map((file, index) => (
                  <li key={`${file.path}:${index}`}>
                    <code>{file.path}</code>
                    <span>{ocrFileReason(file.reason)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        <p>{review.summary}</p>
        {!!ocr.omittedFindings && (
          <p>{t("另有 {v0} 条意见未展示", { v0: ocr.omittedFindings })}</p>
        )}
        {model && <p>{model}</p>}
        {ocr.sessionId && (
          <code aria-label={t("OCR 会话")}>{ocr.sessionId}</code>
        )}
        <p>{t("采纳意见会记录处理决定，代码仍由你或 Agent 修改。")}</p>
      </details>
    </div>
  );
}
