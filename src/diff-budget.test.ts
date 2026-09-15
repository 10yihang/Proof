import { expect, it } from "vitest";
import { DiffReadBudget, diffReadBytes } from "./diff-budget";
import { demoChanges, demoDiff } from "./demo";
import type { DiffRead } from "./types";

function read(size: number): DiffRead {
  return {
    state: "ready",
    diff: { ...demoDiff(demoChanges.files[0]), patch: "x".repeat(size) },
  };
}

it("evicts by content capacity and keeps the most recently used entry", () => {
  const value = read(10_000);
  const cache = new DiffReadBudget(2 * diffReadBytes(value), 64);
  cache.set("a", value);
  cache.set("b", value);
  cache.get("a");
  cache.set("c", value);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe(value);
  expect(cache.get("c")).toBe(value);
});

it("a large Changes entry replaces the cache, while a history cache declines it", () => {
  const small = read(5_000),
    large = read(80_000);
  const changes = new DiffReadBudget(diffReadBytes(small) * 2, 24, true);
  changes.set("small", small);
  changes.set("large", large);
  expect(changes.values().map(([key]) => key)).toEqual(["large"]);
  changes.set("small", small);
  expect(changes.get("large")).toBeUndefined();
  const history = new DiffReadBudget(diffReadBytes(small) * 2, 64);
  history.set("large", large);
  expect(history.get("large")).toBeUndefined();
});

it("replacement and clearing release the accounted capacity", () => {
  const value = read(10_000);
  const cache = new DiffReadBudget(diffReadBytes(value), 64);
  cache.set("a", value);
  cache.set("a", value);
  expect(cache.get("a")).toBe(value);
  cache.clear();
  cache.set("b", value);
  expect(cache.get("b")).toBe(value);
  expect(cache.values()).toHaveLength(1);
});
