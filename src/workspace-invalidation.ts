export interface WorkspaceInvalidation {
  workspaceId: string;
  generation: number;
  reasons: string[];
  paths: string[];
  ignoredPaths?: string[];
  overflow?: boolean;
}

// Older native builds sent only the workspace id. New batches also carry the
// watcher generation, so a reload or repository switch cannot revive old work.
export function isCurrentWorkspaceInvalidation(
  payload: unknown,
  workspaceId: string,
  generation: number,
): boolean {
  if (typeof payload === "string") return payload === workspaceId;
  if (!payload || typeof payload !== "object") return false;
  const batch = payload as Partial<WorkspaceInvalidation>;
  return batch.workspaceId === workspaceId && batch.generation === generation;
}
