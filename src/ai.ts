import {
  advanceAiProgress,
  startAiProgress,
  type AiRunProgress,
} from "./ai-progress";
import { t } from "./i18n";
import { useAiReports, type FindingDecision } from "./ai-reports";
import { publishDiffEvent } from "./diff-events";
import { useEffect, useRef, useState } from "react";
import { asError, useReadRequest, useRequest } from "./api";
import type { Changes, ChangedFile, FileDiff, Side, ProofError } from "./types";

export type AgentKind = "codex" | "claude_code" | "codewiz";
export const agentName = (kind: AgentKind) =>
  ({ codex: "Codex", claude_code: "Claude Code", codewiz: "Codewiz" })[kind];
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
  revision: number;
  decisions: FindingDecision[];
  id: string;
  provider: AgentKind;
  task: "grouping" | "review";
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
) {
  const request = useRequest(),
    reader = useReadRequest();
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  const [provider, setProvider] = useState<AgentKind>("codex");
  const [groups, setGroups] = useState<ChangeGroups>(emptyGroups);
  const [groupReady, setGroupReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [suggestion, setSuggestion] = useState<AiReport | null>(null);
  const [pending, setPending] = useState<"grouping" | "review" | null>(null);
  const [progress, setProgress] = useState<AiRunProgress | null>(null);
  const [error, setError] = useState<ProofError | null>(null);
  const [view, setView] = useState<"files" | "groups">("files");
  const historical = comparison !== undefined;
  const files = historical ? (comparison?.files ?? []) : (changes?.files ?? []);
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
  const workspace = changes?.workspace.id;
  const reviewState = useAiReports(workspace, groupScope, demo);
  const { report } = reviewState;
  useEffect(() => {
    const n = ++generation.current;
    reader.cancel();
    running.current = false;
    editing.current = false;
    setSaving(false);
    setPending(null);
    setProgress(null);
    setSuggestion(null);
    setGroups(emptyGroups());
    setGroupReady(false);
    setView("files");
    setError(null);
    if (!workspace || demo) {
      setProviders([]);
      setGroupReady(true);
      return;
    }
    void request<AgentProviderInfo[]>("agent_providers")
      .then((value) => {
        if (n !== generation.current) return;
        setProviders(value);
        setProvider(
          value.find((p) => p.available && p.isDefault)?.id ??
            value.find((p) => p.available)?.id ??
            "codex",
        );
      })
      .catch((e) => {
        if (n === generation.current) setError(asError(e));
      });
    if (!historical || comparison)
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
          if (n === generation.current) {
            setGroups(value);
            setGroupReady(true);
            if (value.groups.length) setView("groups");
          }
        })
        .catch((e) => {
          if (n === generation.current) setError(asError(e));
        });
    return () => {
      ++generation.current;
      reader.cancel();
    };
  }, [workspace, demo, request, reader, historical, groupScope]);
  useEffect(() => {
    const refresh = () => {
      if (demo || !workspace) return;
      const n = generation.current;
      void request<AgentProviderInfo[]>("agent_providers")
        .then((value) => {
          if (n !== generation.current) return;
          setProviders(value);
          setProvider(
            value.find((p) => p.isDefault && p.available)?.id ??
              value.find((p) => p.available)?.id ??
              "codex",
          );
        })
        .catch((e) => {
          if (n === generation.current) setError(asError(e));
        });
    };
    window.addEventListener("proof:agent-settings-changed", refresh);
    return () =>
      window.removeEventListener("proof:agent-settings-changed", refresh);
  }, [workspace, demo, request]);
  useEffect(() => {
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
            !editing.current &&
            live.current.groups.revision === revision
          ) {
            setGroups(value);
            live.current.groups = value;
          }
        })
        .catch((error) => {
          if (n === generation.current) setError(asError(error));
        });
    };
    window.addEventListener("proof:groups-updated", reload);
    window.addEventListener("focus", reload);
    return () => {
      window.removeEventListener("proof:groups-updated", reload);
      window.removeEventListener("focus", reload);
    };
  }, [workspace, demo, groupScope, historical, request]);
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
    if (
      !changes ||
      (historical && !comparison) ||
      demo ||
      running.current ||
      !providers.some((p) => p.id === provider && p.available)
    )
      return;
    if (task === "grouping" && !groupReady) return;
    const currentGroup = groups.groups.find((g) =>
      g.files.includes(diff?.path ?? ""),
    );
    const selected =
      all || task === "grouping"
        ? null
        : changes.files
            .filter((f) =>
              currentGroup
                ? currentGroup.files.includes(f.path)
                : f.path === diff?.path && f.side === diff.side,
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
    setProgress(startAiProgress());
    setError(null);
    try {
      const result = await reader.read<AiReport>(
        "run_ai_task",
        {
          request: { provider, task, scope },
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
        setPending(null);
      }
    }
  }
  const stale = reportIsStale(report, changes, comparison);
  const currentLabel =
    groups.groups.find((group) => group.files.includes(diff?.path ?? ""))
      ?.title ?? diff?.path;
  const scopeLabel = comparison
    ? `${comparison.baseOid.slice(0, 8)} → ${comparison.targetOid.slice(0, 8)}`
    : t("Local changes · {v0} files", {
        v0: new Set(changes?.files.map((file) => file.path)).size,
      });
  return {
    workspace: changes?.workspace,
    branch: changes?.branch,
    currentLabel,
    scopeLabel,
    sourceToken,
    suggestionStale: reportIsStale(suggestion, changes, comparison),
    providers,
    provider,
    setProvider,
    groups,
    groupReady,
    saving,
    save,
    suggestion,
    pending,
    progress,
    error: error ?? reviewState.reportError,
    ...reviewState,
    view,
    setView,
    run,
    stale,
    cancel: () => {
      setProgress((state) => (state ? { ...state, cancelling: true } : state));
      reader.cancel();
    },
    canRun:
      files.length > 0 &&
      (!historical || !!comparison) &&
      !demo &&
      !!changes?.workspace.trusted &&
      providers.some((p) => p.id === provider && p.available) &&
      !pending &&
      !reviewState.decisionSaving &&
      !reviewState.reportLoading,
    visibleGroups: reconcileGroups(
      groups.groups,
      new Set(files.map((f) => f.path)),
    ),
  };
}
export type AiController = ReturnType<typeof useAi>;
