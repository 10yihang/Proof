import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { request } from "./api";
import type { RepositoryLayout, Workspace } from "./types";
import {
  defaultRepositoryLayout,
  RepositoryLayouts,
} from "./repository-layout";

export function useRepositoryLayout(
  workspace: Workspace | undefined,
  demo: boolean,
) {
  const [store] = useState(
    () =>
      new RepositoryLayouts({
        read: (scope) =>
          scope.demo
            ? Promise.resolve(defaultRepositoryLayout)
            : request<RepositoryLayout>("repository_layout", {
                workspaceId: scope.workspaceId,
              }),
        write: (scope, layout) =>
          scope.demo
            ? Promise.resolve()
            : request<void>("set_repository_layout", {
                workspaceId: scope.workspaceId,
                layout,
              }),
      }),
  );
  const scope = useMemo(
    () => ({
      key: `${demo ? "demo" : "local"}:${workspace?.repositoryId ?? ""}`,
      workspaceId: workspace?.id ?? "",
      demo,
    }),
    [workspace?.id, workspace?.repositoryId, demo],
  );
  const snapshot = useSyncExternalStore(store.subscribe, () =>
    store.snapshot(scope.key),
  );
  useEffect(() => {
    if (scope.workspaceId) void store.load(scope);
  }, [store, scope]);
  return {
    ...snapshot,
    scopeKey: scope.key,
    update: (partial: Partial<RepositoryLayout>) =>
      store.update(scope, partial),
    retry: () => store.load(scope),
    reset: () => store.update(scope, defaultRepositoryLayout),
  };
}
