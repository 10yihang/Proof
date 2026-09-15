import { useId, useMemo, useState } from "react";
import { Copy, DownloadSimple } from "@phosphor-icons/react";
import type { AiReport } from "../ai";
import { asError, useRequest } from "../api";
import {
  acceptedFindingIndices,
  reviewInstructions,
  type ReviewExportContext,
} from "../review-export";
import { t, useLanguage } from "../i18n";
import type { ProofError } from "../types";
import { Modal } from "./Modal";
import { Button, Checkbox, Textarea } from "./ui/controls";
import { decisionLabel } from "./FindingActions";
import { findingLocation } from "./InlineReview";

export function ReviewExport({
  report,
  context,
  onClose,
}: {
  report: AiReport;
  context: ReviewExportContext;
  onClose: () => void;
}) {
  const language = useLanguage();
  const selectionId = useId();
  const request = useRequest();
  const findings = report.review?.findings ?? [];
  const [selected, setSelected] = useState(() =>
    acceptedFindingIndices(report),
  );
  const [busy, setBusy] = useState<"copy" | "save" | null>(null);
  const [error, setError] = useState<ProofError | null>(null);
  const [notice, setNotice] = useState("");
  const content = useMemo(
    () => reviewInstructions(report, selected, context, language),
    [report, selected, context, language],
  );
  function choose(indices: number[]) {
    setSelected(indices);
    setNotice("");
    setError(null);
  }
  async function deliver(action: "copy" | "save") {
    if (busy || !content) return;
    setBusy(action);
    setError(null);
    setNotice("");
    try {
      if (action === "copy") {
        await navigator.clipboard.writeText(content);
        setNotice(t("修改说明已复制，可以粘贴给 Agent。"));
      } else {
        const saved = await request<{ path: string } | null>(
          "save_review_instructions",
          {
            workspaceId: report.scope.workspaceId,
            reportId: report.id,
            expectedRevision: report.revision,
            markdown: content,
            language,
          },
        );
        if (saved) setNotice(t("已保存到 {v0}", { v0: saved.path }));
      }
    } catch (cause) {
      setError(
        action === "copy"
          ? {
              code: "CLIPBOARD_UNAVAILABLE",
              message: t("复制失败，请选中下方说明手动复制。"),
              detail: asError(cause).detail,
            }
          : asError(cause),
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <Modal
      title={t("导出修改建议")}
      onClose={onClose}
      className="review-export-modal"
      wide
      dismissible={!busy}
      error={error}
    >
      <p className="modal-intro">
        {t("默认选择已采纳的意见，可调整本次导出的内容。")}
      </p>
      <div className="review-export-selection-actions">
        <strong aria-live="polite">
          {t("已选择 {v0} 条意见", { v0: selected.length })}
        </strong>
        <Button
          className="text-button"
          disabled={!!busy}
          onClick={() => choose(acceptedFindingIndices(report))}
        >
          {t("选择已采纳")}
        </Button>
        <Button
          className="text-button"
          disabled={!!busy}
          onClick={() => choose(findings.map((_, index) => index))}
        >
          {t("全选")}
        </Button>
        <Button
          className="text-button"
          disabled={!!busy}
          onClick={() => choose([])}
        >
          {t("清空选择")}
        </Button>
      </div>
      <div
        className="review-export-findings"
        role="group"
        aria-label={t("选择要交给 Agent 的意见")}
      >
        {findings.map((finding, index) => (
          <label key={index} className="review-export-finding">
            <Checkbox
              aria-labelledby={`${selectionId}-${index}-title`}
              aria-describedby={`${selectionId}-${index}-location`}
              checked={selected.includes(index)}
              disabled={!!busy}
              onChange={(event) =>
                choose(
                  event.target.checked
                    ? [...selected, index]
                    : selected.filter((value) => value !== index),
                )
              }
            />
            <span>
              <strong id={`${selectionId}-${index}-title`}>
                {finding.title}
              </strong>
              <code id={`${selectionId}-${index}-location`}>
                {finding.file} · {findingLocation(finding)} ·{" "}
                {report.scope.kind === "comparison"
                  ? finding.lineSide === "old"
                    ? "base"
                    : "target"
                  : finding.side}
              </code>
            </span>
            <span
              className={`finding-decision ${report.decisions[index] ?? "pending"}`}
            >
              {decisionLabel[report.decisions[index] ?? "pending"]}
            </span>
          </label>
        ))}
      </div>
      {context.stale && (
        <p className="ai-stale">
          {t(
            "代码已在 Review 后变化。以下行号可能已移动，请以当前 Git Diff 和实际代码重新定位。",
          )}
        </p>
      )}
      <label className="review-export-preview">
        <strong>{t("给 Agent 的修改说明")}</strong>
        <Textarea
          value={content}
          readOnly
          spellCheck={false}
          placeholder={t("选择需要修改的意见后，这里会生成修改说明。")}
          aria-label={t("给 Agent 的修改说明")}
        />
      </label>
      <div className="review-export-footer">
        <span role="status">{notice}</span>
        <div className="modal-actions">
          <Button
            className="button"
            disabled={!!busy || !content}
            onClick={() => void deliver("save")}
          >
            <DownloadSimple size={15} />
            {busy === "save" ? t("正在保存…") : t("保存 Markdown…")}
          </Button>
          <Button
            className="button primary"
            disabled={!!busy || !content}
            onClick={() => void deliver("copy")}
          >
            <Copy size={15} />
            {t("复制修改说明")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
