import { describe, expect, it } from "vitest";
import { rowsForHunk } from "./diff-model";
import type { DiffLine, Hunk } from "./types";

function hunk(lines: DiffLine[]): Hunk {
  return {
    id: "fixture",
    header: "@@ -1,2 +1,3 @@",
    oldStart: 1,
    newStart: 1,
    reviewState: "unreviewed",
    lines,
  };
}
describe("read-only diff alignment", () => {
  it("keeps every source line and its number when changing display modes", () => {
    const original = hunk([
      {
        kind: "context",
        content: " const before = 1;",
        oldLine: 1,
        newLine: 1,
      },
      { kind: "delete", content: '\treturn "old";', oldLine: 2, newLine: null },
      { kind: "add", content: '\treturn "new";', oldLine: null, newLine: 2 },
      {
        kind: "add",
        content: "<script>untrusted source</script>",
        oldLine: null,
        newLine: 3,
      },
      {
        kind: "note",
        content: "\\ No newline at end of file",
        oldLine: null,
        newLine: null,
      },
    ]);
    const before = JSON.stringify(original);
    for (const split of [false, true]) {
      const rows = rowsForHunk(original, split);
      const old = rows.flatMap((r) =>
        r.kind === "line" &&
        r.left?.oldLine !== null &&
        r.left?.oldLine !== undefined
          ? [r.left]
          : [],
      );
      const next = rows.flatMap((r) => {
        if (r.kind !== "line") return [];
        const line = split ? r.right : r.left;
        return line?.newLine !== null && line?.newLine !== undefined
          ? [line]
          : [];
      });
      expect(old.map((l) => l.content)).toEqual([
        " const before = 1;",
        '\treturn "old";',
      ]);
      expect(next.map((l) => l.content)).toEqual([
        " const before = 1;",
        '\treturn "new";',
        "<script>untrusted source</script>",
      ]);
      expect(next.map((l) => l.newLine)).toEqual([1, 2, 3]);
    }
    expect(JSON.stringify(original)).toBe(before);
  });
  it("does not invent matching code for pure additions and deletions", () => {
    const rows = rowsForHunk(
      hunk([
        { kind: "add", content: "new", oldLine: null, newLine: 1 },
        { kind: "context", content: "same", oldLine: 1, newLine: 2 },
        { kind: "delete", content: "removed", oldLine: 2, newLine: null },
      ]),
      true,
    );
    expect(rows[0]).toMatchObject({ left: null, right: { content: "new" } });
    expect(rows[2]).toMatchObject({
      left: { content: "removed" },
      right: null,
    });
  });
});
