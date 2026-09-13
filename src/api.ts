import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProofError } from "./types";

export const isDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export async function request<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!isDesktop)
    throw {
      code: "DESKTOP_REQUIRED",
      message: "请在 Proof 桌面应用中打开真实仓库。",
      detail: "浏览器仅提供明确标注的界面演示，不执行本地 Git。",
    } satisfies ProofError;
  return invoke<T>("proof_command", { command, args });
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
