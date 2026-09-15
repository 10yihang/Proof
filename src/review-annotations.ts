import type { AiFinding, AiReport } from "./ai";
import type { DiffLine, FileDiff } from "./types";
export function annotationsForDiff(
  report: AiReport | null,
  diff: FileDiff,
  stale: boolean,
) {
  if (!report?.review || stale || report.scope.workspaceId !== diff.workspaceId)
    return [];
  const capture = report.files.find(
    (file) => file.path === diff.path && file.side === diff.side,
  );
  if (
    !capture ||
    capture.snapshotToken !== diff.token ||
    (report.scope.kind === "comparison" && capture.snapshotId !== diff.id)
  )
    return [];
  return report.review.findings.flatMap((finding, index) =>
    finding.file === diff.path && finding.side === diff.side
      ? [{ finding, index }]
      : [],
  );
}
export function inFindingRange(
  line: DiffLine | null | undefined,
  range: { line: number; endLine?: number | null; side: "old" | "new" } | null,
) {
  if (!line || !range) return false;
  const number = range.side === "old" ? line.oldLine : line.newLine;
  return (
    number !== null &&
    number >= range.line &&
    number <= (range.endLine ?? range.line)
  );
}
export function findingEnd(
  line: DiffLine | null | undefined,
  finding: AiFinding,
) {
  return (
    !!line &&
    (finding.lineSide === "old" ? line.oldLine : line.newLine) ===
      (finding.endLine ?? finding.line)
  );
}
