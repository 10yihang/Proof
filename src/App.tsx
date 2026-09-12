import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowClockwise,
  ArrowRight,
  CaretDown,
  Check,
  Command,
  FolderOpen,
  GearSix,
  GitBranch,
  GitCommit,
  HardDrives,
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
} from "@phosphor-icons/react";
import { asError, isDesktop, request } from "./api";
import { demoChanges, demoDiff } from "./demo";
import { defaultPreferences, fileKey } from "./types";
import type {
  ChangedFile,
  Changes,
  CommitPreview,
  FileDiff,
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
import { Settings } from "./components/Settings";
import { RecoveryDialog } from "./components/RecoveryDialog";
import { FileHistory } from "./components/FileHistory";

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
  const [recent, setRecent] = useState<Workspace[]>([]);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [incoming, setIncoming] = useState<Changes | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loaded, setLoaded] = useState<Record<string, FileDiff>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<ProofError | null>(null);
  const [busy, setBusy] = useState(false),
    [loadingDiff, setLoadingDiff] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null),
    [tab, setTab] = useState<"changes" | "repository">("changes");
  const [search, setSearch] = useState(""),
    [scope, setScope] = useState<"all" | "unstaged" | "staged">("all");
  const [focused, setFocused] = useState(false),
    [demo, setDemo] = useState(false);
  const [narrow, setNarrow] = useState(window.innerWidth <= 1100),
    [contextDrawer, setContextDrawer] = useState(false);
  const [preview, setPreview] = useState<CommitPreview | null>(null),
    [draft, setDraft] = useState("");
  const [discardPoint, setDiscardPoint] = useState<RecoveryPoint | null>(null);
  const [path, setPath] = useState(""),
    [notification, setNotification] = useState("");
  const sequence = useRef(0),
    workspaceEpoch = useRef(0),
    current = useRef<Changes | null>(null),
    polling = useRef(false);
  current.current = changes;

  useEffect(() => {
    if (isDesktop) {
      void Promise.all([
        request<Preferences>("preferences"),
        request<Workspace[]>("recent_workspaces"),
      ])
        .then(([prefs, projects]) => {
          setPreferences(prefs);
          setRecent(projects);
        })
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
  useEffect(() => {
    const timer = window.setInterval(() => {
      const currentState = current.current;
      if (
        !isDesktop ||
        demo ||
        !currentState ||
        document.visibilityState === "hidden" ||
        polling.current ||
        busy
      )
        return;
      polling.current = true;
      const epoch = workspaceEpoch.current;
      void request<Changes>("changes", {
        workspaceId: currentState.workspace.id,
      })
        .then((next) => {
          if (
            epoch === workspaceEpoch.current &&
            current.current?.workspace.id === next.workspace.id &&
            current.current.token !== next.token
          )
            setIncoming(next);
        })
        .catch((e) => {
          if (epoch === workspaceEpoch.current) setError(asError(e));
        })
        .finally(() => {
          polling.current = false;
        });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [demo, busy]);

  async function loadFile(
    file: ChangedFile,
    workspace = current.current?.workspace,
  ) {
    if (!workspace) return;
    const epoch = workspaceEpoch.current;
    const seq = ++sequence.current;
    setSelected(fileKey(file));
    setLoadingDiff(true);
    try {
      const next =
        workspace.id === "demo"
          ? demoDiff(file)
          : await request<FileDiff>("file_diff", {
              workspaceId: workspace.id,
              path: file.path,
              side: file.side,
            });
      if (
        seq !== sequence.current ||
        epoch !== workspaceEpoch.current ||
        next.workspaceId !== workspace.id ||
        current.current?.workspace.id !== workspace.id
      )
        return;
      setDiff(next);
      setLoaded((cache) => ({ ...cache, [fileKey(file)]: next }));
    } catch (e) {
      if (seq === sequence.current && epoch === workspaceEpoch.current) {
        setError(asError(e));
        setDiff(null);
      }
    } finally {
      if (seq === sequence.current && epoch === workspaceEpoch.current)
        setLoadingDiff(false);
    }
  }
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
      setIncoming(null);
      setDiff(null);
      setLoaded({});
      setSelected(null);
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
    if (!active) return;
    if (active.workspace.id === "demo") {
      setIncoming(null);
      return;
    }
    const workspaceId = active.workspace.id;
    const epoch = workspaceEpoch.current;
    const seq = ++sequence.current;
    setBusy(true);
    try {
      const next = await request<Changes>("changes", { workspaceId });
      if (seq !== sequence.current || epoch !== workspaceEpoch.current) return;
      current.current = next;
      setChanges(next);
      setIncoming(null);
      setLoaded({});
      const file =
        next.files.find((f) => fileKey(f) === selected) ?? next.files[0];
      if (file) await loadFile(file, next.workspace);
      else {
        setDiff(null);
        setSelected(null);
      }
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
  async function updatePreferences(partial: Partial<Preferences>) {
    const next = { ...preferences, ...partial };
    try {
      if (isDesktop) await request("set_preferences", { preferences: next });
      setPreferences(next);
    } catch (e) {
      setError(asError(e));
    }
  }
  async function mark(
    hunkId: string | null,
    reviewed: boolean,
    confirmed = false,
  ) {
    if (!diff) return;
    if (!hunkId && reviewed && !confirmed) {
      setDialog("mark-file");
      return;
    }
    const target = diff;
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
      setLoaded((cache) => ({ ...cache, [fileKey(target)]: next }));
      setDialog(null);
    } catch (e) {
      if (epoch === workspaceEpoch.current) setError(asError(e));
    } finally {
      if (epoch === workspaceEpoch.current) setBusy(false);
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
        setError(asError(e));
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
      if (epoch === workspaceEpoch.current) setError(asError(e));
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
  async function commit() {
    if (!preview) return;
    const epoch = workspaceEpoch.current;
    const workspaceId = preview.workspaceId;
    setBusy(true);
    setError(null);
    try {
      const result = await request<OperationResult>("commit", {
        previewId: preview.id,
        message: draft,
      });
      if (
        epoch !== workspaceEpoch.current ||
        current.current?.workspace.id !== workspaceId
      )
        return;
      if (result.ok) {
        setDraft("");
        try {
          localStorage.removeItem(`proof:draft:${preview.workspaceId}`);
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
  function startDemo() {
    ++workspaceEpoch.current;
    ++sequence.current;
    current.current = demoChanges;
    setBusy(false);
    setLoadingDiff(false);
    setIncoming(null);
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
      if (event.isComposing || event.keyCode === 229) return;
      const editing =
        event.target instanceof HTMLElement &&
        event.target.closest('input,textarea,[contenteditable="true"]') !==
          null;
      if (event.key === "Escape" && !dialog) setFocused(false);
      if (editing || busy || (dialog !== null && dialog !== "commands")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDialog((d) => (d === "commands" ? null : "commands"));
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setFocused(false);
        document.getElementById("file-search")?.focus();
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "r"
      ) {
        event.preventDefault();
        setFocused((f) => !f);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [dialog, busy]);

  const knownDiffs = Object.values(loaded).filter(
    (d) =>
      d.workspaceId === changes?.workspace.id &&
      changes?.files.some((f) => fileKey(f) === fileKey(d)),
  );
  const knownUnits = knownDiffs.flatMap((d) => d.hunks),
    reviewedUnits = knownUnits.filter(
      (h) => h.reviewState === "reviewed",
    ).length;
  const reviewedFiles = knownDiffs.filter((d) =>
    d.hunks.every((h) => h.reviewState === "reviewed"),
  ).length;
  const stagedCount =
    changes?.files.filter((f) => f.side === "staged").length ?? 0;
  const contextOpen =
    !focused && (narrow ? contextDrawer : preferences.contextOpen);
  return (
    <div className={`app ${focused ? "is-focused" : ""}`}>
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
          <button
            className="branch-picker"
            onClick={() => setTab("repository")}
          >
            <GitBranch size={15} />
            <span>{changes.branch ?? "Detached HEAD"}</span>
            <CaretDown size={11} />
          </button>
        )}
        <div className="toolbar-spacer" />
        {demo && <span className="demo-badge">演示数据</span>}
        <button
          className="observer-status"
          onClick={() => setDialog("settings")}
        >
          <span className="status-dot neutral" />
          观察未接入
        </button>
        <button
          className="command-trigger"
          title="命令面板"
          aria-label="打开命令面板"
          onClick={() => setDialog("commands")}
        >
          <Command size={15} />
          <kbd>K</kbd>
        </button>
        <button
          className="icon-button"
          aria-label="设置"
          title="设置"
          onClick={() => setDialog("settings")}
        >
          <GearSix size={19} />
        </button>
      </header>
      {changes ? (
        <>
          <nav className="workspace-navigation" aria-label="工作区">
            <div className="primary-tabs">
              <button
                className={tab === "changes" ? "active" : ""}
                onClick={() => setTab("changes")}
              >
                <span>Changes</span>
                <span className="tab-count">{changes.files.length}</span>
              </button>
              <button
                className={tab === "repository" ? "active" : ""}
                onClick={() => setTab("repository")}
              >
                <HardDrives size={15} />
                Repository
              </button>
            </div>
            <span className="workspace-path" title={changes.workspace.path}>
              {changes.workspace.path}
            </span>
            <button
              className="icon-button"
              disabled={busy}
              aria-label="刷新工作区"
              title="刷新工作区"
              onClick={() => {
                void refresh();
              }}
            >
              <ArrowClockwise size={16} className={busy ? "spinning" : ""} />
            </button>
          </nav>
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
          {incoming && (
            <div className="stale-banner">
              <ArrowClockwise size={16} />
              <span>
                工作区出现新变化。当前阅读快照保持不变，写操作会重新核对。
              </span>
              <button
                className="button compact"
                onClick={() => {
                  void refresh();
                }}
              >
                查看最新变化
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
      {!changes ? (
        <main className="welcome">
          <div className="welcome-main">
            <ProofMark large />
            <p className="welcome-kicker">每一次修改，都值得看清。</p>
            <h1>从真实代码开始审查</h1>
            <p className="welcome-description">
              打开本地 Git 仓库，逐段核对变化。
              <br />
              保留你的开发方式，让每一次判断有据可查。
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
              体验演示工作区 <ArrowRight size={15} />
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
      ) : tab === "repository" ? (
        <RepositoryView
          key={changes.workspace.id}
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
      ) : (
        <main className={`workbench ${contextOpen ? "with-context" : ""}`}>
          {!focused && (
            <aside className="files-panel">
              <FileTree
                files={changes.files}
                selected={selected}
                onSelect={(f) => {
                  void loadFile(f);
                }}
                search={search}
                onSearch={setSearch}
                loaded={loaded}
                scope={scope}
                onScope={setScope}
              />
            </aside>
          )}
          <div className="center-panel">
            {diff ? (
              <DiffView
                key={`${diff.path}:${diff.side}`}
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
                onHistory={demo ? undefined : () => setDialog("file-history")}
                onPreferences={(p) => {
                  void updatePreferences(p);
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
                    ? "选择一个文件，开始审查"
                    : "当前没有代码变化"}
                </h2>
                <p>
                  {changes.files.length
                    ? "真实 Diff、明确基准、由你判断。"
                    : "工作树与索引中暂无需要核对的修改。"}
                </p>
                {!changes.files.length && (
                  <button
                    className="button"
                    onClick={() => setTab("repository")}
                  >
                    查看提交历史
                  </button>
                )}
              </div>
            )}
            {loadingDiff && (
              <div className="loading-overlay" role="status">
                正在读取文件变化…
              </div>
            )}
          </div>
          {contextOpen && (
            <ContextInspector
              diff={diff}
              demo={demo}
              drawer={narrow}
              onClose={() => {
                if (narrow) setContextDrawer(false);
                else void updatePreferences({ contextOpen: false });
              }}
              onSettings={() => setDialog("settings")}
            />
          )}
        </main>
      )}
      {changes && (
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
              已打开内容{" "}
              <strong>
                {reviewedUnits}/{knownUnits.length}
              </strong>{" "}
              块已审查
            </span>
          </div>
          <span className="global-remaining">
            全局还有 {changes.files.length - reviewedFiles} 个文件未完成核对
          </span>
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
            className="icon-button"
            aria-label={contextOpen ? "收起上下文" : "显示上下文"}
            title="上下文面板"
            onClick={() => {
              setFocused(false);
              if (narrow) setContextDrawer(!contextDrawer);
              else
                void updatePreferences({
                  contextOpen: !preferences.contextOpen,
                });
            }}
          >
            <SidebarSimple size={18} />
          </button>
          {diff && (
            <button
              className="button compact"
              disabled={!diff.canStage || busy}
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
              {diff.side === "staged" ? "撤销文件暂存" : "暂存文件"}
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
            disabled={
              busy || demo || !stagedCount || !changes.workspace.trusted
            }
            onClick={() => {
              void prepareCommit();
            }}
          >
            <GitCommit size={16} />
            提交预览<span className="button-count">{stagedCount}</span>
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
          <p>恢复点已经保存。确认后，所选工作树内容会还原到索引中的版本。</p>
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
      {dialog === "mark-file" && diff && (
        <Modal
          title="标记整个文件已审查"
          error={error}
          onClose={() => setDialog(null)}
        >
          <p>
            此标记覆盖 <strong>{diff.path}</strong> 当前完整 Diff 的{" "}
            <strong>{diff.hunks.length} 个变化块</strong>
            ，包含尚未滚动到的内容。
          </p>
          <p className="inline-help">
            只记录你对这个版本的人工审查，不会暂存文件或改变测试状态。
          </p>
          <div className="modal-actions">
            <button className="button" onClick={() => setDialog(null)}>
              继续逐段阅读
            </button>
            <button
              className="button primary"
              disabled={busy}
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
            <span>{preview.files.length} 个已暂存文件</span>
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
            {preview.reviewed}/{preview.total} 个变化块已审查。
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
      {dialog === "settings" && (
        <Settings
          workspaces={recent}
          workspaceId={changes?.workspace.id}
          demo={demo}
          error={error}
          preferences={preferences}
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
                  setFocused(false);
                  setTimeout(
                    () => document.getElementById("file-search")?.focus(),
                    0,
                  );
                },
                disabled: !changes,
              },
              {
                label: "刷新工作区",
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
                run: () => setDialog("settings"),
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
