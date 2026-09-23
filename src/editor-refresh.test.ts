import { describe, expect, it, vi } from "vitest";
import { EditorRefreshLane, LatestEditorRead } from "./editor-refresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("Files refresh lanes", () => {
  it("retains hidden invalidations and combines them into one visible refresh", async () => {
    const refresh = vi.fn(async () => {});
    const lane = new EditorRefreshLane(refresh);
    for (let i = 0; i < 100; i++) lane.invalidate();
    await tick();
    expect(refresh).not.toHaveBeenCalled();
    lane.setEnabled(true);
    await tick();
    expect(refresh).toHaveBeenCalledTimes(1);
    lane.setEnabled(false);
    lane.invalidate();
    lane.invalidate();
    await tick();
    expect(refresh).toHaveBeenCalledTimes(1);
    lane.setEnabled(true);
    await tick();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("bounds an event storm to one running and one trailing read", async () => {
    const first = deferred<void>();
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const lane = new EditorRefreshLane(refresh);
    lane.setEnabled(true);
    lane.invalidate();
    await tick();
    for (let i = 0; i < 100; i++) lane.invalidate();
    await tick();
    expect(refresh).toHaveBeenCalledTimes(1);
    first.resolve();
    await tick();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("pauses a trailing read when hidden and resumes after reactivation", async () => {
    const first = deferred<void>();
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const lane = new EditorRefreshLane(refresh);
    lane.setEnabled(true);
    lane.invalidate();
    await tick();
    lane.invalidate();
    lane.setEnabled(false);
    first.resolve();
    await tick();
    expect(refresh).toHaveBeenCalledTimes(1);
    lane.setEnabled(true);
    await tick();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("allows the next notification after failure and disposes queued refreshes", async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValue(undefined);
    const lane = new EditorRefreshLane(refresh);
    lane.setEnabled(true);
    await lane.flush();
    await lane.flush();
    expect(refresh).toHaveBeenCalledTimes(2);
    lane.invalidate();
    lane.dispose();
    await tick();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("serialized document reads", () => {
  it("keeps only the newest queued navigation without overlapping native reads", async () => {
    const first = deferred<string>();
    const reader = new LatestEditorRead<string>();
    const a = reader.read(() => first.promise);
    const skipped = vi.fn(async () => "b");
    const b = reader.read(skipped);
    const last = vi.fn(async () => "c");
    const c = reader.read(last);
    expect(await b).toBeUndefined();
    expect(last).not.toHaveBeenCalled();
    first.resolve("a");
    expect(await a).toBe("a");
    expect(await c).toBe("c");
    expect(skipped).not.toHaveBeenCalled();
  });

  it("does not start a queued read while the window is hidden", async () => {
    const first = deferred<string>();
    const reader = new LatestEditorRead<string>();
    const a = reader.read(() => first.promise);
    await tick();
    const next = vi.fn(async () => "visible");
    const b = reader.read(next);
    reader.setEnabled(false);
    first.resolve("first");
    expect(await a).toBe("first");
    await tick();
    expect(next).not.toHaveBeenCalled();
    reader.setEnabled(true);
    expect(await b).toBe("visible");
  });

  it("drops in-flight and queued results after the workspace is disposed", async () => {
    const first = deferred<string>();
    const reader = new LatestEditorRead<string>();
    const a = reader.read(() => first.promise);
    await tick();
    const queued = vi.fn(async () => "b");
    const b = reader.read(queued);
    reader.dispose();
    first.resolve("old workspace");
    expect(await a).toBeUndefined();
    expect(await b).toBeUndefined();
    expect(queued).not.toHaveBeenCalled();
    expect(await reader.read(queued)).toBeUndefined();
  });

  it("continues the next read after a rejected request", async () => {
    const first = deferred<string>();
    const reader = new LatestEditorRead<string>();
    const a = reader.read(() => first.promise);
    const rejected = expect(a).rejects.toThrow("unavailable");
    const b = reader.read(async () => "current");
    first.reject(new Error("unavailable"));
    await rejected;
    expect(await b).toBe("current");
  });
});
