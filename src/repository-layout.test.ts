import { describe, expect, it } from "vitest";
import {
  defaultRepositoryLayout as defaults,
  fitPanels,
  RepositoryLayouts,
  type LayoutScope,
} from "./repository-layout";
import type { RepositoryLayout } from "./types";

const scope = (key: string, id = key): LayoutScope => ({
  key,
  workspaceId: id,
  demo: false,
});
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("repository layouts", () => {
  it("fills missing card dimensions when reading a legacy layout without writing defaults", async () => {
    const writes: RepositoryLayout[] = [];
    const legacy: RepositoryLayout = {
      sidebarWidth: 350,
      contextWidth: 440,
      sidebarOpen: false,
      contextOpen: true,
    };
    const store = new RepositoryLayouts({
      read: async () => legacy,
      write: async (_, value) => {
        writes.push(value);
      },
    });
    await store.load(scope("a"));
    expect(store.snapshot("a").value).toEqual({ ...defaults, ...legacy });
    expect(writes).toEqual([]);
    await store.update(scope("a"), { filesSidebarWidth: 310 });
    expect(writes).toEqual([
      { ...defaults, ...legacy, filesSidebarWidth: 310 },
    ]);
  });
  it("merges queued page dimensions and rolls back only a failed final update", async () => {
    const gate = deferred();
    const writes: RepositoryLayout[] = [];
    const saved = { ...defaults, historySidebarWidth: 306 };
    const store = new RepositoryLayouts({
      read: async () => saved,
      write: async (_, value) => {
        writes.push(value);
        if (writes.length === 1) await gate.promise;
        if (writes.length === 3) throw new Error("disk full");
      },
    });
    await store.load(scope("a"));
    const files = store.update(scope("a"), { filesSidebarWidth: 360 });
    const history = store.update(scope("a", "linked-a"), {
      historyDetailsHeight: 240,
    });
    const commit = store.update(scope("a"), { commitDetailsHeight: 420 });
    expect(store.snapshot("a").value).toEqual({
      ...saved,
      filesSidebarWidth: 360,
      historyDetailsHeight: 240,
      commitDetailsHeight: 420,
    });
    gate.resolve();
    await Promise.all([files, history, commit]);
    expect(writes[1]).toEqual({
      ...saved,
      filesSidebarWidth: 360,
      historyDetailsHeight: 240,
    });
    expect(writes[2]).toEqual({ ...writes[1], commitDetailsHeight: 420 });
    expect(store.snapshot("a").value).toEqual(writes[1]);
    expect(store.snapshot("a").error).not.toBeNull();
    expect(store.snapshot("a").saving).toBe(false);
  });
  it("retains saved intent while giving narrow windows usable code space", () => {
    const value = { ...defaults, sidebarWidth: 480, contextWidth: 520 };
    for (const width of [512, 640, 780, 781, 1024, 1101, 1280, 1440, 1920]) {
      const fit = fitPanels(width, value, width > 780, width > 1100);
      expect(
        width - fit.sidebarWidth - fit.contextWidth,
      ).toBeGreaterThanOrEqual(360);
      expect(fit.sidebarWidth).toBeLessThanOrEqual(value.sidebarWidth);
      expect(fit.contextWidth).toBeLessThanOrEqual(value.contextWidth);
    }
    expect(fitPanels(1920, value, true, true)).toEqual({
      sidebarWidth: 480,
      contextWidth: 520,
    });
    expect(value).toEqual({
      ...defaults,
      sidebarWidth: 480,
      contextWidth: 520,
    });
    expect(fitPanels(1440, defaults, true, true)).toEqual({
      sidebarWidth: 320,
      contextWidth: 300,
    });
  });
  it("does not write defaults before loading and allows a failed read to retry", async () => {
    const gate = deferred();
    const writes: RepositoryLayout[] = [];
    let reads = 0;
    const store = new RepositoryLayouts({
      read: async () => {
        if (reads++ === 0) {
          await gate.promise;
          throw new Error("locked");
        }
        return { ...defaults, contextWidth: 420 };
      },
      write: async (_, value) => {
        writes.push(value);
      },
    });
    const loading = store.load(scope("a"));
    await store.update(scope("a"), { sidebarWidth: 320 });
    expect(writes).toEqual([]);
    gate.resolve();
    await loading;
    expect(store.snapshot("a").ready).toBe(false);
    expect(store.snapshot("a").error).not.toBeNull();
    await store.load(scope("a"));
    await store.update(scope("a"), { sidebarWidth: 320 });
    expect(writes).toEqual([
      { ...defaults, sidebarWidth: 320, contextWidth: 420 },
    ]);
  });
  it("serializes within a repository and isolates late writes from another repository", async () => {
    const gate = deferred();
    const writes: { id: string; value: RepositoryLayout }[] = [];
    const store = new RepositoryLayouts({
      read: async () => defaults,
      write: async (target, value) => {
        writes.push({ id: target.workspaceId, value });
        if (writes.length === 1) await gate.promise;
      },
    });
    await store.load(scope("a"));
    await store.load(scope("b"));
    const a = store.update(scope("a"), { sidebarWidth: 350 });
    const a2 = store.update(scope("a", "linked-a"), { contextWidth: 420 });
    await store.update(scope("b"), { sidebarWidth: 190 });
    expect(writes.map((x) => x.id)).toEqual(["a", "b"]);
    expect(store.snapshot("b").value.sidebarWidth).toBe(190);
    gate.resolve();
    await a;
    await a2;
    expect(writes[2]).toEqual({
      id: "linked-a",
      value: { ...defaults, sidebarWidth: 350, contextWidth: 420 },
    });
    expect(store.snapshot("a").value.contextWidth).toBe(420);
    expect(store.snapshot("b").value.sidebarWidth).toBe(190);
    expect(store.snapshot("a").saving).toBe(false);
  });
  it("does not re-save a failed earlier field with a later change and rolls back a final failure", async () => {
    const writes: RepositoryLayout[] = [];
    let fail = true;
    const store = new RepositoryLayouts({
      read: async () => ({ ...defaults, sidebarWidth: 330 }),
      write: async (_, value) => {
        writes.push(value);
        if (fail) {
          fail = false;
          throw new Error("disk full");
        }
      },
    });
    await store.load(scope("a"));
    const first = store.update(scope("a"), { sidebarWidth: 400 });
    await store.update(scope("a"), { contextWidth: 450 });
    await first;
    expect(writes[1]).toEqual({
      ...defaults,
      sidebarWidth: 330,
      contextWidth: 450,
    });
    expect(store.snapshot("a").value).toEqual(writes[1]);
    expect(store.snapshot("a").error).not.toBeNull();
    fail = true;
    await store.update(scope("a"), { sidebarOpen: false });
    expect(store.snapshot("a").value.sidebarOpen).toBe(true);
    expect(store.snapshot("a").error).not.toBeNull();
    expect(store.snapshot("a").saving).toBe(false);
  });
});
