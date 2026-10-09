import type { ReadingRow } from "./diff-reading";

/** Conservative retained-data estimate; editor heap usage is not measured. */
export function idleReaderBytes(rows: readonly ReadingRow[]) {
  return rows.reduce(
    (bytes, row) =>
      bytes +
      96 +
      (row.kind === "line"
        ? 2 *
          ((row.left?.content.length ?? 0) +
            (row.right?.content.length ?? 0) +
            2)
        : 0),
    0,
  );
}

/** Keep at most two small offscreen readers warm, including their text models. */
export class IdleReaders {
  private entries = new Map<object, { bytes: number; evict: () => void }>();
  constructor(
    private readonly maxReaders = 2,
    private readonly maxBytes = 2 * 1024 * 1024,
    readonly maxReaderBytes = 1024 * 1024,
  ) {}

  retain(key: object, bytes: number, evict: () => void) {
    this.release(key);
    if (bytes > this.maxReaderBytes || bytes > this.maxBytes) {
      evict();
      return;
    }
    this.entries.set(key, { bytes, evict });
    while (
      this.entries.size > this.maxReaders ||
      [...this.entries.values()].reduce((sum, value) => sum + value.bytes, 0) >
        this.maxBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      const value = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      value.evict();
    }
  }

  release(key: object) {
    this.entries.delete(key);
  }
}

export const idleReaders = new IdleReaders();
