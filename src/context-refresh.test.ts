import { afterEach, describe, expect, it, vi } from "vitest";
import { startContextRefresh } from "./context-refresh";

class Visibility extends EventTarget {
  visibilityState = "visible";
  set(value: string) {
    this.visibilityState = value;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}
const settle = () => Promise.resolve().then(() => Promise.resolve());
afterEach(() => vi.useRealTimers());

describe("context refresh lifecycle", () => {
  it("pauses hidden reads, refreshes immediately on return, and cleans up", async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();
    const events = new EventTarget();
    const read = vi.fn(async () => "overview");
    const receive = vi.fn();
    const stop = startContextRefresh({
      workspaceId: "repo",
      read,
      receive,
      onError: vi.fn(),
      visibility,
      events,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect(read).toHaveBeenCalledTimes(2);
    visibility.set("hidden");
    events.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(2);
    visibility.set("visible");
    await settle();
    expect(read).toHaveBeenCalledTimes(3);
    stop();
    visibility.set("visible");
    events.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards hidden and disposed results, including errors, without cancelling newer reads", async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();
    const events = new EventTarget();
    const pending: Array<{
      resolve: (value: string) => void;
      reject: (error: unknown) => void;
    }> = [];
    const receive = vi.fn(),
      onError = vi.fn();
    const stop = startContextRefresh({
      workspaceId: "repo",
      read: () =>
        new Promise<string>((resolve, reject) =>
          pending.push({ resolve, reject }),
        ),
      receive,
      onError,
      visibility,
      events,
    });
    visibility.set("hidden");
    visibility.set("visible");
    expect(pending).toHaveLength(2);
    pending[0].resolve("stale");
    await settle();
    expect(receive).not.toHaveBeenCalled();
    pending[1].resolve("current");
    await settle();
    expect(receive).toHaveBeenCalledExactlyOnceWith("current");
    await vi.advanceTimersByTimeAsync(2500);
    expect(pending).toHaveLength(3);
    stop();
    pending[2].reject(new Error("late"));
    await settle();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces matching Git invalidations and ignores unrelated workspaces", async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();
    const events = new EventTarget();
    let resolve!: (value: string) => void;
    const read = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const stop = startContextRefresh({
      workspaceId: "repo",
      read,
      receive: vi.fn(),
      onError: vi.fn(),
      visibility,
      events,
    });
    const emit = (workspaceId: string) =>
      events.dispatchEvent(
        Object.assign(new Event("proof:git-updated"), {
          detail: { workspaceId },
        }),
      );
    emit("other");
    resolve("first");
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    emit("repo");
    emit("repo");
    emit("repo");
    expect(read).toHaveBeenCalledTimes(2);
    resolve("second");
    await settle();
    expect(read).toHaveBeenCalledTimes(3);
    stop();
    resolve("late");
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });
});
