import type { DiffLine, Hunk } from "./types";

export type DiffRow =
  | { kind: "header"; hunk: Hunk }
  | { kind: "line"; left: DiffLine | null; right?: DiffLine | null };

// Presentation alignment only. This module never creates an executable Git patch.
export function rowsForHunk(hunk: Hunk, split: boolean): DiffRow[] {
  if (!split) return hunk.lines.map((line) => ({ kind: "line", left: line }));
  const rows: DiffRow[] = [];
  for (let i = 0; i < hunk.lines.length;) {
    const line = hunk.lines[i];
    if (line.kind === "context" || line.kind === "note") {
      rows.push({ kind: "line", left: line, right: line });
      i++;
      continue;
    }
    const removed: DiffLine[] = [],
      added: DiffLine[] = [];
    while (i < hunk.lines.length && hunk.lines[i].kind === "delete")
      removed.push(hunk.lines[i++]);
    while (i < hunk.lines.length && hunk.lines[i].kind === "add")
      added.push(hunk.lines[i++]);
    for (let n = 0; n < Math.max(removed.length, added.length); n++)
      rows.push({
        kind: "line",
        left: removed[n] ?? null,
        right: added[n] ?? null,
      });
  }
  return rows;
}
