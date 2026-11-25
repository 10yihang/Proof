import {
  advanceAiProgress,
  startAiProgress,
  type AiRunProgress,
} from "./ai-progress";
import { t } from "./i18n";
import { useAiReports, type FindingDecision } from "./ai-reports";
import { publishDiffEvent } from "./diff-events";
import { comparisonRangeLabel } from "./diff-reading";
import {
  receiveOcrReview,
  useOcrReview,
  type OcrReviewRun,
} from "./ocr-reviews";
import { useEffect, useRef, useState } from "react";
import { asError, useReadRequest, useRequest } from "./api";
import type { Changes, ChangedFile, FileDiff, Side, ProofError } from "./types";

export type AgentKind = "codex" | "claude_code" | "codewiz" | "ocr";
export const agentName = (kind: AgentKind) =>
  ({
    codex: "Codex",
    claude_code: "Claude Code",
    codewiz: "Codewiz",
    ocr: "OpenCodeReview",
  })[kind];
export type AiRisk = "low" | "medium" | "high" | "critical" | "unknown";
export interface AiGroup {
  title: string;
  summary: string;
  files: string[];
  risk: AiRisk;
  reviewPriority: number;
}
export interface ChangeGroups {
  revision: number;
  groups: AiGroup[];
  sourceToken: string;
}
export interface AgentProviderInfo {
  id: AgentKind;
  name: string;
  available: boolean;
  path: string | null;
  reason: string | null;
  model?: string | null;
  isDefault?: boolean;
}
function defaultAgents(providers: AgentProviderInfo[]) {
  const available = providers.filter((provider) => provider.available);
  const general =
    available.find((provider) => provider.isDefault && provider.id !== "ocr")
      ?.id ??
    available.find((provider) => provider.id !== "ocr")?.id ??
    "codex";
  return {
    general,
    review: available.some((provider) => provider.id === "ocr")
      ? ("ocr" as const)
      : general,
  };
}
export interface AiFinding {
  severity: AiRisk;
  title: string;
  description: string;
  file: string;
  side: Side;
  line: number;
  endLine?: number | null;
  lineSide: "old" | "new";
  suggestion: string;
}
export interface AiReview {
  summary: string;
  overallRisk: AiRisk;
  findings: AiFinding[];
  behaviorChanges: string[];
  missingTests: string[];
  reviewPriority: string[];
}
export type AiScope =
  | {
      kind: "local";
      workspaceId: string;
      expectedToken: string;
      files:
        { path: string; side: Side; snapshotToken: string | null }[] | null;
    }
  | {
      kind: "comparison";
      workspaceId: string;
      base: string;
      target: string;
      path: string | null;
      paths?: string[] | null;
    };
export interface AiReport {
  session?: { id: string; resumeCommand: string } | null;
  ocr?: {
    status: "complete" | "partial" | "skipped";
    pinnedDiff?: boolean;
    sessionId: string | null;
    model: string | null;
    provider: string | null;
    eligible: number | null;
    reviewed: number;
    excluded: { path: string; reason: string }[];
    incomplete: { path: string; reason: string }[];
    omittedFindings: number;
  };
  revision: number;
  decisions: FindingDecision[];
  id: string;
  provider: AgentKind;
  task: "grouping" | "review" | "commit";
  scope: AiScope;
  fingerprint: string;
  capturedAt: number;
  files: {
    path: string;
    side: Side;
    snapshotId: string;
    snapshotToken: string;
  }[];
  groups: AiGroup[];
  review: AiReview | null;
  commitMessage?: string | null;
  limitations: string[];
}
export interface DiffJump {
  id: string;
  comparisonId?: string;
  snapshotToken: string;
  path: string;
  fileSide: Side;
  line: number;
  endLine?: number | null;
  side: "old" | "new";
}
const emptyGroups = (): ChangeGroups => ({
  revision: 0,
  groups: [],
  sourceToken: "",
});
export function reportIsStale(
  report: AiReport | null,
  changes: Changes | null,
  comparison?: { baseOid: string; targetOid: string } | null,
) {
  if (!report || !changes) return false;
  if (report.scope.workspaceId !== changes.workspace.id) return true;
  return report.scope.kind === "local"
    ? report.scope.expectedToken !== changes.token
    : !comparison ||
        report.scope.base !== comparison.baseOid ||
        report.scope.target !== comparison.targetOid;
}
export function reconcileGroups(groups: AiGroup[], paths: Set<string>) {
  return groups
    .map((group) => ({
      ...group,
      files: group.files.filter((path) => paths.has(path)),
    }))
    .filter((group) => group.files.length > 0);
}
export function moveGroupedFile(
  groups: AiGroup[],
  path: string,
  destination: number | null,
): AiGroup[] {
  return groups
    .map((group, index) => ({
      ...group,
      files: [
        ...group.files.filter((file) => file !== path),
        ...(index === destination ? [path] : []),
      ],
    }))
    .filter((group) => group.files.length > 0);
}
export function useAi(
  changes: Changes | null,
  diff: FileDiff | null,
  demo: boolean,
  comparison?: {
    baseOid: string;
    targetOid: string;
    files: ChangedFile[];
  } | null,
  active = true,
  localSide?: Side,
) {
  const request = useRequest(),
    reader = useReadRequest();
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  const [provider, setProvider] = useState<AgentKind>("codex");
  const [reviewProvider, setReviewProvider] = useState<AgentKind>("ocr");
  const [groups, setGroups] = useState<ChangeGroups>(emptyGroups);
  const [groupReady, setGroupReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [suggestion, setSuggestion] = useState<AiReport | null>(null);
  const [localPending, setPending] = useState<"grouping" | "review" | null>(
    null,
  );
  const [localProgress, setProgress] = useState<AiRunProgress | null>(null);
  const launchingOcr = useRef<{ cancel: boolean } | null>(null);
  const [error, setError] = useState<ProofError | null>(null);
  const [view, setView] = useState<"files" | "groups">("files");
  const historical = comparison !== undefined;
  const files = historical ? (comparison?.files ?? []) : (changes?.files ?? []);
  const reviewSide = historical
    ? undefined
    : (localSide ?? diff?.side ?? files[0]?.side);
  const ocrRange = reviewSide
    ? t(reviewSide === "staged" ? "HEAD → Index" : "Index → 工作区")
    : undefined;
  const comparisonLabel = comparison
    ? comparisonRangeLabel(comparison.baseOid, comparison.targetOid)
    : undefined;
  const sourceToken = comparison
    ? `comparison:${comparison.baseOid}:${comparison.targetOid}`
    : historical
      ? ""
      : (changes?.token ?? "");
  const groupScope = historical ? sourceToken : "local";
  const live = useRef({ changes, groups, files, sourceToken, comparison });
  live.current = { changes, groups, files, sourceToken, comparison };
  const generation = useRef(0),
    running = useRef(false),
    editing = useRef(false);
  const initialGroupsLoaded = useRef(false);
  const initialProvidersLoaded = useRef(false);
  const workspace = changes?.workspace.id;
  const ocrRun = useOcrReview(demo ? undefined : workspace, groupScope);
  const ocrRunning = !!ocrRun && ocrRun.status !== "finished";
  const pending = localPending ?? (ocrRunning ? "review" : null);
  const reviewState = useAiReports(workspace, groupScope, demo, active);
  const { report } = reviewState;
  const currentGroup = groups.groups.find((group) =>
    group.files.includes(diff?.path ?? ""),
  );
  useEffect(() => {
    ++generation.current;
    reader.cancel();
    running.current = false;
    launchingOcr.current = null;
    editing.current = false;
    setSaving(false);
    setPending(null);
    setProgress(null);
    setSuggestion(null);
    const clearedGroups = emptyGroups();
    setGroups(clearedGroups);
    live.current.groups = clearedGroups;
    setGroupReady(false);
    setView("files");
    setError(null);
    initialGroupsLoaded.current = false;
    initialProvidersLoaded.current = false;
    setProviders([]);
    if (!workspace || demo) {
      setGroupReady(true);
    }
    return () => {
      ++generation.current;
      reader.cancel();
    };
  }, [workspace, demo, reader, historical, groupScope]);
  useEffect(() => {
    if (!active || !workspace || demo) return;
    const n = generation.current;
    const revision = live.current.groups.revision;
    let disposed = false;
    const valid = () => !disposed && n === generation.current;
    void request<AgentProviderInfo[]>("agent_providers")
      .then((value) => {
        if (!valid()) return;
        setProviders(value);
        const defaults = defaultAgents(value);
        const firstLoad = !initialProvidersLoaded.current;
        initialProvidersLoaded.current = true;
        setProvider((selected) =>
          firstLoad || !value.some((p) => p.id === selected && p.available)
            ? defaults.general
            : selected,
        );
        setReviewProvider((selected) =>
          firstLoad || !value.some((p) => p.id === selected && p.available)
            ? defaults.review
            : selected,
        );
      })
      .catch((e) => {
        if (valid()) setError(asError(e));
      });
    if ((!historical || comparison) && !editing.current)
      void request<ChangeGroups>(
        historical ? "comparison_change_groups" : "change_groups",
        {
          workspaceId: workspace,
          ...(comparison
            ? { base: comparison.baseOid, target: comparison.targetOid }
            : {}),
        },
      )
        .then((value) => {
          if (
            valid() &&
            !editing.current &&
            live.current.groups.revision === revision
          ) {
            const firstLoad = !initialGroupsLoaded.current;
            initialGroupsLoaded.current = true;
            setGroups(value);
            live.current.groups = value;
            setGroupReady(true);
            if (firstLoad && value.groups.length) setView("groups");
          }
        })
        .catch((e) => {
          if (valid()) setError(asError(e));
        });
    return () => {
      disposed = true;
    };
  }, [workspace, demo, request, historical, groupScope, active]);
  useEffect(() => {
    if (!active || demo || !workspace) return;
    let disposed = false;
    const refresh = () => {
      const n = generation.current;
      void request<AgentProviderInfo[]>("agent_providers")
        .then((value) => {
          if (disposed || n !== generation.current) return;
          setProviders(value);
          const defaults = defaultAgents(value);
          setProvider(defaults.general);
          setReviewProvider(defaults.review);
        })
        .catch((e) => {
          if (!disposed && n === generation.current) setError(asError(e));
        });
    };
    window.addEventListener("proof:agent-settings-changed", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("proof:agent-settings-changed", refresh);
    };
  }, [workspace, demo, request, active]);
  useEffect(() => {
    if (!active || !workspace || demo || (historical && !comparison)) return;
    let disposed = false;
    const reload = (event: Event) => {
      if (!workspace || demo || (historical && !comparison) || editing.current)
        return;
      const detail = (
        event as CustomEvent<{
          workspaceId: string;
          scope: string;
          revision: number;
        }>
      ).detail;
      if (
        detail &&
        (detail.workspaceId !== workspace ||
          detail.scope !== groupScope ||
          detail.revision <= live.current.groups.revision)
      )
        return;
      const n = generation.current,
        revision = live.current.groups.revision;
      void request<ChangeGroups>(
        historical ? "comparison_change_groups" : "change_groups",
        {
          workspaceId: workspace,
          ...(comparison
            ? { base: comparison.baseOid, target: comparison.targetOid }
            : {}),
        },
      )
        .then((value) => {
          if (
            n === generation.current &&
            !disposed &&
            !editing.current &&
            live.current.groups.revision === revision
          ) {
            setGroups(value);
            live.current.groups = value;
          }
        })
        .catch((error) => {
          if (!disposed && n === generation.current) setError(asError(error));
        });
    };
    window.addEventListener("proof:groups-updated", reload);
    window.addEventListener("focus", reload);
    return () => {
      disposed = true;
      window.removeEventListener("proof:groups-updated", reload);
      window.removeEventListener("focus", reload);
    };
  }, [workspace, demo, groupScope, historical, request, active]);
  async function save(
    next: AiGroup[],
    revision = live.current.groups.revision,
    token = live.current.sourceToken,
  ) {
    const current = live.current.changes;
    if (!current || !token || editing.current || demo) return;
    const n = generation.current;
    editing.current = true;
    setSaving(true);
    setError(null);
    try {
      const reconciled = reconcileGroups(
        next,
        new Set(live.current.files.map((f) => f.path)),
      );
      const value = await request<ChangeGroups>(
        historical ? "set_comparison_change_groups" : "set_change_groups",
        {
          ...(comparison
            ? { base: comparison.baseOid, target: comparison.targetOid }
            : {}),
          workspaceId: current.workspace.id,
          expectedRevision: revision,
          expectedToken: token,
          groups: reconciled,
        },
      );
      if (n === generation.current) {
        setGroups(value);
        live.current.groups = value;
        setSuggestion(null);
        publishDiffEvent("proof:groups-updated", {
          workspaceId: current.workspace.id,
          scope: groupScope,
          revision: value.revision,
        });
      }
    } catch (e) {
      if (n === generation.current) {
        setError(asError(e));
        if (asError(e).code === "GROUPS_CHANGED") {
          const fresh = await request<ChangeGroups>(
            historical ? "comparison_change_groups" : "change_groups",
            {
              ...(comparison
                ? { base: comparison.baseOid, target: comparison.targetOid }
                : {}),
              workspaceId: current.workspace.id,
            },
          );
          if (n === generation.current) setGroups(fresh);
        }
      }
    } finally {
      if (n === generation.current) {
        editing.current = false;
        setSaving(false);
      }
    }
  }
  async function run(task: "grouping" | "review", all = false) {
    const engine = task === "review" ? reviewProvider : provider;
    if (
      !changes ||
      (historical && !comparison) ||
      demo ||
      running.current ||
      ocrRunning ||
      !providers.some((p) => p.id === engine && p.available)
    )
      return;
    if (task === "grouping" && !groupReady) return;
    const isOcrReview = task === "review" && engine === "ocr";
    const localOcr = isOcrReview && !historical;
    const selected =
      (all && !localOcr) || task === "grouping"
        ? null
        : changes.files
            .filter(
              (f) =>
                (!localOcr || f.side === reviewSide) &&
                (all ||
                  (currentGroup
                    ? currentGroup.files.includes(f.path)
                    : f.path === diff?.path && f.side === diff.side)),
            )
            .map((f) => ({
              path: f.path,
              side: f.side,
              snapshotToken:
                f.path === diff?.path && f.side === diff.side
                  ? diff.token
                  : null,
            }));
    const scope: AiScope = comparison
      ? {
          kind: "comparison",
          workspaceId: changes.workspace.id,
          base: comparison.baseOid,
          target: comparison.targetOid,
          path:
            all || task === "grouping" || currentGroup
              ? null
              : (diff?.path ?? null),
          ...(!all && task === "review" && currentGroup
            ? { paths: currentGroup.files }
            : {}),
        }
      : {
          kind: "local",
          workspaceId: changes.workspace.id,
          expectedToken: changes.token,
          files: selected,
        };
    const n = generation.current,
      revision = groups.revision;
    running.current = true;
    setPending(task);
    const label = all
      ? (comparisonLabel ?? ocrRange)
      : (currentGroup?.title ?? diff?.path);
    setProgress({
      ...startAiProgress(),
      reviewTarget: isOcrReview ? label : undefined,
    });
    setError(null);
    try {
      if (isOcrReview) {
        const launch = { cancel: false };
        launchingOcr.current = launch;
        const started = await request<OcrReviewRun>("start_ocr_review", {
          request: { provider: engine, task, scope },
          label,
        });
        receiveOcrReview(started);
        if (launch.cancel) {
          const cancelled = await request<OcrReviewRun | null>(
            "cancel_ocr_review",
            {
              id: started.id,
            },
          );
          if (cancelled) receiveOcrReview(cancelled);
        }
        return;
      }
      const result = await reader.read<AiReport>(
        "run_ai_task",
        {
          request: { provider: engine, task, scope },
        },
        (event) => {
          if (n === generation.current)
            setProgress((state) =>
              state ? advanceAiProgress(state, event) : state,
            );
        },
      );
      if (n !== generation.current) return;
      if (task === "review") reviewState.acceptReport(result);
      else {
        setView("groups");
        setSuggestion(result);
        if (
          groups.groups.length === 0 &&
          live.current.groups.revision === revision &&
          live.current.sourceToken === sourceToken &&
          !editing.current
        )
          await save(result.groups, revision, sourceToken);
      }
    } catch (e) {
      if (n === generation.current) setError(asError(e));
    } finally {
      if (n === generation.current) {
        running.current = false;
        launchingOcr.current = null;
        setPending(null);
      }
    }
  }
  const stale = reportIsStale(report, changes, comparison);
  const currentLabel = currentGroup?.title ?? diff?.path;
  const scopeLabel =
    comparisonLabel ??
    t("Local changes · {v0} files", {
      v0: new Set(
        changes?.files
          .filter(
            (file) =>
              reviewProvider !== "ocr" ||
              !reviewSide ||
              file.side === reviewSide,
          )
          .map((file) => file.path),
      ).size,
    });
  const canStart =
    files.length > 0 &&
    (!historical || !!comparison) &&
    !demo &&
    !!changes?.workspace.trusted &&
    !pending &&
    !reviewState.decisionSaving &&
    !reviewState.reportLoading;
  return {
    workspace: changes?.workspace,
    branch: changes?.branch,
    currentLabel,
    currentGroupName: currentGroup?.title,
    scopeLabel,
    ocrRange,
    reviewSide,
    sourceToken,
    suggestionStale: reportIsStale(suggestion, changes, comparison),
    providers,
    provider,
    setProvider,
    reviewProvider,
    setReviewProvider,
    groups,
    groupReady,
    saving,
    save,
    suggestion,
    pending,
    progress: localProgress,
    reviewScope: groupScope,
    ocrRun,
    ocrRunning,
    error:
      error ??
      (!pending && reviewProvider === "ocr" ? ocrRun?.error : null) ??
      reviewState.reportError,
    ...reviewState,
    view,
    setView,
    run,
    stale,
    cancel: () => {
      if (ocrRunning && localPending !== "grouping") {
        const n = generation.current;
        void request<OcrReviewRun | null>("cancel_ocr_review", {
          id: ocrRun.id,
        })
          .then((run) => {
            if (run) receiveOcrReview(run);
          })
          .catch((cause) => {
            if (n === generation.current) setError(asError(cause));
          });
        return;
      }
      setProgress((state) => (state ? { ...state, cancelling: true } : state));
      if (launchingOcr.current) launchingOcr.current.cancel = true;
      else reader.cancel();
    },
    canRun: canStart && providers.some((p) => p.id === provider && p.available),
    canRunReview:
      canStart && providers.some((p) => p.id === reviewProvider && p.available),
    visibleGroups: reconcileGroups(
      groups.groups,
      new Set(files.map((f) => f.path)),
    ),
  };
}
export type AiController = ReturnType<typeof useAi>;
