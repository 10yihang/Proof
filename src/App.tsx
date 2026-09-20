import { CommandList } from "./components/CommandList";
import proofIcon from "../src-tauri/icons/128x128@2x.png";
import { APP_VERSION } from "./version";
import { useHotkeys } from "react-hotkeys-hook";
import { Tabs } from "@base-ui/react/tabs";
import {
  createWindowUI,
  useWindowField,
  reorderComparisonTabs,
} from "./window-ui";
import { toast } from "./components/ui/toast";
import { Button, Select, Input, Textarea } from "./components/ui/controls";
import { uiMessage, t, getLanguage } from "./i18n";
import { DiffLoading } from "./components/DiffLoading";
import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  ArrowSquareOut,
} from "@phosphor-icons/react";
import {
  asError,
  isDesktop,
  useRequest,
  useReadRequest,
  useClientStorage,
  watchWorkspace,
} from "./api";
import { demoChanges, demoDiff, demoDiffContext } from "./demo";
import { hiddenWhitespace } from "./diff-reading";
import { defaultPreferences, fileKey, readTarget } from "./types";
import type {
  ChangedFile,
  Changes,
  CommitPreview,
  FileDiff,
  DiffRead,
  DiffSummary,
  DiffContext,
  OperationResult,
  Preferences,
  ProofError,
  Workspace,
  RecoveryPoint,
  RecoveryAction,
  EditorOpenResult,
} from "./types";
import { HistoryDiff, type HistoryComparison } from "./components/HistoryDiff";
import { DiffView } from "./components/DiffView";
import { useAi, type DiffJump } from "./ai";
import { AiReviewPanel } from "./components/AiReviewPanel";
import { DiffFilePane } from "./components/DiffFilePane";
import { DeferredDiff } from "./components/DeferredDiff";
import { ContextInspector } from "./components/ContextInspector";
import { Modal } from "./components/Modal";
import { RepositoryView } from "./components/RepositoryView";
import type { RepositorySection } from "./components/RepositoryView";
import { Settings } from "./components/Settings";
import { RecoveryDialog } from "./components/RecoveryDialog";
import { FileHistory } from "./components/FileHistory";
import { ResizableWorkbench } from "./components/ResizableWorkbench";
import { useRepositoryLayout } from "./use-repository-layout";
import { DiffCache, matchesGitBase } from "./diff-cache";
import { WorkspaceRefresh, type RefreshResult } from "./workspace-refresh";
import { BranchPicker } from "./components/BranchPicker";
import { useHistoryActions } from "./components/HistoryActions";
import { CommitComposer } from "./components/CommitComposer";
import { CommitWorkspace } from "./components/CommitWorkspace";
import { shouldDismissDrawer } from "./components/panel-focus";
import { isMacDesktop, useWindowMenu } from "./use-window-menu";
import { WorkspaceTabs, type WorkspaceView } from "./components/WorkspaceTabs";

type EditorTarget = Pick<FileDiff, "id" | "workspaceId" | "path" | "side">;

export default function App({
  initialWorkspaceId,
  initialFile,
  initialComparison,
  diffWindow = false,
  initialDataNotice,
  onWorkspaceChange,
}: {
  initialWorkspaceId?: string;
  initialFile?: { path: string; side: "staged" | "unstaged" };
  initialComparison?: HistoryComparison;
  diffWindow?: boolean;
  initialDataNotice?: string;
  onWorkspaceChange?: (id?: string) => void;
} = {}) {
  const [windowUI] = useState(() =>
    createWindowUI(initialDataNotice ? "settings" : null),
  );
  const request = useRequest();
  const fileReader = useReadRequest();
  const contextReader = useReadRequest();
  const readIntent = useRef<string | null>(null);
  const cancelledRead = useRef<string | null>(null);
  const clientStorage = useClientStorage();
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
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  function showReading(read: DiffRead | null) {
    setDiff(read?.state === "ready" ? read.diff : null);
    setSummary(read?.state === "deferred" ? read.summary : null);
  }
  const displayedDiff = useRef<FileDiff | null>(null);
  displayedDiff.current = diff;
  const [inspectorTab, setInspectorTab] = useWindowField(
    windowUI,
    "inspectorTab",
  );
  const [aiJump, setAiJump] = useState<DiffJump | null>(null);
  const [reviewTarget, setReviewTarget] = useState<FileDiff | null>(null);
  const [commandTarget, setCommandTarget] = useState<EditorTarget | null>(null);
  const [loaded, setLoaded] = useState<Record<string, FileDiff>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<ProofError | null>(null);
  const [busy, setBusyState] = useState(false),
    [loadingDiff, setLoadingDiff] = useState(false);
  const [dialog, setDialog] = useWindowField(windowUI, "dialog");
  const [tab, setTab] = useWindowField(windowUI, "tab");
  const [diffTabs, setDiffTabs] = useWindowField(windowUI, "diffTabs");
  const historyTab = useRef<HTMLButtonElement>(null);
  function openHistoryDiff(selection: HistoryComparison) {
    if (!changes) return;
    const id =
      `diff:${selection.base ?? "commit"}:${selection.target}` as const;
    setDiffTabs((previous) =>
      previous.some(
        (t) => t.id === id && t.workspaceId === changes.workspace.id,
      )
        ? previous.map((t) =>
            t.id === id && t.workspaceId === changes.workspace.id
              ? { ...t, selection }
              : t,
          )
        : [
            ...previous
              .filter((t) => t.workspaceId === changes.workspace.id)
              .slice(-7),
            { id, workspaceId: changes.workspace.id, selection },
          ],
    );
    setFocused(false);
    setTab(id);
    requestAnimationFrame(() => {
      const button = document.querySelector<HTMLButtonElement>(
        ".diff-tab-item.active .diff-tab-button",
      );
      button?.focus();
      button
        ?.closest(".diff-tab-item")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
  function closeDiffTab(id: string) {
    if (diffWindow) {
      void getCurrentWindow()
        .close()
        .catch((error) => setError(asError(error)));
      return;
    }
    const origin = document.activeElement;
    setDiffTabs((previous) => previous.filter((t) => t.id !== id));
    if (tab === id) {
      setTab("repository");
      setRepositorySection("history");
      requestAnimationFrame(() => {
        // Do not overwrite a newer keyboard or pointer focus after closing.
        const active = document.activeElement;
        if (
          !active ||
          active === document.body ||
          active === document.documentElement ||
          active === origin
        )
          historyTab.current?.focus();
      });
    }
  }
  useWindowMenu(
    () => {
      if (tab.startsWith("diff:")) closeDiffTab(tab);
      else
        void getCurrentWindow()
          .close()
          .catch((error) => setError(asError(error)));
    },
    (error) => setError(asError(error)),
  );
  useEffect(() => {
    if (!tab.startsWith("diff:")) return;
    const item = document.querySelector<HTMLElement>(".diff-tab-item.active");
    const strip = item?.parentElement;
    if (!item || !strip) return;
    const reveal = () =>
      item.scrollIntoView({ block: "nearest", inline: "nearest" });
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    reveal();
    return () => observer.disconnect();
  }, [tab]);
  useEffect(() => {
    setDiffTabs((previous) =>
      previous.filter((t) => t.workspaceId === changes?.workspace.id),
    );
    if (
      tab.startsWith("diff:") &&
      !diffTabs.some(
        (item) => item.id === tab && item.workspaceId === changes?.workspace.id,
      )
    ) {
      setTab("repository");
      setRepositorySection("history");
    }
  }, [changes?.workspace.id]);
  const [repositoryVisited, setRepositoryVisited] = useState(false);
  const [commitVisited, setCommitVisited] = useState(false);
  const [settingsSection, setSettingsSection] = useState<
    | "appearance"
    | "review"
    | "observer"
    | "data"
    | "editor"
    | "diagnostics"
    | "agents"
  >(initialDataNotice ? "data" : "appearance");
  const [repositorySection, setRepositorySection] = useWindowField(
    windowUI,
    "repositorySection",
  );
  useEffect(() => {
    if (tab === "repository") setRepositoryVisited(true);
    if (tab === "commit") setCommitVisited(true);
  }, [tab]);
  const [search, setSearch] = useState(""),
    [scope, setScope] = useState<"all" | "unstaged" | "staged">("all");
  const [focused, setFocused] = useWindowField(windowUI, "focused"),
    [demo, setDemo] = useState(false);
  const ai = useAi(changes, diff, demo);
  const [narrow, setNarrow] = useState(window.innerWidth <= 1100),
    [contextDrawer, setContextDrawer] = useWindowField(
      windowUI,
      "contextDrawer",
    );
  const [compact, setCompact] = useState(window.innerWidth <= 780),
    [filesDrawer, setFilesDrawer] = useWindowField(windowUI, "filesDrawer");
  const repositoryLayout = useRepositoryLayout(changes?.workspace, demo);
  const [preview, setPreview] = useState<CommitPreview | null>(null),
    [draft, setDraft] = useState("");
  const [amendTarget, setAmendTarget] = useState<{
    head: string;
    branch: string | null;
  } | null>(null);
  const normalDraft = useRef("");
  const [discardPoints, setDiscardPoints] = useState<RecoveryPoint[]>([]);
  const [discardToken, setDiscardToken] = useState<string | null>(null);
  const discardPoint = discardPoints[0] ?? null;
  const [path, setPath] = useState(""),
    [notification, setNotification] = useState(initialDataNotice ?? "");
  const [openingEditor, setOpeningEditor] = useState(false);
  const sequence = useRef(0),
    workspaceEpoch = useRef(0),
    current = useRef<Changes | null>(null),
    polling = useRef(false);
  current.current = changes;
  useEffect(() => {
    onWorkspaceChange?.(changes?.workspace.id);
  }, [changes?.workspace.id, onWorkspaceChange]);
  selectedRef.current = selected;
  function setBusy(value: boolean) {
    busyRef.current = value;
    if (value) ++refreshGeneration.current;
    setBusyState(value);
  }
  const gitActions = useHistoryActions(
    changes ?? demoChanges,
    demo || !changes || diffWindow,
    refresh,
    (path) => {
      const file = changes?.files.find((file) => file.path === path);
      setTab("changes");
      if (file) void loadFile(file);
    },
    !diffWindow && tab === "repository" && repositorySection === "history",
    busy,
    setBusy,
    () => setDialog("recovery"),
  );

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
      if (initialWorkspaceId) {
        const restoreEpoch = workspaceEpoch.current;
        void request<Changes>("changes", { workspaceId: initialWorkspaceId })
          .then(async (next) => {
            if (restoreEpoch !== workspaceEpoch.current) return;
            current.current = next;
            setChanges(next);
            try {
              setDraft(clientStorage.readDraft(next.workspace.id));
            } catch {
              setDraft("");
            }
            if (initialComparison) {
              const id =
                `diff:${initialComparison.base ?? "commit"}:${initialComparison.target}` as const;
              setDiffTabs([
                {
                  id,
                  workspaceId: next.workspace.id,
                  selection: initialComparison,
                },
              ]);
              setTab(id);
            } else if (next.files.length) {
              const file =
                next.files.find(
                  (file) =>
                    file.path === initialFile?.path &&
                    file.side === initialFile.side,
                ) ?? next.files[0];
              await loadFile(file, next.workspace);
            }
          })
          .catch((e) => {
            if (restoreEpoch === workspaceEpoch.current) setError(asError(e));
          });
      }
    } else if (
      new URLSearchParams(window.location.search).get("demo") === "1"
    ) {
      setDemo(true);
      setChanges(demoChanges);
      setSelected(fileKey(demoChanges.files[0]));
      showReading({ state: "ready", diff: demoDiff(demoChanges.files[0]) });
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
    let themeFrame = 0,
      settledFrame = 0;
    const apply = () => {
      cancelAnimationFrame(themeFrame);
      cancelAnimationFrame(settledFrame);
      document.documentElement.dataset.themeChanging = "true";
      document.documentElement.dataset.theme =
        preferences.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : preferences.theme;
      themeFrame = requestAnimationFrame(() => {
        settledFrame = requestAnimationFrame(
          () => delete document.documentElement.dataset.themeChanging,
        );
      });
    };
    apply();
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      cancelAnimationFrame(themeFrame);
      cancelAnimationFrame(settledFrame);
      delete document.documentElement.dataset.themeChanging;
    };
  }, [preferences.theme]);
  useEffect(() => {
    if (notification) {
      const toastId = toast.add({
        title: uiMessage(notification),
        type: "info",
        timeout: 5000,
      });
      const timer = window.setTimeout(() => setNotification(""), 5000);
      return () => {
        window.clearTimeout(timer);
        toast.close(toastId);
      };
    }
  }, [notification]);
  const acceptChangesRef = useRef<(next: Changes) => Promise<boolean>>(
    async () => true,
  );
  const [syncing, setSyncing] = useState(false);
  const pendingRead = useRef<{ intent: string; quiet: boolean } | null>(null);
  const [refreshError, setRefreshError] = useState<ProofError | null>(null);
  const pollRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!isDesktop || demo || !changes || (diffWindow && initialComparison))
      return;
    let cancelled = false;
    setRefreshError(null);
    const workspaceId = changes.workspace.id;
    const poll = async (): Promise<RefreshResult> => {
      const active = current.current;
      if (
        !active ||
        active.workspace.id !== workspaceId ||
        document.visibilityState === "hidden" ||
        polling.current ||
        busyRef.current
      )
        return "busy";
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
          cancelled ||
          epoch !== workspaceEpoch.current ||
          current.current?.workspace.id !== next.workspace.id
        )
          return "done";
        if (generation !== refreshGeneration.current || busyRef.current)
          return "busy";
        if (
          current.current.token !== next.token ||
          (selectedFile &&
            !cache.current.getRead(next, selectedFile) &&
            cancelledRead.current !==
              `${fileKey(selectedFile)}:${cache.current.version(next, selectedFile)}`)
        ) {
          const accepted = await acceptChangesRef.current(next);
          if (accepted) setRefreshError(null);
          return accepted ? "done" : "failed";
        }
        setRefreshError(null);
      } catch (e) {
        if (!cancelled && epoch === workspaceEpoch.current)
          setRefreshError(asError(e));
        return "failed";
      } finally {
        polling.current = false;
      }
      return "done";
    };
    const refreshing = new WorkspaceRefresh(poll, (error) => {
      if (!cancelled) setRefreshError(asError(error));
    });
    refreshing.setVisible(document.visibilityState !== "hidden");
    const requestNow = () => refreshing.request(true);
    pollRef.current = requestNow;
    const stop = watchWorkspace(
      workspaceId,
      () => refreshing.request(),
      () => {}, // The polling fallback reconciles watcher failures quietly.
      (ready) => refreshing.setWatching(ready),
    );
    const focus = () => {
      refreshing.setVisible(document.visibilityState !== "hidden");
      if (document.visibilityState !== "hidden") refreshing.request(true);
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      cancelled = true;
      refreshing.close();
      stop();
      if (pollRef.current === requestNow) pollRef.current = () => {};
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [changes?.workspace.id, demo]);
  useEffect(() => {
    if (tab === "changes" || tab === "commit") pollRef.current();
  }, [tab, changes?.workspace.id]);

  // False means the current selection still needs a read. Cancellation and
  // superseded requests are complete, so background refresh cannot revive them.
  async function loadFile(
    file: ChangedFile,
    workspace = current.current?.workspace,
    force = false,
    loadLarge = false,
    background = false,
  ): Promise<boolean> {
    const active = current.current;
    if (!workspace || !active || active.workspace.id !== workspace.id)
      return true;
    const epoch = workspaceEpoch.current,
      seq = ++sequence.current;
    cancelledRead.current = null;
    selectedRef.current = fileKey(file);
    setSelected(fileKey(file));
    const saved = !force && cache.current.getRead(active, file);
    const cached =
      saved && (!loadLarge || saved.state === "ready" || !saved.summary.canLoad)
        ? saved
        : undefined;
    const intent = `${fileKey(file)}:${cache.current.version(active, file)}:${loadLarge}`;
    // Background reconciliation can join an explicit large-file read. Keep
    // that user's loading/cancel controls until the same request completes.
    const quiet =
      background &&
      !(pendingRead.current?.intent === intent && !pendingRead.current.quiet);
    setSyncing(quiet);
    if (cached || readIntent.current !== intent) {
      fileReader.cancel();
      cache.current.cancelPending();
    }
    readIntent.current = intent;
    if (cached) {
      pendingRead.current = null;
      showReading(cached);
      setLoadingDiff(false);
      setSyncing(false);
      return true;
    }
    pendingRead.current = { intent, quiet };
    // Keep the same file readable within this Git base during a refresh.
    // A different file or Branch must wait for its own capture.
    setDiff((d) =>
      d && fileKey(d) === fileKey(file) && matchesGitBase(active, d) ? d : null,
    );
    setSummary((s) =>
      s && fileKey(s) === fileKey(file) && matchesGitBase(active, s) ? s : null,
    );
    setLoadingDiff(true);
    try {
      const next = await cache.current.read(
        active,
        file,
        () =>
          workspace.id === "demo"
            ? Promise.resolve<DiffRead>({
                state: "ready",
                diff: demoDiff(file),
              })
            : fileReader.read<DiffRead>("read_file_diff", {
                workspaceId: workspace.id,
                path: file.path,
                side: file.side,
                loadLarge,
              }),
        loadLarge,
      );
      const capture = readTarget(next);
      const now = current.current;
      if (
        epoch !== workspaceEpoch.current ||
        !now ||
        now.workspace.id !== workspace.id ||
        capture.workspaceId !== workspace.id ||
        cache.current.version(active, file) !== cache.current.version(now, file)
      ) {
        if (seq !== sequence.current || epoch !== workspaceEpoch.current)
          return true;
        pollRef.current();
        return false;
      }
      if (!matchesGitBase(now, capture)) {
        // An external Commit or Branch switch can happen before the next
        // repository refresh. Never attach that capture to the old view's base.
        cache.current.clear();
        setLoaded({});
        if (seq === sequence.current) showReading(null);
        pollRef.current();
        return false;
      }
      cache.current.putRead(now, file, next);
      setLoaded(cache.current.values());
      if (seq === sequence.current) showReading(next);
      return true;
    } catch (e) {
      if (seq === sequence.current && epoch === workspaceEpoch.current) {
        const failure = asError(e);
        if (
          failure.code !== "STALE_CONTENT" &&
          failure.code !== "CHANGE_MISSING" &&
          failure.code !== "READ_CANCELLED"
        )
          if (quiet) setRefreshError(failure);
          else setError(failure);
        if (!quiet) showReading(null);
        if (failure.code !== "READ_CANCELLED") {
          cache.current.remove(file);
          setLoaded(cache.current.values());
          pollRef.current();
          return false;
        }
      }
      return true;
    } finally {
      if (seq === sequence.current && epoch === workspaceEpoch.current) {
        pendingRead.current = null;
        setLoadingDiff(false);
        setSyncing(false);
      }
    }
  }
  async function acceptChanges(
    next: Changes,
    force = false,
    background = false,
  ): Promise<boolean> {
    current.current = next;
    setChanges(next);
    if (force) cache.current.clear();
    setLoaded(cache.current.retain(next));
    const file =
      next.files.find((file) => fileKey(file) === selectedRef.current) ??
      next.files.find((file) => file.path === diff?.path) ??
      next.files[0];
    if (file) {
      if (
        !force &&
        cancelledRead.current ===
          `${fileKey(file)}:${cache.current.version(next, file)}`
      )
        return true;
      const loadLarge =
        readIntent.current ===
        `${fileKey(file)}:${cache.current.version(next, file)}:true`;
      return await loadFile(file, next.workspace, force, loadLarge, background);
    } else {
      ++sequence.current;
      pendingRead.current = null;
      setSelected(null);
      selectedRef.current = null;
      showReading(null);
      setLoadingDiff(false);
      setSyncing(false);
      return true;
    }
  }
  acceptChangesRef.current = (next) => acceptChanges(next, false, true);

  async function openWorkspace(repositoryPath: string) {
    if (!repositoryPath.trim() || busyRef.current) return;
    const epoch = ++workspaceEpoch.current;
    fileReader.cancel();
    cache.current.cancelPending();
    readIntent.current = null;
    cancelledRead.current = null;
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
      showReading(null);
      setLoaded({});
      setSelected(null);
      setAmendTarget(null);
      setSearch("");
      setScope("all");
      setTab("changes");
      setRecent(projects);
      setDialog(null);
      try {
        setDraft(clientStorage.readDraft(workspace.id));
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
        title: t("打开 Git 仓库"),
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
        message: t("此范围隐藏了空白变化，请显示全部真实变化后再标记已审查。"),
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
    const active = current.current;
    if (!active || !matchesGitBase(active, target)) return;
    const epoch = workspaceEpoch.current;
    setBusy(true);
    try {
      if (!demo)
        await request("mark_reviewed", {
          snapshotId: target.id,
          hunkId,
          reviewed,
        });
      const now = current.current;
      if (
        epoch !== workspaceEpoch.current ||
        !now ||
        now.workspace.id !== target.workspaceId
      )
        return;
      if (
        cache.current.version(active, target) !==
          cache.current.version(now, target) ||
        !matchesGitBase(now, target) ||
        !now.files.some((file) => fileKey(file) === fileKey(target))
      ) {
        // A manual refresh can complete while the Review reply is in flight.
        // Never bind the old capture to the newly observed file version.
        cache.current.remove(target, target.id);
        setLoaded(cache.current.values());
        setDialog(null);
        const file = now.files.find(
          (file) => fileKey(file) === selectedRef.current,
        );
        if (file && displayedDiff.current?.id === target.id)
          await loadFile(file, now.workspace, true);
        return;
      }
      const next: FileDiff = {
        ...target,
        hunks: target.hunks.map((h) =>
          !hunkId || h.id === hunkId
            ? { ...h, reviewState: reviewed ? "reviewed" : "unreviewed" }
            : h,
        ),
      };
      setDiff((d) => (d?.id === target.id ? next : d));
      cache.current.put(active, target, next);
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
    target: EditorTarget,
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
          message: t("Diff 已更新，请重新选择要操作的内容。"),
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
      setDiscardPoints([point]);
      setDiscardToken(null);
      setDialog("discard");
    } catch (e) {
      if (epoch === workspaceEpoch.current) await snapshotError(e, diff, epoch);
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
    }
  }
  async function prepareDiscardFiles(files: ChangedFile[]) {
    const active = current.current;
    if (!active || busyRef.current || demo || !files.length) return;
    const epoch = workspaceEpoch.current;
    setBusy(true);
    setError(null);
    try {
      const points = await request<RecoveryPoint[]>("discard_files_preview", {
        workspaceId: active.workspace.id,
        paths: files.map((file) => file.path),
        expectedToken: active.token,
      });
      if (epoch !== workspaceEpoch.current) return;
      setDiscardPoints(points);
      setDiscardToken(active.token);
      setDialog("discard");
    } catch (cause) {
      if (epoch === workspaceEpoch.current) setError(asError(cause));
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
      for (const point of discardPoints)
        await request("cancel_discard_preview", { recoveryId: point.id });
      if (epoch === workspaceEpoch.current) {
        setDiscardPoints([]);
        setDiscardToken(null);
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
      if (discardToken !== null) {
        const result = await request<{
          applied: RecoveryAction[];
          error: ProofError | null;
        }>("discard_files", {
          workspaceId,
          recoveryIds: discardPoints.map((point) => point.id),
          expectedToken: discardToken,
        });
        if (
          epoch !== workspaceEpoch.current ||
          current.current?.workspace.id !== workspaceId
        )
          return;
        const completed = result.applied.filter(
          (action) => action.result.ok,
        ).length;
        if (completed)
          setNotification(
            t("已 Discard {v0} 个文件，可从恢复点撤销。", { v0: completed }),
          );
        if (result.error) setError(result.error);
        setDiscardPoints([]);
        setDiscardToken(null);
        setDialog(result.error ? "recovery" : null);
        await refresh();
        return;
      }
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
      setDiscardPoints([]);
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
          clientStorage.removeDraft(prepared.workspaceId);
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
      clientStorage.writeDraft(changes.workspace.id, message);
    } catch (error) {
      setError({
        code: "DRAFT_STORAGE",
        message: t("Commit 草稿未保存，请保留当前窗口。"),
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
          message: t("上一条 Commit 已变化，请重新选择 Amend。"),
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
              detail: result.warning ?? t("请检查 Index 后再 Commit。"),
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
          message: t("Branch 或 HEAD 已变化，请检查后再 Commit。"),
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
    showReading({ state: "ready", diff: demoDiff(demoChanges.files[0]) });
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
  useHotkeys(
    "*",
    (event) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
        return;
      if (
        diffWindow &&
        (event.metaKey || event.ctrlKey) &&
        /^[1-4ko]$/i.test(event.key)
      ) {
        event.preventDefault();
        return;
      }
      const editing =
        event.target instanceof HTMLElement &&
        event.target.closest(
          'input,textarea,select,[contenteditable="true"]',
        ) !== null;
      // Context and recovery editors own dialogs outside App's dialog state.
      // Their keyboard input must not navigate the workspace behind the modal.
      if (
        dialog !== "commands" &&
        event.target instanceof HTMLElement &&
        event.target.closest("[role='dialog'][data-open]")
      )
        return;
      if (event.key === "Escape" && !dialog) {
        if (contextDrawer) {
          setContextDrawer(false);
          document.getElementById("context-toggle")?.focus();
        } else if (filesDrawer) {
          setFilesDrawer(false);
          document.getElementById("files-toggle")?.focus();
        } else setFocused(false);
      }
      if (
        !dialog &&
        !isMacDesktop &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "w" &&
        (tab.startsWith("diff:") || diffWindow)
      ) {
        event.preventDefault();
        closeDiffTab(tab);
        return;
      }
      if (
        !dialog &&
        changes &&
        (event.metaKey || event.ctrlKey) &&
        /^[1-3]$/.test(event.key)
      ) {
        event.preventDefault();
        selectWorkspaceView(
          (["changes", "commit", "history"] as const)[Number(event.key) - 1],
        );
        return;
      }
      if (editing || busy || (dialog !== null && dialog !== "commands")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (dialog === "commands") setDialog(null);
        else openCommands();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        if (tab.startsWith("diff:")) return;
        event.preventDefault();
        setFocused(false);
        if (tab === "repository") {
          document
            .querySelector<HTMLInputElement>(
              ".workspace-page:not([hidden]) .graph-search input",
            )
            ?.focus();
        } else if (tab.startsWith("diff:"))
          document
            .querySelector<HTMLInputElement>(
              ".diff-tab-page:not([hidden]) .file-search input",
            )
            ?.focus();
        else if (tab === "commit")
          document.getElementById("commit-file-search")?.focus();
        else showFileSearch();
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
    },
    {
      ignoreModifiers: true,
      enableOnFormTags: true,
      enableOnContentEditable: true,
    },
    [
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
    ],
  );

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
  function showCommit() {
    setFocused(false);
    setTab("commit");
    requestAnimationFrame(() =>
      document.getElementById("quick-commit-message")?.focus(),
    );
  }
  function showFileSearch() {
    if (tab === "commit") {
      setFocused(false);
      requestAnimationFrame(() =>
        document.getElementById("commit-file-search")?.focus(),
      );
      return;
    }
    ai.setView("files");
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
    section:
      | "appearance"
      | "review"
      | "observer"
      | "data"
      | "editor"
      | "diagnostics"
      | "agents" = "appearance",
  ) {
    setSettingsSection(section);
    setDialog("settings");
  }
  function openCommands() {
    const file = tab === "changes" ? displayedDiff.current : null;
    setCommandTarget(
      file
        ? {
            id: file.id,
            workspaceId: file.workspaceId,
            path: file.path,
            side: file.side,
          }
        : null,
    );
    setDialog("commands");
  }
  async function openEditor(
    target: EditorTarget | null = displayedDiff.current,
  ) {
    if (tab !== "changes" || !target || openingEditor) return;
    if (demo || !isDesktop) {
      openSettings("editor");
      return;
    }
    const epoch = workspaceEpoch.current;
    setOpeningEditor(true);
    setError(null);
    try {
      const result = await request<EditorOpenResult>("open_in_editor", {
        snapshotId: target.id,
      });
      if (epoch === workspaceEpoch.current) setNotification(result.message);
    } catch (error) {
      if (epoch !== workspaceEpoch.current) return;
      const failure = asError(error);
      if (failure.code === "EDITOR_NOT_CONFIGURED") openSettings("editor");
      else if (["SNAPSHOT_EXPIRED", "STALE_CONTENT"].includes(failure.code))
        await snapshotError(error, target, epoch);
      else
        setError({
          ...failure,
          message: t("无法打开 {v0}。{v1}", {
            v0: target.path,
            v1: failure.message,
          }),
        });
    } finally {
      setOpeningEditor(false);
    }
  }
  function showRepository(section: RepositorySection) {
    setRepositorySection(section);
    setTab("repository");
  }
  const workspaceView: WorkspaceView =
    tab === "repository" ? "history" : tab;
  function selectWorkspaceView(view: WorkspaceView) {
    if (view === "history") showRepository("history");
    else if (view === "commit") showCommit();
    else setTab(view);
  }
  return (
    <Tabs.Root
      value={workspaceView}
      onValueChange={(value) => {
        if (typeof value === "string")
          selectWorkspaceView(value as WorkspaceView);
      }}
      className={`app layout-enabled ${diffWindow ? "diff-window-app" : ""} ${focused ? "is-focused" : ""}`}
      data-native-macos={isMacDesktop ? "true" : undefined}
    >
      <header className="app-header desktop-toolbar" data-tauri-drag-region>
        {diffWindow && (
          <div className="diff-window-label" data-tauri-drag-region>
            {changes?.workspace.name ?? "Proof"}
            <span>{initialComparison ? "Diff" : t("Local changes")}</span>
          </div>
        )}
        <a
          className="brand"
          href="#"
          aria-label={t("Proof 首页")}
          onClick={(e) => {
            e.preventDefault();
            if (changes) setTab("changes");
          }}
        >
          <ProofMark />
          <span>{t("Proof")}</span>
        </a>
        <span className="header-divider" />
        <Button
          className="workspace-picker"
          disabled={busy}
          onClick={() => setDialog("open")}
        >
          <FolderOpen size={17} />
          <strong>{changes?.workspace.name ?? t("打开仓库")}</strong>
          <CaretDown size={12} />
        </Button>
        {changes && !diffWindow && (
          <BranchPicker
            key={changes.workspace.id}
            changes={changes}
            demo={demo}
            busy={busy}
            onSwitch={switchBranch}
            actions={gitActions}
          />
        )}
        {changes && !diffWindow && (
          <WorkspaceTabs
            onReorder={(source, target) =>
              setDiffTabs((tabs) => reorderComparisonTabs(tabs, source, target))
            }
            active={tab === "repository" ? "history" : tab}
            changesCount={changes.files.length}
            stagedCount={stagedCount}
            comparisons={diffTabs.filter(
              (item) => item.workspaceId === changes.workspace.id,
            )}
            historyRef={historyTab}
            onSelect={selectWorkspaceView}
            onClose={closeDiffTab}
          />
        )}
        <div
          className="toolbar-spacer window-drag-space"
          data-tauri-drag-region
        />
        {demo && <span className="demo-badge">{t("演示数据")}</span>}
        {changes && (
          <Button
            className="icon-button"
            disabled={busy}
            aria-label={t("刷新 Worktree")}
            title={t("刷新本地 Worktree")}
            onClick={() => {
              void refresh();
            }}
          >
            <ArrowClockwise size={17} className={busy ? "spinning" : ""} />
          </Button>
        )}
        <Button
          className="observer-status"
          onClick={() => openSettings("observer")}
        >
          <span className="status-dot neutral" />
          {t("Agent Hook")}
        </Button>
        <Button
          className="command-trigger"
          title={t("命令面板")}
          aria-label={t("打开命令面板")}
          onClick={openCommands}
        >
          <MagnifyingGlass size={15} />
          <span>{t("Command")}</span>
          <kbd>{t("⌘ K")}</kbd>
        </Button>
        <Button
          className="icon-button"
          aria-label={t("设置")}
          title={t("设置")}
          onClick={() => openSettings()}
        >
          <GearSix size={19} />
        </Button>
      </header>
      {changes && !diffWindow && gitActions.feedback}
      {changes && !diffWindow && gitActions.dialog}
      {changes ? (
        <>
          {demo && (
            <div className="demo-notice">
              <Info size={15} />
              {t(
                "当前为虚构的 demo-service 界面演示。审查标记仅用于体验，Git 写操作不可用。",
              )}
              <Button
                onClick={() => {
                  void chooseFolder();
                }}
              >
                {t("打开真实仓库")}
              </Button>
            </div>
          )}
          {!changes.workspace.trusted && !demo && (
            <div className="trust-banner">
              <ShieldCheck size={17} />
              <span>
                {t(
                  "受限查看。信任此仓库后，可暂存和提交；Git Hook、签名及过滤器可能执行。",
                )}
              </span>
              <Button
                className="button compact"
                onClick={() => setDialog("trust")}
              >
                {t("审阅信任设置")}
              </Button>
            </div>
          )}
          {changes.operation && (
            <div className="trust-banner">
              <Warning size={16} />
              {changes.operation} {t(" 进行中。请在外部完成当前流程后刷新。")}
            </div>
          )}
        </>
      ) : null}
      {error && (
        <div className="error-banner" role="alert">
          {!changes && (
            <Button
              className="button compact"
              onClick={() => openSettings("diagnostics")}
            >
              {t("打开诊断")}
            </Button>
          )}
          <Warning size={18} />
          <div>
            <strong>{uiMessage(error.message)}</strong>
            <details>
              <summary>
                {error.code} {t(" · 查看详情")}
              </summary>
              <pre>{error.detail}</pre>
            </details>
          </div>
          <Button
            className="icon-button"
            aria-label={t("关闭错误提示")}
            onClick={() => setError(null)}
          >
            <X size={16} />
          </Button>
        </div>
      )}
      {changes && repositoryLayout.error && dialog !== "settings" && (
        <div className="layout-error-banner" role="alert">
          <Warning size={16} />
          <span>
            {repositoryLayout.ready
              ? repositoryLayout.saving
                ? t("有布局调整未保存，其余调整仍在保存。")
                : t("有布局调整未保存，当前显示已保存的值。")
              : t("无法读取此仓库布局。")}{" "}
            {uiMessage(repositoryLayout.error.message)}
          </span>
          <Button
            onClick={() =>
              repositoryLayout.ready
                ? openSettings()
                : void repositoryLayout.retry()
            }
          >
            {repositoryLayout.ready ? t("布局设置") : t("重试读取")}
          </Button>
        </div>
      )}
      {!changes ? (
        <main className="welcome">
          <div className="welcome-main">
            <ProofMark large />
            <p className="welcome-kicker">{t("Git, with context.")}</p>
            <h1>{t("打开仓库，开始工作")}</h1>
            <p className="welcome-description">
              {t("查看 Diff、管理 Branch、提交代码。")}
              <br />
              {t("按需关联 Agent 的修改记录。")}
            </p>
            <Button
              className="button primary welcome-open"
              onClick={() => {
                void chooseFolder();
              }}
              disabled={busy}
            >
              <FolderOpen size={19} />
              {t("打开本地仓库")}
            </Button>
            <Button className="demo-link" onClick={startDemo}>
              {t("体验演示 Worktree ")}
              <ArrowRight size={15} />
            </Button>
            <div className="welcome-principles">
              <span>
                <Check size={14} />
                {t("无需账号")}
              </span>
              <span>
                <Check size={14} />
                {t("本地优先")}
              </span>
              <span>
                <Check size={14} />
                {t("人工决定")}
              </span>
            </div>
          </div>
          {recent.length > 0 && (
            <div className="recent-projects">
              <h2>{t("最近打开")}</h2>
              {recent.map((w) => (
                <Button
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
                </Button>
              ))}
            </div>
          )}
          <footer className="welcome-footer">
            {t("Proof ")}
            <span>{t("本地代码审查工作台")}</span>
            <span className="version">{APP_VERSION}</span>
          </footer>
        </main>
      ) : (
        <>
          {diffTabs
            .filter((t) => t.workspaceId === changes.workspace.id)
            .map((item) => (
              <Tabs.Panel
                keepMounted
                hidden={tab !== item.id}
                value={item.id}
                key={item.id}
                className="workspace-page diff-tab-page"
              >
                <HistoryDiff
                  panelLayout={repositoryLayout}
                  onOpenWindow={
                    demo || diffWindow
                      ? undefined
                      : (selection) => {
                          void request("open_diff_window", {
                            selection: {
                              kind: "comparison",
                              workspaceId: changes.workspace.id,
                              ...selection,
                            },
                          }).catch((e) => setError(asError(e)));
                        }
                  }
                  onAgentSettings={() => openSettings("agents")}
                  active={tab === item.id}
                  changes={changes}
                  demo={demo}
                  preferences={preferences}
                  onPreferences={(value) => void updatePreferences(value)}
                  selection={item.selection}
                  toolbar={
                    <>
                      {!item.selection.base &&
                        (item.selection.parents?.length ?? 0) > 1 && (
                          <Select
                            aria-label={t("Diff 比较父提交")}
                            value={item.selection.parent ?? 0}
                            onChange={(e) =>
                              setDiffTabs((tabs) =>
                                tabs.map((t) =>
                                  t.id === item.id
                                    ? {
                                        ...t,
                                        selection: {
                                          ...t.selection,
                                          parent: Number(e.target.value),
                                        },
                                      }
                                    : t,
                                ),
                              )
                            }
                          >
                            {item.selection.parents!.map((oid, index) => (
                              <option key={oid} value={index}>
                                {t("Parent ")}
                                {index + 1} · {oid.slice(0, 8)}
                              </option>
                            ))}
                          </Select>
                        )}
                      <Button
                        className="button compact"
                        onClick={() => {
                          setTab("repository");
                          setRepositorySection("history");
                        }}
                      >
                        {t("返回 History")}
                      </Button>
                    </>
                  }
                />
              </Tabs.Panel>
            ))}
          <Tabs.Panel
            keepMounted
            hidden={tab !== "repository"}
            value="history"
            className="workspace-page"
          >
            {(repositoryVisited || tab === "repository") && (
              <RepositoryView
                actions={gitActions}
                key={changes.workspace.id}
                onOpenDiff={openHistoryDiff}
                section={repositorySection}
                onSection={setRepositorySection}
                changes={changes}
                demo={demo}
                onOpen={openWorkspace}
                onError={(e) => {
                  if (current.current?.workspace.id === changes.workspace.id)
                    setError(asError(e));
                }}
                branchDelimiter={preferences.branchDelimiter}
              />
            )}
          </Tabs.Panel>
          <Tabs.Panel
            keepMounted
            hidden={tab !== "changes" && tab !== "commit"}
            value={tab === "commit" ? "commit" : "changes"}
            className="workspace-page"
          >
            <ResizableWorkbench
              layout={repositoryLayout.value}
              scopeKey={repositoryLayout.scopeKey}
              enabled={repositoryLayout.ready}
              active={
                (tab === "changes" || tab === "commit") && dialog === null
              }
              sidebarVisible={
                tab === "commit" ? !focused : sidebarVisible && !compact
              }
              contextDocked={tab !== "commit" && contextOpen && !narrow}
              onChange={(partial) => {
                void repositoryLayout.update(partial);
              }}
              onCollapse={(side) => {
                if (tab === "commit" && side === "sidebarWidth")
                  setFocused(true);
                else if (side === "sidebarWidth") closeFiles();
                else closeContext();
              }}
              sidebar={
                <>
                  <div className="local-files-pane" hidden={tab === "commit"}>
                    <DiffFilePane
                      ai={ai}
                      token={changes.token}
                      scopeKey={changes.workspace.id}
                      containerProps={{
                        id: "files-panel",
                        "aria-label": t("变化文件"),
                        hidden: !sidebarVisible,
                        className: compact ? "files-drawer" : "",
                        onBlurCapture: (event) => {
                          if (compact && shouldDismissDrawer(event))
                            setFilesDrawer(false);
                        },
                      }}
                      onClose={closeFiles}
                      closeDisabled={!compact && !repositoryLayout.ready}
                      disabled={
                        busy ||
                        demo ||
                        !changes.workspace.trusted ||
                        !!changes.operation
                      }
                      onStage={(files, side) => void stageFiles(files, side)}
                      onDiscard={(files) => void prepareDiscardFiles(files)}
                      onRecovery={() => setDialog("recovery")}
                      workspacePath={changes.workspace.path}
                      files={changes.files}
                      selected={selected}
                      onSelect={(file) => {
                        void loadFile(file);
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
                  </div>
                  <div className="commit-files-pane" hidden={tab !== "commit"}>
                    {(commitVisited || tab === "commit") && (
                      <CommitWorkspace
                        key={changes.workspace.id}
                        changes={changes}
                        loaded={loaded}
                        disabled={
                          busy ||
                          demo ||
                          !changes.workspace.trusted ||
                          !!changes.operation
                        }
                        onStage={(files, side) => void stageFiles(files, side)}
                        onDiscard={(files) => void prepareDiscardFiles(files)}
                        onRecovery={() => setDialog("recovery")}
                        selected={selected}
                        onSelect={(file) => void loadFile(file)}
                      >
                        <CommitComposer
                          changes={changes}
                          ai={ai}
                          onAgentSettings={() => openSettings("agents")}
                          message={draft}
                          onMessage={editDraft}
                          amend={!!amendTarget}
                          onAmend={(value) => void toggleAmend(value)}
                          head={changes.head}
                          branch={changes.branch}
                          staged={stagedCount}
                          unstaged={
                            changes.files.filter(
                              (file) => file.side === "unstaged",
                            ).length
                          }
                          busy={busy}
                          disabled={
                            demo ||
                            !changes.workspace.trusted ||
                            !!changes.operation
                          }
                          demo={demo}
                          strictReview={preferences.strictReview}
                          onReviewSettings={() => openSettings("review")}
                          onCommit={(all) => void quickCommit(all)}
                        />
                      </CommitWorkspace>
                    )}
                  </div>
                </>
              }
              context={
                tab !== "commit" &&
                contextOpen && (
                  <ContextInspector
                    activeTab={inspectorTab}
                    onTab={setInspectorTab}
                    aiPanel={
                      <AiReviewPanel
                        onSettings={() => openSettings("agents")}
                        ai={ai}
                        hasDiff={!!diff}
                        demo={demo}
                        onFinding={(finding) => {
                          const captured = ai.report?.files.find(
                            (f) =>
                              f.path === finding.file &&
                              f.side === finding.side,
                          );
                          const file = changes.files.find(
                            (f) =>
                              f.path === finding.file &&
                              f.side === finding.side,
                          );
                          if (!captured || !file || ai.stale) return;
                          setAiJump({
                            id: crypto.randomUUID(),
                            snapshotToken: captured.snapshotToken,
                            path: captured.path,
                            fileSide: captured.side,
                            line: finding.line,
                            endLine: finding.endLine,
                            side: finding.lineSide,
                          });
                          void loadFile(file);
                        }}
                      />
                    }
                    diff={diff}
                    demo={demo}
                    drawer={narrow}
                    closeDisabled={!narrow && !repositoryLayout.ready}
                    onClose={closeContext}
                    onLeave={() => setContextDrawer(false)}
                    onSettings={() => openSettings("observer")}
                    onError={(error) => setError(asError(error))}
                  />
                )
              }
            >
              <div className="center-panel">
                {summary ? (
                  <DeferredDiff
                    summary={summary}
                    pending={busy || loadingDiff}
                    onLoad={() => {
                      const file = changes.files.find(
                        (file) => fileKey(file) === fileKey(summary),
                      );
                      if (file)
                        void loadFile(file, changes.workspace, true, true);
                    }}
                    onStage={
                      !demo &&
                      changes.workspace.trusted &&
                      !changes.operation &&
                      summary.reason !== "file_limit" &&
                      changes.files.some(
                        (file) =>
                          fileKey(file) === fileKey(summary) &&
                          !file.conflicted,
                      )
                        ? () => {
                            const file = changes.files.find(
                              (file) => fileKey(file) === fileKey(summary),
                            );
                            if (file && !file.conflicted)
                              void stageFiles([file], file.side);
                          }
                        : undefined
                    }
                  />
                ) : diff ? (
                  <DiffView
                    key={`${diff.workspaceId}:${diff.path}:${diff.side}`}
                    onOpenWindow={
                      demo || diffWindow
                        ? undefined
                        : () => {
                            void request("open_diff_window", {
                              selection: {
                                kind: "local",
                                workspaceId: diff.workspaceId,
                                path: diff.path,
                                side: diff.side,
                              },
                            }).catch((error) => setError(asError(error)));
                          }
                    }
                    jumpTo={aiJump}
                    ai={ai}
                    diff={diff}
                    preferences={preferences}
                    onEditor={() => void openEditor()}
                    openingEditor={openingEditor}
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
                          : await contextReader.read<DiffContext>(
                              "diff_context",
                              {
                                snapshotId: diff.id,
                                ...(contextLines === "file"
                                  ? { fullFile: true }
                                  : { contextLines }),
                              },
                            );
                      } catch (error) {
                        if (
                          ["STALE_CONTENT", "SNAPSHOT_EXPIRED"].includes(
                            asError(error).code,
                          )
                        )
                          await snapshotError(error, diff, epoch);
                        throw error;
                      }
                    }}
                    onCancelContext={contextReader.cancel}
                    onFocus={() => setFocused((f) => !f)}
                  />
                ) : loadingDiff ? null : (
                  <div className="empty-diff">
                    <div className="empty-symbol">
                      <Check size={30} />
                    </div>
                    <h2>
                      {changes.files.length
                        ? t("选择文件查看 Diff")
                        : t("当前没有代码变化")}
                    </h2>
                    <p>
                      {changes.files.length
                        ? t("选择左侧文件查看 Diff。")
                        : t("Worktree clean")}
                    </p>
                    {!changes.files.length && (
                      <Button
                        className="button"
                        onClick={() => showRepository("history")}
                      >
                        {t("查看提交历史")}
                      </Button>
                    )}
                  </div>
                )}
                {loadingDiff && !syncing && (
                  <DiffLoading
                    updating={!!diff || !!summary}
                    path={
                      changes.files.find((file) => fileKey(file) === selected)
                        ?.path
                    }
                    onCancel={() => {
                      const file = changes.files.find(
                        (file) => fileKey(file) === selectedRef.current,
                      );
                      if (file)
                        cancelledRead.current = `${fileKey(file)}:${cache.current.version(changes, file)}`;
                      ++sequence.current;
                      fileReader.cancel();
                      cache.current.cancelPending();
                      setLoadingDiff(false);
                      setNotification(t("读取已取消，选择文件可重新读取。"));
                    }}
                  />
                )}
              </div>
            </ResizableWorkbench>
          </Tabs.Panel>
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
              {t("Review")}{" "}
              <strong>
                {reviewedUnits}/{knownUnits.length}
              </strong>{" "}
              {t("hunks reviewed")}
            </span>
          </div>
          <div className="toolbar-spacer" />
          {focused && (
            <Button
              className="button subtle compact"
              onClick={() => setFocused(false)}
            >
              {t("退出专注")}
            </Button>
          )}
          <Button
            id="files-toggle"
            className="icon-button"
            aria-label={sidebarVisible ? t("收起文件栏") : t("显示文件栏")}
            aria-expanded={sidebarVisible}
            aria-controls="files-panel"
            title={t("文件栏 · ⌘/Ctrl P 搜索")}
            disabled={!compact && !repositoryLayout.ready}
            onClick={() => {
              if (sidebarVisible) closeFiles();
              else showFileSearch();
            }}
          >
            <List size={18} />
          </Button>
          <Button
            id="context-toggle"
            className="icon-button"
            aria-label={contextOpen ? t("收起上下文") : t("显示上下文")}
            title={t("Context 面板")}
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
          </Button>
          {diff && (
            <Button
              className="button compact"
              disabled={!diff.canStage || busy || loadingDiff}
              title={
                !diff.canStage
                  ? t("此文件当前不支持 Git 写操作")
                  : t("操作当前整个文件")
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
              {diff.side === "staged" ? t("Unstage file") : t("Stage file")}
            </Button>
          )}
          <Button
            className="icon-button"
            aria-label={t("打开丢弃恢复点")}
            title={t("丢弃恢复点")}
            disabled={busy || demo}
            onClick={() => {
              setError(null);
              setDialog("recovery");
            }}
          >
            <ClockCounterClockwise size={18} />
          </Button>
          {diff?.side === "unstaged" && (
            <Button
              className="icon-button"
              aria-label={t("预览丢弃文件")}
              title={
                diff.canDiscard
                  ? t("预览丢弃整个文件的未暂存变化")
                  : (diff.discardReason ?? t("当前不能丢弃"))
              }
              disabled={busy || !diff.canDiscard}
              onClick={() => void prepareDiscard(null)}
            >
              <Trash size={18} />
            </Button>
          )}
        </footer>
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
          title={t("确认丢弃未暂存变化")}
          error={error}
          onClose={() => void cancelDiscard()}
        >
          <div className="discard-scope">
            {discardPoints.length > 1 && (
              <strong>{t("{v0} 个文件", { v0: discardPoints.length })}</strong>
            )}
            <ul>
              {discardPoints.map((point) => (
                <li key={point.id}>
                  <strong>{point.path}</strong>
                  <small>{point.scope}</small>
                </li>
              ))}
            </ul>
          </div>
          <p>
            {t(
              "恢复点已经保存。已跟踪文件会还原到 Index 版本，untracked 文件会移出 Worktree；均可从恢复点撤销。",
            )}
          </p>
          <p className="inline-help">
            {t("恢复内容保留至 ")}
            {new Date(discardPoint.expiresAt).toLocaleString(getLanguage())}
            {t(
              "，总计上限 256 MiB。撤销时若文件已有新改动，Proof 会停止恢复并保留副本。",
            )}
          </p>
          <div className="modal-actions">
            <Button
              className="button"
              disabled={busy}
              onClick={() => void cancelDiscard()}
            >
              {t("取消")}
            </Button>
            <Button
              className="button danger"
              disabled={busy}
              onClick={() => void confirmDiscard()}
            >
              {busy ? t("正在核对…") : t("确认丢弃所选变化")}
            </Button>
          </div>
        </Modal>
      )}
      {dialog === "open" && (
        <Modal
          title={t("打开仓库")}
          error={error}
          onClose={() => setDialog(null)}
        >
          <p className="modal-intro">
            {t("选择已有 Git 仓库，或输入仓库内的目录路径。")}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void openWorkspace(path);
            }}
          >
            <label className="field-label" htmlFor="repository-path">
              {t("本地目录")}
            </label>
            <div className="path-input">
              <Input
                id="repository-path"
                autoFocus
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t("/Users/you/code/project")}
              />
              <Button
                type="button"
                className="button"
                onClick={() => {
                  void chooseFolder();
                }}
                disabled={!isDesktop}
              >
                <FolderOpen size={16} />
                {t("选择")}
              </Button>
            </div>
            <div className="dialog-recent">
              {recent.map((w) => (
                <Button
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
                </Button>
              ))}
            </div>
            {!isDesktop && (
              <p className="inline-help">
                {t("浏览器无法读取本地 Git。请运行桌面应用，或体验虚构演示。")}
              </p>
            )}
            <div className="modal-actions">
              <Button
                className="button subtle"
                type="button"
                onClick={startDemo}
              >
                {t("体验演示")}
              </Button>
              <Button
                type="submit"
                className="button primary"
                disabled={!isDesktop || !path.trim() || busy}
              >
                {t("打开仓库")}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === "trust" && changes && (
        <Modal
          title={t("信任此仓库")}
          error={error}
          onClose={() => setDialog(null)}
        >
          <div className="trust-summary">
            <ShieldCheck size={28} />
            <strong>{changes.workspace.name}</strong>
            <code>{changes.workspace.path}</code>
          </div>
          <p>
            {t(
              "执行暂存、提交和分支操作时，Git 可能运行此仓库及你的 Git 配置中的过滤器、Hook 和签名程序。",
            )}
          </p>
          <p className="inline-help">
            {t(
              "此选择保存在 Proof 本地。不会修改 safe.directory、现有 Hook 或全局 Git 配置。",
            )}
          </p>
          <div className="modal-actions">
            <Button className="button" onClick={() => setDialog(null)}>
              {t("继续受限查看")}
            </Button>
            <Button
              className="button primary"
              disabled={busy}
              onClick={() => {
                void trustWorkspace();
              }}
            >
              {t("信任并启用 Git 操作")}
            </Button>
          </div>
        </Modal>
      )}
      {dialog === "mark-file" && reviewTarget && (
        <Modal
          title={t("标记整个文件已审查")}
          error={error}
          onClose={() => setDialog(null)}
        >
          <p>
            {t("此标记覆盖 ")}
            <strong>{reviewTarget.path}</strong> {t(" 当前完整 Diff 的")}{" "}
            <strong>
              {reviewTarget.hunks.length} {t(" 个变化块")}
            </strong>
            {t("，包含尚未滚动到的内容。")}
          </p>
          <p className="inline-help">
            {t("只记录你对这个版本的人工审查，不会 Stage 文件或改变测试状态。")}
          </p>
          {diff?.id !== reviewTarget.id && (
            <p role="status" className="inline-help">
              {t("文件已更新，请关闭此窗口并重新选择 Review 范围。")}
            </p>
          )}
          <div className="modal-actions">
            <Button className="button" onClick={() => setDialog(null)}>
              {t("继续逐段阅读")}
            </Button>
            <Button
              className="button primary"
              disabled={busy || diff?.id !== reviewTarget.id || loadingDiff}
              onClick={() => {
                void mark(null, true, true);
              }}
            >
              {t("确认已审查全部内容")}
            </Button>
          </div>
        </Modal>
      )}
      {dialog === "commit" && preview && (
        <Modal
          title={t("提交预览")}
          error={error}
          onClose={() => {
            if (!busy) setDialog(null);
          }}
          wide
        >
          <div className="commit-target">
            <GitBranch size={17} />
            <strong>{preview.branch ?? "Detached HEAD"}</strong>
            <span>
              {preview.files.length} {t(" staged files")}
            </span>
            <code>{preview.head?.slice(0, 8) ?? t("首次提交")}</code>
          </div>
          <div className="commit-files">
            {preview.files.map((f) => (
              <div key={fileKey(f)}>
                <span className={`file-status status-${f.status}`}>
                  {f.status}
                </span>
                <span>{f.path}</span>
                {preview.unreadFiles?.includes(f.path) && (
                  <small className="commit-unread">
                    {t("Diff 超过读取上限")}
                  </small>
                )}
              </div>
            ))}
          </div>
          <div
            className={`commit-coverage ${preview.coverageComputed && !preview.unreadFiles?.length && preview.reviewed === preview.total ? "complete" : ""}`}
          >
            <Info size={16} />
            <span>
              {!preview.coverageComputed
                ? t("未统计 Review。")
                : preview.unreadFiles?.length
                  ? t("{v0} 个文件的 Diff 未加载，Review 未完成。", {
                      v0: preview.unreadFiles.length,
                    })
                  : `${preview.reviewed}/${preview.total} hunks reviewed。`}
              {preferences.strictReview
                ? t("Strict Review 已启用。")
                : t("将提交列出的全部 Staged 文件。")}
            </span>
          </div>
          <label className="field-label" htmlFor="commit-message">
            {t("提交说明")}
          </label>
          <Textarea
            id="commit-message"
            autoFocus
            rows={4}
            value={draft}
            placeholder={t("描述这次修改的目的…")}
            onChange={(e) => {
              setDraft(e.target.value);
              try {
                clientStorage.writeDraft(preview.workspaceId, e.target.value);
              } catch (error) {
                setError({
                  code: "DRAFT_STORAGE",
                  message: t("提交草稿未能持久保存，请保留当前窗口。"),
                  detail: String(error),
                });
              }
            }}
          />
          <p className="inline-help">
            <ShieldCheck size={14} />
            {t("Git Hook 与签名将按现有配置执行。只提交已暂存内容。")}
          </p>
          <div className="modal-actions">
            <Button
              className="button"
              disabled={busy}
              onClick={() => setDialog(null)}
            >
              {t("返回审查")}
            </Button>
            <Button
              className="button primary"
              disabled={
                busy ||
                !draft.trim() ||
                (preferences.strictReview &&
                  (!preview.coverageComputed ||
                    !!preview.unreadFiles?.length ||
                    preview.reviewed !== preview.total))
              }
              onClick={() => {
                void commit();
              }}
            >
              <GitCommit size={16} />
              {busy ? t("正在提交…") : t("确认提交")}
            </Button>
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
          <span
            className="live-status"
            title={refreshError ? uiMessage(refreshError.message) : undefined}
          >
            <span className={`status-dot ${refreshError ? "neutral" : ""}`} />
            {diffWindow && initialComparison
              ? t("Snapshot")
              : refreshError
                ? t("正在重试刷新")
                : t("Live")}
          </span>
        </div>
      )}
      {dialog === "settings" && (
        <Settings
          onError={(error) => setError(asError(error))}
          onRecentChanged={async () =>
            setRecent(await request<Workspace[]>("recent_workspaces"))
          }
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
        <Modal title={t("命令面板")} onClose={() => setDialog(null)}>
          <CommandList
            actions={[
              ...(["fetch", "pull", "push"] as const).map((kind) => ({
                label: { fetch: "Fetch", pull: "Pull", push: "Push" }[kind],
                icon: <ArrowClockwise size={19} />,
                run: () => {
                  setDialog(null);
                  gitActions.open(kind);
                },
                disabled:
                  !changes ||
                  gitActions.disabled ||
                  !!changes.operation ||
                  !gitActions.state?.remotes.length ||
                  (kind !== "fetch" && !changes.branch),
              })),
              {
                label: t("复制 Branch 名称"),
                icon: <GitBranch size={19} />,
                disabled: !changes?.branch,
                run: () => {
                  setDialog(null);
                  if (changes?.branch) void gitActions.copy(changes.branch);
                },
              },
              {
                label: t("保存到 Stash…"),
                icon: <GitBranch size={19} />,
                disabled:
                  !changes?.head ||
                  !changes.files.length ||
                  gitActions.disabled,
                run: () => {
                  setDialog(null);
                  gitActions.open("stash");
                },
              },
              {
                label: t("Stashes"),
                icon: <ClockCounterClockwise size={19} />,
                disabled: !changes || gitActions.disabled,
                run: () => {
                  setDialog(null);
                  gitActions.manageStashes();
                },
              },
              {
                label: t("打开本地仓库"),
                icon: <FolderOpen size={19} />,
                run: () => {
                  setDialog(null);
                  void chooseFolder();
                },
              },
              {
                label: t("搜索变化文件"),
                icon: <MagnifyingGlass size={19} />,
                run: () => {
                  setDialog(null);
                  showFileSearch();
                },
                disabled: !changes,
              },
              {
                label: t("刷新 Worktree"),
                icon: <ArrowClockwise size={19} />,
                run: () => {
                  setDialog(null);
                  void refresh();
                },
                disabled: !changes,
              },
              {
                label: t("打开 Commit"),
                icon: <GitCommit size={19} />,
                run: () => {
                  setDialog(null);
                  showCommit();
                },
                disabled: !changes,
              },
              {
                label: t("提交预览"),
                icon: <GitCommit size={19} />,
                run: () => {
                  setDialog(null);
                  void prepareCommit();
                },
                disabled: tab !== "commit" || !stagedCount || demo,
              },
              {
                label: focused ? t("退出专注审查") : t("进入专注审查"),
                icon: <Check size={19} />,
                run: () => {
                  setDialog(null);
                  setFocused(!focused);
                },
                disabled: !changes,
              },
              {
                label: t("在外部编辑器打开"),
                detail: commandTarget?.path,
                icon: <ArrowSquareOut size={19} />,
                run: () => {
                  setDialog(null);
                  void openEditor(commandTarget);
                },
                disabled: tab !== "changes" || !commandTarget || openingEditor,
              },
              {
                label: t("观察与偏好设置"),
                icon: <GearSix size={19} />,
                run: () => openSettings(),
              },
            ]}
          />
        </Modal>
      )}
    </Tabs.Root>
  );
}

export function ProofMark({ large = false }: { large?: boolean }) {
  return (
    <img
      className={`proof-mark ${large ? "large" : ""}`}
      width={large ? 58 : 27}
      height={large ? 58 : 27}
      src={proofIcon}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
