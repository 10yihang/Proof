import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  FolderOpen,
  GitBranch,
  HardDrives,
  Plus,
} from "@phosphor-icons/react";
import { request } from "../api";
import type { BranchEntry, Changes, WorktreeEntry, ProofError } from "../types";
import { Modal } from "./Modal";
import { CommitHistory } from "./CommitHistory";
import { demoGraphPage } from "../graph-demo";

export type RepositorySection = "history" | "branches" | "worktrees";

export function RepositoryView({
  section,
  onSection,
  changes,
  error,
  demo,
  onOpen,
  onError,
  onChanged,
}: {
  section: RepositorySection;
  onSection: (section: RepositorySection) => void;
  changes: Changes;
  error: ProofError | null;
  demo: boolean;
  onOpen: (path: string) => Promise<void>;
  onError: (e: unknown) => void;
  onChanged: () => Promise<void>;
}) {
  const [historyVisited, setHistoryVisited] = useState(section === "history");
  useEffect(() => {
    if (section === "history") setHistoryVisited(true);
  }, [section]);
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [create, setCreate] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [historyScope, setHistoryScope] = useState("all");
  const [historyRef, setHistoryRef] = useState<string | null>(null);
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
  }, [changes.workspace.id, changes.head, changes.branch, demo]);
  async function switchBranch(name: string, creating: boolean) {
    setBusy(true);
    try {
      await request("switch_branch", {
        workspaceId: changes.workspace.id,
        name,
        create: creating,
        expectedToken: changes.token,
      });
      setCreate(false);
      await onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="repository-view">
      <aside className="repository-nav">
        <span className="sidebar-heading">
          <strong>仓库与引用</strong>
        </span>
        <button
          className={section === "worktrees" ? "active" : ""}
          onClick={() =>
            onSection(section === "worktrees" ? "history" : "worktrees")
          }
        >
          <HardDrives size={17} />
          Worktree<span className="count-badge">{worktrees.length}</span>
        </button>
        {section === "history" && (
          <div className="repository-refs">
            <div className="refs-heading">
              <span>本地分支</span>
              <span>{branches.filter((branch) => !branch.remote).length}</span>
            </div>
            <button
              className={`repo-ref ${historyScope === "all" ? "active" : ""}`}
              onClick={() => {
                setHistoryScope("all");
                setHistoryRef(null);
              }}
            >
              <GitBranch size={15} />
              <span>所有分支</span>
            </button>
            {branches
              .filter((branch) => !branch.remote)
              .map((branch) => (
                <button
                  key={branch.name}
                  className={`repo-ref ${historyRef === `${branch.remote ? "remote" : "local"}:${branch.name}` ? "active" : ""}`}
                  title={`查看 ${branch.name} 的历史`}
                  onClick={() => {
                    setHistoryScope(
                      `refs/${branch.remote ? "remotes" : "heads"}/${branch.name}`,
                    );
                    setHistoryRef(
                      `${branch.remote ? "remote" : "local"}:${branch.name}`,
                    );
                  }}
                >
                  <GitBranch size={14} />
                  <span>{branch.name}</span>
                  {branch.current && (
                    <span className="current-ref-dot" aria-label="当前分支" />
                  )}
                </button>
              ))}
            {branches.some((branch) => branch.remote) && (
              <>
                <div className="refs-heading">
                  <span>远程引用</span>
                  <span>本地已知</span>
                </div>
                {branches
                  .filter((branch) => branch.remote)
                  .map((branch) => (
                    <button
                      key={branch.name}
                      className={`repo-ref ${historyRef === `${branch.remote ? "remote" : "local"}:${branch.name}` ? "active" : ""}`}
                      title={`查看 ${branch.name} 的本地历史`}
                      onClick={() => {
                        setHistoryScope(
                          `refs/${branch.remote ? "remotes" : "heads"}/${branch.name}`,
                        );
                        setHistoryRef(
                          `${branch.remote ? "remote" : "local"}:${branch.name}`,
                        );
                      }}
                    >
                      <GitBranch size={14} />
                      <span>{branch.name}</span>
                    </button>
                  ))}
              </>
            )}
          </div>
        )}
        <div className="repository-meta">
          <span>当前 Git</span>
          <code>{changes.gitVersion}</code>
          <span>数据来源</span>
          <span>本地仓库与引用</span>
          <p>远程引用代表本地已知状态。Proof 不会自动 fetch。</p>
        </div>
      </aside>
      <section
        className={`repository-content ${section === "history" ? "is-history" : ""}`}
      >
        {section !== "history" && (
          <header className="repository-header">
            <div>
              <h2>{section === "branches" ? "分支" : "Worktree"}</h2>
              <p>
                {section === "branches"
                  ? "本地分支与已知远程引用。"
                  : "每个 worktree 的代码和审查进度独立保存。"}
              </p>
            </div>
            {section === "branches" && (
              <button
                className="button compact"
                disabled={demo || !changes.workspace.trusted || busy}
                onClick={() => setCreate(true)}
              >
                <Plus size={15} />
                创建分支
              </button>
            )}
          </header>
        )}
        <div className="repository-page" hidden={section !== "history"}>
          {(historyVisited || section === "history") && (
            <CommitHistory
              changes={changes}
              demo={demo}
              scope={historyScope}
              scopeLabel={historyRef?.slice(historyRef.indexOf(":") + 1)}
              onScope={(scope) => {
                setHistoryScope(scope);
                setHistoryRef(null);
              }}
              onBranches={setBranches}
            />
          )}
        </div>
        {section === "branches" && (
          <div className="branch-list">
            {branches.map((branch) => (
              <div
                className="branch-row"
                key={`${branch.remote}:${branch.name}`}
              >
                <GitBranch size={19} />
                <div>
                  <strong>{branch.name}</strong>
                  <small>
                    {branch.remote ? "远程引用 · 本地已知" : "本地分支"}
                    <code>{branch.oid.slice(0, 8)}</code>
                  </small>
                </div>
                {branch.current ? (
                  <span className="tag active-tag">
                    <Check size={13} />
                    当前分支
                  </span>
                ) : (
                  !branch.remote && (
                    <button
                      className="button compact"
                      disabled={demo || busy || !changes.workspace.trusted}
                      onClick={() => {
                        void switchBranch(branch.name, false);
                      }}
                    >
                      切换 <ArrowRight size={14} />
                    </button>
                  )
                )}
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
                    {tree.locked && " · 已锁定"}
                  </small>
                </div>
                {tree.path === changes.workspace.path ? (
                  <span className="tag active-tag">当前 Worktree</span>
                ) : (
                  <button
                    className="button compact"
                    disabled={demo}
                    onClick={() => {
                      void onOpen(tree.path);
                    }}
                  >
                    打开
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      {create && (
        <Modal
          title="创建并切换分支"
          error={error}
          onClose={() => setCreate(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void switchBranch(branchName, true);
            }}
          >
            <label className="field-label" htmlFor="branch-name">
              分支名称
            </label>
            <input
              id="branch-name"
              autoFocus
              placeholder="feature/your-change"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
            />
            <p className="inline-help">
              从当前 HEAD 创建。已有修改交由 Git 检查，不自动 stash 或覆盖。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                onClick={() => setCreate(false)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={!branchName.trim() || busy}
              >
                创建并切换
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
