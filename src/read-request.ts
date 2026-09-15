import { t } from "./i18n";
import type { ProofError } from "./types";

export const readCancelled = (): ProofError => ({
  code: "READ_CANCELLED",
  message: t("本次读取已取消。"),
  detail: "Superseded or cancelled read",
});

// One native read and one replaceable pending request per view.
export class LatestReadRequest {
  private active: AbortController | null = null;
  private pending: {
    start: (signal: AbortSignal) => Promise<void>;
    reject: (error: ProofError) => void;
  } | null = null;
  run<T>(execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.pending?.reject(readCancelled());
    this.active?.abort();
    return new Promise<T>((resolve, reject) => {
      this.pending = {
        reject,
        start: async (signal) => {
          try {
            const value = await execute(signal);
            if (signal.aborted) throw readCancelled();
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
      };
      this.advance();
    });
  }
  cancel() {
    this.pending?.reject(readCancelled());
    this.pending = null;
    this.active?.abort();
  }
  private advance() {
    if (this.active || !this.pending) return;
    const next = this.pending;
    this.pending = null;
    const controller = new AbortController();
    this.active = controller;
    void next.start(controller.signal).finally(() => {
      this.active = null;
      this.advance();
    });
  }
}
