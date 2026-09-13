import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowClockwise,
  ArrowRight,
  CaretDown,
  Check,
  FolderOpen,
  GearSix,
  GitBranch,
  GitCommit,
  Info,
  MagnifyingGlass,
  Minus,
  Plus,
  SidebarSimple,
  ShieldCheck,
  Warning,
  X,
  Trash,
  ClockCounterClockwise,
  List,
} from "@phosphor-icons/react";
import { asError, isDesktop, request, watchWorkspace } from "./api";
import { demoChanges, demoDiff, demoDiffContext } from "./demo";
import { hiddenWhitespace } from "./diff-reading";
import { defaultPreferences, fileKey } from "./types";
import type {
  ChangedFile,
  Changes,
  CommitPreview,
  FileDiff,
  DiffContext,
  OperationResult,
  Preferences,
  ProofError,
  Workspace,
  RecoveryPoint,
  RecoveryAction,
} from "./types";
import { DiffView } from "./components/DiffView";
import { FileTree } from "./components/FileTree";
import { ContextInspector } from "./components/ContextInspector";
import { Modal } from "./components/Modal";
import { RepositoryView } from "./components/RepositoryView";
import type { RepositorySection } from "./components/RepositoryView";
import { Settings } from "./components/Settings";
import { RecoveryDialog } from "./components/RecoveryDialog";
import { FileHistory } from "./components/FileHistory";
import { ResizableWorkbench } from "./components/ResizableWorkbench";
import { useRepositoryLayout } from "./use-repository-layout";
import { DiffCache } from "./diff-cache";
import { BranchPicker } from "./components/BranchPicker";
import { CommitComposer } from "./components/CommitComposer";
import { shouldDismissDrawer } from "./components/panel-focus";

type Dialog =
  | "open"
  | "settings"
  | "trust"
  | "commit"
  | "commands"
  | "mark-file"
  | "discard"
  | "recovery"
  | "file-history"
  | null;
export default function App() {
  const [preferences, setPreferences] = useState(defaultPreferences);
  const preferenceState = useRef(defaultPreferences);
  const savedPreferences = useRef(defaultPreferences);
  const preferenceWrites = useRef<Promise<void>>(Promise.resolve());
  const preferenceLoad = useRef<Promise<Preferences>>(
    Promise.resolve(defaultPreferences),
  );
  const preferenceRevision = useRef(0);
  const pendingPreferences = useRef(new Map<number, Partial<Preferences>>());
  const initialized = useRef(false);
  const [recent, setRecent] = useState<Workspace[]>([]);
  const [changes, setChanges] = useState<Changes | null>(null);
  const cache = useRef(new DiffCache());
  const selectedRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const refreshGeneration = useRef(0);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const displayedDiff = useRef<FileDiff | null>(null);
  displayedDiff.current = diff;
  const [reviewTarget, setReviewTarget] = useState<FileDiff | null>(null);
  const [loaded, setLoaded] = useState<Record<string, FileDiff>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<ProofError | null>(null);
  const [busy, setBusyState] = useState(false),
    [loadingDiff, setLoadingDiff] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null),
    [tab, setTab] = useState<"changes" | "repository">("changes");
  const [repositoryVisited, setRepositoryVisited] = useState(false);
  const [settingsSection, setSettingsSection] = useState<
    "appearance" | "review" | "observer" | "data"
  >("appearance");
  const [repositorySection, setRepositorySection] =
    useState<RepositorySection>("history");
  useEffect(() => {
    if (tab === "repository") setRepositoryVisited(true);
  }, [tab]);
  const [search, setSearch] = useState(""),
    [scope, setScope] = useState<"all" | "unstaged" | "staged">("all");
  const [focused, setFocused] = useState(false),
    [demo, setDemo] = useState(false);
  const [narrow, setNarrow] = useState(window.innerWidth <= 1100),
    [contextDrawer, setContextDrawer] = useState(false);
  const [compact, setCompact] = useState(window.innerWidth <= 780),
    [filesDrawer, setFilesDrawer] = useState(false);
  const repositoryLayout = useRepositoryLayout(changes?.workspace, demo);
  const [preview, setPreview] = useState<CommitPreview | null>(null),
    [draft, setDraft] = useState("");
  const [amendTarget, setAmendTarget] = useState<{
    head: string;
    branch: string | null;
  } | null>(null);
  const normalDraft = useRef("");
  const [discardPoint, setDiscardPoint] = useState<RecoveryPoint | null>(null);
  const [path, setPath] = useState(""),
    [notification, setNotification] = useState("");
  const sequence = useRef(0),
    workspaceEpoch = useRef(0),
    current = useRef<Changes | null>(null),
    polling = useRef(false);
  current.current = changes;
  selectedRef.current = selected;
  function setBusy(value: boolean) {
    busyRef.current = value;
    if (value) ++refreshGeneration.current;
    setBusyState(value);
  }

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (isDesktop) {
      const load = request<Preferences>("preferences").then((prefs) => {
        savedPreferences.current = prefs;
        const visible = [
          ...pendingPreferences.current.values(),
        ].reduce<Preferences>(
          (next, partial) => ({ ...next, ...partial }),
          prefs,
        );
        preferenceState.current = visible;
        setPreferences(visible);
        return prefs;
      });
      preferenceLoad.current = load;
      void load.catch((e) => setError(asError(e)));
      void request<Workspace[]>("recent_workspaces")
        .then(setRecent)
        .catch((e) => setError(asError(e)));
    } else if (
      new URLSearchParams(window.location.search).get("demo") === "1"
    ) {
      setDemo(true);
      setChanges(demoChanges);
      setSelected(fileKey(demoChanges.files[0]));
      setDiff(demoDiff(demoChanges.files[0]));
      setLoaded({
        [fileKey(demoChanges.files[0])]: demoDiff(demoChanges.files[0]),
      });
    }
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    const update = () => {
      setNarrow(media.matches);
      setContextDrawer(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 780px)");
    const update = () => {
      setCompact(media.matches);
      setFilesDrawer(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    setFilesDrawer(false);
    setContextDrawer(false);
  }, [changes?.workspace.id]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        preferences.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : preferences.theme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences.theme]);
  useEffect(() => {
    if (notification) {
      const timer = window.setTimeout(() => setNotification(""), 5000);
      return () => window.clearTimeout(timer);
    }
  }, [notification]);
  const acceptChangesRef = useRef<(next: Changes) => Promise<void>>(
    async () => {},
  );
  const [syncing, setSyncing] = useState(false);
  const pollRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!isDesktop || demo || !changes) return;
    let timer = 0;
    const stop = watchWorkspace(
      changes.workspace.id,
      () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => pollRef.current(), 120);
      },
      (error) => setError(asError(error)),
    );
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [changes?.workspace.id, demo]);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const active = current.current;
      if (
        !isDesktop ||
        demo ||
        !active ||
        document.visibilityState === "hidden" ||
        polling.current ||
        busyRef.current
      )
        return;
      polling.current = true;
      const epoch = workspaceEpoch.current,
        generation = refreshGeneration.current;
      try {
        const next = await request<Changes>("changes", {
          workspaceId: active.workspace.id,
        });
        const selectedFile = next.files.find(
          (file) => fileKey(file) === selectedRef.current,
        );
        if (
          !cancelled &&
          epoch === workspaceEpoch.current &&
          generation === refreshGeneration.current &&
          !busyRef.current &&
          current.current?.workspace.id === next.workspace.id &&
          (current.current.token !== next.token ||
            (selectedFile && !cache.current.get(next, selectedFile)))
        ) {
          await acceptChangesRef.current(next);
        }
      } catch (e) {
        if (!cancelled && epoch === workspaceEpoch.current)
          setError(asError(e));
      } finally {
        polling.current = false;
      }
    };
    pollRef.current = () => void poll();
    const timer = window.setInterval(() => void poll(), 1200);
    const focus = () => void poll();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [demo]);

  async function loadFile(
    file: ChangedFile,
    workspace = current.current?.workspace,
    force = false,
  ) {
    const active = current.current;
    if (!workspace || !active || active.workspace.id !== workspace.id) return;
    const epoch = workspaceEpoch.current,
      seq = ++sequence.current;
    selectedRef.current = fileKey(file);
    setSelected(fileKey(file));
    const cached = !force && cache.current.get(active, file);
    if (cached) {
      setDiff(cached);
      setLoadingDiff(false);
      return;
    }
    // Keep the same file readable during a refresh. Never label the previous
    // file as the new selection while its contents are still loading.
    setDiff((d) => (d && fileKey(d) === fileKey(file) ? d : null));
    setLoadingDiff(true);
    try {
      const next = await cache.current.read(active, file, () =>
        workspace.id === "demo"
          ? Promise.resolve(demoDiff(file))
          : request<FileDiff>("file_diff", {
              workspaceId: workspace.id,
              path: file.path,
              side: file.side,
            }),
      );
      const now = current.current;
      if (
        epoch !== workspaceEpoch.current ||
        !now ||
        now.workspace.id !== workspace.id ||
        next.workspaceId !== workspace.id ||
        cache.current.version(active, file) !== cache.current.version(now, file)
      )
        return;
      cache.current.put(now, file, next);
      setLoaded(cache.current.values());
      if (seq === sequence.current) setDiff(next);
    } catch (e) {
      if (seq === sequence.current && epoch === workspaceEpoch.current) {
        const failure = asError(e);
        if (
          failure.code !== "STALE_CONTENT" &&
          failure.code !== "CHANGE_MISSING"
        )
          setError(failure);
        setDiff(null);
      }
    } finally {
      if (seq === sequence.current && epoch === workspaceEpoch.current)
        setLoadingDiff(false);
    }
  }
  async function acceptChanges(next: Changes, force = false) {
    current.current = next;
    setChanges(next);
    if (force) cache.current.clear();
    setLoaded(cache.current.retain(next));
    const file =
      next.files.find((file) => fileKey(file) === selectedRef.current) ??
      next.files.find((file) => file.path === diff?.path) ??
      next.files[0];
    if (file) {
      setSyncing(true);
      try {
        await loadFile(file, next.workspace, force);
      } finally {
        setSyncing(false);
      }
    } else {
      ++sequence.current;
      setSelected(null);
      selectedRef.current = null;
      setDiff(null);
      setLoadingDiff(false);
    }
  }
  acceptChangesRef.current = acceptChanges;

  async function openWorkspace(repositoryPath: string) {
    if (!repositoryPath.trim()) return;
    const epoch = ++workspaceEpoch.current;
    ++sequence.current;
    setBusy(true);
    setError(null);
    try {
      const workspace = await request<Workspace>("open_workspace", {
        path: repositoryPath,
      });
      if (epoch !== workspaceEpoch.current) return;
      const [next, projects] = await Promise.all([
        request<Changes>("changes", { workspaceId: workspace.id }),
        request<Workspace[]>("recent_workspaces"),
      ]);
      if (epoch !== workspaceEpoch.current) return;
      ++sequence.current;
      current.current = next;
      setDemo(false);
      setChanges(next);
      cache.current.clear();
      setDiff(null);
      setLoaded({});
      setSelected(null);
      setAmendTarget(null);
      setSearch("");
      setScope("all");
      setTab("changes");
      setRecent(projects);
      setDialog(null);
      try {
        setDraft(localStorage.getItem(`proof:draft:${workspace.id}`) ?? "");
      } catch {
        setDraft("");
      }
      if (next.files.length) await loadFile(next.files[0], workspace);
    } catch (e) {
      if (epoch === workspaceEpoch.current) setError(asError(e));
    } finally {
      if (epoch === workspaceEpoch.current) {
        setBusy(false);
        setLoadingDiff(false);
      }
    }
  }
  async function chooseFolder() {
    if (!isDesktop) {
      setDialog("open");
      return;
    }
    try {
      const result = await open({
        directory: true,
        multiple: false,
        title: "打开 Git 仓库",
      });
      if (typeof result === "string") await openWorkspace(result);
    } catch (e) {
      setError(asError(e));
    }
  }
  async function refresh() {
    const active = current.current;
    if (!active || active.workspace.id === "demo") return;
    const epoch = workspaceEpoch.current;
    setBusy(true);
    try {
      const next = await request<Changes>("changes", {
        workspaceId: active.workspace.id,
      });
      if (
        epoch === workspaceEpoch.current &&
        current.current?.workspace.id === next.workspace.id
      )
        await acceptChanges(next, true);
    } catch (e) {
      if (epoch === workspaceEpoch.current) setError(asError(e));
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  async function updatePreferences(partial: Partial<Preferences>) {
    const revision = ++preferenceRevision.current;
    pendingPreferences.current.set(revision, partial);
    const next = { ...preferenceState.current, ...partial };
    preferenceState.current = next;
    setPreferences(next);
    // Rapid reading toggles must compose and persist in the same order.
    const write = preferenceWrites.current
      .then(async () => {
        await preferenceLoad.current;
        const persisted = { ...savedPreferences.current, ...partial };
        if (isDesktop)
          await request("set_preferences", { preferences: persisted });
        savedPreferences.current = persisted;
        if (preferenceRevision.current === revision) {
          preferenceState.current = persisted;
          setPreferences(persisted);
        }
      })
      .catch((e) => {
        if (preferenceRevision.current === revision) {
          preferenceState.current = savedPreferences.current;
          setPreferences(savedPreferences.current);
        }
        setError(asError(e));
      })
      .finally(() => {
        pendingPreferences.current.delete(revision);
      });
    preferenceWrites.current = write;
    await write;
  }
  async function mark(
    hunkId: string | null,
    reviewed: boolean,
    confirmed = false,
  ) {
    const target = confirmed ? reviewTarget : diff;
    if (!target) return;
    if (confirmed && target.id !== diff?.id) return;
    if (
      reviewed &&
      preferences.ignoreWhitespace &&
      target.hunks.some(
        (hunk) =>
          (!hunkId || hunk.id === hunkId) && hiddenWhitespace(hunk).size > 0,
      )
    ) {
      setError({
        code: "HIDDEN_REVIEW_CONTENT",
        message: "此范围隐藏了空白变化，请显示全部真实变化后再标记已审查。",
        detail:
          "Review remains bound to the complete original Hunk, including whitespace.",
      });
      return;
    }
    if (!hunkId && reviewed && !confirmed) {
      setReviewTarget(target);
      setDialog("mark-file");
      return;
    }
    const epoch = workspaceEpoch.current;
    setBusy(true);
    try {
      if (!demo)
        await request("mark_reviewed", {
          snapshotId: target.id,
          hunkId,
          reviewed,
        });
      if (
        epoch !== workspaceEpoch.current ||
        current.current?.workspace.id !== target.workspaceId
      )
        return;
      const next: FileDiff = {
        ...target,
        hunks: target.hunks.map((h) =>
          !hunkId || h.id === hunkId
            ? { ...h, reviewState: reviewed ? "reviewed" : "unreviewed" }
            : h,
        ),
      };
      setDiff((d) => (d?.id === target.id ? next : d));
      if (current.current) cache.current.put(current.current, target, next);
      setLoaded(cache.current.values());
      setDialog(null);
    } catch (e) {
      if (epoch === workspaceEpoch.current)
        await snapshotError(e, target, epoch);
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  async function snapshotError(
    error: unknown,
    target: FileDiff,
    epoch: number,
  ) {
    const active = current.current;
    if (
      epoch !== workspaceEpoch.current ||
      !active ||
      active.workspace.id !== target.workspaceId
    )
      return;
    const failure = asError(error);
    if (["SNAPSHOT_EXPIRED", "STALE_CONTENT"].includes(failure.code)) {
      cache.current.remove(target, target.id);
      setLoaded(cache.current.values());
    }
    if (
      displayedDiff.current?.id !== target.id ||
      selectedRef.current !== fileKey(target)
    )
      return;
    setError(failure);
    if (!["SNAPSHOT_EXPIRED", "STALE_CONTENT"].includes(failure.code)) return;
    const file = active.files.find((file) => fileKey(file) === fileKey(target));
    if (file) {
      const expectedSequence = sequence.current + 1;
      await loadFile(file, active.workspace, true);
      if (
        epoch === workspaceEpoch.current &&
        sequence.current === expectedSequence &&
        current.current?.workspace.id === target.workspaceId
      ) {
        setError({
          ...failure,
          message: "Diff 已更新，请重新选择要操作的内容。",
        });
      }
    }
  }
  async function stage(hunkId: string | null) {
    if (!diff) return;
    const epoch = workspaceEpoch.current;
    const workspaceId = diff.workspaceId;
    setBusy(true);
    setError(null);
    try {
      const result = await request<OperationResult>("stage", {
        snapshotId: diff.id,
        hunkId,
      });
      if (
        epoch !== workspaceEpoch.current ||
        current.current?.workspace.id !== workspaceId
      )
        return;
      setNotification(result.message);
      if (result.warning)
        setError({
          code: "OPERATION_RECORD_WARNING",
          message: result.message,
          detail: result.warning,
        });
      await refresh();
    } catch (e) {
      if (
        epoch === workspaceEpoch.current &&
        current.current?.workspace.id === workspaceId
      )
        await snapshotError(e, diff, epoch);
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  async function stageFiles(files: ChangedFile[], side: "staged" | "unstaged") {
    const active = current.current;
    if (!active || busyRef.current || demo) return;
    const epoch = workspaceEpoch.current;
    setBusy(true);
    setError(null);
    try {
      const result = await request<OperationResult>("stage_files", {
        workspaceId: active.workspace.id,
        paths: files.map((file) => file.path),
        side,
        expectedToken: active.token,
      });
      if (epoch !== workspaceEpoch.current) return;
      setNotification(result.message);
      if (result.warning)
        setError({
          code: "STAGE_CHANGED",
          message: result.message,
          detail: result.warning,
        });
      await refresh();
    } catch (error) {
      if (epoch === workspaceEpoch.current) setError(asError(error));
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  async function switchBranch(name: string, create: boolean, remote?: string) {
    const active = current.current;
    if (!active || busyRef.current || demo) return false;
    const epoch = workspaceEpoch.current;
    setBusy(true);
    setError(null);
    try {
      const result = await request<OperationResult>("switch_branch", {
        workspaceId: active.workspace.id,
        name,
        create,
        remote,
        expectedToken: active.token,
      });
      if (epoch !== workspaceEpoch.current) return false;
      setNotification(result.message);
      await refresh();
      return result.ok;
    } catch (error) {
      if (epoch === workspaceEpoch.current) setError(asError(error));
      return false;
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  async function prepareDiscard(hunkId: string | null) {
    if (!diff || busy) return;
    const epoch = workspaceEpoch.current;
    const workspaceId = diff.workspaceId;
    setBusy(true);
    setError(null);
    try {
      const point = await request<RecoveryPoint>("discard_preview", {
        snapshotId: diff.id,
        hunkId,
      });
      if (
        epoch !== workspaceEpoch.current ||
        current.current?.workspace.id !== workspaceId
      )
        return;
      setDiscardPoint(point);
      setDialog("discard");
    } catch (e) {
      if (epoch === workspaceEpoch.current) await snapshotError(e, diff, epoch);
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  async function cancelDiscard() {
    if (busy || !discardPoint) return;
    const epoch = workspaceEpoch.current;
    setBusy(true);
    setError(null);
    try {
      await request("cancel_discard_preview", { recoveryId: discardPoint.id });
      if (epoch === workspaceEpoch.current) {
        setDiscardPoint(null);
        setDialog(null);
      }
    } catch (e) {
      if (epoch === workspaceEpoch.current) setError(asError(e));
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  async function confirmDiscard() {
    if (busy || !discardPoint) return;
    const epoch = workspaceEpoch.current;
    const workspaceId = discardPoint.workspaceId;
    setBusy(true);
    setError(null);
    try {
      const action = await request<RecoveryAction>("discard", {
        recoveryId: discardPoint.id,
      });
      if (
        epoch !== workspaceEpoch.current ||
        current.current?.workspace.id !== workspaceId
      )
        return;
      setNotification(action.result.message);
      if (action.result.warning)
        setError({
          code: "RECOVERY_WARNING",
          message: action.result.message,
          detail: action.result.warning,
        });
      setDiscardPoint(null);
      setDialog(action.result.ok ? null : "recovery");
      await refresh();
    } catch (e) {
      if (epoch === workspaceEpoch.current) setError(asError(e));
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  const prepareCommit = useCallback(async () => {
    if (!changes) return;
    const epoch = workspaceEpoch.current;
    setBusy(true);
    setError(null);
    try {
      const next = await request<CommitPreview>("commit_preview", {
        workspaceId: changes.workspace.id,
      });
      if (
        epoch !== workspaceEpoch.current ||
        current.current?.workspace.id !== next.workspaceId
      )
        return;
      setPreview(next);
      setDialog("commit");
    } catch (e) {
      if (
        epoch === workspaceEpoch.current &&
        current.current?.workspace.id === changes.workspace.id
      )
        setError(asError(e));
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }, [changes]);
  async function commit(prepared = preview) {
    if (!prepared) return;
    const epoch = workspaceEpoch.current;
    const workspaceId = prepared.workspaceId;
    setBusy(true);
    setError(null);
    try {
      const result = await request<OperationResult>("commit", {
        previewId: prepared.id,
        message: draft,
      });
      if (
        epoch !== workspaceEpoch.current ||
        current.current?.workspace.id !== workspaceId
      )
        return;
      if (result.ok) {
        setDraft("");
        setAmendTarget(null);
        try {
          localStorage.removeItem(`proof:draft:${prepared.workspaceId}`);
        } catch {
          /* Draft is already cleared in memory. */
        }
      }
      if (result.warning)
        setError({
          code: "COMMIT_RESULT_CHANGED",
          message: result.message,
          detail: result.warning,
        });
      setNotification(result.message);
      setDialog(null);
      await refresh();
    } catch (e) {
      if (
        epoch === workspaceEpoch.current &&
        current.current?.workspace.id === workspaceId
      )
        setError(asError(e));
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  function editDraft(message: string) {
    setDraft(message);
    if (!changes) return;
    try {
      localStorage.setItem(`proof:draft:${changes.workspace.id}`, message);
    } catch (error) {
      setError({
        code: "DRAFT_STORAGE",
        message: "Commit 草稿未保存，请保留当前窗口。",
        detail: String(error),
      });
    }
  }
  async function toggleAmend(value: boolean) {
    if (!value) {
      setAmendTarget(null);
      editDraft(normalDraft.current);
      return;
    }
    const active = current.current;
    if (!active || demo || busyRef.current || !active.head) return;
    const epoch = workspaceEpoch.current;
    setBusy(true);
    setError(null);
    try {
      const next = await request<CommitPreview>("commit_preview", {
        workspaceId: active.workspace.id,
        amend: true,
        coverage: false,
        expectedToken: active.token,
      });
      if (
        epoch !== workspaceEpoch.current ||
        next.head !== active.head ||
        next.branch !== active.branch
      )
        return;
      normalDraft.current = draft;
      setAmendTarget({ head: active.head, branch: active.branch });
      editDraft(next.message);
    } catch (error) {
      if (epoch === workspaceEpoch.current) setError(asError(error));
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  async function quickCommit(all: boolean) {
    const active = current.current;
    if (!active || busyRef.current || demo || !draft.trim()) return;
    const epoch = workspaceEpoch.current;
    setBusy(true);
    setError(null);
    try {
      let token = active.token;
      if (
        amendTarget &&
        (amendTarget.head !== active.head ||
          amendTarget.branch !== active.branch)
      )
        throw {
          code: "AMEND_TARGET_CHANGED",
          message: "上一条 Commit 已变化，请重新选择 Amend。",
          detail: "HEAD changed since Amend was selected",
        };
      if (all) {
        const paths = active.files
          .filter((file) => file.side === "unstaged")
          .map((file) => file.path);
        if (paths.length) {
          const result = await request<OperationResult & { token: string }>(
            "stage_files",
            {
              workspaceId: active.workspace.id,
              paths,
              side: "unstaged",
              expectedToken: token,
            },
          );
          if (epoch !== workspaceEpoch.current) return;
          if (!result.ok || result.warning)
            throw {
              code: "STAGE_CHANGED",
              message: result.message,
              detail: result.warning ?? "请检查 Index 后再 Commit。",
            };
          token = result.token;
        }
      }
      const next = await request<CommitPreview>("commit_preview", {
        workspaceId: active.workspace.id,
        amend: !!amendTarget,
        coverage: preferences.strictReview,
        expectedToken: token,
      });
      if (epoch !== workspaceEpoch.current) return;
      if (next.head !== active.head || next.branch !== active.branch)
        throw {
          code: "COMMIT_TARGET_CHANGED",
          message: "Branch 或 HEAD 已变化，请检查后再 Commit。",
          detail: "Commit target changed",
        };
      await commit(next);
    } catch (error) {
      if (epoch === workspaceEpoch.current) {
        setError(asError(error));
        await refresh();
      }
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  function startDemo() {
    ++workspaceEpoch.current;
    ++sequence.current;
    current.current = demoChanges;
    setBusy(false);
    setLoadingDiff(false);
    cache.current.clear();
    setDemo(true);
    setChanges(demoChanges);
    setDiff(demoDiff(demoChanges.files[0]));
    setLoaded({
      [fileKey(demoChanges.files[0])]: demoDiff(demoChanges.files[0]),
    });
    setSelected(fileKey(demoChanges.files[0]));
    setDialog(null);
    setError(null);
  }
  async function trustWorkspace() {
    const workspace = current.current?.workspace;
    if (!workspace) return;
    const epoch = workspaceEpoch.current;
    setBusy(true);
    try {
      await request("set_trust", { workspaceId: workspace.id, trusted: true });
      if (
        epoch !== workspaceEpoch.current ||
        current.current?.workspace.id !== workspace.id
      )
        return;
      setDialog(null);
      await refresh();
    } catch (error) {
      if (
        epoch === workspaceEpoch.current &&
        current.current?.workspace.id === workspace.id
      )
        setError(asError(error));
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
        return;
      const editing =
        event.target instanceof HTMLElement &&
        event.target.closest(
          'input,textarea,select,[contenteditable="true"]',
        ) !== null;
      if (event.key === "Escape" && !dialog) {
        if (contextDrawer) {
          setContextDrawer(false);
          document.getElementById("context-toggle")?.focus();
        } else if (filesDrawer) {
          setFilesDrawer(false);
          document.getElementById("files-toggle")?.focus();
        } else setFocused(false);
      }
      if (editing || busy || (dialog !== null && dialog !== "commands")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDialog((d) => (d === "commands" ? null : "commands"));
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setFocused(false);
        if (tab === "repository") {
          document
            .querySelector<HTMLInputElement>(
              ".workspace-page:not([hidden]) .graph-search input",
            )
            ?.focus();
        } else showFileSearch();
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        tab === "changes" &&
        event.key.toLowerCase() === "r"
      ) {
        event.preventDefault();
        setFocused((f) => !f);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [
    dialog,
    busy,
    tab,
    compact,
    filesDrawer,
    contextDrawer,
    repositoryLayout.ready,
    repositoryLayout.value.sidebarOpen,
    repositoryLayout.scopeKey,
    changes?.workspace.id,
  ]);

  const knownDiffs = Object.values(loaded).filter(
    (d) =>
      d.workspaceId === changes?.workspace.id &&
      changes?.files.some((f) => fileKey(f) === fileKey(d)),
  );
  const knownUnits = knownDiffs.flatMap((d) => d.hunks),
    reviewedUnits = knownUnits.filter(
      (h) => h.reviewState === "reviewed",
    ).length;
  const stagedCount =
    changes?.files.filter((f) => f.side === "staged").length ?? 0;
  const contextOpen =
    !focused &&
    (narrow
      ? contextDrawer
      : (repositoryLayout.value.contextOpen ?? preferences.contextOpen));
  const sidebarVisible =
    !focused && (compact ? filesDrawer : repositoryLayout.value.sidebarOpen);
  function showFileSearch() {
    setFocused(false);
    setTab("changes");
    if (compact) {
      setFilesDrawer(true);
      setContextDrawer(false);
    } else if (!repositoryLayout.value.sidebarOpen)
      void repositoryLayout.update({ sidebarOpen: true });
    requestAnimationFrame(() =>
      document.getElementById("file-search")?.focus(),
    );
  }
  function closeFiles() {
    if (compact) setFilesDrawer(false);
    else void repositoryLayout.update({ sidebarOpen: false });
    requestAnimationFrame(() =>
      document.getElementById("files-toggle")?.focus(),
    );
  }
  function closeContext() {
    if (narrow) setContextDrawer(false);
    else void repositoryLayout.update({ contextOpen: false });
    requestAnimationFrame(() =>
      document.getElementById("context-toggle")?.focus(),
    );
  }
  function openSettings(
    section: "appearance" | "review" | "observer" | "data" = "appearance",
  ) {
    setSettingsSection(section);
    setDialog("settings");
  }
  function showRepository(section: RepositorySection) {
    setRepositorySection(section);
    setTab("repository");
  }
  return (
    <div className={`app layout-enabled ${focused ? "is-focused" : ""}`}>
      <header className="app-header">
        <a
          className="brand"
          href="#"
          aria-label="Proof 首页"
          onClick={(e) => {
            e.preventDefault();
            if (changes) setTab("changes");
          }}
        >
          <ProofMark />
          <span>Proof</span>
        </a>
        <span className="header-divider" />
        <button className="workspace-picker" onClick={() => setDialog("open")}>
          <FolderOpen size={17} />
          <strong>{changes?.workspace.name ?? "打开仓库"}</strong>
          <CaretDown size={12} />
        </button>
        {changes && (
          <BranchPicker
            key={changes.workspace.id}
            changes={changes}
            demo={demo}
            busy={busy}
            onSwitch={switchBranch}
          />
        )}
        {changes && (
          <nav
            className="top-navigation"
            aria-label="Worktree"
            style={
              {
                "--nav-index":
                  tab === "changes"
                    ? 0
                    : repositorySection === "history"
                      ? 1
                      : 2,
              } as React.CSSProperties
            }
          >
            <button
              className={tab === "changes" ? "active" : ""}
              aria-current={tab === "changes" ? "page" : undefined}
              onClick={() => setTab("changes")}
            >
              Changes<span className="tab-count">{changes.files.length}</span>
            </button>
            <button
              className={
                tab === "repository" && repositorySection === "history"
                  ? "active"
                  : ""
              }
              aria-current={
                tab === "repository" && repositorySection === "history"
                  ? "page"
                  : undefined
              }
              onClick={() => showRepository("history")}
            >
              History
            </button>
            <button
              className={
                tab === "repository" && repositorySection !== "history"
                  ? "active"
                  : ""
              }
              aria-current={
                tab === "repository" && repositorySection !== "history"
                  ? "page"
                  : undefined
              }
              onClick={() => showRepository("branches")}
            >
              Branches
            </button>
          </nav>
        )}
        <div className="toolbar-spacer" />
        {demo && <span className="demo-badge">演示数据</span>}
        {changes && (
          <button
            className="icon-button"
            disabled={busy}
            aria-label="刷新 Worktree"
            title="刷新本地 Worktree"
            onClick={() => {
              void refresh();
            }}
          >
            <ArrowClockwise size={17} className={busy ? "spinning" : ""} />
          </button>
        )}
        <button
          className="observer-status"
          onClick={() => openSettings("observer")}
        >
          <span className="status-dot neutral" />
          Connect agent
        </button>
        <button
          className="command-trigger"
          title="命令面板"
          aria-label="打开命令面板"
          onClick={() => setDialog("commands")}
        >
          <MagnifyingGlass size={15} />
          <span>Command</span>
          <kbd>⌘ K</kbd>
        </button>
        <button
          className="icon-button"
          aria-label="设置"
          title="设置"
          onClick={() => openSettings()}
        >
          <GearSix size={19} />
        </button>
      </header>
      {changes ? (
        <>
          {demo && (
            <div className="demo-notice">
              <Info size={15} />
              当前为虚构的 demo-service 界面演示。审查标记仅用于体验，Git
              写操作不可用。
              <button
                onClick={() => {
                  void chooseFolder();
                }}
              >
                打开真实仓库
              </button>
            </div>
          )}
          {!changes.workspace.trusted && !demo && (
            <div className="trust-banner">
              <ShieldCheck size={17} />
              <span>
                受限查看。信任此仓库后，可暂存和提交；Git
                Hook、签名及过滤器可能执行。
              </span>
              <button
                className="button compact"
                onClick={() => setDialog("trust")}
              >
                审阅信任设置
              </button>
            </div>
          )}
          {changes.operation && (
            <div className="trust-banner">
              <Warning size={16} />
              {changes.operation} 进行中。请在外部完成当前流程后刷新。
            </div>
          )}
        </>
      ) : null}
      {error && (
        <div className="error-banner" role="alert">
          <Warning size={18} />
          <div>
            <strong>{error.message}</strong>
            <details>
              <summary>{error.code} · 查看详情</summary>
              <pre>{error.detail}</pre>
            </details>
          </div>
          <button
            className="icon-button"
            aria-label="关闭错误提示"
            onClick={() => setError(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {changes && repositoryLayout.error && dialog !== "settings" && (
        <div className="layout-error-banner" role="alert">
          <Warning size={16} />
          <span>
            {repositoryLayout.ready
              ? repositoryLayout.saving
                ? "有布局调整未保存，其余调整仍在保存。"
                : "有布局调整未保存，当前显示已保存的值。"
              : "无法读取此仓库布局。"}{" "}
            {repositoryLayout.error.message}
          </span>
          <button
            onClick={() =>
              repositoryLayout.ready
                ? openSettings()
                : void repositoryLayout.retry()
            }
          >
            {repositoryLayout.ready ? "布局设置" : "重试读取"}
          </button>
        </div>
      )}
      {!changes ? (
        <main className="welcome">
          <div className="welcome-main">
            <ProofMark large />
            <p className="welcome-kicker">Git, with context.</p>
            <h1>打开仓库，开始工作</h1>
            <p className="welcome-description">
              查看 Diff、管理 Branch、提交代码。
              <br />
              按需关联 Agent 的修改记录。
            </p>
            <button
              className="button primary welcome-open"
              onClick={() => {
                void chooseFolder();
              }}
              disabled={busy}
            >
              <FolderOpen size={19} />
              打开本地仓库
            </button>
            <button className="demo-link" onClick={startDemo}>
              体验演示 Worktree <ArrowRight size={15} />
            </button>
            <div className="welcome-principles">
              <span>
                <Check size={14} />
                无需账号
              </span>
              <span>
                <Check size={14} />
                本地优先
              </span>
              <span>
                <Check size={14} />
                人工决定
              </span>
            </div>
          </div>
          {recent.length > 0 && (
            <div className="recent-projects">
              <h2>最近打开</h2>
              {recent.map((w) => (
                <button
                  key={w.id}
                  onClick={() => {
                    void openWorkspace(w.path);
                  }}
                >
                  <FolderOpen size={18} />
                  <span>
                    <strong>{w.name}</strong>
                    <small>{w.path}</small>
                  </span>
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
          )}
          <footer className="welcome-footer">
            Proof <span>本地代码审查工作台</span>
            <span className="version">0.1.0 Alpha</span>
          </footer>
        </main>
      ) : (
        <>
          <div className="workspace-page" hidden={tab !== "repository"}>
            {(repositoryVisited || tab === "repository") && (
              <RepositoryView
                key={changes.workspace.id}
                section={repositorySection}
                onSection={setRepositorySection}
                error={error}
                changes={changes}
                demo={demo}
                onOpen={openWorkspace}
                onError={(e) => {
                  if (current.current?.workspace.id === changes.workspace.id)
                    setError(asError(e));
                }}
                onChanged={refresh}
              />
            )}
          </div>
          <div className="workspace-page" hidden={tab !== "changes"}>
            <ResizableWorkbench
              layout={repositoryLayout.value}
              scopeKey={repositoryLayout.scopeKey}
              enabled={repositoryLayout.ready}
              active={tab === "changes" && dialog === null}
              sidebarVisible={sidebarVisible && !compact}
              contextDocked={contextOpen && !narrow}
              onChange={(partial) => {
                void repositoryLayout.update(partial);
              }}
              onCollapse={(side) =>
                side === "sidebarWidth" ? closeFiles() : closeContext()
              }
              sidebar={
                <aside
                  id="files-panel"
                  aria-label="变化文件"
                  hidden={!sidebarVisible}
                  className={`files-panel ${compact ? "files-drawer" : ""}`}
                  onBlurCapture={(event) => {
                    if (compact && shouldDismissDrawer(event))
                      setFilesDrawer(false);
                  }}
                >
                  <button
                    className="icon-button files-close"
                    aria-label="收起文件栏"
                    onClick={closeFiles}
                    disabled={!compact && !repositoryLayout.ready}
                  >
                    <X size={15} />
                  </button>
                  <FileTree
                    key={changes.workspace.id}
                    disabled={
                      busy ||
                      demo ||
                      !changes.workspace.trusted ||
                      !!changes.operation
                    }
                    onStage={(files, side) => void stageFiles(files, side)}
                    files={changes.files}
                    selected={selected}
                    onSelect={(f) => {
                      void loadFile(f);
                      if (compact) {
                        setFilesDrawer(false);
                        requestAnimationFrame(() =>
                          document
                            .querySelector<HTMLElement>(
                              ".workspace-page:not([hidden]) .diff-scroll",
                            )
                            ?.focus(),
                        );
                      }
                    }}
                    search={search}
                    onSearch={setSearch}
                    loaded={loaded}
                    scope={scope}
                    onScope={setScope}
                  />
                  <CommitComposer
                    message={draft}
                    onMessage={editDraft}
                    amend={!!amendTarget}
                    onAmend={(value) => void toggleAmend(value)}
                    head={changes.head}
                    branch={changes.branch}
                    staged={stagedCount}
                    unstaged={
                      changes.files.filter((file) => file.side === "unstaged")
                        .length
                    }
                    busy={busy}
                    disabled={
                      demo || !changes.workspace.trusted || !!changes.operation
                    }
                    demo={demo}
                    strictReview={preferences.strictReview}
                    onReviewSettings={() => openSettings("review")}
                    onCommit={(all) => void quickCommit(all)}
                  />
                </aside>
              }
              context={
                contextOpen && (
                  <ContextInspector
                    diff={diff}
                    demo={demo}
                    drawer={narrow}
                    closeDisabled={!narrow && !repositoryLayout.ready}
                    onClose={closeContext}
                    onLeave={() => setContextDrawer(false)}
                    onSettings={() => openSettings("observer")}
                  />
                )
              }
            >
              <div className="center-panel">
                {diff ? (
                  <DiffView
                    key={`${diff.workspaceId}:${diff.path}:${diff.side}`}
                    diff={diff}
                    preferences={preferences}
                    pending={busy || loadingDiff}
                    onMark={(h, r) => {
                      void mark(h, r);
                    }}
                    onStage={(h) => {
                      void stage(h);
                    }}
                    onDiscard={(h) => {
                      void prepareDiscard(h);
                    }}
                    onHistory={
                      demo ? undefined : () => setDialog("file-history")
                    }
                    onPreferences={(p) => {
                      void updatePreferences(p);
                    }}
                    onLoadContext={async (contextLines) => {
                      const epoch = workspaceEpoch.current;
                      try {
                        return demo
                          ? demoDiffContext(diff, contextLines)
                          : await request<DiffContext>("diff_context", {
                              snapshotId: diff.id,
                              contextLines,
                            });
                      } catch (error) {
                        await snapshotError(error, diff, epoch);
                        throw error;
                      }
                    }}
                    onFocus={() => setFocused((f) => !f)}
                  />
                ) : (
                  <div className="empty-diff">
                    <div className="empty-symbol">
                      <Check size={30} />
                    </div>
                    <h2>
                      {changes.files.length
                        ? "选择文件查看 Diff"
                        : "当前没有代码变化"}
                    </h2>
                    <p>
                      {changes.files.length
                        ? "选择左侧文件查看 Diff。"
                        : "Worktree clean"}
                    </p>
                    {!changes.files.length && (
                      <button
                        className="button"
                        onClick={() => showRepository("history")}
                      >
                        查看提交历史
                      </button>
                    )}
                  </div>
                )}
                {loadingDiff && (
                  <div
                    className={`diff-loading ${diff ? "background" : ""}`}
                    role="status"
                  >
                    <ArrowClockwise size={14} className="spinning" />{" "}
                    {diff ? "更新中…" : "载入 Diff…"}
                  </div>
                )}
              </div>
            </ResizableWorkbench>
          </div>
        </>
      )}
      {changes && tab === "changes" && (
        <footer className="app-footer">
          <div className="review-progress">
            <span
              className="progress-circle"
              style={
                {
                  "--progress": `${knownUnits.length ? (reviewedUnits / knownUnits.length) * 100 : 0}%`,
                } as React.CSSProperties
              }
            />
            <span>
              Review{" "}
              <strong>
                {reviewedUnits}/{knownUnits.length}
              </strong>{" "}
              hunks reviewed
            </span>
          </div>
          <div className="toolbar-spacer" />
          {focused && (
            <button
              className="button subtle compact"
              onClick={() => setFocused(false)}
            >
              退出专注
            </button>
          )}
          <button
            id="files-toggle"
            className="icon-button"
            aria-label={sidebarVisible ? "收起文件栏" : "显示文件栏"}
            aria-expanded={sidebarVisible}
            aria-controls="files-panel"
            title="文件栏 · ⌘/Ctrl P 搜索"
            disabled={!compact && !repositoryLayout.ready}
            onClick={() => {
              if (sidebarVisible) closeFiles();
              else showFileSearch();
            }}
          >
            <List size={18} />
          </button>
          <button
            id="context-toggle"
            className="icon-button"
            aria-label={contextOpen ? "收起上下文" : "显示上下文"}
            title="Context 面板"
            aria-expanded={contextOpen}
            aria-controls="context-panel"
            disabled={!narrow && !repositoryLayout.ready}
            onClick={() => {
              if (contextOpen) {
                closeContext();
                return;
              }
              setFocused(false);
              if (narrow) {
                setContextDrawer(true);
                setFilesDrawer(false);
              } else
                void repositoryLayout.update({
                  contextOpen: true,
                });
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLButtonElement>(
                    "#context-panel .context-header button",
                  )
                  ?.focus(),
              );
            }}
          >
            <SidebarSimple size={18} />
          </button>
          {diff && (
            <button
              className="button compact"
              disabled={!diff.canStage || busy || loadingDiff}
              title={
                !diff.canStage
                  ? "此文件当前不支持 Git 写操作"
                  : "操作当前整个文件"
              }
              onClick={() => {
                void stage(null);
              }}
            >
              {diff.side === "staged" ? (
                <Minus size={15} />
              ) : (
                <Plus size={15} />
              )}
              {diff.side === "staged" ? "Unstage file" : "Stage file"}
            </button>
          )}
          <button
            className="icon-button"
            aria-label="打开丢弃恢复点"
            title="丢弃恢复点"
            disabled={busy || demo}
            onClick={() => {
              setError(null);
              setDialog("recovery");
            }}
          >
            <ClockCounterClockwise size={18} />
          </button>
          {diff?.side === "unstaged" && (
            <button
              className="icon-button"
              aria-label="预览丢弃文件"
              title={
                diff.canDiscard
                  ? "预览丢弃整个文件的未暂存变化"
                  : (diff.discardReason ?? "当前不能丢弃")
              }
              disabled={busy || !diff.canDiscard}
              onClick={() => void prepareDiscard(null)}
            >
              <Trash size={18} />
            </button>
          )}
          <button
            className="button primary compact"
            disabled={busy}
            onClick={() => {
              showFileSearch();
              requestAnimationFrame(() =>
                document.getElementById("quick-commit-message")?.focus(),
              );
            }}
          >
            <GitCommit size={16} />
            Commit<span className="button-count">{stagedCount}</span>
          </button>
        </footer>
      )}
      {notification && (
        <div className="toast" role="status">
          <Check size={16} />
          {notification}
        </div>
      )}
      {dialog === "file-history" && diff && (
        <FileHistory
          key={`${diff.workspaceId}:${diff.path}`}
          workspaceId={diff.workspaceId}
          path={diff.path}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "recovery" && changes && (
        <RecoveryDialog
          key={changes.workspace.id}
          workspaceId={changes.workspace.id}
          onClose={() => setDialog(null)}
          onChanged={() => {
            void refresh();
          }}
        />
      )}
      {dialog === "discard" && discardPoint && (
        <Modal
          title="确认丢弃未暂存变化"
          error={error}
          onClose={() => void cancelDiscard()}
        >
          <div className="discard-scope">
            <strong>{discardPoint.path}</strong>
            <p>{discardPoint.scope}</p>
          </div>
          <p>
            恢复点已经保存。确认后，所选 Worktree 内容会还原到索引中的版本。
          </p>
          <p className="inline-help">
            恢复内容保留至 {new Date(discardPoint.expiresAt).toLocaleString()}
            ，总计上限 256 MiB。撤销时若文件已有新改动，Proof
            会停止恢复并保留副本。
          </p>
          <div className="modal-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => void cancelDiscard()}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void confirmDiscard()}
            >
              {busy ? "正在核对…" : "确认丢弃所选变化"}
            </button>
          </div>
        </Modal>
      )}
      {dialog === "open" && (
        <Modal title="打开仓库" error={error} onClose={() => setDialog(null)}>
          <p className="modal-intro">
            选择已有 Git 仓库，或输入仓库内的目录路径。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void openWorkspace(path);
            }}
          >
            <label className="field-label" htmlFor="repository-path">
              本地目录
            </label>
            <div className="path-input">
              <input
                id="repository-path"
                autoFocus
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/Users/you/code/project"
              />
              <button
                type="button"
                className="button"
                onClick={() => {
                  void chooseFolder();
                }}
                disabled={!isDesktop}
              >
                <FolderOpen size={16} />
                选择
              </button>
            </div>
            <div className="dialog-recent">
              {recent.map((w) => (
                <button
                  type="button"
                  key={w.id}
                  onClick={() => {
                    void openWorkspace(w.path);
                  }}
                >
                  <FolderOpen size={17} />
                  <span>
                    <strong>{w.name}</strong>
                    <small>{w.path}</small>
                  </span>
                </button>
              ))}
            </div>
            {!isDesktop && (
              <p className="inline-help">
                浏览器无法读取本地 Git。请运行桌面应用，或体验虚构演示。
              </p>
            )}
            <div className="modal-actions">
              <button
                className="button subtle"
                type="button"
                onClick={startDemo}
              >
                体验演示
              </button>
              <button
                className="button primary"
                disabled={!isDesktop || !path.trim() || busy}
              >
                打开仓库
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === "trust" && changes && (
        <Modal title="信任此仓库" error={error} onClose={() => setDialog(null)}>
          <div className="trust-summary">
            <ShieldCheck size={28} />
            <strong>{changes.workspace.name}</strong>
            <code>{changes.workspace.path}</code>
          </div>
          <p>
            执行暂存、提交和分支操作时，Git 可能运行此仓库及你的 Git
            配置中的过滤器、Hook 和签名程序。
          </p>
          <p className="inline-help">
            此选择保存在 Proof 本地。不会修改 safe.directory、现有 Hook 或全局
            Git 配置。
          </p>
          <div className="modal-actions">
            <button className="button" onClick={() => setDialog(null)}>
              继续受限查看
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                void trustWorkspace();
              }}
            >
              信任并启用 Git 操作
            </button>
          </div>
        </Modal>
      )}
      {dialog === "mark-file" && reviewTarget && (
        <Modal
          title="标记整个文件已审查"
          error={error}
          onClose={() => setDialog(null)}
        >
          <p>
            此标记覆盖 <strong>{reviewTarget.path}</strong> 当前完整 Diff 的{" "}
            <strong>{reviewTarget.hunks.length} 个变化块</strong>
            ，包含尚未滚动到的内容。
          </p>
          <p className="inline-help">
            只记录你对这个版本的人工审查，不会 Stage 文件或改变测试状态。
          </p>
          {diff?.id !== reviewTarget.id && (
            <p role="status" className="inline-help">
              文件已更新，请关闭此窗口并重新选择 Review 范围。
            </p>
          )}
          <div className="modal-actions">
            <button className="button" onClick={() => setDialog(null)}>
              继续逐段阅读
            </button>
            <button
              className="button primary"
              disabled={busy || diff?.id !== reviewTarget.id || loadingDiff}
              onClick={() => {
                void mark(null, true, true);
              }}
            >
              确认已审查全部内容
            </button>
          </div>
        </Modal>
      )}
      {dialog === "commit" && preview && (
        <Modal
          title="提交预览"
          error={error}
          onClose={() => {
            if (!busy) setDialog(null);
          }}
          wide
        >
          <div className="commit-target">
            <GitBranch size={17} />
            <strong>{preview.branch ?? "Detached HEAD"}</strong>
            <span>{preview.files.length} staged files</span>
            <code>{preview.head?.slice(0, 8) ?? "首次提交"}</code>
          </div>
          <div className="commit-files">
            {preview.files.map((f) => (
              <div key={fileKey(f)}>
                <span className={`file-status status-${f.status}`}>
                  {f.status}
                </span>
                <span>{f.path}</span>
              </div>
            ))}
          </div>
          <div
            className={`commit-coverage ${preview.reviewed === preview.total ? "complete" : ""}`}
          >
            <Info size={16} />
            {preview.reviewed}/{preview.total} hunks reviewed.
            {preview.reviewed !== preview.total
              ? "未审查内容也会包含在本次提交中。"
              : "此状态只代表人工审查记录。"}
          </div>
          <label className="field-label" htmlFor="commit-message">
            提交说明
          </label>
          <textarea
            id="commit-message"
            autoFocus
            rows={4}
            value={draft}
            placeholder="描述这次修改的目的…"
            onChange={(e) => {
              setDraft(e.target.value);
              try {
                localStorage.setItem(
                  `proof:draft:${preview.workspaceId}`,
                  e.target.value,
                );
              } catch (error) {
                setError({
                  code: "DRAFT_STORAGE",
                  message: "提交草稿未能持久保存，请保留当前窗口。",
                  detail: String(error),
                });
              }
            }}
          />
          <p className="inline-help">
            <ShieldCheck size={14} />
            Git Hook 与签名将按现有配置执行。只提交已暂存内容。
          </p>
          <div className="modal-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => setDialog(null)}
            >
              返回审查
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                !draft.trim() ||
                (preferences.strictReview && preview.reviewed !== preview.total)
              }
              onClick={() => {
                void commit();
              }}
            >
              <GitCommit size={16} />
              {busy ? "正在提交…" : "确认提交"}
            </button>
          </div>
        </Modal>
      )}
      {changes && (
        <div className="workspace-statusbar">
          <span className="workspace-path" title={changes.workspace.path}>
            {changes.workspace.path}
          </span>
          <span>
            <GitBranch size={12} />
            {changes.branch ?? "Detached HEAD"}
          </span>
          <span className="live-status">
            <span className={`status-dot ${syncing ? "neutral" : ""}`} />
            {syncing ? "更新中" : "Live"}
          </span>
        </div>
      )}
      {dialog === "settings" && (
        <Settings
          initialSection={settingsSection}
          workspaces={recent}
          workspaceId={changes?.workspace.id}
          demo={demo}
          error={error}
          preferences={preferences}
          layout={
            changes
              ? {
                  snapshot: repositoryLayout,
                  name: changes.workspace.name,
                  key: repositoryLayout.scopeKey,
                  onChange: (partial) => {
                    void repositoryLayout.update(partial);
                  },
                  onReset: () => {
                    void repositoryLayout.reset();
                  },
                  onRetry: () => {
                    void repositoryLayout.retry();
                  },
                }
              : undefined
          }
          onChange={updatePreferences}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "commands" && (
        <Modal title="命令面板" onClose={() => setDialog(null)}>
          <div className="command-list">
            {[
              {
                label: "打开本地仓库",
                icon: <FolderOpen size={19} />,
                run: () => {
                  setDialog(null);
                  void chooseFolder();
                },
              },
              {
                label: "搜索变化文件",
                icon: <MagnifyingGlass size={19} />,
                run: () => {
                  setDialog(null);
                  showFileSearch();
                },
                disabled: !changes,
              },
              {
                label: "刷新 Worktree",
                icon: <ArrowClockwise size={19} />,
                run: () => {
                  setDialog(null);
                  void refresh();
                },
                disabled: !changes,
              },
              {
                label: "提交预览",
                icon: <GitCommit size={19} />,
                run: () => {
                  setDialog(null);
                  void prepareCommit();
                },
                disabled: !stagedCount || demo,
              },
              {
                label: focused ? "退出专注审查" : "进入专注审查",
                icon: <Check size={19} />,
                run: () => {
                  setDialog(null);
                  setFocused(!focused);
                },
                disabled: !changes,
              },
              {
                label: "观察与偏好设置",
                icon: <GearSix size={19} />,
                run: () => openSettings(),
              },
            ].map((action) => (
              <button
                key={action.label}
                onClick={action.run}
                disabled={action.disabled}
              >
                {action.icon}
                <span>{action.label}</span>
                {action.disabled && <small>当前不可用</small>}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

export function ProofMark({ large = false }: { large?: boolean }) {
  return (
    <svg
      className={`proof-mark ${large ? "large" : ""}`}
      width={large ? 58 : 27}
      height={large ? 58 : 27}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <path
        d="M10 9H7v14h3M22 9h3v14h-3"
        stroke="var(--brand-ink,white)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m11.5 16 3 3 6-7"
        stroke="var(--brand-ink,white)"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
