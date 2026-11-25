export interface AiActivity {
  phase:
    | "preparing"
    | "context"
    | "starting"
    | "reading"
    | "searching"
    | "git"
    | "tool"
    | "tool_failed"
    | "analyzing"
    | "ocr_capture"
    | "ocr_selecting"
    | "ocr_scope"
    | "ocr_reviewing"
    | "ocr_reading"
    | "ocr_searching"
    | "ocr_plan_done"
    | "ocr_filtering"
    | "ocr_subtask_failed"
    | "validating";
  path?: string | null;
  completed?: number | null;
  total?: number | null;
  excluded?: number | null;
}
export interface AiActivityRecord extends AiActivity {
  at: number;
  firstAt: number;
}
export interface AiRunProgress {
  startedAt: number;
  lastEventAt: number;
  cancelling: boolean;
  activity: AiActivity;
  ocrScope?: { eligible: number; excluded: number };
  reviewTarget?: string;
  recentPath?: string;
  history: AiActivityRecord[];
}
export function startAiProgress(now = Date.now()): AiRunProgress {
  return {
    startedAt: now,
    lastEventAt: now,
    cancelling: false,
    activity: { phase: "preparing" },
    history: [],
  };
}
export function advanceAiProgress(
  state: AiRunProgress,
  event: AiActivity,
  now = Date.now(),
): AiRunProgress {
  // Capture can emit once per file. Keep a bounded public activity log.
  const last = state.history.at(-1);
  const record = { ...event, at: now, firstAt: now };
  const repeat =
    last?.phase === event.phase &&
    (event.phase === "preparing" ||
      event.phase === "context" ||
      last.path === event.path);
  const related =
    event.phase === "ocr_reviewing" ||
    event.phase === "ocr_reading" ||
    event.phase === "ocr_searching"
      ? state.history.findIndex(
          (item) =>
            item.phase === event.phase &&
            item.path === event.path &&
            now - item.at < 5000,
        )
      : -1;
  const history =
    related >= 0
      ? state.history.map((item, index) =>
          index === related ? { ...record, firstAt: item.firstAt } : item,
        )
      : [
          ...(repeat ? state.history.slice(0, -1) : state.history),
          record,
        ].slice(-40);
  return {
    ...state,
    activity: event,
    recentPath: event.path ?? state.recentPath,
    ocrScope:
      event.phase === "ocr_scope" && event.total != null
        ? { eligible: event.total, excluded: event.excluded ?? 0 }
        : state.ocrScope,
    lastEventAt: now,
    history,
  };
}
