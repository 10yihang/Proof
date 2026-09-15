import type { AiReport } from "./ai";
import { translate, type Language, type MessageKey } from "./i18n";

export interface ReviewExportContext {
  workspaceName: string;
  workspacePath: string;
  branch?: string | null;
  stale: boolean;
}

export function acceptedFindingIndices(report: AiReport) {
  return (
    report.review?.findings.flatMap((_, index) =>
      report.decisions[index] === "accepted" ? [index] : [],
    ) ?? []
  );
}

// Keep paths with Markdown delimiters or unusual filename characters unambiguous.
function code(value: string) {
  const literal = /[\r\n\t]/.test(value) ? JSON.stringify(value) : value;
  const fence = "`".repeat(
    Math.max(
      0,
      ...[...literal.matchAll(/`+/g)].map((match) => match[0].length),
    ) + 1,
  );
  const padding = literal.startsWith("`") || literal.endsWith("`") ? " " : "";
  return `${fence}${padding}${literal}${padding}${fence}`;
}

/** Export only the user's selection; report-wide suggestions are not extra tasks. */
export function reviewInstructions(
  report: AiReport,
  indices: readonly number[],
  context: ReviewExportContext,
  language: Language,
) {
  const selected = new Set(indices);
  const findings =
    report.review?.findings.filter((_, index) => selected.has(index)) ?? [];
  if (!findings.length) return "";
  const text = (key: MessageKey) => translate(key, language);
  const lines = [
    `# ${text("Proof · Review 修改任务")}`,
    "",
    text(
      "请结合实际代码和当前 Git Diff，逐条核实并修复下面选中的 Review 意见，补充必要的测试。保留无关改动；不要自动 Stage、Commit 或 Amend。",
    ),
    "",
    `- ${text("仓库")}: ${context.workspaceName}`,
    `- Worktree: ${code(context.workspacePath)}`,
    ...(context.branch
      ? [`- ${text("当前 Branch")}: ${code(context.branch)}`]
      : []),
    `- ${text("Review 时间")}: ${new Date(report.capturedAt).toISOString()}`,
    `- ${text("Review 来源")}: ${report.provider === "codex" ? "Codex" : "Claude Code"}`,
    report.scope.kind === "comparison"
      ? `- ${text("比较范围")}: ${code(report.scope.base)} → ${code(report.scope.target)}`
      : `- ${text("Review 范围")}: Local changes`,
    "",
    text(
      report.scope.kind === "comparison"
        ? "行号对应所比较的 Commit：修改前为 base，修改后为 target。请先核对当前 Worktree，确认问题仍然存在，再进行修改。"
        : "行号对应 Review 时的版本；修改前 / 修改后以及 staged / unstaged 表明意见引用的 Diff 侧。请先确认问题仍然存在，再进行修改。",
    ),
  ];
  if (context.stale)
    lines.push(
      "",
      `> ${text("代码已在 Review 后变化。以下行号可能已移动，请以当前 Git Diff 和实际代码重新定位。")}`,
    );
  findings.forEach((finding, index) => {
    const end = finding.endLine ?? finding.line;
    const source =
      report.scope.kind === "comparison"
        ? `${finding.lineSide === "old" ? "base" : "target"} ${code(finding.lineSide === "old" ? report.scope.base : report.scope.target)}`
        : finding.side;
    lines.push(
      "",
      `## ${index + 1}. [${finding.severity}] ${finding.title.replace(/[\r\n]+/g, " ")}`,
      "",
      `- ${text("文件")}: ${code(finding.file)}`,
      `- ${text("位置")}: ${source} · ${text(finding.lineSide === "old" ? "修改前" : "修改后")} · L${finding.line}${end > finding.line ? `–L${end}` : ""}`,
      "",
      `${text("问题说明")}:`,
      finding.description,
      "",
      `${text("修改建议")}:`,
      finding.suggestion,
    );
  });
  lines.push(
    "",
    text("完成后请说明修改点、验证结果，以及仍未解决的意见和原因。"),
    "",
  );
  return lines.join("\n");
}
