import { useCallback, type SetStateAction } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import type { ComparisonTab } from "./components/WorkspaceTabs";
import type { RepositorySection } from "./components/RepositoryView";

export type WindowDialog =
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
export interface WindowUI {
  tab: "changes" | "commit" | "repository" | `diff:${string}`;
  diffTabs: ComparisonTab[];
  dialog: WindowDialog;
  inspectorTab: "context" | "ai";
  repositorySection: RepositorySection;
  focused: boolean;
  filesDrawer: boolean;
  contextDrawer: boolean;
}
/** A store per renderer/App lifetime. Git and persisted data never live here. */
export function createWindowUI(dialog: WindowDialog = null) {
  return createStore<WindowUI>(() => ({
    tab: "changes",
    diffTabs: [],
    dialog,
    inspectorTab: "context",
    repositorySection: "history",
    focused: false,
    filesDrawer: false,
    contextDrawer: false,
  }));
}
export function useWindowField<K extends keyof WindowUI>(
  store: StoreApi<WindowUI>,
  key: K,
) {
  const value = useStore(store, (state) => state[key]);
  const update = useCallback(
    (next: SetStateAction<WindowUI[K]>) =>
      store.setState(
        (state) =>
          ({
            [key]:
              typeof next === "function"
                ? (next as (value: WindowUI[K]) => WindowUI[K])(state[key])
                : next,
          }) as Pick<WindowUI, K>,
      ),
    [store, key],
  );
  return [value, update] as const;
}
export function reorderComparisonTabs(
  tabs: ComparisonTab[],
  sourceId: string,
  targetId: string,
) {
  const from = tabs.findIndex((tab) => tab.id === sourceId),
    to = tabs.findIndex((tab) => tab.id === targetId);
  if (
    from < 0 ||
    to < 0 ||
    from === to ||
    tabs[from].workspaceId !== tabs[to].workspaceId
  )
    return tabs;
  const next = tabs.slice();
  const [source] = next.splice(from, 1);
  next.splice(to, 0, source);
  return next;
}
