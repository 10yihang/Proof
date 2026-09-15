import { Button } from "./ui/controls";
import { t } from "../i18n";
import { Code, ArrowRight, ArrowClockwise } from "@phosphor-icons/react";
import type { DiffSummary } from "../types";

export function DeferredDiff({
  summary,
  pending,
  onLoad,
  onStage,
  comparison,
}: {
  summary: DiffSummary;
  pending: boolean;
  onLoad: () => void;
  onStage?: () => void;
  comparison?: { base: string; target: string };
}) {
  const limited = !summary.canLoad;
  return (
    <section
      className="diff-panel deferred-diff"
      aria-label={t("Diff 尚未加载")}
    >
      <div className="diff-topbar">
        <header className="diff-file-header">
          <div className="file-title">
            <Code size={20} />
            <div>
              <strong>{summary.path.split("/").pop()}</strong>
              <span>
                {summary.oldPath ? `${summary.oldPath} → ` : ""}
                {summary.path}
              </span>
            </div>
          </div>
        </header>
        <span className="comparison">
          {comparison?.base ?? (summary.side === "staged" ? "HEAD" : "Index")}
          <ArrowRight size={12} />
          {comparison?.target ??
            (summary.side === "staged" ? "Index" : "Worktree")}
        </span>
      </div>
      <div className="deferred-diff-body">
        <Code size={28} />
        <h2>{limited ? t("Diff 超过读取上限") : t("Large diff")}</h2>
        {summary.patchBytes !== null && (
          <span className="deferred-size">
            {(summary.patchBytes / 1024 / 1024).toFixed(2)} {t(" MiB patch")}
          </span>
        )}
        {summary.patchBytes === null && summary.reason === "patch_size" && (
          <span className="deferred-size">{t("&gt; 1 MiB patch")}</span>
        )}
        <p>
          {summary.reason === "file_limit"
            ? t("文件超过 32 MiB，请使用外部 Git 工具查看。")
            : limited
              ? t("内置阅读器最多加载 8 MiB、100,000 行 Diff。")
              : summary.reason === "long_line"
                ? t("包含较长的代码行，点击后加载 Diff。")
                : t("内容较多，点击后加载 Diff。")}
        </p>
        <div className="deferred-actions">
          {summary.canLoad && (
            <Button
              className="button primary"
              disabled={pending}
              onClick={onLoad}
            >
              {pending && <ArrowClockwise size={15} className="spinning" />}
              {pending ? t("载入 Diff…") : t("加载 Diff")}
            </Button>
          )}
          {onStage && (
            <Button className="button" disabled={pending} onClick={onStage}>
              {summary.side === "staged" ? t("Unstage file") : t("Stage file")}
            </Button>
          )}
        </div>
        <small>{t("尚未加载 · 未计入 Review")}</small>
      </div>
    </section>
  );
}
