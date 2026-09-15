import { describe, expect, it } from "vitest";
import { highlightedParts } from "./diff-reading";
import { hunkSyntax } from "./syntax";
import type { DiffLine } from "./types";

describe("language-aware Diff highlighting", () => {
  it("keeps TSX text exact while layering syntax, inline changes and search", () => {
    const text =
      "const node = <Button size={42} onClick={() => submit(true)} />;";
    const parts = highlightedParts(
      text,
      [{ start: 26, end: 28 }],
      "submit",
      "panel.tsx",
    );
    expect(parts.map((part) => part.text).join("")).toBe(text);
    for (const style of [
      "syntax-keyword",
      "syntax-tag",
      "syntax-property",
      "syntax-number",
      "syntax-function",
      "syntax-constant",
    ])
      expect(parts.some((part) => part.syntax === style)).toBe(true);
    expect(
      parts
        .filter((part) => part.matched)
        .map((part) => part.text)
        .join(""),
    ).toBe("submit");
    expect(parts.some((part) => part.changed)).toBe(true);
  });
  it("recognizes Go and keeps multiline comment state separately on each side", () => {
    expect(
      highlightedParts(
        "func Load(value int) bool { return value > 42 }",
        [],
        "",
        "main.go",
      ).some(
        (part) => part.text === "Load" && part.syntax === "syntax-function",
      ),
    ).toBe(true);
    const lines: DiffLine[] = [
      { kind: "context", oldLine: 1, newLine: 1, content: "/* comment" },
      { kind: "delete", oldLine: 2, newLine: null, content: "old value" },
      { kind: "add", oldLine: null, newLine: 2, content: "new value" },
      { kind: "context", oldLine: 3, newLine: 3, content: "*/" },
    ];
    const tokens = hunkSyntax([{ lines }], "example.ts");
    expect(tokens.old.get(lines[1])?.[0].style).toBe("syntax-comment");
    expect(tokens.new.get(lines[2])?.[0].style).toBe("syntax-comment");
    expect(tokens.old.has(lines[2])).toBe(false);
  });
  it("leaves unknown files and oversized lines selectable without interpreting HTML", () => {
    const text = '<script>alert("not executed")</script>';
    expect(
      highlightedParts(text, [], "", "opaque.data")
        .map((part) => part.text)
        .join(""),
    ).toBe(text);
    const long = "x".repeat(10001);
    expect(highlightedParts(long, [], "", "big.ts")).toEqual([
      {
        text: long,
        changed: false,
        matched: false,
        syntax: "",
        simplified: true,
      },
    ]);
  });
});
