import { describe, expect, it, vi } from "vitest";
import { IdleReaders, idleReaderBytes } from "./idle-readers";
import type { ReadingRow } from "./diff-reading";

describe("idle reader budget", () => {
  it("does not treat a large blank-line reader as zero retained data", () => {
    const line: ReadingRow = {
      kind: "line",
      key: "blank",
      hunkId: null,
      left: { kind: "context", content: "", oldLine: 1, newLine: 1 },
    };
    const bytes = idleReaderBytes(Array.from({ length: 12000 }, () => line));
    const budget = new IdleReaders();
    const evict = vi.fn();
    expect(bytes).toBeGreaterThan(budget.maxReaderBytes);
    budget.retain({}, bytes, evict);
    expect(evict).toHaveBeenCalledOnce();
  });
  it("evicts the oldest hidden reader and makes a resumed reader recent", () => {
    const budget = new IdleReaders(2, 100, 100);
    const one = {},
      two = {},
      three = {};
    const evictOne = vi.fn(),
      evictTwo = vi.fn(),
      evictThree = vi.fn();
    budget.retain(one, 20, evictOne);
    budget.retain(two, 20, evictTwo);
    budget.release(one);
    budget.retain(one, 20, evictOne);
    budget.retain(three, 20, evictThree);
    expect(evictTwo).toHaveBeenCalledOnce();
    expect(evictOne).not.toHaveBeenCalled();
    expect(evictThree).not.toHaveBeenCalled();
  });
  it("bounds total bytes and rejects an oversized reader", () => {
    const budget = new IdleReaders(3, 100, 80);
    const one = {},
      two = {},
      oversized = {};
    const evictOne = vi.fn(),
      evictTwo = vi.fn(),
      evictOversized = vi.fn();
    budget.retain(one, 60, evictOne);
    budget.retain(two, 60, evictTwo);
    expect(evictOne).toHaveBeenCalledOnce();
    budget.retain(oversized, 81, evictOversized);
    expect(evictOversized).toHaveBeenCalledOnce();
    expect(evictTwo).not.toHaveBeenCalled();
  });
  it("released readers no longer participate in eviction", () => {
    const budget = new IdleReaders(1, 100, 100);
    const one = {},
      two = {};
    const evictOne = vi.fn();
    budget.retain(one, 90, evictOne);
    budget.release(one);
    budget.retain(two, 90, vi.fn());
    expect(evictOne).not.toHaveBeenCalled();
  });
});
