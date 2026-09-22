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
  fileVersions?: Record<string, string>;
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
export interface DiffSummary {
  workspaceId: string;
  path: string;
  oldPath: string | null;
  side: Side;
  base: string;
  capturedAt: number;
  patchBytes: number | null;
  reason:
    "patch_size" | "line_count" | "long_line" | "read_limit" | "file_limit";
  canLoad: boolean;
}
export type DiffRead =
  | { state: "ready"; diff: FileDiff }
  | { state: "deferred"; summary: DiffSummary };
export const readTarget = (read: DiffRead) =>
  read.state === "ready" ? read.diff : read.summary;
export interface DiffContext {
  snapshotId: string;
  contextLines: number;
  fullFile?: boolean;
  gaps: { beforeHunkId: string | null; lines: DiffLine[] }[];
}
export type DiffContextRange = number | "file";
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
  /** Delimiter used to group branch names into a collapsible tree (default "/"). */
  branchDelimiter: string;
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
  coverageComputed?: boolean;
  unreadFiles?: string[];
  indexFingerprint: string;
  capturedAt: number;
  amend: boolean;
  message: string;
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
export interface TextFileContent {
  workspaceId: string;
  path: string;
  revision: string | null;
  content: string;
  eol: "lf" | "crlf";
  size: number;
  editable: boolean;
  fingerprint: string;
}
export interface TextFileState {
  path: string;
  size: number;
  fingerprint: string;
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
  removesFile?: boolean;
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
  activeObserverScopes: number;
  pendingContentDeletions: number;
  contentCleanupError: string | null;
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
  pendingContentDeletions: number;
  contentCleanupError: string | null;
  redactedOutputs: number;
  deletedEvents: number;
  deletedSessions: number;
  deletedReviewRecords: number;
  deletedCorrections: number;
  deletedOperations: number;
  walCheckpointComplete: boolean;
  databaseCompactionPending: boolean;
}

export interface DataSession {
  epoch: number;
  wipeEpoch: number;
  deletedWorkspaceIds: string[];
}
export interface DataWorkspace {
  workspace: Workspace;
  recent: boolean;
}
export type DataScope =
  { kind: "repository"; repositoryId: string } | { kind: "all" };
export interface DataDeletionPreview {
  hookRemovals?: import("./components/ObserverSettings").HookPreview[];
  id: string;
  scope: DataScope;
  workspaces: Workspace[];
  capturedAt: number;
  counts: {
    observerEvents: number;
    reviewRecords: number;
    operations: number;
    recoveryPoints: number;
    recoveryBytes: number;
  };
}
export interface DataDeletionResult {
  session: DataSession;
  deletedWorkspaceIds: string[];
  all: boolean;
  cleanup: DataCleanup;
  cleanupError: ProofError | null;
}
export type ObserverAgent = "codex" | "claude" | "codewiz";
export interface ObserverProgramLocation {
  agent: ObserverAgent;
  executablePath: string | null;
  name: string;
  installationAvailable: boolean;
  unavailableReason: string | null;
}
export interface ObserverProbe {
  agent: ObserverAgent;
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
  branchDelimiter: "/",
};
export const fileKey = (file: Pick<ChangedFile, "side" | "path">) =>
  `${file.side}:${file.path}`;

export interface EditorApplication {
  path: string;
  name: string;
  bundleId: string | null;
}
export type EditorChoice =
  | { mode: "inherit" }
  | { mode: "disabled" }
  | { mode: "application"; application: EditorApplication };
export interface EditorSettings {
  revision: number;
  application: EditorChoice;
  repository: EditorChoice | null;
  effective: EditorApplication | null;
  source: "application" | "repository";
  platform: string;
}
export interface EditorOpenResult {
  application: EditorApplication;
  path: string;
  message: string;
}
