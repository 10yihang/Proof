export type Side = "unstaged" | "staged";
export type ReviewState = "unreviewed" | "reviewed" | "needs_review";
export interface Workspace {
  id: string;
  repositoryId: string;
  name: string;
  path: string;
  gitDir: string;
  commonDir: string;
  trusted: boolean;
}
export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: string;
  side: Side;
  conflicted: boolean;
}
export interface Changes {
  workspace: Workspace;
  head: string | null;
  branch: string | null;
  operation: string | null;
  token: string;
  capturedAt: number;
  files: ChangedFile[];
  gitVersion: string;
}
export interface DiffLine {
  kind: "add" | "delete" | "context" | "note";
  content: string;
  oldLine: number | null;
  newLine: number | null;
}
export interface Hunk {
  id: string;
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
  reviewState: ReviewState;
}
export interface FileDiff {
  id: string;
  workspaceId: string;
  path: string;
  oldPath: string | null;
  side: Side;
  base: string;
  capturedAt: number;
  token: string;
  patch: string;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  kind: string;
  notice: string | null;
  canStage: boolean;
  canStageHunks: boolean;
  canDiscard: boolean;
  canDiscardHunks: boolean;
  discardReason: string | null;
}
export interface DiffContext {
  snapshotId: string;
  contextLines: number;
  gaps: { beforeHunkId: string | null; lines: DiffLine[] }[];
}
export interface Preferences {
  theme: "light" | "dark" | "system";
  fontSize: number;
  diffMode: "unified" | "split";
  wrapLines: boolean;
  ignoreWhitespace: boolean;
  showWhitespace: boolean;
  contextOpen: boolean;
  strictReview: boolean;
  gitPath: string;
}
export interface RepositoryLayout {
  sidebarWidth: number;
  contextWidth: number;
  sidebarOpen: boolean;
  contextOpen: boolean | null;
}
export interface CommitPreview {
  id: string;
  workspaceId: string;
  branch: string | null;
  head: string | null;
  files: ChangedFile[];
  reviewed: number;
  total: number;
  indexFingerprint: string;
  capturedAt: number;
}
export interface CommitEntry {
  oid: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  refs: string;
  boundary?: "shallow" | null;
}
export interface CommitGraphPage {
  snapshotId: string;
  workspaceId: string;
  scope: string;
  commits: CommitEntry[];
  branches: BranchEntry[];
  head: string | null;
  offset: number;
  hasMore: boolean;
  capturedAt: number;
  shallow: boolean;
}
export interface BlameLine {
  oid: string | null;
  originalLine: number;
  line: number;
  author: string | null;
  authorTime: number | null;
  summary: string;
  content: string;
  originPath: string;
  uncommitted: boolean;
}
export interface FileBlame {
  workspaceId: string;
  path: string;
  revision: string | null;
  head: string | null;
  lines: BlameLine[];
  totalLines: number;
  offset: number;
  hasMore: boolean;
  notice: string;
}
export interface BranchEntry {
  name: string;
  current: boolean;
  oid: string;
  remote: boolean;
}
export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  locked: boolean;
}
export interface OperationResult {
  ok: boolean;
  message: string;
  actualHead: string | null;
  actualBranch: string | null;
  warning: string | null;
}
export interface RecoveryPoint {
  id: string;
  workspaceId: string;
  path: string;
  scope: string;
  status: string;
  createdAt: number;
  expiresAt: number;
  bytes: number;
  message: string | null;
}
export interface RecoveryAction {
  point: RecoveryPoint;
  result: OperationResult;
}
export interface ProofError {
  code: string;
  message: string;
  detail: string;
}
export interface DataUsage {
  applicationBytes: number;
  applicationBytesLowerBound: boolean;
  softLimitBytes: number;
  observerEvents: number;
  observerSessions: number;
  observationPayloadBytes: number;
  contentCollectionPaused: boolean;
  cleanupPending: boolean;
  databaseCompactionPending: boolean;
  outputRetentionDays: number;
  observationRetentionDays: number;
  reviewRetentionDays: number;
}
export interface DataCleanup {
  redactedOutputs: number;
  deletedEvents: number;
  deletedSessions: number;
  deletedReviewRecords: number;
  deletedCorrections: number;
  deletedOperations: number;
  walCheckpointComplete: boolean;
  databaseCompactionPending: boolean;
}
export interface ObserverProgramLocation {
  agent: "codex" | "claude";
  executablePath: string | null;
}
export interface ObserverProbe {
  agent: "codex" | "claude";
  executablePath: string;
  executableIdentity: string;
  version: string;
  status: "candidate_unverified" | "unsupported_version";
  checkedAt: number;
  profile: {
    adapterVersion: string;
    registeredEvents: string[];
    asyncHandlers: boolean;
    fixtureStatus: string;
    runtimeVerified: boolean;
    trustReviewRequired: boolean;
  } | null;
}
export const defaultPreferences: Preferences = {
  theme: "light",
  fontSize: 13,
  diffMode: "unified",
  wrapLines: false,
  ignoreWhitespace: false,
  showWhitespace: false,
  contextOpen: true,
  strictReview: false,
  gitPath: "git",
};
export const fileKey = (file: Pick<ChangedFile, "side" | "path">) =>
  `${file.side}:${file.path}`;
