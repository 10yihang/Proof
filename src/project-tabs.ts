import type { Workspace } from "./types";

export interface ProjectSession {
  /** Stable renderer identity, including while the welcome page is adopted. */
  key: string;
  workspaceId?: string;
  workspace?: Workspace;
}

export interface ProjectSessions {
  sessions: ProjectSession[];
  activeKey: string;
}

export function initialProjectSessions(workspaceId?: string): ProjectSessions {
  return {
    sessions: [{ key: "initial", workspaceId }],
    activeKey: "initial",
  };
}

export function selectProjectSession(state: ProjectSessions, key: string) {
  return state.sessions.some((session) => session.key === key)
    ? { ...state, activeKey: key }
    : state;
}

export function adoptProjectWorkspace(
  state: ProjectSessions,
  key: string,
  workspace: Workspace,
): ProjectSessions {
  const source = state.sessions.find((session) => session.key === key);
  if (!source) return state;
  const existing = state.sessions.find(
    (session) => session.key !== key && session.workspaceId === workspace.id,
  );
  if (existing)
    return {
      sessions: state.sessions
        .filter((session) => session.key !== key)
        .map((session) =>
          session.key === existing.key ? { ...session, workspace } : session,
        ),
      activeKey: state.activeKey === key ? existing.key : state.activeKey,
    };
  if (
    source.workspace &&
    (Object.keys(workspace) as (keyof Workspace)[]).every(
      (field) => source.workspace?.[field] === workspace[field],
    )
  )
    return state;
  return {
    ...state,
    sessions: state.sessions.map((session) =>
      session.key === key
        ? { ...session, workspaceId: workspace.id, workspace }
        : session,
    ),
  };
}

export function openProjectSession(
  state: ProjectSessions,
  workspace: Workspace,
  key: string,
): ProjectSessions {
  const existing = state.sessions.find(
    (session) => session.workspaceId === workspace.id,
  );
  if (existing)
    return adoptProjectWorkspace(
      { ...state, activeKey: existing.key },
      existing.key,
      workspace,
    );
  return {
    sessions: [
      ...state.sessions.filter((session) => session.workspaceId),
      { key, workspaceId: workspace.id, workspace },
    ],
    activeKey: key,
  };
}

export function closeProjectSession(
  state: ProjectSessions,
  key: string,
  welcomeKey: string,
): ProjectSessions {
  const index = state.sessions.findIndex((session) => session.key === key);
  if (index < 0) return state;
  const sessions = state.sessions.filter((session) => session.key !== key);
  if (!sessions.length)
    return { sessions: [{ key: welcomeKey }], activeKey: welcomeKey };
  return {
    sessions,
    activeKey:
      state.activeKey === key
        ? sessions[Math.min(index, sessions.length - 1)].key
        : state.activeKey,
  };
}

export function cycleProjectSession(state: ProjectSessions, direction: number) {
  const projects = state.sessions.filter((session) => session.workspaceId);
  if (projects.length < 2) return state;
  const index = projects.findIndex(
    (session) => session.key === state.activeKey,
  );
  const next = (index + direction + projects.length) % projects.length;
  return { ...state, activeKey: projects[next].key };
}
