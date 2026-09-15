import { describe, expect, it } from "vitest";
import { annotationsForDiff, inFindingRange } from "./review-annotations";
import type { AiReport } from "./ai";
import { demoChanges, demoDiff } from "./demo";

describe("Review annotations", () => {
  const diff = demoDiff(demoChanges.files[0]);
  const report = {
    id: "review",
    scope: { kind: "local", workspaceId: diff.workspaceId },
    files: [
      {
        path: diff.path,
        side: diff.side,
        snapshotToken: diff.token,
        snapshotId: "previous-process-id",
      },
    ],
    review: { findings: [{ file: diff.path, side: diff.side }] },
  } as AiReport;
  it("reattaches unchanged local captures after restart, and rejects stale tokens or another side", () => {
    expect(annotationsForDiff(report, diff, false)).toHaveLength(1);
    expect(annotationsForDiff(report, diff, true)).toHaveLength(0);
    expect(
      annotationsForDiff(report, { ...diff, token: "changed" }, false),
    ).toHaveLength(0);
    expect(
      annotationsForDiff(
        report,
        { ...diff, side: diff.side === "staged" ? "unstaged" : "staged" },
        false,
      ),
    ).toHaveLength(0);
    expect(
      annotationsForDiff(report, { ...diff, workspaceId: "other" }, false),
    ).toHaveLength(0);
    const comparison = {
      ...report,
      scope: {
        kind: "comparison",
        workspaceId: diff.workspaceId,
        base: "a",
        target: "b",
        path: null,
      },
    } as AiReport;
    expect(annotationsForDiff(comparison, diff, false)).toHaveLength(0);
    comparison.files = [{ ...comparison.files[0], snapshotId: diff.id }];
    expect(annotationsForDiff(comparison, diff, false)).toHaveLength(1);
  });
  it("includes both range boundaries only on the cited side, including deleted lines", () => {
    const line = { ...diff.hunks[0].lines[0], oldLine: 10, newLine: null };
    expect(inFindingRange(line, { line: 9, endLine: 10, side: "old" })).toBe(
      true,
    );
    expect(inFindingRange(line, { line: 10, endLine: 12, side: "old" })).toBe(
      true,
    );
    expect(inFindingRange(line, { line: 10, endLine: 12, side: "new" })).toBe(
      false,
    );
    expect(inFindingRange(line, { line: 11, endLine: 12, side: "old" })).toBe(
      false,
    );
    expect(inFindingRange(line, { line: 10, side: "old" })).toBe(true);
    expect(inFindingRange(line, null)).toBe(false);
  });
});
