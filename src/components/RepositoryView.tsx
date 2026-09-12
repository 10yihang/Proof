import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  ClockCounterClockwise,
  FolderOpen,
  GitBranch,
  GitCommit,
  HardDrives,
  MagnifyingGlass,
  Plus,
} from "@phosphor-icons/react";
import { request } from "../api";
import type {
  BranchEntry,
  Changes,
  CommitEntry,
  WorktreeEntry,
  ProofError,
} from "../types";
import { Modal } from "./Modal";

export function RepositoryView({
  changes,
  error,
  demo,
  onOpen,
  onError,
  onChanged,
}: {
  changes: Changes;
  error: ProofError | null;
  demo: boolean;
  onOpen: (path: string) => Promise<void>;
  onError: (e: unknown) => void;
  onChanged: () => Promise<void>;
}) {
  const [section, setSection] = useState<"history" | "branches" | "worktrees">(
    "history",
  );
  const [commits, setCommits] = useState<CommitEntry[]>([]),
    [branches, setBranches] = useState<BranchEntry[]>([]),
    [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    [create, setCreate] = useState(false),
    [branchName, setBranchName] = useState("");
  const [selected, setSelected] = useState<CommitEntry | null>(null),
    [patch, setPatch] = useState(""),
    [parent, setParent] = useState(0);
  const [more, setMore] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setSelected(null);
    setPatch("");
    if (demo) {
      setCommits([]);
      setBranches([
        {
          name: changes.branch ?? "main",
          current: true,
          oid: changes.head ?? "",
          remote: false,
        },
      ]);
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
      request<CommitEntry[]>("history", {
        workspaceId: changes.workspace.id,
        offset: 0,
      }),
      request<BranchEntry[]>("branches", { workspaceId: changes.workspace.id }),
      request<WorktreeEntry[]>("worktrees", {
        workspaceId: changes.workspace.id,
      }),
    ])
      .then(([history, refs, trees]) => {
        if (!cancelled) {
          setCommits(history);
          setMore(history.length === 50);
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
  useEffect(() => {
    if (!selected || demo) return;
    let cancelled = false;
    setPatch("正在读取提交差异…");
    void request<string>("commit_diff", {
      workspaceId: changes.workspace.id,
      oid: selected.oid,
      parent,
    })
      .then((value) => {
        if (!cancelled) setPatch(value || "此比较基准下没有文本变化。");
      })
      .catch((e) => {
        if (!cancelled) {
          setPatch("无法读取提交差异。");
          onError(e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected, parent, changes.workspace.id, demo]);
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
          <strong>Repository</strong>
        </span>
        {(
          [
            {
              key: "history",
              label: "提交历史",
              icon: <ClockCounterClockwise size={18} />,
            },
            { key: "branches", label: "分支", icon: <GitBranch size={18} /> },
            {
              key: "worktrees",
              label: "工作区",
              icon: <HardDrives size={18} />,
            },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            className={section === item.key ? "active" : ""}
            onClick={() => setSection(item.key)}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
        <div className="repository-meta">
          <span>当前 Git</span>
          <code>{changes.gitVersion}</code>
          <span>数据来源</span>
          <span>本地仓库与引用</span>
          <p>远程引用代表本地已知状态。Proof 不会自动 fetch。</p>
        </div>
      </aside>
      <section className="repository-content">
        <header className="repository-header">
          <div>
            <h2>
              {section === "history"
                ? "提交历史"
                : section === "branches"
                  ? "分支"
                  : "工作区"}
            </h2>
            <p>
              {section === "history"
                ? "按真实 Git 提交记录核对每一次变化。"
                : section === "branches"
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
        {section === "history" && (
          <>
            <div className="history-search">
              <MagnifyingGlass size={17} />
              <input
                aria-label="搜索已加载的提交"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索已加载的提交说明、作者或 ID…"
              />
              <span>{commits.length} 条已加载</span>
            </div>
            <div className={`history-layout ${selected ? "has-detail" : ""}`}>
              <div className="commit-list">
                {commits
                  .filter((c) =>
                    `${c.subject} ${c.author} ${c.oid}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((c) => (
                    <button
                      key={c.oid}
                      className={`commit-row ${selected?.oid === c.oid ? "active" : ""}`}
                      onClick={() => {
                        setParent(0);
                        setSelected(c);
                      }}
                    >
                      <GitCommit size={20} />
                      <span>
                        <strong>{c.subject}</strong>
                        <small>
                          {c.author}
                          <span>
                            {new Date(c.date).toLocaleString("zh-CN")}
                          </span>
                        </small>
                        {c.refs && <span className="ref-label">{c.refs}</span>}
                      </span>
                      <code>{c.oid.slice(0, 8)}</code>
                    </button>
                  ))}
                {!commits.length && (
                  <div className="empty-list">
                    {busy
                      ? "正在读取提交…"
                      : demo
                        ? "演示未生成虚构提交历史，请打开真实仓库查看。"
                        : "此仓库尚无提交。"}
                  </div>
                )}
                {more && commits.length > 0 && (
                  <button
                    className="button load-more"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void request<CommitEntry[]>("history", {
                        workspaceId: changes.workspace.id,
                        offset: commits.length,
                      })
                        .then((next) => {
                          setCommits((c) => [...c, ...next]);
                          setMore(next.length === 50);
                        })
                        .catch(onError)
                        .finally(() => setBusy(false));
                    }}
                  >
                    加载更多提交
                  </button>
                )}
              </div>
              {selected && (
                <div className="commit-detail">
                  <header>
                    <strong>{selected.oid.slice(0, 8)}</strong>
                    {selected.parents.length > 1 ? (
                      <select
                        aria-label="比较父提交"
                        value={parent}
                        onChange={(e) => setParent(Number(e.target.value))}
                      >
                        {selected.parents.map((p, i) => (
                          <option key={p} value={i}>
                            父提交 {i + 1} · {p.slice(0, 8)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>
                        {selected.parents[0]?.slice(0, 8) ?? "空树"} → 当前提交
                      </span>
                    )}
                  </header>
                  <pre>{patch}</pre>
                </div>
              )}
            </div>
          </>
        )}
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
                  <span className="tag active-tag">当前工作区</span>
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
