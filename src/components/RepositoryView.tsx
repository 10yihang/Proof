import { DropdownMenuItem as MenuItem } from "./ui/dropdown-menu";
import { Button } from "./ui/controls";
import { t } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CaretDown,
  CaretRight,
  Check,
  Folder,
  FolderOpen,
  GitBranch,
  HardDrives,
} from "@phosphor-icons/react";
import { useRequest } from "../api";
import type { BranchEntry, Changes, WorktreeEntry } from "../types";
import type { HistoryComparison } from "./HistoryDiff";
import { CommitHistory } from "./CommitHistory";
import { branchRef } from "../history-actions";
import { demoGraphPage } from "../graph-demo";
import {
  HistoryTargetActions,
  GitContextMenu,
  HistoryMoreButton,
} from "./HistoryActions";
import type { HistoryActions } from "./HistoryActions";

export type RepositorySection = "history" | "branches" | "worktrees";

export function RepositoryView({
  actions,
  section,
  onSection,
  changes,
  demo,
  onOpen,
  onError,
  onOpenDiff,
}: {
  actions: HistoryActions;
  section: RepositorySection;
  onSection: (section: RepositorySection) => void;
  changes: Changes;
  demo: boolean;
  onOpen: (path: string) => Promise<void>;
  onError: (e: unknown) => void;
  onOpenDiff: (value: HistoryComparison) => void;
}) {
  const request = useRequest();
  const [comparison, setComparison] = useState<HistoryComparison | null>(null);
  const [branchAnchor, setBranchAnchor] = useState<BranchEntry | null>(null);
  const [branchMenu, setBranchMenu] = useState<{
    branch: BranchEntry;
    x: number;
    y: number;
  } | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );

  function toggleGroup(prefix: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) {
        next.delete(prefix);
      } else {
        next.add(prefix);
      }
      return next;
    });
  }

  function compareBranches(base: BranchEntry, target: BranchEntry) {
    setComparison({
      base: base.oid,
      target: target.oid,
      baseLabel: base.name,
      targetLabel: target.name,
    });
    setHistoryScope("all");
    setHistoryRef(null);
    onSection("history");
    onOpenDiff({
      base: base.oid,
      target: target.oid,
      baseLabel: base.name,
      targetLabel: target.name,
    });
  }
  function chooseBranch(branch: BranchEntry, compare: boolean) {
    if (compare && branchAnchor) {
      compareBranches(branchAnchor, branch);
      return;
    }
    setBranchAnchor(branch);
    setComparison(null);
    setHistoryScope(
      `refs/${branch.remote ? "remotes" : "heads"}/${branch.name}`,
    );
    setHistoryRef(`${branch.remote ? "remote" : "local"}:${branch.name}`);
  }
  function branchContext(event: React.MouseEvent, branch: BranchEntry) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setBranchMenu({
      branch,
      x: event.type === "contextmenu" ? event.clientX : rect.left,
      y: event.type === "contextmenu" ? event.clientY : rect.bottom + 4,
    });
  }
  const [historyVisited, setHistoryVisited] = useState(section === "history");
  useEffect(() => {
    if (section === "history") setHistoryVisited(true);
  }, [section]);
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [historyScope, setHistoryScope] = useState("all");
  const [historyRef, setHistoryRef] = useState<string | null>(null);

  // Group branches by path prefix (e.g. "codex/backup/*" → folder "codex/backup")
  const groupedBranches = useMemo(() => {
    const groups = new Map<
      string,
      { local: BranchEntry[]; remote: BranchEntry[] }
    >();
    const ungrouped: { local: BranchEntry[]; remote: BranchEntry[] } = {
      local: [],
      remote: [],
    };

    for (const branch of branches) {
      const lastSlash = branch.name.lastIndexOf("/");
      if (lastSlash <= 0) {
        // No prefix or prefix at start (e.g. "/foo") → ungrouped
        ungrouped[branch.remote ? "remote" : "local"].push(branch);
        continue;
      }
      const prefix = branch.name.slice(0, lastSlash);
      const key = `${branch.remote ? "remote" : "local"}:${prefix}`;
      if (!groups.has(key)) {
        groups.set(key, { local: [], remote: [] });
      }
      groups.get(key)![branch.remote ? "remote" : "local"].push(branch);
    }

    // Sort groups by name, ungrouped branches by name
    const sortedGroups = [...groups.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    ungrouped.local.sort((a, b) => a.name.localeCompare(b.name));
    ungrouped.remote.sort((a, b) => a.name.localeCompare(b.name));

    return { groups: sortedGroups, ungrouped };
  }, [branches]);
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    if (demo) {
      setBranches(demoGraphPage().branches);
      setWorktrees([
        {
          path: changes.workspace.path,
          branch: changes.branch,
          head: changes.head ?? "",
          locked: false,
        },
      ]);
      setBusy(false);
      return;
    }
    void Promise.all([
      request<BranchEntry[]>("branches", { workspaceId: changes.workspace.id }),
      request<WorktreeEntry[]>("worktrees", {
        workspaceId: changes.workspace.id,
      }),
    ])
      .then(([refs, trees]) => {
        if (!cancelled) {
          setBranches(refs);
          setWorktrees(trees);
        }
      })
      .catch((e) => {
        if (!cancelled) onError(e);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    changes.workspace.id,
    changes.head,
    changes.branch,
    demo,
    actions.revision,
  ]);
  useEffect(() => {
    if (
      historyScope.startsWith("refs/") &&
      branches.length &&
      !branches.some((branch) => branchRef(branch) === historyScope)
    ) {
      setHistoryScope("all");
      setHistoryRef(null);
      setBranchAnchor(null);
    }
  }, [branches, historyScope]);
  return (
    <main className="repository-view">
      <aside className="repository-nav">
        <span className="sidebar-heading">
          <strong>{t("仓库与引用")}</strong>
        </span>
        <Button
          className={section === "worktrees" ? "active" : ""}
          onClick={() =>
            onSection(section === "worktrees" ? "history" : "worktrees")
          }
        >
          <HardDrives size={17} />
          {t("Worktree")}
          <span className="count-badge">{worktrees.length}</span>
        </Button>
        {section === "history" && (
          <div className="repository-refs">
            <div className="refs-heading">
              <span>{t("本地分支")}</span>
              <span>{branches.filter((branch) => !branch.remote).length}</span>
            </div>
            <Button
              className={`repo-ref ${historyScope === "all" ? "active" : ""}`}
              onClick={() => {
                setHistoryScope("all");
                setHistoryRef(null);
              }}
            >
              <GitBranch size={15} />
              <span>{t("所有分支")}</span>
            </Button>
            {branches
              .filter((branch) => !branch.remote)
              .map((branch) => (
                <div className="repo-ref-wrap" key={branch.name}>
                  <Button
                    className={`repo-ref ${branch.current ? "is-current" : ""} ${historyRef === `${branch.remote ? "remote" : "local"}:${branch.name}` ? "active" : ""}`}
                    title={t("查看 {v0} 的历史", { v0: branch.name })}
                    onClick={(event) =>
                      chooseBranch(
                        branch,
                        event.metaKey || event.ctrlKey || event.shiftKey,
                      )
                    }
                    onContextMenu={(event) => branchContext(event, branch)}
                    onDoubleClick={() => {
                      if (!actions.disabled && !branch.current)
                        actions.open("switch", { type: "branch", branch });
                    }}
                  >
                    <GitBranch size={14} />
                    <span>{branch.name}</span>
                    {branch.current && (
                      <span
                        className="current-ref-badge"
                        aria-label={t("当前分支")}
                      >
                        HEAD
                      </span>
                    )}
                  </Button>
                  <HistoryMoreButton
                    label={t("{v0} 的 Branch 操作", { v0: branch.name })}
                    onClick={(event) => branchContext(event, branch)}
                  />
                </div>
              ))}
            {branches.some((branch) => branch.remote) && (
              <>
                <div className="refs-heading">
                  <span>{t("远程引用")}</span>
                  <span>{t("本地已知")}</span>
                </div>
                {branches
                  .filter((branch) => branch.remote)
                  .map((branch) => (
                    <div className="repo-ref-wrap" key={branch.name}>
                      <Button
                        className={`repo-ref ${historyRef === `${branch.remote ? "remote" : "local"}:${branch.name}` ? "active" : ""}`}
                        title={t("查看 {v0} 的本地历史", { v0: branch.name })}
                        onClick={(event) =>
                          chooseBranch(
                            branch,
                            event.metaKey || event.ctrlKey || event.shiftKey,
                          )
                        }
                        onContextMenu={(event) => branchContext(event, branch)}
                        onDoubleClick={() => {
                          if (!actions.disabled)
                            actions.open("switch", { type: "branch", branch });
                        }}
                      >
                        <GitBranch size={14} />
                        <span>{branch.name}</span>
                      </Button>
                      <HistoryMoreButton
                        label={t("{v0} 的 Branch 操作", { v0: branch.name })}
                        onClick={(event) => branchContext(event, branch)}
                      />
                    </div>
                  ))}
              </>
            )}
          </div>
        )}
        <div className="repository-meta" title={changes.gitVersion}>
          <span>{t("Local repository")}</span>
        </div>
      </aside>
      <section
        className={`repository-content ${section === "history" ? "is-history" : ""}`}
      >
        {section !== "history" && (
          <header className="repository-header">
            <div>
              <h2>{section === "branches" ? t("分支") : "Worktree"}</h2>
              <p>
                {section === "branches"
                  ? t("本地分支与已知远程引用。")
                  : t("每个 worktree 的代码和审查进度独立保存。")}
              </p>
            </div>
            {section === "branches" && (
              <Button
                className="button compact"
                disabled={demo || !changes.workspace.trusted || busy}
                onClick={() => actions.open("createBranch")}
              >
                <GitBranch size={15} />
                {t("创建分支")}
              </Button>
            )}
          </header>
        )}
        <div className="repository-page" hidden={section !== "history"}>
          {(historyVisited || section === "history") && (
            <CommitHistory
              actions={actions}
              branches={branches}
              branchNavigation={{
                selected: branchAnchor,
                compare: compareBranches,
                show: (branch) => {
                  chooseBranch(branch, false);
                  onSection("history");
                },
              }}
              changes={changes}
              demo={demo}
              onOpenDiff={onOpenDiff}
              requestedComparison={comparison}
              scope={historyScope}
              scopeLabel={historyRef?.slice(historyRef.indexOf(":") + 1)}
              onScope={(scope) => {
                setComparison(null);
                setHistoryScope(scope);
                setHistoryRef(null);
              }}
              onBranches={setBranches}
            />
          )}
        </div>
        {section === "branches" && (
          <div className="branch-list">
            {/* Grouped branches (e.g. codex/backup/*) */}
            {groupedBranches.groups.map(([key, { local, remote }]) => {
              const prefix = key.slice(key.indexOf(":") + 1);
              const allBranches = [...local, ...remote];
              const isCollapsed = collapsedGroups.has(key);
              return (
                <div key={key} className="branch-group">
                  <button
                    className="branch-group-header"
                    onClick={() => toggleGroup(key)}
                    aria-expanded={!isCollapsed}
                    aria-label={t(
                      isCollapsed
                        ? "展开 {v0} 分组"
                        : "折叠 {v0} 分组",
                      { v0: prefix },
                    )}
                  >
                    {isCollapsed ? (
                      <CaretRight size={14} />
                    ) : (
                      <CaretDown size={14} />
                    )}
                    <Folder size={15} />
                    <span>{prefix}</span>
                    <small>
                      {allBranches.length} {t("个分支")}
                    </small>
                  </button>
                  {!isCollapsed &&
                    allBranches.map((branch) => (
                      <div
                        className="branch-row branch-row-grouped"
                        key={`${branch.remote}:${branch.name}`}
                        onContextMenu={(event) => branchContext(event, branch)}
                      >
                        <GitBranch size={19} />
                        <div>
                          <strong>
                            {branch.name.slice(prefix.length + 1)}
                          </strong>
                          <small>
                            {branch.remote
                              ? t("远程引用 · 本地已知")
                              : t("本地分支")}
                            <code>{branch.oid.slice(0, 8)}</code>
                          </small>
                        </div>
                        {branch.current ? (
                          <span className="tag active-tag">
                            <Check size={13} />
                            {t("当前分支")}
                          </span>
                        ) : (
                          !branch.remote && (
                            <Button
                              className="button compact"
                              disabled={demo || busy || !changes.workspace.trusted}
                              onClick={() => {
                                actions.open("switch", { type: "branch", branch });
                              }}
                            >
                              {t("切换 ")}
                              <ArrowRight size={14} />
                            </Button>
                          )
                        )}
                        <HistoryMoreButton
                          label={t("{v0} 的 Branch 操作", { v0: branch.name })}
                          onClick={(event) => branchContext(event, branch)}
                        />
                      </div>
                    ))}
                </div>
              );
            })}

            {/* Ungrouped branches */}
            {[
              ...groupedBranches.ungrouped.local,
              ...groupedBranches.ungrouped.remote,
            ].map((branch) => (
              <div
                className="branch-row"
                key={`${branch.remote}:${branch.name}`}
                onContextMenu={(event) => branchContext(event, branch)}
              >
                <GitBranch size={19} />
                <div>
                  <strong>{branch.name}</strong>
                  <small>
                    {branch.remote ? t("远程引用 · 本地已知") : t("本地分支")}
                    <code>{branch.oid.slice(0, 8)}</code>
                  </small>
                </div>
                {branch.current ? (
                  <span className="tag active-tag">
                    <Check size={13} />
                    {t("当前分支")}
                  </span>
                ) : (
                  !branch.remote && (
                    <Button
                      className="button compact"
                      disabled={demo || busy || !changes.workspace.trusted}
                      onClick={() => {
                        actions.open("switch", { type: "branch", branch });
                      }}
                    >
                      {t("切换 ")}
                      <ArrowRight size={14} />
                    </Button>
                  )
                )}
                <HistoryMoreButton
                  label={t("{v0} 的 Branch 操作", { v0: branch.name })}
                  onClick={(event) => branchContext(event, branch)}
                />
              </div>
            ))}
          </div>
        )}
        {section === "worktrees" && (
          <div className="worktree-list">
            {worktrees.map((tree) => (
              <div key={tree.path} className="worktree-card">
                <FolderOpen size={22} />
                <div>
                  <strong>{tree.branch ?? "Detached HEAD"}</strong>
                  <code>{tree.path}</code>
                  <small>
                    {tree.head.slice(0, 8)}
                    {tree.locked && t(" · 已锁定")}
                  </small>
                </div>
                {tree.path === changes.workspace.path ? (
                  <span className="tag active-tag">{t("当前 Worktree")}</span>
                ) : (
                  <Button
                    className="button compact"
                    disabled={demo}
                    onClick={() => {
                      void onOpen(tree.path);
                    }}
                  >
                    {t("打开")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      {branchMenu && (
        <GitContextMenu
          x={branchMenu.x}
          y={branchMenu.y}
          onClose={() => setBranchMenu(null)}
          label={t("Branch 操作")}
        >
          <HistoryTargetActions
            target={{ type: "branch", branch: branchMenu.branch }}
            actions={actions}
            changes={changes}
            onClose={() => setBranchMenu(null)}
          />
          <MenuItem
            role="menuitem"
            disabled={!changes.head}
            onClick={() => {
              compareBranches(branchMenu.branch, {
                name: changes.branch ?? "HEAD",
                oid: changes.head!,
                current: true,
                remote: false,
              });
              setBranchMenu(null);
            }}
          >
            {t("与当前 Branch 比较")}
          </MenuItem>
          <MenuItem
            role="menuitem"
            disabled={
              !branchAnchor || branchAnchor.name === branchMenu.branch.name
            }
            onClick={() => {
              if (branchAnchor)
                compareBranches(branchAnchor, branchMenu.branch);
              setBranchMenu(null);
            }}
          >
            {t("与所选 Branch 比较")}
          </MenuItem>
          <MenuItem
            role="menuitem"
            onClick={() => {
              chooseBranch(branchMenu.branch, false);
              onSection("history");
              setBranchMenu(null);
            }}
          >
            {t("查看此 Branch 的历史")}
          </MenuItem>
        </GitContextMenu>
      )}
    </main>
  );
}
