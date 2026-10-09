import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import App from "../App";
import { useRequest } from "../api";
import { t } from "../i18n";
import {
  adoptProjectWorkspace,
  closeProjectSession,
  cycleProjectSession,
  initialProjectSessions,
  openProjectSession,
  selectProjectSession,
} from "../project-tabs";
import type { ProjectSession } from "../project-tabs";
import type { Workspace } from "../types";
import { Modal } from "./Modal";
import { ProjectTabs } from "./ProjectTabs";
import { Button } from "./ui/controls";
import { toast } from "./ui/toast";

export interface ProjectCloseGuard {
  dirty: boolean;
  busy: boolean;
}

function focusProjectTab() {
  requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent("proof:focus-project")),
  );
}

function ProjectRenderer({
  session,
  active,
  initialDataNotice,
  projectTabs,
  onOpen,
  onReady,
  onClose,
  onGuard,
}: {
  session: ProjectSession;
  active: boolean;
  initialDataNotice?: string;
  projectTabs: ReactNode;
  onOpen: (path: string) => Promise<void>;
  onReady: (key: string, workspace: Workspace) => void;
  onClose: (key: string) => void;
  onGuard: (key: string, guard: ProjectCloseGuard) => void;
}) {
  const ready = useCallback(
    (workspace: Workspace) => onReady(session.key, workspace),
    [session.key, onReady],
  );
  const close = useCallback(() => onClose(session.key), [session.key, onClose]);
  const guard = useCallback(
    (value: ProjectCloseGuard) => onGuard(session.key, value),
    [session.key, onGuard],
  );
  return (
    <div
      className="project-session"
      id={`project-panel-${session.workspaceId ?? session.key}`}
      role={session.workspace ? "tabpanel" : undefined}
      aria-label={session.workspace?.name}
      hidden={!active}
      inert={!active}
      data-project-id={session.workspaceId}
    >
      <App
        active={active}
        autoDemo={session.key === "initial"}
        initialWorkspaceId={session.workspaceId}
        initialDataNotice={initialDataNotice}
        projectTabs={projectTabs}
        onOpenProject={onOpen}
        onProjectReady={ready}
        onCloseProject={close}
        onProjectCloseGuardChange={guard}
      />
    </div>
  );
}

/** Each open project keeps its renderer, drafts and reading anchors alive. */
export function ProjectWorkspace({
  initialWorkspaceId,
  initialDataNotice,
  onWorkspaceChange,
}: {
  initialWorkspaceId?: string;
  initialDataNotice?: string;
  onWorkspaceChange?: (id?: string) => void;
}) {
  const request = useRequest();
  const [state, setState] = useState(() =>
    initialProjectSessions(initialWorkspaceId),
  );
  const live = useRef(state);
  live.current = state;
  const mounted = useRef(false);
  const openSequence = useRef(0);
  const guards = useRef(new Map<string, ProjectCloseGuard>());
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const activeSession = state.sessions.find(
    (session) => session.key === state.activeKey,
  );
  const activeWorkspace = activeSession?.workspace;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++openSequence.current;
    };
  }, []);
  useEffect(() => {
    onWorkspaceChange?.(activeSession?.workspaceId);
  }, [activeSession?.workspaceId, onWorkspaceChange]);
  useEffect(() => {
    const cycle = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        !event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.key !== "Tab" ||
        document.querySelector(
          "[role='dialog'][data-open]:not(.proof-branch-popup)",
        )
      )
        return;
      const next = cycleProjectSession(live.current, event.shiftKey ? -1 : 1);
      if (next === live.current) return;
      event.preventDefault();
      setState(next);
      focusProjectTab();
    };
    window.addEventListener("keydown", cycle);
    return () => window.removeEventListener("keydown", cycle);
  }, []);

  const openProject = useCallback(
    async (path: string) => {
      if (!path.trim()) return;
      const sequence = ++openSequence.current;
      const existing = live.current.sessions.find(
        (session) => session.workspace?.path === path,
      );
      if (existing) {
        setState((state) => selectProjectSession(state, existing.key));
        return;
      }
      const workspace = await request<Workspace>("open_workspace", { path });
      if (!mounted.current || sequence !== openSequence.current) return;
      // The native workspace identity deduplicates aliases and symlink paths.
      setState((state) =>
        openProjectSession(state, workspace, crypto.randomUUID()),
      );
    },
    [request],
  );
  const removeProject = useCallback((key: string) => {
    ++openSequence.current;
    guards.current.delete(key);
    setPendingClose(null);
    setState((state) => closeProjectSession(state, key, crypto.randomUUID()));
    focusProjectTab();
  }, []);
  const closeProject = useCallback(
    (key: string) => {
      const guard = guards.current.get(key);
      if (guard?.busy) {
        toast.add({ title: t("项目正在处理任务，请稍后关闭。"), type: "info" });
        return;
      }
      if (guard?.dirty) {
        setState((state) => selectProjectSession(state, key));
        setPendingClose(key);
        return;
      }
      removeProject(key);
    },
    [removeProject],
  );
  const readyProject = useCallback((key: string, workspace: Workspace) => {
    setState((state) => adoptProjectWorkspace(state, key, workspace));
  }, []);
  const guardProject = useCallback((key: string, guard: ProjectCloseGuard) => {
    guards.current.set(key, guard);
  }, []);
  const projectTabs = (
    <ProjectTabs
      projects={state.sessions.flatMap((session) =>
        session.workspace
          ? [
              {
                id: session.workspace.id,
                name: session.workspace.name,
                path: session.workspace.path,
              },
            ]
          : [],
      )}
      activeId={activeWorkspace?.id ?? null}
      onSelect={(id) => {
        ++openSequence.current;
        const session = live.current.sessions.find(
          (session) => session.workspaceId === id,
        );
        if (session) {
          setState((state) => selectProjectSession(state, session.key));
          focusProjectTab();
        }
      }}
      onClose={(id) => {
        const session = live.current.sessions.find(
          (session) => session.workspaceId === id,
        );
        if (session) closeProject(session.key);
      }}
      onOpen={() => window.dispatchEvent(new CustomEvent("proof:open-project"))}
    />
  );

  return (
    <div className="project-workspace">
      {state.sessions.map((session) => (
        <ProjectRenderer
          key={session.key}
          session={session}
          active={session.key === state.activeKey}
          initialDataNotice={
            session.key === "initial" ? initialDataNotice : undefined
          }
          projectTabs={projectTabs}
          onOpen={openProject}
          onReady={readyProject}
          onClose={closeProject}
          onGuard={guardProject}
        />
      ))}
      {pendingClose && (
        <Modal title={t("关闭项目")} onClose={() => setPendingClose(null)}>
          <p>{t("此项目有未保存的文件更改。关闭将丢弃这些更改。")}</p>
          <div className="modal-actions">
            <Button className="button" onClick={() => setPendingClose(null)}>
              {t("取消")}
            </Button>
            <Button
              className="button danger"
              onClick={() => {
                if (guards.current.get(pendingClose)?.busy) return;
                removeProject(pendingClose);
              }}
            >
              {t("丢弃并关闭")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
