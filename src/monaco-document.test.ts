import { describe, expect, it } from "vitest";
import {
  gitEditorDocument,
  sourceLineLabel,
  rowAtOffset,
  canUseMonaco,
} from "./monaco-document";
import { readingRows } from "./diff-reading";
import { demoDiff } from "./demo";

describe("Git editor documents", () => {
  it("keeps native source numbers and excludes synthetic missing cells and headers", () => {
    const diff = demoDiff({
      path: "src/api/requests.ts",
      oldPath: null,
      status: "M",
      side: "unstaged",
      conflicted: false,
    });
    const rows = readingRows(diff, true, false, null);
    const old = gitEditorDocument(rows, "old", {
        old: new WeakMap(),
        new: new WeakMap(),
      }),
      next = gitEditorDocument(rows, "new", {
        old: new WeakMap(),
        new: new WeakMap(),
      });
    expect(
      old.lines.every(
        (entry) => entry.source.kind !== "add" && entry.source.oldLine !== null,
      ),
    ).toBe(true);
    expect(
      next.lines.every(
        (entry) =>
          entry.source.kind !== "delete" && entry.source.newLine !== null,
      ),
    ).toBe(true);
    for (const [row, line] of old.rowLines) {
      expect(rows[row].kind).toBe("line");
      expect(sourceLineLabel(old, line)).toBe(
        String(old.lines[line - 1].source.oldLine),
      );
    }
    expect(old.text).not.toContain("@@");
    expect(next.text).not.toContain("@@");
  });
  it("preserves unified Git ordering without borrowing Monaco's diff algorithm", () => {
    const diff = demoDiff({
      path: "src/api/requests.ts",
      oldPath: null,
      status: "M",
      side: "unstaged",
      conflicted: false,
    });
    const rows = readingRows(diff, false, false, null);
    const doc = gitEditorDocument(rows, "unified", {
      old: new WeakMap(),
      new: new WeakMap(),
    });
    expect(doc.lines.map((entry) => entry.source.content).join("\n")).toBe(
      doc.text,
    );
    expect(doc.lines.some((entry) => entry.source.kind === "delete")).toBe(
      true,
    );
    expect(doc.lines.some((entry) => entry.source.kind === "add")).toBe(true);
  });
  it("maps viewport offsets to the owning source row", () => {
    expect(rowAtOffset([0, 40, 66, 92], 0)).toBe(0);
    expect(rowAtOffset([0, 40, 66, 92], 65)).toBe(1);
    expect(rowAtOffset([0, 40, 66, 92], 92)).toBe(3);
  });
});

it("keeps CRLF and EOF metadata outside the normalized display model", () => {
  const diff = demoDiff({
    path: "code.ts",
    oldPath: null,
    status: "M",
    side: "unstaged",
    conflicted: false,
  });
  diff.hunks = [
    {
      ...diff.hunks[0],
      lines: [
        {
          kind: "context",
          content: "const value = 1;\r",
          oldLine: 7,
          newLine: 9,
        },
        {
          kind: "note",
          content: "No newline at end of file",
          oldLine: null,
          newLine: null,
        },
      ],
    },
  ];
  const source = JSON.stringify(diff);
  const doc = gitEditorDocument(
    readingRows(diff, false, false, null),
    "unified",
    { old: new WeakMap(), new: new WeakMap() },
  );
  expect(doc.text).toBe("const value = 1;");
  expect(sourceLineLabel(doc, 1).trim()).toBe("7    9");
  expect(JSON.stringify(diff)).toBe(source);
});
it("keeps insert-only original models empty instead of copying alignment spacers", () => {
  const diff = demoDiff({
    path: "new.ts",
    oldPath: null,
    status: "U",
    side: "unstaged",
    conflicted: false,
  });
  diff.hunks = [
    {
      ...diff.hunks[0],
      lines: [{ kind: "add", content: "hello", oldLine: null, newLine: 1 }],
    },
  ];
  const rows = readingRows(diff, true, false, null),
    syntax = { old: new WeakMap(), new: new WeakMap() };
  expect(gitEditorDocument(rows, "old", syntax).text).toBe("");
  expect(gitEditorDocument(rows, "old", syntax).rowLines.size).toBe(0);
  expect(gitEditorDocument(rows, "new", syntax).text).toBe("hello");
});
it("uses the byte-preserving fallback for model-normalizing control characters", () => {
  const diff = demoDiff({
    path: "code.ts",
    oldPath: null,
    status: "M",
    side: "unstaged",
    conflicted: false,
  });
  expect(canUseMonaco(diff)).toBe(true);
  diff.hunks[0].lines[0].content = "before\rafter";
  expect(canUseMonaco(diff)).toBe(false);
  diff.hunks[0].lines[0].content = "\uFEFFleading BOM";
  expect(canUseMonaco(diff)).toBe(false);
});
