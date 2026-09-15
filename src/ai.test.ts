import { describe, expect, it } from "vitest";
import {
  moveGroupedFile,
  reconcileGroups,
  reportIsStale,
  type AiGroup,
  type AiReport,
} from "./ai";
import { demoChanges } from "./demo";
const groups: AiGroup[] = [
  {
    title: "Auth",
    summary: "Authentication",
    files: ["auth.rs", "token.rs"],
    risk: "high",
    reviewPriority: 1,
  },
  {
    title: "Pool",
    summary: "Connections",
    files: ["pool.rs"],
    risk: "medium",
    reviewPriority: 2,
  },
];
describe("AI grouping and snapshot boundaries", () => {
  it("moves a file exactly once and removes empty groups", () => {
    const next = moveGroupedFile(groups, "pool.rs", 0);
    expect(next).toHaveLength(1);
    expect(next[0].files).toEqual(["auth.rs", "token.rs", "pool.rs"]);
    expect(groups[1].files).toEqual(["pool.rs"]);
  });
  it("can ungroup and removes paths no longer changed without inventing membership", () => {
    expect(moveGroupedFile(groups, "auth.rs", null)[0].files).toEqual([
      "token.rs",
    ]);
    expect(reconcileGroups(groups, new Set(["pool.rs", "new.rs"]))).toEqual([
      groups[1],
    ]);
  });
  it("expires local results on input changes and compares historical OIDs independently", () => {
    const report = {
      scope: {
        kind: "local",
        workspaceId: demoChanges.workspace.id,
        expectedToken: demoChanges.token,
        files: null,
      },
    } as AiReport;
    expect(reportIsStale(report, demoChanges)).toBe(false);
    expect(reportIsStale(report, { ...demoChanges, token: "next" })).toBe(true);
    report.scope = {
      kind: "comparison",
      workspaceId: demoChanges.workspace.id,
      base: "base",
      target: "target",
      path: null,
    };
    expect(
      reportIsStale(report, demoChanges, {
        baseOid: "base",
        targetOid: "target",
      }),
    ).toBe(false);
    expect(
      reportIsStale(report, demoChanges, {
        baseOid: "target",
        targetOid: "base",
      }),
    ).toBe(true);
  });
});
