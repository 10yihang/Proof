import { describe, expect, it } from "vitest";
import { isCurrentWorkspaceInvalidation } from "./workspace-invalidation";

describe("native invalidation protocol", () => {
  it("accepts legacy ids without responding to another workspace", () => {
    expect(isCurrentWorkspaceInvalidation("repo", "repo", 5)).toBe(true);
    expect(isCurrentWorkspaceInvalidation("other", "repo", 5)).toBe(false);
  });
  it("rejects old batches after renderer reload or repository change", () => {
    const batch = {
      workspaceId: "repo",
      generation: 5,
      reasons: ["refs"],
      paths: [],
    };
    expect(isCurrentWorkspaceInvalidation(batch, "repo", 5)).toBe(true);
    expect(isCurrentWorkspaceInvalidation(batch, "repo", 6)).toBe(false);
    expect(isCurrentWorkspaceInvalidation(batch, "other", 5)).toBe(false);
  });
  it("ignores malformed events and permits conservative overflow batches", () => {
    expect(isCurrentWorkspaceInvalidation(null, "repo", 5)).toBe(false);
    expect(
      isCurrentWorkspaceInvalidation({ workspaceId: "repo" }, "repo", 5),
    ).toBe(false);
    expect(
      isCurrentWorkspaceInvalidation(
        {
          workspaceId: "repo",
          generation: 5,
          reasons: ["overflow"],
          paths: [],
          overflow: true,
        },
        "repo",
        5,
      ),
    ).toBe(true);
  });
});
