import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WorkspaceRefresh, type RefreshResult } from "./workspace-refresh";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("healthy watching keeps a slow backstop and failure restores fallback", async () => {
  const read = vi.fn(async () => "done" as const),
    error = vi.fn();
  const refresh = new WorkspaceRefresh(read, error);
  refresh.setWatching(true);
  await vi.advanceTimersByTimeAsync(0);
  read.mockClear();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  expect(read).toHaveBeenCalledTimes(1);
  refresh.setWatching(false);
  await vi.advanceTimersByTimeAsync(0);
  read.mockClear();
  await vi.advanceTimersByTimeAsync(1_201);
  expect(read).toHaveBeenCalledTimes(1);
  refresh.close();
  expect(error).not.toHaveBeenCalled();
});

test("continuous invalidations cannot postpone a read forever", async () => {
  const read = vi.fn(async () => "done" as const);
  const refresh = new WorkspaceRefresh(read, vi.fn());
  refresh.setWatching(true);
  await vi.advanceTimersByTimeAsync(0);
  read.mockClear();
  for (let n = 0; n < 20; n++) {
    refresh.request();
    await vi.advanceTimersByTimeAsync(20);
  }
  expect(read.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(read.mock.calls.length).toBeLessThanOrEqual(4);
  await vi.advanceTimersByTimeAsync(120);
  expect(read).toHaveBeenCalledTimes(4);
  refresh.close();
});

test("an event during a read and a skipped busy read are retried", async () => {
  let release: (result: RefreshResult) => void = () => {};
  const read = vi.fn(
    () =>
      new Promise<RefreshResult>((resolve) => {
        release = resolve;
      }),
  );
  const refresh = new WorkspaceRefresh(read, vi.fn());
  refresh.request(true);
  await vi.advanceTimersByTimeAsync(0);
  refresh.request();
  await vi.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenCalledTimes(1);
  release("done");
  await vi.advanceTimersByTimeAsync(121);
  expect(read).toHaveBeenCalledTimes(2);
  release("busy");
  await vi.advanceTimersByTimeAsync(251);
  expect(read).toHaveBeenCalledTimes(3);
  refresh.close();
  release("busy");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(3);
});

test("hidden views retain dirty state and refresh when visible", async () => {
  const read = vi.fn(async () => "done" as const);
  const refresh = new WorkspaceRefresh(read, vi.fn());
  refresh.setVisible(false);
  refresh.request();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).not.toHaveBeenCalled();
  refresh.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  refresh.close();
});

test("a failed last read is retried without another invalidation", async () => {
  const read = vi
    .fn<() => Promise<RefreshResult>>()
    .mockResolvedValueOnce("failed")
    .mockResolvedValue("done");
  const refresh = new WorkspaceRefresh(read, vi.fn());
  refresh.setWatching(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_199);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2);
  expect(read).toHaveBeenCalledTimes(2);
  refresh.close();
});
