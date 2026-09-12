import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { CodeText } from "./components/CodeText";
import { demoChanges, demoDiff, demoDiffContext } from "./demo";
import {
  findAnchor,
  hiddenWhitespace,
  highlightedParts,
  inlineChanges,
  readingRows,
  rowAnchor,
  whitespaceDecorationsAllowed,
} from "./diff-reading";
import type { DiffLine, Hunk } from "./types";

const line = (kind: DiffLine["kind"], content: string, n = 1): DiffLine => ({
  kind,
  content,
  oldLine: kind === "add" || kind === "note" ? null : n,
  newLine: kind === "delete" || kind === "note" ? null : n,
});
const hunk = (lines: DiffLine[]): Hunk => ({
  id: "unit",
  header: "@@ -1,3 +1,3 @@",
  oldStart: 1,
  newStart: 1,
  reviewState: "unreviewed",
  lines,
});

describe("immutable Diff reading", () => {
  it("only folds paired whitespace replacements, preserving semantic changes and actual counts", () => {
    const diff = demoDiff(demoChanges.files[1]);
    const captured = JSON.stringify(diff);
    for (const split of [false, true]) {
      const rows = readingRows(diff, split, true, null);
      expect(
        rows
          .filter((r) => r.kind === "header")
          .map((r) => r.kind === "header" && r.hunk.id),
      ).toEqual(diff.hunks.map((h) => h.id));
      expect(
        rows.reduce(
          (count, r) => count + (r.kind === "hidden" ? r.count : 0),
          0,
        ),
      ).toBe(2);
      expect(
        rows.some(
          (r) =>
            r.kind === "line" &&
            [r.left, r.right].some((l) =>
              l?.content.includes("{ status, headers }"),
            ),
        ),
      ).toBe(true);
      expect(
        readingRows(diff, split, false, null).some((r) => r.kind === "hidden"),
      ).toBe(false);
    }
    expect(JSON.stringify(diff)).toBe(captured);
  });

  it("does not hide inserted blank lines, removed lines, EOF markers, or unchanged moved text", () => {
    for (const lines of [
      [line("add", "   ")],
      [line("delete", "\t")],
      [line("delete", "value"), line("add", "value")],
      [
        line("delete", "value"),
        line("note", "\\ No newline at end of file"),
        line("add", "value "),
      ],
      [line("delete", "　value"), line("add", "value")],
      [line("delete", " a"), line("add", "a"), line("add", "")],
    ])
      expect(hiddenWhitespace(hunk(lines)).size).toBe(0);
    expect(
      hiddenWhitespace(hunk([line("delete", "a \r"), line("add", "\ta")])).size,
    ).toBe(2);
  });

  it("keeps all original Hunk IDs and coordinates when expanded context joins the visible blocks", () => {
    const diff = demoDiff(demoChanges.files[0]);
    const before = JSON.stringify(diff);
    const context = demoDiffContext(diff, 25);
    const rows = readingRows(diff, false, false, context);
    const old = rows.flatMap((r) =>
      r.kind === "line" && r.left?.oldLine ? [r.left.oldLine] : [],
    );
    const next = rows.flatMap((r) =>
      r.kind === "line" && r.left?.newLine ? [r.left.newLine] : [],
    );
    expect(new Set(old).size).toBe(old.length);
    expect(new Set(next).size).toBe(next.length);
    expect(old).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
    expect(next).toEqual(Array.from({ length: 36 }, (_, i) => i + 1));
    expect(JSON.stringify(diff)).toBe(before);
  });

  it("highlights changed words in Unicode text without rewriting or trusting code", () => {
    const removed = line("delete", 'const café = greet("小明", 1);');
    const added = line("add", 'const café = greet("小红", 2);');
    const ranges = inlineChanges(hunk([removed, added]));
    const parts = highlightedParts(added.content, ranges.get(added), "小红");
    expect(parts.map((p) => p.text).join("")).toBe(added.content);
    expect(
      parts
        .filter((p) => p.changed)
        .map((p) => p.text)
        .join(""),
    ).toContain("小红");
    expect(parts.some((p) => p.matched && p.changed)).toBe(true);
    const source = "\t<script>alert('x')</script> \r";
    const html = renderToStaticMarkup(
      createElement(CodeText, {
        text: source,
        search: "alert",
        showWhitespace: true,
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("visible-tab");
    expect(html).not.toContain("→"); // whitespace glyphs are CSS only, never copied text
  });

  it("bounds expensive highlighters and preserves the complete long source line", () => {
    const source = "long " + "word + ".repeat(3000);
    expect(highlightedParts(source, [], "word")).toEqual([
      {
        text: source,
        changed: false,
        matched: false,
        syntax: "",
        simplified: true,
      },
    ]);
    expect(
      inlineChanges(hunk([line("delete", source), line("add", source + "x")]))
        .size,
    ).toBe(0);
  });

  it("bounds dense search, syntax and whitespace decorations while retaining all source bytes", () => {
    for (const source of [
      "a".repeat(10000),
      " ".repeat(10000),
      "const true ".repeat(500),
    ]) {
      const parts = highlightedParts(source, [], "a");
      expect(parts.length).toBeLessThanOrEqual(257);
      expect(parts.map((part) => part.text).join("")).toBe(source);
      const html = renderToStaticMarkup(
        createElement(CodeText, {
          text: source,
          search: "a",
          showWhitespace: true,
        }),
      );
      expect((html.match(/<span/g) ?? []).length).toBeLessThanOrEqual(386);
    }
    expect(whitespaceDecorationsAllowed("\t".repeat(65))).toBe(false);
  });

  it("anchors by source line across display modes and never picks an ambiguous refreshed line", () => {
    const diff = demoDiff(demoChanges.files[1]);
    const unified = readingRows(diff, false, false, null);
    const target = unified.find(
      (r) => r.kind === "line" && r.left?.kind === "delete",
    )!;
    const anchor = rowAnchor(target);
    const split = readingRows(diff, true, false, null);
    expect(findAnchor(split, anchor)).toBeGreaterThan(0);
    expect(
      readingRows(diff, false, true, null)[
        findAnchor(readingRows(diff, false, true, null), anchor)
      ].kind,
    ).toBe("header");
    const unknown = {
      ...anchor,
      hunkId: "other",
      key: "other",
      oldLine: 900,
      newLine: null,
      content: "duplicate",
    };
    const rows = readingRows(
      {
        ...diff,
        hunks: [
          hunk([
            line("context", "duplicate", 2),
            line("context", "duplicate", 3),
          ]),
        ],
      },
      false,
      false,
      null,
    );
    expect(findAnchor(rows, unknown, true)).toBe(-1);
    // An index insertion was staged: old/new coordinates now independently hit
    // two equal lines. Neither is evidence that this is the original location.
    expect(findAnchor(rows, { ...unknown, oldLine: 2, newLine: 3 }, true)).toBe(
      -1,
    );
    expect(findAnchor(rows, { ...unknown, content: "missing" }, true)).toBe(-1);
  });
});
