import { matchesGitBase } from "./diff-cache";
import {
  fileKey,
  type ChangedFile,
  type Changes,
  type FileDiff,
} from "./types";

export interface ReviewCoverage {
  loadedFiles: number;
  totalFiles: number;
  unreadFiles: number;
  reviewed: number;
  total: number;
}

function currentDiff(
  changes: Changes,
  loaded: Record<string, FileDiff>,
  file: ChangedFile,
) {
  const diff = loaded[fileKey(file)];
  return diff &&
    fileKey(diff) === fileKey(file) &&
    matchesGitBase(changes, diff)
    ? diff
    : undefined;
}

// Cache coverage is deliberately separate from review coverage. An unloaded
// or evicted Diff is unknown; it can never make a global progress ratio full.
export function reviewCoverage(
  changes: Changes,
  loaded: Record<string, FileDiff>,
): ReviewCoverage {
  let loadedFiles = 0,
    reviewed = 0,
    total = 0;
  for (const file of changes.files) {
    const diff = currentDiff(changes, loaded, file);
    if (!diff) continue;
    loadedFiles++;
    total += diff.hunks.length;
    reviewed += diff.hunks.filter(
      (hunk) => hunk.reviewState === "reviewed",
    ).length;
  }
  return {
    loadedFiles,
    totalFiles: changes.files.length,
    unreadFiles: changes.files.length - loadedFiles,
    reviewed,
    total,
  };
}

export function nextReviewFile(
  changes: Changes,
  loaded: Record<string, FileDiff>,
  selected: string | null,
): ChangedFile | undefined {
  const start = changes.files.findIndex((file) => fileKey(file) === selected);
  for (let offset = 1; offset <= changes.files.length; offset++) {
    const file = changes.files[(start + offset) % changes.files.length];
    const diff = currentDiff(changes, loaded, file);
    if (!diff || diff.hunks.some((hunk) => hunk.reviewState !== "reviewed"))
      return file;
  }
}
