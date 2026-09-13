import type { DataSession, ProofError } from "./types";

const markerPrefix = "proof:data-wipe:";
const epochPrefix = "proof:data-session:";
export function readClientDataEpoch(storage: Storage = localStorage): number {
  let epoch = 0;
  for (const key of Object.keys(storage))
    if (key.startsWith(epochPrefix)) {
      const value = Number(key.slice(epochPrefix.length));
      if (Number.isSafeInteger(value) && value >= 0)
        epoch = Math.max(epoch, value);
    }
  return epoch;
}
export function readClientWipeEpoch(storage: Storage = localStorage): number {
  const legacy = Number(storage.getItem("proof:data-wipe-epoch") ?? 0);
  let epoch = Number.isSafeInteger(legacy) && legacy >= 0 ? legacy : 0;
  for (const key of Object.keys(storage))
    if (key.startsWith(markerPrefix)) {
      const value = Number(key.slice(markerPrefix.length));
      if (Number.isSafeInteger(value) && value >= 0)
        epoch = Math.max(epoch, value);
    }
  return epoch;
}
export function draftStorageKey(
  wipeEpoch: number,
  workspaceId: string,
  epoch = wipeEpoch,
) {
  return `proof:draft:v${wipeEpoch}:e${epoch}:${workspaceId}`;
}
export function fileViewStorageKey(wipeEpoch: number, epoch = wipeEpoch) {
  return `proof:file-view:v${wipeEpoch}:e${epoch}`;
}
function draftParts(key: string) {
  const match = /^proof:draft:v(\d+):(?:e(\d+):)?(.+)$/.exec(key);
  return match
    ? {
        wipe: Number(match[1]),
        epoch: Number(match[2] ?? match[1]),
        id: match[3],
      }
    : null;
}
function viewParts(key: string) {
  const match = /^proof:file-view:v(\d+)(?::e(\d+))?$/.exec(key);
  return match
    ? { wipe: Number(match[1]), epoch: Number(match[2] ?? match[1]) }
    : null;
}
function outdatedSession(): ProofError {
  return {
    code: "DATA_SESSION_OUTDATED",
    message: "另一窗口已更新本地记录，请刷新后重试。",
    detail: "Shared client data is newer than this response",
  };
}
function checkSession(session: DataSession, storage: Storage) {
  if (
    readClientWipeEpoch(storage) > session.wipeEpoch ||
    readClientDataEpoch(storage) > session.epoch
  )
    throw outdatedSession();
}

// Keys carry the wipe generation. An older renderer can remove only older
// generations, even when another window advances while this loop is running.
// Immutable acknowledgement keys cannot roll a shared counter backwards.
export function reconcileClientStorage(
  session: DataSession,
  storage: Storage = localStorage,
) {
  checkSession(session, storage);
  // Publish the barrier before taking the deletion snapshot. Otherwise a late
  // writer could miss both the snapshot and the old end-of-cleanup marker.
  storage.setItem(`${markerPrefix}${session.wipeEpoch}`, "1");
  storage.setItem(`${epochPrefix}${session.epoch}`, "1");
  const deleted = new Set(session.deletedWorkspaceIds);
  for (const key of Object.keys(storage)) {
    const draft = draftParts(key);
    const view = viewParts(key);
    if (draft) {
      const generation = draft.wipe;
      if (
        generation < session.wipeEpoch ||
        (generation <= session.wipeEpoch &&
          draft.epoch <= session.epoch &&
          deleted.has(draft.id))
      )
        storage.removeItem(key);
    } else if (view) {
      if (view.wipe < session.wipeEpoch) storage.removeItem(key);
    } else if (key.startsWith("proof:draft:")) {
      if (
        session.wipeEpoch > 0 ||
        deleted.has(key.slice("proof:draft:".length))
      )
        storage.removeItem(key);
    } else if (key === "proof:file-view" && session.wipeEpoch > 0)
      storage.removeItem(key);
  }
  for (const key of Object.keys(storage))
    if (key.startsWith(markerPrefix)) {
      const value = Number(key.slice(markerPrefix.length));
      if (Number.isSafeInteger(value) && value < session.wipeEpoch)
        storage.removeItem(key);
    }
  for (const key of Object.keys(storage))
    if (key.startsWith(epochPrefix)) {
      const value = Number(key.slice(epochPrefix.length));
      if (Number.isSafeInteger(value) && value < session.epoch)
        storage.removeItem(key);
    }
  checkSession(session, storage);
}

// Every write is isolated by the complete data epoch, so rolling back a late
// write cannot erase a peer's newer draft, including for an unaffected repo.
export function createClientStorage(
  getSession: () => DataSession,
  storage: Storage = localStorage,
) {
  const current = () => {
    const session = getSession();
    checkSession(session, storage);
    return session;
  };
  const stillCurrent = (session: DataSession) => {
    const next = current();
    if (session.epoch !== next.epoch || session.wipeEpoch !== next.wipeEpoch)
      throw outdatedSession();
  };
  const write = (key: string, value: string, session: DataSession) => {
    storage.setItem(key, value);
    try {
      stillCurrent(session);
    } catch (error) {
      // Only this older epoch's slot is removed. New epochs use distinct keys.
      storage.removeItem(key);
      throw error;
    }
  };
  const read = (id?: string) => {
    const session = current();
    let selected: string | undefined,
      newest = -1;
    for (const key of Object.keys(storage)) {
      const parts = id === undefined ? viewParts(key) : draftParts(key);
      if (
        !parts ||
        parts.wipe !== session.wipeEpoch ||
        parts.epoch > session.epoch ||
        (id !== undefined && (!("id" in parts) || parts.id !== id)) ||
        parts.epoch < newest
      )
        continue;
      newest = parts.epoch;
      selected = key;
    }
    const value = selected
      ? storage.getItem(selected)
      : session.wipeEpoch === 0
        ? storage.getItem(
            id === undefined ? "proof:file-view" : `proof:draft:${id}`,
          )
        : null;
    stillCurrent(session);
    return id !== undefined && session.deletedWorkspaceIds.includes(id)
      ? null
      : value;
  };
  return {
    readDraft(id: string) {
      return read(id) ?? "";
    },
    readFileView() {
      return read();
    },
    writeDraft(id: string, value: string) {
      const session = current();
      if (session.deletedWorkspaceIds.includes(id)) throw outdatedSession();
      write(
        draftStorageKey(session.wipeEpoch, id, session.epoch),
        value,
        session,
      );
    },
    writeFileView(value: string) {
      const session = current();
      write(
        fileViewStorageKey(session.wipeEpoch, session.epoch),
        value,
        session,
      );
    },
    removeDraft(id: string) {
      const session = current();
      for (const key of Object.keys(storage)) {
        const draft = draftParts(key);
        if (
          draft?.id === id &&
          draft.wipe <= session.wipeEpoch &&
          draft.epoch <= session.epoch
        )
          storage.removeItem(key);
      }
      storage.removeItem(`proof:draft:${id}`);
    },
  };
}
