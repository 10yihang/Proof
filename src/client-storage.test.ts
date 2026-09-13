import { describe, expect, it } from "vitest";
import {
  draftStorageKey,
  createClientStorage,
  fileViewStorageKey,
  readClientDataEpoch,
  readClientWipeEpoch,
  reconcileClientStorage,
} from "./client-storage";

// Like browser Storage, data keys are enumerable; methods are not. The hook
// deterministically interleaves a second window inside the first cleanup.
function storageFixture() {
  const storage = {} as Storage;
  let onRemove: ((key: string) => void) | undefined;
  let onWrite: ((key: string) => void) | undefined;
  Object.defineProperties(storage, {
    length: { get: () => Object.keys(storage).length },
    getItem: { value: (key: string) => storage[key] ?? null },
    setItem: {
      value: (key: string, value: string) => {
        const callback = onWrite;
        onWrite = undefined;
        callback?.(key);
        storage[key] = value;
      },
    },
    removeItem: {
      value: (key: string) => {
        delete storage[key];
        const callback = onRemove;
        onRemove = undefined;
        callback?.(key);
      },
    },
    clear: {
      value: () => Object.keys(storage).forEach((key) => delete storage[key]),
    },
    key: { value: (index: number) => Object.keys(storage)[index] ?? null },
  });
  return {
    storage,
    onNextWrite: (callback: (key: string) => void) => {
      onWrite = callback;
    },
    onNextRemoval: (callback: (key: string) => void) => {
      onRemove = callback;
    },
  };
}

describe("client deletion across windows", () => {
  it("blocks a write that starts after the cleaner captured its key list", () => {
    const { storage, onNextRemoval } = storageFixture();
    const client = createClientStorage(
      () => ({ epoch: 0, wipeEpoch: 0, deletedWorkspaceIds: [] }),
      storage,
    );
    storage.setItem(draftStorageKey(0, "first"), "old content");
    onNextRemoval(() => {
      expect(() =>
        client.writeDraft("not-in-cleanup-snapshot", "late private content"),
      ).toThrowError(
        expect.objectContaining({ code: "DATA_SESSION_OUTDATED" }),
      );
    });
    reconcileClientStorage(
      { epoch: 1, wipeEpoch: 1, deletedWorkspaceIds: [] },
      storage,
    );
    expect(Object.values(storage)).not.toContain("late private content");
  });
  it("keeps unaffected drafts across a repository deletion and resets them at a global wipe", () => {
    const { storage } = storageFixture();
    let session = {
      epoch: 0,
      wipeEpoch: 0,
      deletedWorkspaceIds: [] as string[],
    };
    const client = createClientStorage(() => session, storage);
    client.writeDraft("survivor", "unfinished work");
    client.writeFileView("list");
    session = { epoch: 1, wipeEpoch: 0, deletedWorkspaceIds: ["deleted"] };
    reconcileClientStorage(session, storage);
    expect(client.readDraft("survivor")).toBe("unfinished work");
    expect(client.readFileView()).toBe("list");
    client.writeDraft("survivor", "continued work");
    expect(client.readDraft("survivor")).toBe("continued work");
    session = { epoch: 2, wipeEpoch: 2, deletedWorkspaceIds: [] };
    reconcileClientStorage(session, storage);
    expect(client.readDraft("survivor")).toBe("");
    expect(client.readFileView()).toBeNull();
    expect(Object.values(storage)).not.toContain("unfinished work");
    expect(Object.values(storage)).not.toContain("continued work");
  });
  it("revokes a draft write that reaches disk after a peer finished deleting all data", () => {
    const { storage, onNextWrite } = storageFixture();
    const client = createClientStorage(
      () => ({ epoch: 0, wipeEpoch: 0, deletedWorkspaceIds: [] }),
      storage,
    );
    onNextWrite(() =>
      reconcileClientStorage(
        { epoch: 1, wipeEpoch: 1, deletedWorkspaceIds: [] },
        storage,
      ),
    );
    expect(() =>
      client.writeDraft("deleted", "old private draft"),
    ).toThrowError(expect.objectContaining({ code: "DATA_SESSION_OUTDATED" }));
    expect(Object.values(storage)).not.toContain("old private draft");
    expect(readClientWipeEpoch(storage)).toBe(1);
  });

  it("revokes only the old write and preserves a peer's new work after a repository deletion", () => {
    const { storage, onNextWrite } = storageFixture();
    const old = createClientStorage(
      () => ({ epoch: 0, wipeEpoch: 0, deletedWorkspaceIds: [] }),
      storage,
    );
    const session = {
      epoch: 1,
      wipeEpoch: 0,
      deletedWorkspaceIds: ["deleted"],
    };
    const peer = createClientStorage(() => session, storage);
    onNextWrite(() => {
      reconcileClientStorage(session, storage);
      peer.writeDraft("unaffected", "new work from peer");
    });
    expect(() => old.writeDraft("unaffected", "stale old work")).toThrowError(
      expect.objectContaining({ code: "DATA_SESSION_OUTDATED" }),
    );
    expect(peer.readDraft("unaffected")).toBe("new work from peer");
    expect(Object.values(storage)).not.toContain("stale old work");
  });
  it("preserves newer drafts and view choices when a peer advances during cleanup", () => {
    const { storage, onNextRemoval } = storageFixture();
    storage.setItem(draftStorageKey(0, "old"), "private old draft");
    onNextRemoval(() => {
      reconcileClientStorage(
        { epoch: 2, wipeEpoch: 2, deletedWorkspaceIds: [] },
        storage,
      );
      storage.setItem(draftStorageKey(2, "new"), "new user work");
      storage.setItem(fileViewStorageKey(2), "list");
    });
    expect(() =>
      reconcileClientStorage(
        { epoch: 1, wipeEpoch: 1, deletedWorkspaceIds: [] },
        storage,
      ),
    ).toThrowError(expect.objectContaining({ code: "DATA_SESSION_OUTDATED" }));
    expect(storage.getItem(draftStorageKey(0, "old"))).toBeNull();
    expect(storage.getItem(draftStorageKey(2, "new"))).toBe("new user work");
    expect(storage.getItem(fileViewStorageKey(2))).toBe("list");
    expect(readClientWipeEpoch(storage)).toBe(2);
    expect(readClientDataEpoch(storage)).toBe(2);
  });

  it("rejects a delayed session before touching data acknowledged by a peer", () => {
    const { storage } = storageFixture();
    reconcileClientStorage(
      { epoch: 4, wipeEpoch: 2, deletedWorkspaceIds: [] },
      storage,
    );
    storage.setItem(draftStorageKey(2, "fresh"), "keep");
    expect(() =>
      reconcileClientStorage(
        { epoch: 3, wipeEpoch: 2, deletedWorkspaceIds: ["fresh"] },
        storage,
      ),
    ).toThrowError(expect.objectContaining({ code: "DATA_SESSION_OUTDATED" }));
    expect(storage.getItem(draftStorageKey(2, "fresh"))).toBe("keep");
    expect(readClientDataEpoch(storage)).toBe(4);
  });

  it("clears only the deleted workspace and old wipe generations", () => {
    const { storage } = storageFixture();
    for (const [key, value] of Object.entries({
      [draftStorageKey(0, "old")]: "old wipe",
      [draftStorageKey(2, "deleted")]: "deleted repo",
      [draftStorageKey(2, "clone")]: "clone work",
      [draftStorageKey(3, "deleted")]: "future work",
      [fileViewStorageKey(0)]: "list",
      [fileViewStorageKey(2)]: "tree",
      "unrelated-key": "keep",
    }))
      storage.setItem(key, value);
    reconcileClientStorage(
      { epoch: 3, wipeEpoch: 2, deletedWorkspaceIds: ["deleted"] },
      storage,
    );
    expect(storage.getItem(draftStorageKey(0, "old"))).toBeNull();
    expect(storage.getItem(draftStorageKey(2, "deleted"))).toBeNull();
    expect(storage.getItem(draftStorageKey(2, "clone"))).toBe("clone work");
    expect(storage.getItem(draftStorageKey(3, "deleted"))).toBe("future work");
    expect(storage.getItem(fileViewStorageKey(0))).toBeNull();
    expect(storage.getItem(fileViewStorageKey(2))).toBe("tree");
    expect(storage.getItem("unrelated-key")).toBe("keep");
  });

  it("migrates legacy cleanup markers without clearing unrelated settings", () => {
    const { storage } = storageFixture();
    storage.setItem("proof:draft:deleted", "old draft");
    storage.setItem("proof:draft:clone", "keep before wipe");
    storage.setItem("proof:file-view", "list");
    storage.setItem("unrelated-key", "keep");
    reconcileClientStorage(
      { epoch: 1, wipeEpoch: 0, deletedWorkspaceIds: ["deleted"] },
      storage,
    );
    expect(storage.getItem("proof:draft:deleted")).toBeNull();
    expect(storage.getItem("proof:draft:clone")).toBe("keep before wipe");
    expect(storage.getItem("proof:file-view")).toBe("list");
    reconcileClientStorage(
      { epoch: 2, wipeEpoch: 2, deletedWorkspaceIds: [] },
      storage,
    );
    expect(storage.getItem("proof:draft:clone")).toBeNull();
    expect(storage.getItem("proof:file-view")).toBeNull();
    storage.setItem("proof:data-wipe-epoch", "3");
    expect(() =>
      reconcileClientStorage(
        { epoch: 2, wipeEpoch: 2, deletedWorkspaceIds: [] },
        storage,
      ),
    ).toThrowError(expect.objectContaining({ code: "DATA_SESSION_OUTDATED" }));
    expect(readClientWipeEpoch(storage)).toBe(3);
    expect(storage.getItem("unrelated-key")).toBe("keep");
  });
});
