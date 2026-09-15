export interface AiActivity {
  phase:
    | "preparing"
    | "snapshot"
    | "starting"
    | "reading"
    | "searching"
    | "git"
    | "tool"
    | "tool_failed"
    | "analyzing"
    | "validating";
  path?: string | null;
  completed?: number | null;
  total?: number | null;
}
export interface AiActivityRecord extends AiActivity {
  at: number;
}
export interface AiRunProgress {
  startedAt: number;
  lastEventAt: number;
  cancelling: boolean;
  activity: AiActivity;
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
  const record = { ...event, at: now };
  const repeat =
    last?.phase === event.phase &&
    (event.phase === "preparing" ||
      event.phase === "snapshot" ||
      last.path === event.path);
  return {
    ...state,
    activity: event,
    lastEventAt: now,
    history: [
      ...(repeat ? state.history.slice(0, -1) : state.history),
      record,
    ].slice(-40),
  };
}
