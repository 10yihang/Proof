import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { createStore, useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { currentDataEpoch, isDesktop, useRequest } from "./api";
import {
  advanceAiProgress,
  startAiProgress,
  type AiActivity,
} from "./ai-progress";
import type { ProofError } from "./types";

export interface OcrReviewRun {
  id: string;
  epoch: number;
  revision: number;
  workspaceId: string;
  scope: string;
  comparison: { base: string; target: string } | null;
  label: string;
  startedAt: number;
  status: "running" | "cancelling" | "finished";
  activity: { at: number; event: AiActivity }[];
  coverage: AiActivity | null;
  recentPath: string | null;
  error: ProofError | null;
}

const runs = createStore<Record<string, OcrReviewRun>>(() => ({}));
const scopeKey = (workspaceId: string, scope: string) =>
  JSON.stringify([workspaceId, scope]);

export function resetOcrReviews() {
  runs.setState({}, true);
}

export function receiveOcrReview(run: OcrReviewRun) {
  if (run.epoch !== currentDataEpoch()) return;
  const key = scopeKey(run.workspaceId, run.scope);
  runs.setState((state) => {
    const current = state[key];
    if (
      current &&
      (current.id === run.id
        ? current.revision >= run.revision
        : current.startedAt > run.startedAt)
    )
      return state;
    return { [key]: run };
  });
}

export function useOcrReviewRuns(dataKey: number) {
  const request = useRequest();
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const refresh = () => {
      void request<OcrReviewRun[]>("ocr_review_runs")
        .then((values) => {
          if (!disposed) values.forEach(receiveOcrReview);
        })
        .catch(() => {});
    };
    void listen<OcrReviewRun>("proof://ocr-review", ({ payload }) => {
      if (!disposed) receiveOcrReview(payload);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else {
          stop = unlisten;
          refresh();
        }
      })
      .catch(() => refresh());
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      stop?.();
      window.removeEventListener("focus", refresh);
    };
  }, [dataKey, request]);
}

export function useOcrReview(workspaceId: string | undefined, scope: string) {
  return useStore(
    runs,
    useShallow((state) => {
      const run = workspaceId ? state[scopeKey(workspaceId, scope)] : undefined;
      return run
        ? { id: run.id, status: run.status, error: run.error }
        : undefined;
    }),
  );
}

export function useLatestOcrReview(workspaceId: string | undefined) {
  return useStore(
    runs,
    useShallow((state) => {
      let latest: OcrReviewRun | undefined;
      for (const run of Object.values(state)) {
        if (run.workspaceId !== workspaceId) continue;
        if (
          !latest ||
          (latest.status === "finished" && run.status !== "finished") ||
          ((latest.status === "finished") === (run.status === "finished") &&
            latest.startedAt <= run.startedAt)
        )
          latest = run;
      }
      return latest
        ? {
            status: latest.status,
            label: latest.label,
            error: latest.error?.code,
            base: latest.comparison?.base,
            target: latest.comparison?.target,
          }
        : undefined;
    }),
  );
}

export function useOcrReviewProgress(
  workspaceId: string | undefined,
  scope: string,
) {
  const run = useStore(runs, (state) =>
    workspaceId ? state[scopeKey(workspaceId, scope)] : undefined,
  );
  if (!run || run.status === "finished") return null;
  const progress = run.activity.reduce(
    (state, { at, event }) => advanceAiProgress(state, event, at),
    startAiProgress(run.startedAt),
  );
  return {
    ...progress,
    reviewTarget: run.label,
    cancelling: run.status === "cancelling",
    recentPath: run.recentPath ?? undefined,
    ocrScope:
      run.coverage?.total != null
        ? { eligible: run.coverage.total, excluded: run.coverage.excluded ?? 0 }
        : progress.ocrScope,
  };
}
