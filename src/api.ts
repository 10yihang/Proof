import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMemo } from "react";
import {
  createClientStorage,
  readClientWipeEpoch,
  readClientDataEpoch,
  reconcileClientStorage,
} from "./client-storage";
import type { DataDeletionResult, DataSession, ProofError } from "./types";

export const isDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export interface DataSessionChange {
  session: DataSession;
  previousEpoch: number;
  notice: string;
}
let liveSession: DataSession | undefined;
let sessionPromise: Promise<DataSession> | undefined;
let rendererGeneration = 0;
function staleDataRequest(): ProofError {
  return {
    code: "DATA_EPOCH_CHANGED",
    message: "本地记录已更新，旧动作已取消。",
    detail: "Stale renderer generation",
  };
}
function acceptDataSession(
  session: DataSession,
  deletion?: DataDeletionResult,
  changedNotice?: string,
) {
  if (
    !Number.isSafeInteger(session.epoch) ||
    session.epoch < 0 ||
    !Number.isSafeInteger(session.wipeEpoch) ||
    session.wipeEpoch < 0 ||
    session.wipeEpoch > session.epoch ||
    !Array.isArray(session.deletedWorkspaceIds)
  )
    throw {
      code: "DATA_SESSION_INVALID",
      message: "本地记录状态无法读取，请重新打开应用。",
      detail: "Invalid data session",
    };
  if (liveSession && session.epoch < liveSession.epoch) return false;
  if (liveSession && session.wipeEpoch < liveSession.wipeEpoch)
    throw staleDataRequest();
  const previous = liveSession?.epoch;
  let cleanupFailed = false;
  try {
    reconcileClientStorage(session);
  } catch (error) {
    if (asError(error).code === "DATA_SESSION_OUTDATED") throw error;
    cleanupFailed = true;
  }
  liveSession = session;
  sessionPromise = Promise.resolve(session);
  if (previous !== undefined && previous !== session.epoch) {
    ++rendererGeneration;
    const pending =
      deletion &&
      (!deletion.cleanup.walCheckpointComplete ||
        deletion.cleanup.pendingContentDeletions > 0 ||
        deletion.cleanupError);
    const notice = cleanupFailed
      ? "记录已删除，本窗口的缓存清理尚未完成。请重启后重试。"
      : pending
        ? "记录已删除，磁盘副本清理尚未完成。请在本地数据中重试清理。"
        : changedNotice
          ? changedNotice
          : deletion
            ? "Proof 记录已删除。项目文件和 Git 历史保留。"
            : "本地记录已在另一窗口更新，已重新载入。";
    window.dispatchEvent(
      new CustomEvent<DataSessionChange>("proof:data-session-changed", {
        detail: { session, previousEpoch: previous, notice },
      }),
    );
  }
  if (cleanupFailed) {
    sessionPromise = undefined;
    throw {
      code: "DATA_CLIENT_CLEANUP_PENDING",
      message: "本窗口的缓存清理尚未完成，请重新打开应用。",
      detail: "Client storage is unavailable; cached drafts were not restored",
    };
  }
  return true;
}
async function loadDataSession(notice?: string): Promise<DataSession> {
  const value = await invoke<DataSession>("proof_command", {
    command: "data_session",
    args: {},
  });
  acceptDataSession(value, undefined, notice);
  return liveSession!;
}
function dataSession() {
  return (sessionPromise ??= loadDataSession().catch((error) => {
    sessionPromise = undefined;
    throw error;
  }));
}
export async function request<T>(
  command: string,
  args: Record<string, unknown> = {},
  generation: number = rendererGeneration,
): Promise<T> {
  if (!isDesktop)
    throw {
      code: "DESKTOP_REQUIRED",
      message: "请在 Proof 桌面应用中打开真实仓库。",
      detail: "浏览器仅提供明确标注的界面演示，不执行本地 Git。",
    } satisfies ProofError;
  if (generation !== rendererGeneration) throw staleDataRequest();
  const session = await dataSession();
  if (generation !== rendererGeneration) throw staleDataRequest();
  try {
    const value = await invoke<T>("proof_command", {
      command,
      args: { ...args, _dataEpoch: session.epoch },
    });
    if (command === "delete_local_data") {
      const deletion = value as DataDeletionResult;
      // Install the new epoch before notifying the renderer. Old callbacks and
      // commands can no longer repopulate state or write an old settings draft.
      if (!acceptDataSession(deletion.session, deletion))
        throw staleDataRequest();
    } else if (command === "clear_observer_data") {
      sessionPromise = loadDataSession(
        "观察已暂停，记录已清理。磁盘清理状态可在下方查看。",
      ).catch((error) => {
        sessionPromise = undefined;
        throw error;
      });
      await sessionPromise;
    } else if (session.epoch !== liveSession?.epoch) {
      throw {
        code: "DATA_EPOCH_CHANGED",
        message: "本地记录已更新，旧请求已取消。",
        detail: "Stale response discarded",
      };
    }
    return value;
  } catch (error) {
    if (
      asError(error).code === "DATA_EPOCH_CHANGED" &&
      session.epoch === liveSession?.epoch
    ) {
      sessionPromise = loadDataSession().catch((error) => {
        sessionPromise = undefined;
        throw error;
      });
      await sessionPromise;
    }
    throw error;
  }
}
// Each mounted component owns a request capability. Queued callbacks from an
// old renderer can never borrow a newer data session after deletion.
export function useRequest() {
  return useMemo(() => {
    const generation = rendererGeneration;
    return <T>(command: string, args: Record<string, unknown> = {}) =>
      request<T>(command, args, generation);
  }, []);
}
export function useClientStorage() {
  return useMemo(() => {
    const generation = rendererGeneration;
    return createClientStorage(() => {
      if (generation !== rendererGeneration) throw staleDataRequest();
      return (
        liveSession ?? {
          epoch: isDesktop ? 0 : readClientDataEpoch(),
          wipeEpoch: isDesktop ? 0 : readClientWipeEpoch(),
          deletedWorkspaceIds: [],
        }
      );
    });
  }, []);
}
export function asError(error: unknown): ProofError {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error
  )
    return error as ProofError;
  return {
    code: "UNEXPECTED_ERROR",
    message: "本次操作未完成，请查看详情后重试。",
    detail: String(error),
  };
}

// New renderer instances must supersede a watcher left by a previous reload.
let watchGeneration = Date.now() * 1000;
export function watchWorkspace(
  workspaceId: string,
  onChange: () => void,
  onError: (error: unknown) => void,
) {
  let closed = false;
  const generation = ++watchGeneration;
  let stop: (() => void) | undefined;
  void listen<string>("workspace-invalidated", (event) => {
    if (!closed && event.payload === workspaceId) onChange();
  })
    .then(async (unlisten) => {
      if (closed) {
        unlisten();
        return;
      }
      stop = unlisten;
      await invoke("watch_workspace", { workspaceId, generation });
    })
    .catch((error) => {
      if (!closed) onError(error);
    });
  return () => {
    closed = true;
    stop?.();
    void invoke("watch_workspace", {
      workspaceId: null,
      generation: ++watchGeneration,
    }).catch(() => {});
  };
}
