import { rowsForHunk, type DiffRow } from "./diff-model";
import type { DiffContext, DiffLine, FileDiff, Hunk } from "./types";

export type ReadingRow = DiffRow & { key: string; hunkId: string | null };
export type TextRange = { start: number; end: number };

function replacements(hunk: Hunk) {
  const result: { removed: DiffLine[]; added: DiffLine[] }[] = [];
  for (let i = 0; i < hunk.lines.length;) {
    const removed: DiffLine[] = [],
      added: DiffLine[] = [];
    if (hunk.lines[i].kind !== "delete") {
      i++;
      continue;
    }
    while (hunk.lines[i]?.kind === "delete") removed.push(hunk.lines[i++]);
    while (hunk.lines[i]?.kind === "add") added.push(hunk.lines[i++]);
    result.push({ removed, added });
  }
  return result;
}

// A presentation rule, not semantic equivalence: spaces, tabs and CR can matter
// inside code/string literals. Never fold line insertion/deletion or EOF notes.
export function hiddenWhitespace(hunk: Hunk): Set<DiffLine> {
  const hidden = new Set<DiffLine>();
  for (const { removed, added } of replacements(hunk)) {
    if (removed.length !== added.length) continue;
    for (let i = 0; i < removed.length; i++) {
      if (
        removed[i].content !== added[i].content &&
        removed[i].content.replace(/[ \t\r]/g, "") ===
          added[i].content.replace(/[ \t\r]/g, "")
      ) {
        hidden.add(removed[i]);
        hidden.add(added[i]);
      }
    }
  }
  return hidden;
}

export function readingRows(
  diff: FileDiff,
  split: boolean,
  ignoreWhitespace: boolean,
  context: DiffContext | null,
): ReadingRow[] {
  const rows: ReadingRow[] = [];
  const gaps = new Map(context?.gaps.map((gap) => [gap.beforeHunkId, gap]));
  function append(items: DiffRow[], hunkId: string | null, prefix: string) {
    items.forEach((row, index) =>
      rows.push({ ...row, hunkId, key: `${prefix}:${index}` } as ReadingRow),
    );
  }
  for (const hunk of diff.hunks) {
    const gap = gaps.get(hunk.id);
    if (gap)
      append(
        gap.lines.map((line) => ({
          kind: "line",
          left: line,
          ...(split ? { right: line } : {}),
        })),
        hunk.id,
        `context:${hunk.id}`,
      );
    append([{ kind: "header", hunk }], hunk.id, `header:${hunk.id}`);
    const hidden = ignoreWhitespace
      ? hiddenWhitespace(hunk)
      : new Set<DiffLine>();
    const visible: DiffRow[] = [];
    for (const row of rowsForHunk(hunk, split)) {
      if (row.kind !== "line") continue;
      const sides = [row.left, row.right].filter(
        (line): line is DiffLine => !!line,
      );
      if (sides.length > 0 && sides.every((line) => hidden.has(line))) {
        const previous = visible[visible.length - 1];
        if (previous?.kind === "hidden") previous.count += sides.length;
        else
          visible.push({
            kind: "hidden",
            hunkId: hunk.id,
            count: sides.length,
          });
      } else visible.push(row);
    }
    append(visible, hunk.id, `hunk:${hunk.id}`);
  }
  const tail = gaps.get(null);
  if (tail)
    append(
      tail.lines.map((line) => ({
        kind: "line",
        left: line,
        ...(split ? { right: line } : {}),
      })),
      null,
      "context:tail",
    );
  return rows;
}

type Token = { text: string; start: number; end: number };
function tokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}_]+|[ \t]+|[^\p{L}\p{N}_\s]|\s/gu)].map(
    (match) => ({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    }),
  );
}
function ranges(values: Token[], unchanged: Set<number>): TextRange[] {
  const result: TextRange[] = [];
  values.forEach((token, index) => {
    if (unchanged.has(index)) return;
    const previous = result[result.length - 1];
    if (previous?.end === token.start) previous.end = token.end;
    else result.push({ start: token.start, end: token.end });
  });
  return result;
}

// Bounded token LCS. For a very large replacement, matching prefix/suffix tokens
// still provide a useful highlight without allocating an unbounded matrix.
export function inlineChanges(hunk: Hunk): Map<DiffLine, TextRange[]> {
  const result = new Map<DiffLine, TextRange[]>();
  let budget = 200_000;
  for (const { removed, added } of replacements(hunk)) {
    for (let pair = 0; pair < Math.min(removed.length, added.length); pair++) {
      if (
        removed[pair].content.length > 10_000 ||
        added[pair].content.length > 10_000
      )
        continue;
      const old = tokens(removed[pair].content),
        next = tokens(added[pair].content);
      const oldSame = new Set<number>(),
        newSame = new Set<number>();
      let start = 0,
        oldEnd = old.length,
        newEnd = next.length;
      while (
        start < oldEnd &&
        start < newEnd &&
        old[start].text === next[start].text
      ) {
        oldSame.add(start);
        newSame.add(start);
        start++;
      }
      while (
        oldEnd > start &&
        newEnd > start &&
        old[oldEnd - 1].text === next[newEnd - 1].text
      ) {
        oldSame.add(--oldEnd);
        newSame.add(--newEnd);
      }
      const n = oldEnd - start,
        m = newEnd - start,
        cost = (n + 1) * (m + 1);
      if (n && m && cost <= Math.min(65_536, budget)) {
        budget -= cost;
        const table = new Uint16Array(cost);
        const at = (i: number, j: number) => i * (m + 1) + j;
        for (let i = n - 1; i >= 0; i--)
          for (let j = m - 1; j >= 0; j--)
            table[at(i, j)] =
              old[start + i].text === next[start + j].text
                ? table[at(i + 1, j + 1)] + 1
                : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
        let i = 0,
          j = 0;
        while (i < n && j < m) {
          if (old[start + i].text === next[start + j].text) {
            oldSame.add(start + i++);
            newSame.add(start + j++);
          } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) i++;
          else j++;
        }
      }
      result.set(removed[pair], ranges(old, oldSame));
      result.set(added[pair], ranges(next, newSame));
    }
  }
  return result;
}

export function rowMatches(row: DiffRow, search: string) {
  return (
    row.kind === "line" &&
    !!search &&
    [row.left, row.right].some((line) => line?.content.includes(search))
  );
}

export type ReadingAnchor = {
  hunkId: string | null;
  oldLine: number | null;
  newLine: number | null;
  key: string;
  content: string | null;
};
export function rowAnchor(row: ReadingRow): ReadingAnchor {
  return {
    hunkId: row.hunkId,
    key: row.key,
    content:
      row.kind === "line" ? ((row.left ?? row.right)?.content ?? null) : null,
    oldLine: row.kind === "line" ? (row.left?.oldLine ?? null) : null,
    newLine:
      row.kind === "line" ? ((row.right ?? row.left)?.newLine ?? null) : null,
  };
}
export function findAnchor(
  rows: ReadingRow[],
  anchor: ReadingAnchor,
  requireContent = false,
): number {
  if (requireContent && anchor.content !== null) {
    // Old/new coordinates can refer to different bases after a stage. Repeated
    // text at either coordinate is ambiguous, so do not silently choose one.
    const exact = rows.flatMap((row, index) =>
      row.kind === "line" &&
      [row.left?.content, row.right?.content].includes(
        anchor.content ?? undefined,
      )
        ? [index]
        : [],
    );
    return exact.length === 1 ? exact[0] : -1;
  }
  const line = rows.findIndex(
    (row) =>
      row.kind === "line" &&
      (!requireContent ||
        [row.left?.content, row.right?.content].includes(
          anchor.content ?? undefined,
        )) &&
      ((anchor.oldLine !== null && row.left?.oldLine === anchor.oldLine) ||
        (anchor.newLine !== null &&
          (row.right ?? row.left)?.newLine === anchor.newLine)),
  );
  if (line >= 0) return line;
  const header = rows.findIndex(
    (row) => row.kind === "header" && row.hunkId === anchor.hunkId,
  );
  return header >= 0
    ? header
    : requireContent
      ? -1
      : rows.findIndex((row) => row.key === anchor.key);
}

export type HighlightPart = {
  text: string;
  changed: boolean;
  matched: boolean;
  syntax: string;
  simplified?: boolean;
};
export function highlightedParts(
  text: string,
  changes: TextRange[] = [],
  search = "",
): HighlightPart[] {
  const plain = (): HighlightPart[] => [
    { text, changed: false, matched: false, syntax: "", simplified: true },
  ];
  if (text.length > 10_000 || changes.length > 64) return plain();
  const matches: TextRange[] = [];
  if (search)
    for (
      let at = text.indexOf(search);
      at >= 0;
      at = text.indexOf(search, at + search.length)
    ) {
      if (matches.length === 64) return plain();
      matches.push({ start: at, end: at + search.length });
    }
  const syntax: (TextRange & { style: string })[] = [];
  if (text.trimStart().startsWith("//") || text.trimStart().startsWith("#")) {
    syntax.push({ start: 0, end: text.length, style: "syntax-comment" });
  } else {
    const pattern =
      /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\b(?:import|from|export|async|await|const|let|function|return|if|else|new|throw|class|interface|type|try|catch|true|false|null|undefined)\b)/g;
    for (const match of text.matchAll(pattern)) {
      if (syntax.length + matches.length + changes.length >= 128)
        return plain();
      syntax.push({
        start: match.index,
        end: match.index + match[0].length,
        style: /^['"]/.test(match[0]) ? "syntax-string" : "syntax-keyword",
      });
    }
  }
  const boundaries = [
    ...new Set([
      0,
      text.length,
      ...[...changes, ...matches, ...syntax].flatMap((range) => [
        range.start,
        range.end,
      ]),
    ]),
  ].sort((a, b) => a - b);
  let changeAt = 0,
    matchAt = 0,
    syntaxAt = 0;
  return boundaries.slice(0, -1).map((start, index) => {
    while (changeAt < changes.length && changes[changeAt].end <= start)
      changeAt++;
    while (matchAt < matches.length && matches[matchAt].end <= start) matchAt++;
    while (syntaxAt < syntax.length && syntax[syntaxAt].end <= start)
      syntaxAt++;
    return {
      text: text.slice(start, boundaries[index + 1]),
      changed: !!changes[changeAt] && changes[changeAt].start <= start,
      matched: !!matches[matchAt] && matches[matchAt].start <= start,
      syntax: syntax[syntaxAt]?.start <= start ? syntax[syntaxAt].style : "",
    };
  });
}

export function whitespaceDecorationsAllowed(text: string): boolean {
  if (text.length > 10_000) return false;
  let count = 0;
  for (const char of text)
    if ((char === " " || char === "\t" || char === "\r") && ++count > 64)
      return false;
  return true;
}
