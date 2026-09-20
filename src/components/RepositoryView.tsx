import { DropdownMenuItem as MenuItem } from "./ui/dropdown-menu";
import { Button } from "./ui/controls";
import { t } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import {
  CaretDown,
  CaretRight,
  Folder,
  FolderOpen,
  GitBranch,
  HardDrives,
} from "@phosphor-icons/react";
import { useRequest } from "../api";
import type { BranchEntry, Changes, WorktreeEntry } from "../types";
import {
  buildBranchTree,
  countTreeBranches,
  type BranchTreeNode,
} from "../branch-tree";
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

export type RepositorySection = "history" | "worktrees";

export function RepositoryView({
  actions,
  section,
  onSection,
  changes,
  demo,
  onOpen,
  onError,
  onOpenDiff,
  branchDelimiter = "/",
}: {
  actions: HistoryActions;
  section: RepositorySection;
  onSection: (section: RepositorySection) => void;
  changes: Changes;
  demo: boolean;
  onOpen: (path: string) => Promise<void>;
  onError: (e: unknown) => void;
  onOpenDiff: (value: HistoryComparison) => void;
  branchDelimiter?: string;
}) {
  const request = useRequest();
  const [comparison, setComparison] = useState<HistoryComparison | null>(null);
  const [branchAnchor, setBranchAnchor] = useState<BranchEntry | null>(null);
  const [branchMenu, setBranchMenu] = useState<{
    branch: BranchEntry;
    x: number;
    y: number;
  } | null>(null);

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
  const [historyScope, setHistoryScope] = useState("all");
  const [historyRef, setHistoryRef] = useState<string | null>(null);

  // Sidebar: nested tree keyed by the configurable delimiter. Remote names
  // carry their remote prefix (origin/…), so they fold into the same shape.
  const sidebarTree = useMemo(
    () => ({
      local: buildBranchTree(
        branches.filter((b) => !b.remote),
        branchDelimiter,
      ),
      remote: buildBranchTree(
        branches.filter((b) => b.remote),
        branchDelimiter,
      ),
    }),
    [branches, branchDelimiter],
  );

  const [collapsedRefs, setCollapsedRefs] = useState<Set<string>>(new Set());
  function toggleRefGroup(path: string) {
    setCollapsedRefs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  useEffect(() => {
    let cancelled = false;
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

  // Render a single branch leaf row in the History sidebar tree.
  function renderSidebarLeaf(branch: BranchEntry, depth: number) {
    const indent = depth * 16;
    const segments = branch.name.split(branchDelimiter);
    const leafName = segments[segments.length - 1] || branch.name;
    return (
      <div
        className="repo-ref-wrap"
        key={`${branch.remote}:${branch.name}`}
        style={{ paddingLeft: `${indent}px` }}
      >
        <Button
          className={`repo-ref ${branch.current ? "is-current" : ""} ${historyRef === `${branch.remote ? "remote" : "local"}:${branch.name}` ? "active" : ""}`}
          title={t(
            branch.remote
              ? "查看 {v0} 的本地历史"
              : "查看 {v0} 的历史",
            { v0: branch.name },
          )}
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
          <span>{leafName}</span>
          {branch.current && (
            <span className="current-ref-badge" aria-label={t("当前分支")}>
              HEAD
            </span>
          )}
        </Button>
        <HistoryMoreButton
          label={t("{v0} 的 Branch 操作", { v0: branch.name })}
          onClick={(event) => branchContext(event, branch)}
        />
      </div>
    );
  }

  // Render a folder node (and its children) in the History sidebar tree.
  function renderSidebarNode(
    node: BranchTreeNode,
    depth: number,
  ): React.ReactNode {
    const isCollapsed = collapsedRefs.has(node.path);
    const indent = depth * 16;

    if (node.branch) {
      // Leaf: an actual branch
      return renderSidebarLeaf(node.branch, depth);
    }

    // Folder: only render if it has children
    if (!node.children.length) return null;

    return (
      <div className="repo-ref-tree-node" key={node.path}>
        <button
          className="repo-ref repo-ref-folder"
          style={{ paddingLeft: `${indent}px` }}
          onClick={() => toggleRefGroup(node.path)}
          aria-expanded={!isCollapsed}
          aria-label={t(
            isCollapsed ? "展开 {v0} 分组" : "折叠 {v0} 分组",
            { v0: node.path },
          )}
        >
          {isCollapsed ? <CaretRight size={13} /> : <CaretDown size={13} />}
          <Folder size={14} />
          <span>{node.name}</span>
          <span className="repo-ref-count">{countTreeBranches(node)}</span>
        </button>
        <div
          className={`repo-ref-children ${isCollapsed ? "" : "is-open"}`}
          aria-hidden={isCollapsed}
        >
          <div className="repo-ref-children-inner">
            {node.children.map((child) => renderSidebarNode(child, depth + 1))}
          </div>
        </div>
      </div>
    );
  }

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
            {sidebarTree.local.map((node) => renderSidebarNode(node, 0))}
            {sidebarTree.remote.length > 0 && (
              <>
                <div className="refs-heading">
                  <span>{t("远程引用")}</span>
                  <span>{t("本地已知")}</span>
                </div>
                {sidebarTree.remote.map((node) => renderSidebarNode(node, 0))}
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
              <h2>Worktree</h2>
              <p>{t("每个 worktree 的代码和审查进度独立保存。")}</p>
            </div>
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
