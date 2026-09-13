import { fileKey } from "./types";
import type { ChangedFile, Changes, FileDiff } from "./types";

// A small display cache; write commands always revalidate the native snapshot.
// Keep fewer entries than the core's snapshot store, leaving room for writes
// and expanded context requests. A repository refresh invalidates by file.
export class DiffCache {
  private entries = new Map<string, { version: string; diff: FileDiff }>();
  private pending = new Map<string, Promise<FileDiff>>();
  version(changes: Changes, file: Pick<ChangedFile, "side" | "path">) {
    return `${changes.workspace.id}:${changes.fileVersions?.[fileKey(file)] ?? changes.token}`;
  }
  get(changes: Changes, file: ChangedFile) {
    const key = fileKey(file),
      entry = this.entries.get(key);
    if (!entry || entry.version !== this.version(changes, file)) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.diff;
  }
  put(
    changes: Changes,
    file: Pick<ChangedFile, "side" | "path">,
    diff: FileDiff,
  ) {
    const key = fileKey(file);
    this.entries.delete(key);
    this.entries.set(key, { version: this.version(changes, file), diff });
    while (this.entries.size > 24)
      this.entries.delete(this.entries.keys().next().value!);
  }
  read(changes: Changes, file: ChangedFile, fetch: () => Promise<FileDiff>) {
    const key = `${this.version(changes, file)}:${fileKey(file)}`;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = fetch().finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }
  retain(changes: Changes) {
    const files = new Map(changes.files.map((file) => [fileKey(file), file]));
    for (const [key, entry] of this.entries) {
      const file = files.get(key);
      if (!file || this.version(changes, file) !== entry.version)
        this.entries.delete(key);
    }
    return this.values();
  }
  values() {
    return Object.fromEntries(
      [...this.entries].map(([key, entry]) => [key, entry.diff]),
    );
  }
  clear() {
    this.entries.clear();
  }
  remove(file: Pick<ChangedFile, "side" | "path">, snapshotId?: string) {
    const key = fileKey(file);
    if (!snapshotId || this.entries.get(key)?.diff.id === snapshotId)
      this.entries.delete(key);
  }
}
