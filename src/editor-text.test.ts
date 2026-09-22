import { describe, expect, it } from "vitest";
import { formatSize, toDiskEol } from "./editor-text";

describe("editor EOL round-trip", () => {
  it("keeps LF content untouched", () => {
    expect(toDiskEol("a\nb\n", "lf")).toBe("a\nb\n");
  });
  it("converts LF to CRLF for CRLF files", () => {
    expect(toDiskEol("a\nb\n", "crlf")).toBe("a\r\nb\r\n");
  });
  it("is idempotent over already-CRLF content", () => {
    expect(toDiskEol("a\r\nb\r\n", "crlf")).toBe("a\r\nb\r\n");
  });
  it("normalizes mixed line endings to CRLF", () => {
    expect(toDiskEol("a\nb\r\nc", "crlf")).toBe("a\r\nb\r\nc");
  });
  it("handles empty and trailing-newline content", () => {
    expect(toDiskEol("", "crlf")).toBe("");
    expect(toDiskEol("\n", "crlf")).toBe("\r\n");
  });
});

describe("formatSize", () => {
  it("formats bytes, KB and MB", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(20 * 1024)).toBe("20 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(4.2 * 1024 * 1024)).toBe("4.2 MB");
  });
});
