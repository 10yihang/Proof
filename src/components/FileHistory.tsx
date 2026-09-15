import { Button, Input } from "./ui/controls";
import { t, getLanguage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  ArrowRight,
  GitCommit,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { asError, useRequest } from "../api";
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
  const request = useRequest();
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [more, setMore] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [revision, setRevision] = useState<string | null>(null);
  const [blame, setBlame] = useState<FileBlame | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [historyError, setHistoryError] = useState<ProofError | null>(null);
  const [blameError, setBlameError] = useState<ProofError | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [blameRevision, setBlameRevision] = useState(0);
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
    setHistoryError(null);
    request<CommitEntry[]>("history", { workspaceId, path, offset: 0 })
      .then((rows) => {
        if (active) {
          setCommits(rows);
          setMore(rows.length === 50);
        }
      })
      .catch((e) => {
        if (active) setHistoryError(asError(e));
      })
      .finally(() => {
        if (active) setHistoryBusy(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, path, historyRevision]);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setBlameError(null);
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
        if (active) setBlameError(asError(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, activePath, revision, offset, blameRevision]);
  const virtualizer = useVirtualizer({
    count: blame?.lines.length ?? 0,
    getScrollElement: () => scroller.current,
    estimateSize: () => 34,
    overscan: 15,
  });
  function select(oid: string | null) {
    if (busy && oid === revision && activePath === path && offset === 0) return;
    setRevision(oid);
    setOffset(0);
    setActivePath(path);
    setHistoricalPath(path);
    setBlameRevision((value) => value + 1);
  }
  return (
    <Modal
      title={t("文件历史与 Blame")}
      wide
      error={blameError ?? historyError}
      onClose={onClose}
    >
      <p className="file-history-path">{path}</p>
      <p className="inline-help">
        {t(
          "作者来自 Git 历史。重命名追溯可能无法确定；若当前路径在旧提交中不存在，可填写当时路径。关闭后回到原来的 Diff 阅读位置。",
        )}
      </p>
      <div className="file-history-layout">
        <aside className="file-history-commits" aria-label={t("文件提交历史")}>
          <Button
            className={`file-history-current ${revision === null ? "active" : ""}`}
            onClick={() => select(null)}
          >
            {t("当前 Worktree · 含未提交变化")}
          </Button>
          <label className="file-history-search">
            <MagnifyingGlass size={15} />
            <Input
              aria-label={t("搜索已加载的文件历史")}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t("搜索已加载历史…")}
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
              <Button
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
                  {c.author} ·{" "}
                  {new Date(c.date).toLocaleDateString(getLanguage())}
                </small>
              </Button>
            ))}
          {!commits.length && (
            <p className="muted">
              {historyBusy
                ? t("正在读取文件历史…")
                : historyError
                  ? t("文件历史读取失败。")
                  : t("此路径暂无提交历史。")}
            </p>
          )}
          {historyError && !commits.length && (
            <Button
              className="button compact"
              disabled={historyBusy}
              onClick={() => setHistoryRevision((value) => value + 1)}
            >
              {t("重新读取历史")}
            </Button>
          )}
          {more && (
            <Button
              className="button compact"
              disabled={historyBusy}
              onClick={() => {
                setHistoryBusy(true);
                setHistoryError(null);
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
                    if (alive.current) setHistoryError(asError(e));
                  })
                  .finally(() => {
                    if (alive.current) setHistoryBusy(false);
                  });
              }}
            >
              {t("加载更多历史")}
            </Button>
          )}
        </aside>
        <section className="file-blame" aria-label={t("所选版本的逐行归属")}>
          <header className="blame-header">
            <strong>
              {revision
                ? t("提交 {v0}", { v0: revision.slice(0, 12) })
                : t("当前 Worktree")}
            </strong>
            <span>{blame ? t("{v0} 行", { v0: blame.totalLines }) : ""}</span>
          </header>
          {revision && (
            <form
              className="historical-path"
              onSubmit={(e) => {
                e.preventDefault();
                if (busy) return;
                setOffset(0);
                setActivePath(historicalPath);
                setBlameRevision((value) => value + 1);
              }}
            >
              <label htmlFor="historical-path">{t("版本内路径")}</label>
              <Input
                id="historical-path"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={historicalPath}
                onChange={(e) => setHistoricalPath(e.target.value)}
              />
              <Button
                type="submit"
                className="button compact"
                disabled={busy || !historicalPath}
              >
                {t("读取")}
              </Button>
            </form>
          )}
          <div className="blame-scroll" ref={scroller}>
            {busy ? (
              <p className="empty-list" role="status">
                {t("正在读取所选版本…")}
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
                        title={`${line.summary}\n${line.originPath}:${line.originalLine}${line.authorTime ? `\n${new Date(line.authorTime * 1000).toLocaleString(getLanguage())}` : ""}`}
                      >
                        <code>{line.oid?.slice(0, 8) ?? t("未提交")}</code>
                        <span>
                          {line.uncommitted
                            ? t("未提交变化")
                            : (line.author ?? t("作者未知"))}
                        </span>
                      </span>
                      <span className="blame-number">{line.line}</span>
                      <code className="blame-source">{line.content}</code>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty-list">
                <p>
                  {t("当前版本无法显示 Blame，请查看上方错误或选择其他提交。")}
                </p>
                {blameError && (
                  <Button
                    className="button compact"
                    onClick={() => setBlameRevision((value) => value + 1)}
                  >
                    {t("重新读取 Blame")}
                  </Button>
                )}
              </div>
            )}
            {blame?.totalLines === 0 && (
              <p className="empty-list">{t("此版本为空文件。")}</p>
            )}
          </div>
          {blame && (
            <footer className="blame-footer">
              <Button
                className="button compact"
                disabled={busy || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 400))}
              >
                <ArrowLeft size={14} />
                {t("上一页")}
              </Button>
              <span>
                {blame.totalLines
                  ? `${offset + 1}–${offset + blame.lines.length}`
                  : "0"}{" "}
                / {blame.totalLines}
              </span>
              <Button
                className="button compact"
                disabled={busy || !blame.hasMore}
                onClick={() => setOffset(offset + blame.lines.length)}
              >
                {t("下一页")}
                <ArrowRight size={14} />
              </Button>
            </footer>
          )}
        </section>
      </div>
    </Modal>
  );
}
