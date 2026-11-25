import { ArrowRight, CaretDown, Export } from "@phosphor-icons/react";
import { useId, useRef, useState } from "react";
import type { AiFinding, AiReport } from "../ai";
import type { FindingDecision } from "../ai-reports";
import { riskLabel, t } from "../i18n";
import { FindingActions, decisionLabel } from "./FindingActions";
import { findingLocation } from "./InlineReview";
import { Button } from "./ui/controls";

export function OcrReviewFindings({
  report,
  busy,
  loading,
  onFinding,
  onDecision,
  onExport,
}: {
  report: AiReport;
  busy: boolean;
  loading: boolean;
  onFinding: (finding: AiFinding, index: number) => void;
  onDecision: (index: number, decision: FindingDecision) => void;
  onExport: () => void;
}) {
  const id = useId();
  const pendingButton = useRef<HTMLButtonElement>(null);
  const findings = report.review?.findings ?? [];
  const [expanded, setExpanded] = useState<number | null>(
    findings.length ? 0 : null,
  );
  const [pendingOnly, setPendingOnly] = useState(false);
  const decision = (index: number) => report.decisions[index] ?? "pending";
  const pending = findings.filter(
    (_, index) => decision(index) === "pending",
  ).length;

  if (!findings.length) {
    if (report.ocr?.status !== "complete") return null;
    return (
      <p className="ocr-findings-empty">
        {t("本次已审文件未发现问题，仍需人工复核。")}
      </p>
    );
  }

  return (
    <section className="ocr-findings" aria-label={t("审查意见")}>
      <header className="ocr-findings-heading">
        <h3>
          {t("审查意见")} <span>{findings.length}</span>
        </h3>
        <Button
          className="icon-button"
          title={t("导出给 Agent")}
          aria-label={t("导出给 Agent")}
          disabled={busy}
          onClick={onExport}
        >
          <Export size={16} aria-hidden="true" />
        </Button>
      </header>
      <div className="ocr-findings-filter">
        <Button
          ref={pendingButton}
          className="button compact"
          aria-pressed={pendingOnly}
          onClick={() => setPendingOnly((value) => !value)}
        >
          {t("待处理 {v0} 条", { v0: pending })}
        </Button>
      </div>
      {pendingOnly && pending === 0 && (
        <p className="ocr-findings-empty" role="status">
          {t("没有待处理的意见。")}
        </p>
      )}
      {findings.map((finding, index) => {
        const status = decision(index);
        if (pendingOnly && status !== "pending") return null;
        const open = expanded === index;
        const detailsId = `${id}-${index}`;
        return (
          <article
            className="ai-finding ocr-finding"
            key={index}
            data-expanded={open || undefined}
          >
            <div className="ocr-finding-heading">
              <span className={`ai-risk ${finding.severity}`}>
                {riskLabel(finding.severity)}
              </span>
              <Button
                className="ai-finding-link"
                title={t(finding.line === 0 ? "打开变更文件" : "定位当前代码")}
                disabled={loading}
                onClick={() => {
                  setExpanded(index);
                  onFinding(finding, index);
                }}
              >
                <strong>{finding.title}</strong>
                <ArrowRight size={13} aria-hidden="true" />
              </Button>
              <Button
                className="icon-button ocr-finding-toggle"
                aria-label={t(open ? "收起意见详情" : "展开意见详情")}
                aria-controls={detailsId}
                aria-expanded={open}
                onClick={() => setExpanded(open ? null : index)}
              >
                <CaretDown size={14} aria-hidden="true" />
              </Button>
            </div>
            <div className="ocr-finding-location">
              <code>{finding.file}</code>
              <span>{findingLocation(finding)}</span>
              {!open && status !== "pending" && (
                <span className="ocr-finding-decision">
                  {decisionLabel[status]}
                </span>
              )}
            </div>
            <div id={detailsId} className="ocr-finding-details" hidden={!open}>
              <p>{finding.description}</p>
              {finding.suggestion && (
                <p className="ocr-finding-suggestion">{finding.suggestion}</p>
              )}
              <FindingActions
                decision={status}
                disabled={busy}
                onChange={(value) => {
                  if (pendingOnly && value !== "pending")
                    pendingButton.current?.focus();
                  onDecision(index, value);
                }}
              />
            </div>
          </article>
        );
      })}
    </section>
  );
}
