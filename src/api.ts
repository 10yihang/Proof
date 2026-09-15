import type { AiActivity } from "./ai-progress";
import { t } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { useEffect, useMemo } from "react";
import { LatestReadRequest, readCancelled } from "./read-request";
import {
  createClientStorage,
  readClientWipeEpoch,
  readClientDataEpoch,
  reconcileClientStorage,
} from "./client-storage";
import type { DataDeletionResult, DataSession, ProofError } from "./types";

export const isDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
// This report contains only public application information and remains available
// when local storage cannot initialize a data session.
export function applicationDiagnostic<T>(
  command: "prepare" | "validate" | "cancel" | "export",
  args: Record<string, unknown> = {},
) {
  return invoke<T>("application_diagnostic", { command, args });
}
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
    message: t("本地记录已更新，旧动作已取消。"),
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
      message: t("本地记录状态无法读取，请重新打开应用。"),
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
      ? t("记录已删除，本窗口的缓存清理尚未完成。请重启后重试。")
      : pending
        ? t("记录已删除，磁盘副本清理尚未完成。请在本地数据中重试清理。")
        : changedNotice
          ? changedNotice
          : deletion
            ? t("Proof 记录已删除。项目文件和 Git 历史保留。")
            : t("本地记录已在另一窗口更新，已重新载入。");
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
      message: t("本窗口的缓存清理尚未完成，请重新打开应用。"),
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
      message: t("请在 Proof 桌面应用中打开真实仓库。"),
      detail: t("浏览器仅提供明确标注的界面演示，不执行本地 Git。"),
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
      void emit("proof:data-invalidated", {
        epoch: deletion.session.epoch,
      }).catch(() => {});
    } else if (command === "clear_observer_data") {
      sessionPromise = loadDataSession(
        t("观察已暂停，记录已清理。磁盘清理状态可在下方查看。"),
      ).catch((error) => {
        sessionPromise = undefined;
        throw error;
      });
      await sessionPromise;
      if (liveSession)
        void emit("proof:data-invalidated", { epoch: liveSession.epoch }).catch(
          () => {},
        );
    } else if (session.epoch !== liveSession?.epoch) {
      throw {
        code: "DATA_EPOCH_CHANGED",
        message: t("本地记录已更新，旧请求已取消。"),
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
// Other Diff windows refresh through the authoritative data-session endpoint.
export async function refreshDataSession(epoch: number) {
  if (!isDesktop || (liveSession && liveSession.epoch >= epoch)) return;
  sessionPromise = loadDataSession().catch((error) => {
    sessionPromise = undefined;
    throw error;
  });
  await sessionPromise;
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
type ReadCommand =
  | "run_ai_task"
  | "probe_ai_agent"
  | "read_file_diff"
  | "read_compare_file"
  | "compare_commit"
  | "compare_refs"
  | "diff_context"
  | "compare_context";
async function requestRead<T>(
  command: ReadCommand,
  args: Record<string, unknown>,
  signal: AbortSignal,
  generation: number,
  onProgress?: (event: AiActivity) => void,
) {
  if (signal.aborted) throw readCancelled();
  if (generation !== rendererGeneration) throw staleDataRequest();
  const ticket = await invoke<string>("prepare_read_request");
  let stopProgress: (() => void) | undefined;
  let cancelFailure: unknown;
  const cancel = () => {
    void invoke("cancel_read_request", { ticket }).catch((error) => {
      cancelFailure = error;
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (onProgress) {
      stopProgress = await listen<{ ticket: string; event: AiActivity }>(
        "proof://ai-progress",
        ({ payload }) => {
          if (
            payload.ticket === ticket &&
            !signal.aborted &&
            generation === rendererGeneration
          )
            onProgress(payload.event);
        },
      );
    }
    if (signal.aborted) {
      cancel();
      throw readCancelled();
    }
    const value = await request<T>(
      command,
      { ...args, _readTicket: ticket },
      generation,
    );
    if (cancelFailure) throw cancelFailure;
    if (signal.aborted) throw readCancelled();
    return value;
  } finally {
    stopProgress?.();
    signal.removeEventListener("abort", cancel);
    // Also releases a ticket when the data-session gate rejected before dispatch.
    await invoke("cancel_read_request", { ticket }).catch(() => {});
  }
}
export function useReadRequest() {
  const reader = useMemo(() => {
    const generation = rendererGeneration;
    const queue = new LatestReadRequest();
    return {
      read: <T>(
        command: ReadCommand,
        args: Record<string, unknown>,
        onProgress?: (event: AiActivity) => void,
      ) =>
        queue.run((signal) =>
          requestRead<T>(command, args, signal, generation, onProgress),
        ),
      cancel: () => queue.cancel(),
    };
  }, []);
  useEffect(() => () => reader.cancel(), [reader]);
  return reader;
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
    message: t("本次操作未完成，请查看详情后重试。"),
    detail: String(error),
  };
}

// New renderer instances must supersede a watcher left by a previous reload.
let watchGeneration = Date.now() * 1000;
export function watchWorkspace(
  workspaceId: string,
  onChange: () => void,
  onError: (error: unknown) => void,
  onReady: (ready: boolean) => void,
) {
  let closed = false;
  let failed = false;
  const generation = ++watchGeneration;
  const stops: (() => void)[] = [];
  const fail = (error: unknown) => {
    if (closed || failed) return;
    failed = true;
    onReady(false);
    onError(error);
  };
  void Promise.allSettled([
    listen<string>("workspace-invalidated", (event) => {
      if (!closed && event.payload === workspaceId) onChange();
    }),
    listen<{ workspaceId: string; generation: number }>(
      "workspace-watch-failed",
      (event) => {
        if (
          event.payload?.workspaceId === workspaceId &&
          event.payload.generation === generation
        )
          fail({
            code: "WATCH_UNAVAILABLE",
            message: t("文件监听不可用，已改用定时刷新。"),
            detail: "Native file watcher failed",
          });
      },
    ),
  ])
    .then(async (results) => {
      for (const result of results) {
        if (result.status === "fulfilled") {
          if (closed) result.value();
          else stops.push(result.value);
        } else fail(result.reason);
      }
      if (closed || failed) {
        for (const stop of stops.splice(0)) stop();
        return;
      }
      const ready = await invoke<boolean>("watch_workspace", {
        workspaceId,
        generation,
      });
      // A native failure can arrive before the registration reply.
      if (!closed && !failed) onReady(ready);
    })
    .catch((error) => {
      fail(error);
    });
  return () => {
    closed = true;
    for (const stop of stops.splice(0)) stop();
    void invoke("watch_workspace", {
      workspaceId: null,
      generation: ++watchGeneration,
    }).catch(() => {});
  };
}
