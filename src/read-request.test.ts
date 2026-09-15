import { expect, it } from "vitest";
import { LatestReadRequest } from "./read-request";

it("keeps one active read and only the newest queued selection", async () => {
  const reader = new LatestReadRequest();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: number[] = [];
  let signal!: AbortSignal;
  const first = reader.run(async (current) => {
    signal = current;
    calls.push(0);
    await waiting;
    return 0;
  });
  const firstError = first.catch((error) => error.code);
  const results = Array.from({ length: 50 }, (_, n) =>
    reader
      .run(async () => {
        calls.push(n + 1);
        return n + 1;
      })
      .catch((error) => error.code),
  );
  expect(signal.aborted).toBe(true);
  expect(calls).toEqual([0]);
  release();
  expect(await firstError).toBe("READ_CANCELLED");
  const values = await Promise.all(results);
  expect(calls).toEqual([0, 50]);
  expect(values.slice(0, -1).every((value) => value === "READ_CANCELLED")).toBe(
    true,
  );
  expect(values.at(-1)).toBe(50);
});

it("cancel removes a pending read and later use still works", async () => {
  const reader = new LatestReadRequest();
  let release!: () => void;
  const first = reader
    .run(
      async () =>
        new Promise<number>((resolve) => {
          release = () => resolve(1);
        }),
    )
    .catch((error) => error.code);
  let started = false;
  const pending = reader
    .run(async () => {
      started = true;
      return 2;
    })
    .catch((error) => error.code);
  reader.cancel();
  release();
  expect(await first).toBe("READ_CANCELLED");
  expect(await pending).toBe("READ_CANCELLED");
  expect(started).toBe(false);
  expect(await reader.run(async () => 3)).toBe(3);
});
