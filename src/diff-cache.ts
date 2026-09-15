import { fileKey, readTarget } from "./types";
import type { ChangedFile, Changes, FileDiff, DiffRead } from "./types";
import { DiffReadBudget } from "./diff-budget";

export function matchesGitBase(
  changes: Pick<Changes, "workspace" | "head" | "branch">,
  diff: Pick<FileDiff, "workspaceId" | "base">,
) {
  return (
    diff.workspaceId === changes.workspace.id &&
    diff.base === `${changes.head ?? "unborn"}:${changes.branch ?? "detached"}`
  );
}

// A small display cache; write commands always revalidate the native snapshot.
// Keep fewer entries than the core's snapshot store, leaving room for writes
// and expanded context requests. A repository refresh invalidates by file.
export class DiffCache {
  private entries = new DiffReadBudget(16 * 1024 * 1024, 24, true);
  private versions = new Map<string, string>();
  private pending = new Map<string, Promise<DiffRead>>();
  version(changes: Changes, file: Pick<ChangedFile, "side" | "path">) {
    return `${changes.workspace.id}:${changes.fileVersions?.[fileKey(file)] ?? changes.token}`;
  }
  get(changes: Changes, file: ChangedFile) {
    const read = this.getRead(changes, file);
    return read?.state === "ready" ? read.diff : undefined;
  }
  getRead(changes: Changes, file: ChangedFile) {
    const key = fileKey(file),
      read = this.entries.get(key);
    if (
      !read ||
      this.versions.get(key) !== this.version(changes, file) ||
      !matchesGitBase(changes, readTarget(read))
    )
      return;
    return read;
  }
  put(
    changes: Changes,
    file: Pick<ChangedFile, "side" | "path">,
    diff: FileDiff,
  ) {
    this.putRead(changes, file, { state: "ready", diff });
  }
  putRead(
    changes: Changes,
    file: Pick<ChangedFile, "side" | "path">,
    read: DiffRead,
  ) {
    if (!matchesGitBase(changes, readTarget(read))) return;
    const key = fileKey(file);
    this.entries.set(key, read);
    this.versions.set(key, this.version(changes, file));
    const retained = new Set(this.entries.values().map(([key]) => key));
    for (const key of this.versions.keys())
      if (!retained.has(key)) this.versions.delete(key);
  }
  read(
    changes: Changes,
    file: ChangedFile,
    fetch: () => Promise<DiffRead>,
    loadLarge = false,
  ) {
    const key = `${this.version(changes, file)}:${fileKey(file)}:${loadLarge ? "full" : "preview"}`;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = fetch().finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      });
      this.pending.set(key, pending);
    }
    return pending;
  }
  cancelPending() {
    this.pending.clear();
  }
  retain(changes: Changes) {
    const files = new Map(changes.files.map((file) => [fileKey(file), file]));
    for (const [key, read] of this.entries.values()) {
      const file = files.get(key);
      if (
        !file ||
        this.version(changes, file) !== this.versions.get(key) ||
        !matchesGitBase(changes, readTarget(read))
      ) {
        this.entries.delete(key);
        this.versions.delete(key);
      }
    }
    return this.values();
  }
  values() {
    return Object.fromEntries(
      this.entries
        .values()
        .flatMap(([key, read]) =>
          read.state === "ready" ? [[key, read.diff]] : [],
        ),
    );
  }
  clear() {
    this.entries.clear();
    this.versions.clear();
  }
  remove(file: Pick<ChangedFile, "side" | "path">, snapshotId?: string) {
    const key = fileKey(file);
    const read = this.entries.get(key);
    if (
      !snapshotId ||
      (read?.state === "ready" && read.diff.id === snapshotId)
    ) {
      this.entries.delete(key);
      this.versions.delete(key);
    }
  }
}
