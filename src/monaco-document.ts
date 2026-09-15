import type { DiffLine, FileDiff } from "./types";
import type { ReadingRow } from "./diff-reading";
import type { SyntaxSpan, hunkSyntax } from "./syntax";
export type GitSyntax = ReturnType<typeof hunkSyntax>;

export type EditorSide = "old" | "new" | "unified";
export interface EditorLine {
  row: number;
  source: DiffLine;
  tokens: SyntaxSpan[] | undefined;
}
export interface GitEditorDocument {
  side: EditorSide;
  text: string;
  lines: EditorLine[];
  /** A missing cell is a view zone, never an invented blank line in the model. */
  rowLines: Map<number, number>;
  afterLines: number[];
  digits: number;
}
export function canUseMonaco(diff: FileDiff) {
  return (
    ["text", "rename"].includes(diff.kind) &&
    diff.hunks.some((h) => h.lines.length > 0) &&
    diff.hunks.every((h) =>
      h.lines.every(
        (line) =>
          !line.content.slice(0, -1).includes("\r") &&
          !line.content.startsWith("\uFEFF"),
      ),
    )
  );
}
export function gitEditorDocument(
  rows: ReadingRow[],
  side: EditorSide,
  syntax: GitSyntax,
): GitEditorDocument {
  const lines: EditorLine[] = [],
    rowLines = new Map<number, number>(),
    afterLines: number[] = [];
  rows.forEach((row, index) => {
    afterLines.push(lines.length);
    const line =
      row.kind === "line"
        ? side === "new"
          ? (row.right ?? null)
          : row.left
        : null;
    if (line && line.kind !== "note") {
      lines.push({
        row: index,
        source: line,
        tokens:
          syntax[side === "old" || line.kind === "delete" ? "old" : "new"].get(
            line,
          ),
      });
      rowLines.set(index, lines.length);
    }
  });
  // Git owns all EOL bytes in the patch. Monaco's text model is display-only;
  // CRLF indicators and EOF notes are rendered separately from copied code.
  const digits = lines.reduce(
    (max, entry) =>
      Math.max(
        max,
        String(Math.max(entry.source.oldLine ?? 0, entry.source.newLine ?? 0))
          .length,
      ),
    3,
  );
  return {
    side,
    text: lines
      .map((line) => line.source.content.replace(/\r$/, ""))
      .join("\n"),
    lines,
    rowLines,
    afterLines,
    digits,
  };
}
export function sourceLineLabel(
  document: GitEditorDocument,
  modelLine: number,
) {
  const line = document.lines[modelLine - 1]?.source;
  if (!line) return "";
  if (document.side === "old")
    return line.oldLine === null ? "" : String(line.oldLine);
  if (document.side === "new")
    return line.newLine === null ? "" : String(line.newLine);
  const digits = document.digits;
  return `${String(line.oldLine ?? "").padStart(digits)}  ${String(line.newLine ?? "").padStart(digits)}`;
}
export function rowAtOffset(starts: number[], offset: number) {
  let low = 0,
    high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}
