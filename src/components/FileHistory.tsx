import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  ArrowRight,
  GitCommit,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { asError, request } from "../api";
import type { CommitEntry, FileBlame, ProofError } from "../types";
import { Modal } from "./Modal";

export function FileHistory({
  workspaceId,
  path,
  onClose,
}: {
  workspaceId: string;
  path: string;
  onClose: () => void;
}) {
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [more, setMore] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [revision, setRevision] = useState<string | null>(null);
  const [blame, setBlame] = useState<FileBlame | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProofError | null>(null);
  const [search, setSearch] = useState("");
  const [historicalPath, setHistoricalPath] = useState(path);
  const [activePath, setActivePath] = useState(path);
  const alive = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setHistoryBusy(true);
    request<CommitEntry[]>("history", { workspaceId, path, offset: 0 })
      .then((rows) => {
        if (active) {
          setCommits(rows);
          setMore(rows.length === 50);
        }
      })
      .catch((e) => {
        if (active) setError(asError(e));
      })
      .finally(() => {
        if (active) setHistoryBusy(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, path]);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    setBlame(null);
    request<FileBlame>("file_blame", {
      workspaceId,
      path: activePath,
      revision,
      offset,
    })
      .then((value) => {
        if (active) {
          setBlame(value);
          if (scroller.current) scroller.current.scrollTop = 0;
        }
      })
      .catch((e) => {
        if (active) setError(asError(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, activePath, revision, offset]);
  const virtualizer = useVirtualizer({
    count: blame?.lines.length ?? 0,
    getScrollElement: () => scroller.current,
    estimateSize: () => 34,
    overscan: 15,
  });
  function select(oid: string | null) {
    setRevision(oid);
    setOffset(0);
    setActivePath(path);
    setHistoricalPath(path);
  }
  return (
    <Modal title="文件历史与 Blame" wide error={error} onClose={onClose}>
      <p className="file-history-path">{path}</p>
      <p className="inline-help">
        作者来自 Git
        历史。重命名追溯可能无法确定；若当前路径在旧提交中不存在，可填写当时路径。关闭后回到原来的
        Diff 阅读位置。
      </p>
      <div className="file-history-layout">
        <aside className="file-history-commits" aria-label="文件提交历史">
          <button
            className={`file-history-current ${revision === null ? "active" : ""}`}
            onClick={() => select(null)}
          >
            当前 Worktree · 含未提交变化
          </button>
          <label className="file-history-search">
            <MagnifyingGlass size={15} />
            <input
              aria-label="搜索已加载的文件历史"
              placeholder="搜索已加载历史…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {commits
            .filter((c) =>
              `${c.subject} ${c.author} ${c.oid}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((c) => (
              <button
                key={c.oid}
                className={`file-history-commit ${revision === c.oid ? "active" : ""}`}
                onClick={() => select(c.oid)}
              >
                <span>
                  <GitCommit size={14} />
                  <code>{c.oid.slice(0, 8)}</code>
                </span>
                <strong>{c.subject}</strong>
                <small>
                  {c.author} · {new Date(c.date).toLocaleDateString()}
                </small>
              </button>
            ))}
          {!commits.length && (
            <p className="muted">
              {historyBusy ? "正在读取文件历史…" : "此路径暂无提交历史。"}
            </p>
          )}
          {more && (
            <button
              className="button compact"
              disabled={historyBusy}
              onClick={() => {
                setHistoryBusy(true);
                request<CommitEntry[]>("history", {
                  workspaceId,
                  path,
                  offset: commits.length,
                })
                  .then((rows) => {
                    if (alive.current) {
                      setCommits((c) => [...c, ...rows]);
                      setMore(rows.length === 50);
                    }
                  })
                  .catch((e) => {
                    if (alive.current) setError(asError(e));
                  })
                  .finally(() => {
                    if (alive.current) setHistoryBusy(false);
                  });
              }}
            >
              加载更多历史
            </button>
          )}
        </aside>
        <section className="file-blame" aria-label="所选版本的逐行归属">
          <header className="blame-header">
            <strong>
              {revision ? `提交 ${revision.slice(0, 12)}` : "当前 Worktree"}
            </strong>
            <span>{blame ? `${blame.totalLines} 行` : ""}</span>
          </header>
          {revision && (
            <form
              className="historical-path"
              onSubmit={(e) => {
                e.preventDefault();
                setOffset(0);
                setActivePath(historicalPath);
              }}
            >
              <label htmlFor="historical-path">版本内路径</label>
              <input
                id="historical-path"
                value={historicalPath}
                onChange={(e) => setHistoricalPath(e.target.value)}
              />
              <button
                className="button compact"
                disabled={busy || !historicalPath}
              >
                读取
              </button>
            </form>
          )}
          <div className="blame-scroll" ref={scroller}>
            {busy ? (
              <p className="empty-list" role="status">
                正在读取所选版本…
              </p>
            ) : blame ? (
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  position: "relative",
                  minWidth: "max-content",
                }}
              >
                {virtualizer.getVirtualItems().map((item) => {
                  const line = blame.lines[item.index];
                  return (
                    <div
                      key={line.line}
                      className={`blame-row ${line.uncommitted ? "uncommitted" : ""}`}
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <span
                        className="blame-author"
                        title={`${line.summary}\n${line.originPath}:${line.originalLine}${line.authorTime ? `\n${new Date(line.authorTime * 1000).toLocaleString()}` : ""}`}
                      >
                        <code>{line.oid?.slice(0, 8) ?? "未提交"}</code>
                        <span>
                          {line.uncommitted
                            ? "未提交变化"
                            : (line.author ?? "作者未知")}
                        </span>
                      </span>
                      <span className="blame-number">{line.line}</span>
                      <code className="blame-source">{line.content}</code>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="empty-list">
                当前版本无法显示 Blame，请查看上方错误或选择其他提交。
              </p>
            )}
            {blame?.totalLines === 0 && (
              <p className="empty-list">此版本为空文件。</p>
            )}
          </div>
          {blame && (
            <footer className="blame-footer">
              <button
                className="button compact"
                disabled={busy || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 400))}
              >
                <ArrowLeft size={14} />
                上一页
              </button>
              <span>
                {blame.totalLines
                  ? `${offset + 1}–${offset + blame.lines.length}`
                  : "0"}{" "}
                / {blame.totalLines}
              </span>
              <button
                className="button compact"
                disabled={busy || !blame.hasMore}
                onClick={() => setOffset(offset + blame.lines.length)}
              >
                下一页
                <ArrowRight size={14} />
              </button>
            </footer>
          )}
        </section>
      </div>
    </Modal>
  );
}
