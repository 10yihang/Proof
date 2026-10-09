import { t } from "./i18n";

export interface FindingLocationTarget {
  workspaceId: string;
  reportId?: string;
  contextId?: string;
  findingIndex: number;
}
export type FindingLocationStatus =
  "exact" | "shifted" | "modified" | "deleted" | "ambiguous" | "unavailable";
export interface FindingLineRange {
  line: number;
  endLine: number;
}
export interface FindingLocationDocument {
  path: string;
  source: string;
  line: number | null;
  endLine: number | null;
  content: string;
  startLine: number;
  fingerprint: string;
}
export interface FindingLocationResult {
  workspaceId: string;
  path: string;
  status: FindingLocationStatus;
  original: FindingLocationDocument | null;
  current: FindingLocationDocument | null;
  candidates: FindingLineRange[];
  reason?: string | null;
}
export function findingLocationTargetKey(target: FindingLocationTarget) {
  return JSON.stringify([
    target.workspaceId,
    target.reportId ?? null,
    target.contextId ?? null,
    target.findingIndex,
  ]);
}
/** watchWorkspace has already rejected old watcher generations before dispatching this event. */
export function findingWorkspaceInvalidated(
  workspaceId: string,
  detail: unknown,
) {
  return (
    detail !== null &&
    typeof detail === "object" &&
    "workspaceId" in detail &&
    detail.workspaceId === workspaceId
  );
}
/** Translate real source numbers to a snippet model; never clamp an absent line to an unrelated row. */
export function findingModelRange(
  range: FindingLineRange | null | undefined,
  startLine: number,
  lineCount: number,
): FindingLineRange | null {
  if (
    !range ||
    !Number.isSafeInteger(range.line) ||
    !Number.isSafeInteger(range.endLine) ||
    range.line < 1 ||
    range.endLine < range.line ||
    !Number.isSafeInteger(startLine) ||
    startLine < 1 ||
    lineCount < 1
  )
    return null;
  const line = Math.max(range.line, startLine);
  const endLine = Math.min(range.endLine, startLine + lineCount - 1);
  return line > endLine
    ? null
    : { line: line - startLine + 1, endLine: endLine - startLine + 1 };
}
export function findingDisplayRange(
  result: FindingLocationResult,
  mode: "current" | "original",
  candidate: FindingLineRange | null,
): FindingLineRange | null {
  const document = result[mode];
  if (!document) return null;
  if (mode === "current" && result.status === "ambiguous") {
    return candidate &&
      result.candidates.some(
        (value) =>
          value.line === candidate.line && value.endLine === candidate.endLine,
      )
      ? candidate
      : null;
  }
  if (document.line === null) return null;
  return { line: document.line, endLine: document.endLine ?? document.line };
}
export function findingLocationSourceLabel(
  source: string,
  mode: "current" | "original" = "current",
) {
  switch (source) {
    case "worktree":
      return mode === "original" ? t("审查时的工作区") : t("当前工作区");
    case "index":
      return t("暂存区");
    case "head":
      return t("HEAD 版本");
    case "base":
      return t("审查基准");
    case "target":
      return t("审查目标");
    default:
      return source;
  }
}
export function findingLocationStatusLabel(status: FindingLocationStatus) {
  switch (status) {
    case "exact":
      return t("位置准确");
    case "shifted":
      return t("行号已移动");
    case "modified":
      return t("代码已修改，待复核");
    case "deleted":
      return t("代码已删除，待复核");
    case "ambiguous":
      return t("存在多个候选位置");
    case "unavailable":
      return t("无法确认位置");
  }
}
export function findingLocationReason(reason: string | null | undefined) {
  switch (reason) {
    case "CODE_MODIFIED":
    case "CODE_DELETED":
      // The authoritative status already explains these mapped changes.
      return null;
    case "ANCHOR_NOT_SAVED":
      return t("旧记录没有保存代码锚点，当前文件仅供查阅。");
    case "FILE_MISSING":
      return t("文件已不存在，可查看审查原位置。");
    case "BINARY_FILE":
      return t("文件是二进制，无法显示文本位置。");
    case "FILE_TOO_LARGE":
      return t("文件超过定位视图的读取上限。");
    case "ORIGINAL_LINE_UNAVAILABLE":
      return t("审查时的代码行不可用，当前文件仅供查阅。");
    case "PATH_RENAMED":
      return t("文件路径已变化，请核对当前路径。");
    default:
      return reason ? t("位置不能唯一确认，请核对当前代码。") : null;
  }
}
