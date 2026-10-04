import { describe, expect, it } from "vitest";
import { demoChanges, demoDiff } from "./demo";
import { fileKey } from "./types";
import { nextReviewFile, reviewCoverage } from "./review-coverage";

describe("review coverage", () => {
  it("keeps unloaded files explicit after every loaded hunk is reviewed", () => {
    const file = demoChanges.files[0],
      diff = demoDiff(file);
    diff.hunks.forEach((hunk) => {
      hunk.reviewState = "reviewed";
    });
    const loaded = { [fileKey(file)]: diff };
    expect(reviewCoverage(demoChanges, loaded)).toEqual({
      loadedFiles: 1,
      totalFiles: 5,
      unreadFiles: 4,
      reviewed: 2,
      total: 2,
    });
    expect(nextReviewFile(demoChanges, loaded, fileKey(file))).toEqual(
      demoChanges.files[1],
    );
  });

  it("does not borrow review between staged and unstaged versions of one path", () => {
    const unstaged = demoChanges.files[0],
      staged = { ...unstaged, side: "staged" as const };
    const changes = { ...demoChanges, files: [unstaged, staged] };
    const diff = demoDiff(unstaged);
    diff.hunks.forEach((hunk) => {
      hunk.reviewState = "reviewed";
    });
    const loaded = { [fileKey(unstaged)]: diff };
    expect(reviewCoverage(changes, loaded).unreadFiles).toBe(1);
    expect(nextReviewFile(changes, loaded, fileKey(unstaged))).toEqual(staged);
    expect(
      reviewCoverage(changes, { [fileKey(staged)]: diff }).loadedFiles,
    ).toBe(0);
  });

  it("ignores another workspace, old Git base and removed files", () => {
    const file = demoChanges.files[0],
      diff = demoDiff(file);
    expect(
      reviewCoverage(
        { ...demoChanges, head: "different-head" },
        { [fileKey(file)]: diff },
      ).loadedFiles,
    ).toBe(0);
    expect(
      reviewCoverage(
        {
          ...demoChanges,
          workspace: { ...demoChanges.workspace, id: "other" },
        },
        { [fileKey(file)]: diff },
      ).loadedFiles,
    ).toBe(0);
    expect(
      reviewCoverage({ ...demoChanges, files: [] }, { [fileKey(file)]: diff })
        .total,
    ).toBe(0);
  });

  it("wraps to a needs-review hunk but leaves a completed scope without a next action", () => {
    const file = demoChanges.files[0],
      diff = demoDiff(file),
      changes = { ...demoChanges, files: [file] };
    diff.hunks.forEach((hunk) => {
      hunk.reviewState = "reviewed";
    });
    const loaded = { [fileKey(file)]: diff };
    expect(nextReviewFile(changes, loaded, fileKey(file))).toBeUndefined();
    diff.hunks[0].reviewState = "needs_review";
    expect(nextReviewFile(changes, loaded, fileKey(file))).toEqual(file);
    expect(reviewCoverage(changes, loaded).reviewed).toBe(1);
  });
});
