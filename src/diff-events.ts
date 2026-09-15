import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { isDesktop, refreshDataSession } from "./api";

type DiffEvent =
  | "proof:comparison-reviewed"
  | "proof:groups-updated"
  | "proof:git-updated"
  | "proof:ai-review-updated"
  | "proof:language-updated";
let origin: string;
const sender = () => (origin ??= crypto.randomUUID());
export function publishDiffEvent(name: DiffEvent, detail: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
  if (isDesktop) void emit(name, { origin: sender(), detail }).catch(() => {});
}
/** One native bridge per renderer. Notifications invalidate; Git/SQLite decide state. */
export function useDiffEvents() {
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    const stops: (() => void)[] = [];
    for (const name of [
      "proof:comparison-reviewed",
      "proof:groups-updated",
      "proof:git-updated",
      "proof:ai-review-updated",
      "proof:language-updated",
    ] as const) {
      void listen<{ origin: string; detail: unknown }>(name, ({ payload }) => {
        if (!disposed && payload?.origin !== sender())
          window.dispatchEvent(
            new CustomEvent(name, { detail: payload?.detail }),
          );
      })
        .then((stop) => {
          if (disposed) stop();
          else stops.push(stop);
        })
        .catch(() => {});
    }
    void listen<{ epoch: number }>("proof:data-invalidated", ({ payload }) => {
      if (!disposed && Number.isSafeInteger(payload?.epoch))
        void refreshDataSession(payload.epoch).catch(() => {});
    })
      .then((stop) => {
        if (disposed) stop();
        else stops.push(stop);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, []);
}
