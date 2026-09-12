import { invoke } from "@tauri-apps/api/core";
import type { ProofError } from "./types";

export const isDesktop = "__TAURI_INTERNALS__" in window;
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
