import type { DiffRead } from "./types";

// Conservative retained-content estimate. This is not a measurement of V8 RSS.
export function diffReadBytes(read: DiffRead): number {
  if (read.state === "deferred")
    return (
      512 + 2 * (read.summary.path.length + (read.summary.oldPath?.length ?? 0))
    );
  const diff = read.diff;
  return (
    1024 +
    2 * diff.patch.length +
    diff.hunks.reduce(
      (bytes, hunk) =>
        bytes +
        256 +
        2 * hunk.header.length +
        hunk.lines.reduce(
          (total, line) => total + 96 + 2 * line.content.length,
          0,
        ),
      0,
    )
  );
}

export class DiffReadBudget {
  private entries = new Map<string, { value: DiffRead; bytes: number }>();
  private bytes = 0;
  constructor(
    private maxBytes: number,
    private maxEntries: number,
    private keepSingleLarge = false,
  ) {}
  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: DiffRead) {
    this.delete(key);
    const bytes = diffReadBytes(value);
    if (bytes > this.maxBytes && !this.keepSingleLarge) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (
      this.entries.size > this.maxEntries ||
      (this.bytes > this.maxBytes &&
        this.entries.size > (this.keepSingleLarge ? 1 : 0))
    )
      this.delete(this.entries.keys().next().value!);
  }
  delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
  values() {
    return [...this.entries].map(([key, entry]) => [key, entry.value] as const);
  }
}
