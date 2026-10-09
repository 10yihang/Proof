import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  findingDisplayRange,
  findingLocationTargetKey,
  findingModelRange,
  findingWorkspaceInvalidated,
  type FindingLocationResult,
} from "./finding-location";
import { FindingLocationBody } from "./components/FindingLocationPane";

const result: FindingLocationResult = {
  workspaceId: "workspace",
  path: "auth.rs",
  status: "exact",
  current: {
    path: "auth.rs",
    source: "worktree",
    line: 12,
    endLine: 14,
    content: "guard\ncall\nreturn",
    startLine: 12,
    fingerprint: "current",
  },
  original: {
    path: "auth.rs",
    source: "index",
    line: 4,
    endLine: 6,
    content: "guard\ncall\nreturn",
    startLine: 4,
    fingerprint: "original",
  },
  candidates: [],
};
function body(
  value: FindingLocationResult,
  mode: "current" | "original" = "current",
) {
  return renderToString(
    React.createElement(FindingLocationBody, {
      result: value,
      mode,
      candidate: null,
      onCandidate: vi.fn(),
      fontSize: 13,
    }),
  );
}
describe("version-aware read-only finding locations", () => {
  it("maps real source lines into a snippet without highlighting an unrelated row for an absent finding", () => {
    expect(findingModelRange({ line: 12, endLine: 14 }, 12, 3)).toEqual({
      line: 1,
      endLine: 3,
    });
    expect(findingModelRange({ line: 11, endLine: 13 }, 12, 3)).toEqual({
      line: 1,
      endLine: 2,
    });
    expect(findingModelRange({ line: 1, endLine: 4 }, 12, 3)).toBeNull();
    expect(findingModelRange({ line: 19, endLine: 20 }, 12, 3)).toBeNull();
    expect(findingModelRange({ line: 0, endLine: 3 }, 1, 3)).toBeNull();
    expect(findingModelRange({ line: 4, endLine: 3 }, 1, 6)).toBeNull();
    expect(findingModelRange(null, 1, 6)).toBeNull();
  });
  it("keeps original and current coordinates separate, including a moved location", () => {
    expect(
      findingDisplayRange({ ...result, status: "shifted" }, "current", null),
    ).toEqual({ line: 12, endLine: 14 });
    expect(
      findingDisplayRange({ ...result, status: "shifted" }, "original", null),
    ).toEqual({ line: 4, endLine: 6 });
    expect(
      findingDisplayRange(
        {
          ...result,
          current: { ...result.current!, line: null, endLine: null },
        },
        "current",
        null,
      ),
    ).toBeNull();
  });
  it("never auto-selects a repeated-code candidate and rejects a candidate from another result", () => {
    const ambiguous: FindingLocationResult = {
      ...result,
      status: "ambiguous",
      candidates: [
        { line: 12, endLine: 14 },
        { line: 24, endLine: 26 },
      ],
    };
    expect(findingDisplayRange(ambiguous, "current", null)).toBeNull();
    expect(
      findingDisplayRange(ambiguous, "current", ambiguous.candidates[1]),
    ).toEqual({ line: 24, endLine: 26 });
    expect(
      findingDisplayRange(ambiguous, "current", { line: 50, endLine: 52 }),
    ).toBeNull();
    const html = body(ambiguous);
    expect(html).toContain("Proof 不会自动选择");
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-pressed="true"');
  });
  it("presents source versions and absolute lines separately from snippet model coordinates", () => {
    const current = body(result);
    expect(current).toContain("当前工作区");
    expect(current).toContain("第 12–14 行");
    expect(current).toContain('data-finding-line="12"');
    expect(current).toContain('data-source-start-line="12"');
    const original = body(result, "original");
    expect(original).toContain("暂存区");
    expect(original).toContain("第 4–6 行");
    expect(original).toContain('data-finding-source="index"');
    const frozenWorktree = body(
      { ...result, original: { ...result.original!, source: "worktree" } },
      "original",
    );
    expect(frozenWorktree).toContain("审查时的工作区");
    expect(frozenWorktree).not.toContain("当前工作区");
    expect(
      body(
        { ...result, original: { ...result.original!, source: "head" } },
        "original",
      ),
    ).toContain("HEAD 版本");
    expect(
      body(
        { ...result, original: { ...result.original!, source: "base" } },
        "original",
      ),
    ).toContain("审查基准");
    expect(
      body(
        { ...result, original: { ...result.original!, source: "target" } },
        "original",
      ),
    ).toContain("审查目标");
    const ambiguous = {
      ...result,
      status: "ambiguous",
      candidates: [{ line: 24, endLine: 26 }],
    } satisfies FindingLocationResult;
    expect(body(ambiguous)).toContain("范围未确认");
    expect(body(ambiguous)).not.toContain('data-finding-line="12"');
    const selected = renderToString(
      React.createElement(FindingLocationBody, {
        result: ambiguous,
        mode: "current",
        candidate: ambiguous.candidates[0],
        onCandidate: vi.fn(),
        fontSize: 13,
      }),
    );
    expect(selected).toContain("第 24–26 行");
    expect(selected).toContain('data-finding-line="24"');
  });
  it("labels modified/deleted code for manual confirmation rather than presenting the old line as exact", () => {
    expect(body({ ...result, status: "modified" })).toContain(
      "代码已修改，待复核",
    );
    const deleted = body({
      ...result,
      status: "deleted",
      current: null,
      reason: "FILE_MISSING",
    });
    expect(deleted).toContain("代码已删除，待复核");
    expect(deleted).toContain("文件已不存在，可查看审查原位置");
    expect(deleted).toContain("此版本没有可显示的文本");
    expect(body(result, "original")).toContain("原始审查代码，只读");
  });
  it("shows missing anchor coverage for an old report without inventing a precise highlight", () => {
    const old: FindingLocationResult = {
      ...result,
      status: "unavailable",
      original: null,
      reason: "ANCHOR_NOT_SAVED",
      current: { ...result.current!, line: null, endLine: null },
    };
    expect(findingDisplayRange(old, "current", null)).toBeNull();
    expect(body(old)).toContain("旧记录没有保存代码锚点，当前文件仅供查阅");
    expect(body(old)).toContain("人工 Reviewed 状态不变");
  });
  it("refreshes only the workspace affected by a generation-filtered invalidation event", () => {
    expect(
      findingWorkspaceInvalidated("workspace", {
        workspaceId: "workspace",
        generation: 3,
        batch: { paths: ["auth.rs"] },
      }),
    ).toBe(true);
    expect(
      findingWorkspaceInvalidated("workspace", {
        workspaceId: "another",
        generation: 3,
        batch: { paths: ["auth.rs"] },
      }),
    ).toBe(false);
    expect(findingWorkspaceInvalidated("workspace", null)).toBe(false);
    expect(findingWorkspaceInvalidated("workspace", "workspace")).toBe(false);
    expect(findingWorkspaceInvalidated("workspace", { workspaceId: 3 })).toBe(
      false,
    );
  });
  it("keys pending reads by workspace, persisted report/context and finding index", () => {
    const key = findingLocationTargetKey({
      workspaceId: "a",
      reportId: "report",
      findingIndex: 0,
    });
    expect(
      findingLocationTargetKey({
        workspaceId: "b",
        reportId: "report",
        findingIndex: 0,
      }),
    ).not.toBe(key);
    expect(
      findingLocationTargetKey({
        workspaceId: "a",
        contextId: "report",
        findingIndex: 0,
      }),
    ).not.toBe(key);
    expect(
      findingLocationTargetKey({
        workspaceId: "a",
        reportId: "report",
        findingIndex: 1,
      }),
    ).not.toBe(key);
  });
});
