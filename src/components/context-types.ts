import { t } from "../i18n";
export interface AssociationOverride {
  enabled: boolean;
  note: string;
}
export interface AssociationEvidence {
  pathEventCount: number;
  eventIds: string[];
  matchedAtCapture: boolean;
}
export interface ContextSession {
  id: string;
  agent: "codex" | "claude" | null;
  nativeSessionId: string | null;
  nativeAgentId: string | null;
  firstReceivedAt: number | null;
  lastReceivedAt: number | null;
  eventCount: number;
  promptExcerpt: string | null;
  promptStatus: string;
  cleared: boolean;
}
export interface ContextLink {
  session: ContextSession;
  originalEvidence: AssociationEvidence;
  userOverride: AssociationOverride | null;
  revision: string;
  active: boolean;
}
export interface ContextOverview {
  workspaceId: string;
  path: string;
  links: ContextLink[];
  excludedCount: number;
  historyCount: number;
  hasMore: boolean;
}
export interface ContextCandidates {
  links: ContextLink[];
  next: ContextCandidateCursor | null;
}
export interface ContextCandidateCursor {
  firstReceivedAt: number;
  sessionId: string;
}
export type ContextAction = "link" | "exclude" | "automatic" | "undo";
export interface ContextChange {
  id: string;
  sessionId: string;
  createdAt: number;
  action: ContextAction;
  before: AssociationOverride | null;
  after: AssociationOverride | null;
  originalEvidence: AssociationEvidence;
  undoOf: string | null;
  source: "user";
  canUndo: boolean;
  revision: string;
}
export interface ContextHistory {
  entries: ContextChange[];
  nextOffset: number | null;
}
export interface ContextMutation {
  change: ContextChange | null;
  revision: string;
}
export interface ContextEvent {
  id: string;
  sessionId: string;
  nativeSessionId: string | null;
  kind: string;
  toolName: string | null;
  toolRef: string | null;
  turnId: string | null;
  receivedAt: number;
  paths: string[];
  prompt: string | null;
  command: string | null;
  reply: string | null;
  output: string | null;
  exitCode: number | null;
  commandState: string;
  fieldStatus: Record<string, string>;
  truncated: boolean;
  possiblyDuplicate: boolean;
}
export interface ContextEventCursor {
  receivedAt: number;
  id: string;
}
export interface ContextEvents {
  events: ContextEvent[];
  expiry: Record<string, { contentExpiresAt: number; expiresAt: number }>;
  next: ContextEventCursor | null;
  cleared: boolean;
}
export function agentName(session: ContextSession) {
  return session.agent === "codex"
    ? "Codex"
    : session.agent === "claude"
      ? "Claude Code"
      : t("原始会话已清理");
}
export function fieldState(status: string) {
  return (
    (
      {
        not_authorized: t("未开启记录"),
        not_provided: t("Hook 未提供"),
        expired: t("记录已清理"),
        truncated: t("已截断"),
        redacted: t("已隐藏"),
        limited_or_outside_scope: t("超出采集范围"),
      } as Record<string, string>
    )[status] ?? t("暂无可用记录")
  );
}
export function associationReason(evidence: AssociationEvidence) {
  return evidence.pathEventCount
    ? t("{v0} 条原始事件引用了此文件。", { v0: evidence.pathEventCount }) +
        (evidence.matchedAtCapture
          ? " " + t("其中有写入内容在捕获时与文件一致。")
          : "")
    : t("原始事件没有引用此文件。");
}
export function associationState(value: AssociationOverride | null) {
  return value === null
    ? t("按原始记录关联")
    : value.enabled
      ? t("用户指定 · 已关联")
      : t("用户指定 · 已解除");
}
