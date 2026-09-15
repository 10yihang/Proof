import { describe, expect, it } from "vitest";
import type { AiReport } from "./ai";
import { acceptedFindingIndices, reviewInstructions } from "./review-export";

const report: AiReport = {
  id: "review-1",
  revision: 3,
  provider: "codex",
  task: "review",
  capturedAt: Date.UTC(2026, 8, 15),
  fingerprint: "capture",
  scope: {
    kind: "local",
    workspaceId: "workspace",
    expectedToken: "token",
    files: null,
  },
  files: [],
  groups: [],
  limitations: [],
  decisions: ["accepted", "pending", "dismissed"],
  review: {
    summary: "Report-wide summary must not add unselected work",
    overallRisk: "high",
    behaviorChanges: [],
    missingTests: ["Unselected report-wide test"],
    reviewPriority: [],
    findings: [
      "Fix connection lifetime",
      "Add boundary test",
      "Keep existing response",
    ].map((title, index) => ({
      severity: "high",
      title,
      description: `Description ${index}`,
      suggestion: `Suggestion ${index}`,
      file: "src/pool.ts",
      side: "unstaged",
      line: index + 10,
      endLine: index + 12,
      lineSide: "new",
    })),
  },
};
const context = {
  workspaceName: "Proof",
  workspacePath: "/work/Proof",
  branch: "feature/review",
  stale: false,
};

describe("Review instructions for an Agent", () => {
  it("defaults to accepted findings and exports no extra report-wide tasks", () => {
    expect(acceptedFindingIndices(report)).toEqual([0]);
    const result = reviewInstructions(
      report,
      acceptedFindingIndices(report),
      context,
      "zh-CN",
    );
    expect(result).toContain("Fix connection lifetime");
    expect(result).toContain("Description 0");
    expect(result).toContain("Suggestion 0");
    expect(result).toContain("unstaged · 修改后 · L10–L12");
    expect(result).toContain("/work/Proof");
    expect(result).toContain("feature/review");
    expect(result).not.toContain("Add boundary test");
    expect(result).not.toContain("Keep existing response");
    expect(result).not.toContain("report-wide");
  });
  it("honors an explicit selection in report order without changing decisions", () => {
    const before = structuredClone(report);
    const result = reviewInstructions(
      report,
      [2, 1, 2, 100, -1],
      context,
      "en",
    );
    expect(result).not.toContain("Fix connection lifetime");
    expect(result).toContain("## 1. [high] Add boundary test");
    expect(result).toContain("## 2. [high] Keep existing response");
    expect(result).not.toContain("## 3.");
    expect(result).toContain("do not automatically Stage, Commit, or Amend");
    expect(report).toEqual(before);
  });
  it("preserves frozen comparisons, deleted-side ranges and stale version context", () => {
    const history: AiReport = {
      ...report,
      scope: {
        kind: "comparison",
        workspaceId: "workspace",
        base: "a".repeat(40),
        target: "b".repeat(40),
        path: null,
      },
      review: {
        ...report.review!,
        findings: [
          { ...report.review!.findings[0], side: "staged", lineSide: "old" },
        ],
      },
    };
    const result = reviewInstructions(
      history,
      [0],
      { ...context, stale: true },
      "en",
    );
    expect(result).toContain("a".repeat(40));
    expect(result).toContain("b".repeat(40));
    expect(result).toContain("Before · L10–L12");
    expect(result).toContain(`base \`${"a".repeat(40)}\``);
    expect(result).not.toContain("staged");
    expect(result).toContain("Code has changed since this Review");
    expect(result).not.toContain("Local changes");
  });
  it("keeps unusual file paths unambiguous and includes single-line locations", () => {
    const custom: AiReport = {
      ...report,
      review: {
        ...report.review!,
        findings: [
          {
            ...report.review!.findings[0],
            file: "src/中文`file\nname.ts",
            endLine: null,
          },
        ],
      },
    };
    const result = reviewInstructions(custom, [0], context, "zh-CN");
    expect(result).toContain('``"src/中文`file\\nname.ts"``');
    expect(result).toContain("L10\n");
  });
  it("does not generate a task for an empty or invalid selection", () => {
    expect(reviewInstructions(report, [], context, "en")).toBe("");
    expect(reviewInstructions(report, [99], context, "en")).toBe("");
    expect(acceptedFindingIndices({ ...report, review: null })).toEqual([]);
  });
});
