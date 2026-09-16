import { agentName } from "../ai";
import { AiTaskProgress } from "./AiTaskProgress";
import { useState } from "react";
import { ReviewExport } from "./ReviewExport";
import { Select, Button } from "./ui/controls";
import { uiMessage, t, getLanguage, riskLabel } from "../i18n";
import { FindingActions } from "./FindingActions";
import { findingLocation } from "./InlineReview";
import {
  ArrowRight,
  Sparkle,
  WarningCircle,
  GearSix,
  Export,
} from "@phosphor-icons/react";
import type { AiController, AiFinding } from "../ai";
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
  onFinding: (finding: AiFinding) => void;
  onSettings?: () => void;
}) {
  const review = ai.report?.review;
  const [exportId, setExportId] = useState<string | null>(null);
  return (
    <div className="ai-review-panel">
      <div className="ai-provider">
        <Sparkle size={16} />
        <Select
          aria-label={t("AI provider")}
          value={ai.provider}
          onChange={(e) => ai.setProvider(e.target.value as typeof ai.provider)}
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
        <span className="tag">{t("Read-only")}</span>
        {onSettings && (
          <Button
            className="icon-button"
            title={t("Agent settings")}
            aria-label={t("Agent settings")}
            onClick={onSettings}
          >
            <GearSix size={16} />
          </Button>
        )}
      </div>
      <div className="ai-scope">
        <span>{ai.scopeLabel}</span>
        {ai.currentLabel && (
          <strong title={ai.currentLabel}>{ai.currentLabel}</strong>
        )}
      </div>
      <div className="ai-review-actions">
        <Button
          className="button primary"
          disabled={!ai.canRun || !hasDiff}
          onClick={() => void ai.run("review")}
          title={t("审查当前 Change group；未分组时审查当前文件")}
        >
          {t("Review Current Change")}
        </Button>
        <Button
          className="button"
          disabled={!ai.canRun}
          onClick={() => void ai.run("review", true)}
        >
          {t("Review All Changes")}
        </Button>
      </div>
      <p className="ai-help">
        {demo
          ? t("演示模式不调用本机 Agent。")
          : t(
              "点击后由 Agent 只读访问完整项目目录，使用其现有登录和额度。AI 结果不会标记为 Reviewed。",
            )}
      </p>
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
      <AiTaskProgress ai={ai} />
      {ai.error && (
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
              <Button className="text-button" onClick={onSettings}>
                {t("Open Agent settings")}
              </Button>
            )}
          </span>
        </div>
      )}
      {ai.reports.length > 0 && (
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
      {review && (
        <>
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
              {t("Diff 已变化，此结果已过期。重新 Review 后可定位 Findings。")}
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
                  disabled={ai.stale}
                  onClick={() => onFinding(finding)}
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
            <section key={title}>
              <h3>{title}</h3>
              {items.length ? (
                <ol>
                  {items.map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ol>
              ) : (
                <p className="ai-help">{t("此次分析未列出。")}</p>
              )}
            </section>
          ))}
          {ai.report?.limitations.map((text) => (
            <p className="ai-help" key={text}>
              {text}
            </p>
          ))}
        </>
      )}
      {!review && !ai.pending && (
        <div className="ai-empty">
          <Sparkle size={24} />
          <strong>{t("Review your diff")}</strong>
          <p>{t("检查风险、Bug、行为变化和遗漏测试。")}</p>
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
