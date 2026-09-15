import { DropdownMenuItem as MenuItem } from "./ui/dropdown-menu";
import { Input, Button, Select } from "./ui/controls";
import { uiMessage, t, getLanguage } from "../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowClockwise,
  ArrowDown,
  ArrowUp,
  GitBranch,
  GitCommit,
  GitMerge,
  MagnifyingGlass,
  X,
} from "@phosphor-icons/react";
import { useRequest, asError } from "../api";
import type {
  BranchEntry,
  Changes,
  CommitEntry,
  CommitGraphPage,
  ProofError,
} from "../types";
import { type HistoryComparison } from "./HistoryDiff";
import { demoGraphPage } from "../graph-demo";
import {
  GitContextMenu,
  HistoryTargetActions,
  HistoryMoreButton,
} from "./HistoryActions";
import type { HistoryActions } from "./HistoryActions";
import {
  GRAPH_ROW_HEIGHT,
  GRAPH_ROW_CENTER,
  graphPath,
  graphX,
  layoutCommitGraph,
} from "../commit-graph";

export function CommitHistory({
  changes,
  demo,
  scope,
  scopeLabel,
  onScope,
  onBranches,
  onOpenDiff,
  requestedComparison,
  actions,
  branches,
  onBranchMenu,
}: {
  actions: HistoryActions;
  branches: BranchEntry[];
  onBranchMenu: (event: React.MouseEvent, branch: BranchEntry) => void;
  changes: Changes;
  demo: boolean;
  scope: string;
  scopeLabel?: string;
  onScope: (scope: string) => void;
  onBranches: (branches: BranchEntry[]) => void;
  onOpenDiff: (selection: HistoryComparison) => void;
  requestedComparison?: HistoryComparison | null;
}) {
  const request = useRequest();
  const [page, setPage] = useState<CommitGraphPage | null>(null);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [selected, setSelected] = useState<CommitEntry | null>(null);
  const [compared, setCompared] = useState<CommitEntry | null>(null);
  const [branchComparison, setBranchComparison] =
    useState<HistoryComparison | null>(null);
  const [parent, setParent] = useState(0);
  const [menu, setMenu] = useState<{
    commit: CommitEntry;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    setBranchComparison(requestedComparison ?? null);
  }, [requestedComparison]);

  const [error, setError] = useState<ProofError | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const sequence = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const columnHeader = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const generation = ++sequence.current;
    setBusy(true);
    setError(null);
    setPage(null);
    setCommits([]);
    setSelected(null);
    setCompared(null);
    setParent(0);
    const load = demo
      ? Promise.resolve(demoGraphPage(scope))
      : request<CommitGraphPage>("commit_graph", {
          workspaceId: changes.workspace.id,
          scope,
        });
    void load
      .then((value) => {
        if (sequence.current !== generation) return;
        scroll.current?.scrollTo({ top: 0, left: 0 });
        setPage(value);
        setCommits(value.commits);
        setSelected(value.commits[0] ?? null);
        onBranches(value.branches);
      })
      .catch((cause) => {
        if (sequence.current === generation) setError(asError(cause));
      })
      .finally(() => {
        if (sequence.current === generation) setBusy(false);
      });
    return () => {
      sequence.current++;
    };
  }, [
    changes.workspace.id,
    changes.head,
    changes.branch,
    demo,
    scope,
    revision,
    actions.revision,
  ]);

  const graph = useMemo(() => layoutCommitGraph(commits), [commits]);
  const query = search.trim().toLowerCase();
  const matches = useMemo(
    () =>
      commits.flatMap((commit, index) =>
        `${commit.subject} ${commit.author} ${commit.oid} ${commit.refs}`
          .toLowerCase()
          .includes(query)
          ? [index]
          : [],
      ),
    [commits, query],
  );
  const matching = useMemo(() => new Set(matches), [matches]);
  const graphWidth = Math.max(100, graphX(graph.columns) + 8);
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => GRAPH_ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => commits[index].oid,
    rangeExtractor: (range) => {
      const visible = defaultRangeExtractor(range);
      for (const entry of [selected, compared]) {
        const index = commits.findIndex((c) => c.oid === entry?.oid);
        if (index >= 0 && !visible.includes(index)) visible.push(index);
      }
      return visible.sort((a, b) => a - b);
    },
  });
  function select(index: number, compare = false) {
    const commit = commits[index];
    if (!commit) return;
    setBranchComparison(null);
    setParent(0);
    if (compare && selected && selected.oid !== commit.oid) {
      if (compared?.oid === commit.oid) setCompared(null);
      else {
        setCompared(commit);
        const ordered = [selected, commit].sort(
          (a, b) =>
            commits.findIndex((c) => c.oid === b.oid) -
            commits.findIndex((c) => c.oid === a.oid),
        );
        onOpenDiff({
          base: ordered[0].oid,
          target: ordered[1].oid,
          baseLabel: ordered[0].refs || undefined,
          targetLabel: ordered[1].refs || undefined,
        });
      }
    } else {
      setSelected(commit);
      setCompared(null);
    }
    virtualizer.scrollToIndex(index, { align: "auto" });
  }
  function findMatch(direction: number) {
    if (!matches.length) return;
    const index = commits.findIndex((commit) => commit.oid === selected?.oid);
    const target =
      direction > 0
        ? (matches.find((value) => value > index) ?? matches[0])
        : ([...matches].reverse().find((value) => value < index) ??
          matches[matches.length - 1]);
    select(target);
  }
  async function more() {
    if (!page || busy) return;
    const generation = sequence.current;
    setBusy(true);
    setError(null);
    try {
      const next = await request<CommitGraphPage>("commit_graph", {
        workspaceId: changes.workspace.id,
        snapshotId: page.snapshotId,
        offset: commits.length,
        scope,
      });
      if (generation !== sequence.current) return;
      setCommits((previous) => [...previous, ...next.commits]);
      setPage(next);
    } catch (cause) {
      if (generation === sequence.current) setError(asError(cause));
    } finally {
      if (generation === sequence.current) setBusy(false);
    }
  }
  const scopeName =
    scope === "all"
      ? t("所有分支")
      : scope === "current"
        ? t("当前分支")
        : (scopeLabel ??
          page?.branches.find((branch) => branch.oid === scope)?.name ??
          t("选中引用"));
  const ordered =
    selected && compared
      ? [selected, compared].sort(
          (a, b) =>
            commits.findIndex((c) => c.oid === b.oid) -
            commits.findIndex((c) => c.oid === a.oid),
        )
      : null;
  const comparison: HistoryComparison | null =
    branchComparison ??
    (ordered
      ? {
          base: ordered[0].oid,
          target: ordered[1].oid,
          baseLabel: ordered[0].refs || undefined,
          targetLabel: ordered[1].refs || undefined,
        }
      : selected
        ? {
            target: selected.oid,
            targetLabel: selected.subject,
            parents: selected.parents,
            parent,
            unavailable:
              selected.boundary === "shallow"
                ? t("父版本尚未获取，无法显示此次提交的变化。")
                : undefined,
          }
        : null);
  const range = !!branchComparison || !!compared;
  return (
    <section className="commit-history" aria-label={t("Git 提交图")}>
      <header className="graph-toolbar">
        <div className="graph-heading">
          <GitBranch size={21} />
          <h2>{t("提交图")}</h2>
          <span className="graph-loaded">
            {commits.length} {t(" 条")}
          </span>
        </div>
        <div className="graph-search">
          <MagnifyingGlass size={16} />
          <Input
            aria-label={t("搜索已加载的提交")}
            placeholder={t("搜索提交、作者、分支或 ID…")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {query ? (
            <>
              <span>
                {matches.length} {t(" 个匹配")}
              </span>
              <Button
                className="icon-button"
                aria-label={t("上一个匹配提交")}
                disabled={!matches.length}
                onClick={() => findMatch(-1)}
              >
                <ArrowUp size={14} />
              </Button>
              <Button
                className="icon-button"
                aria-label={t("下一个匹配提交")}
                disabled={!matches.length}
                onClick={() => findMatch(1)}
              >
                <ArrowDown size={14} />
              </Button>
              <Button
                className="icon-button"
                aria-label={t("清空提交搜索")}
                onClick={() => setSearch("")}
              >
                <X size={14} />
              </Button>
            </>
          ) : (
            <span className="graph-search-hint">{t("↑ ↓ 浏览提交")}</span>
          )}
        </div>
        <Select
          value={scope}
          aria-label={t("提交图范围")}
          onChange={(event) => onScope(event.target.value)}
        >
          <option value="all">{t("所有分支")}</option>
          <option value="current">{t("当前分支")}</option>
          {scope !== "all" && scope !== "current" && (
            <option value={scope}>{scopeName}</option>
          )}
        </Select>
        <Button
          className="icon-button"
          aria-label={t("刷新提交图")}
          title={t("重新读取本地引用")}
          onClick={actions.refresh}
          disabled={busy}
        >
          <ArrowClockwise size={17} className={busy ? "spinning" : ""} />
        </Button>
      </header>
      {error && (
        <div className="graph-error" role="alert">
          <span>
            {uiMessage(error.message)} <code>{error.code}</code>
          </span>
          <Button
            className="button compact"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t("重新加载")}
          </Button>
        </div>
      )}
      <div
        className="graph-table-wrap"
        style={
          {
            "--graph-width": `${graphWidth}px`,
            "--graph-row-height": `${GRAPH_ROW_HEIGHT}px`,
          } as React.CSSProperties
        }
      >
        <div className="graph-columns" ref={columnHeader}>
          <span>{t("分支图")}</span>
          <span>{t("提交说明")}</span>
          <span>{t("作者")}</span>
          <span>{t("作者时间")}</span>
          <span>{t("提交")}</span>
        </div>
        <div
          className="graph-scroll"
          ref={scroll}
          onScroll={(event) => {
            if (columnHeader.current)
              columnHeader.current.style.transform = `translateX(${-event.currentTarget.scrollLeft}px)`;
          }}
          role="listbox"
          aria-multiselectable="true"
          aria-label={t("提交列表与分支关系")}
          tabIndex={0}
          aria-busy={busy}
          aria-activedescendant={
            selected
              ? `graph-commit-${page?.snapshotId}-${selected.oid}`
              : undefined
          }
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.altKey ||
              event.metaKey ||
              event.ctrlKey
            )
              return;
            if (
              event.key === "ContextMenu" ||
              (event.key === "F10" && event.shiftKey)
            ) {
              event.preventDefault();
              if (selected) {
                const rect = document
                  .getElementById(
                    `graph-commit-${page?.snapshotId}-${selected.oid}`,
                  )
                  ?.getBoundingClientRect();
                setMenu({
                  commit: selected,
                  x: rect?.left ?? 300,
                  y: rect?.bottom ?? 150,
                });
              }
              return;
            }
            const index = commits.findIndex(
              (commit) => commit.oid === (compared ?? selected)?.oid,
            );
            const next =
              event.key === "ArrowDown"
                ? Math.min(index + 1, commits.length - 1)
                : event.key === "ArrowUp"
                  ? Math.max(index - 1, 0)
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? commits.length - 1
                      : null;
            if (next === null) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            select(next, event.shiftKey);
          }}
        >
          <div
            className="graph-virtual-space"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const commit = commits[item.index],
                row = graph.rows[item.index];
              const selectedRow = branchComparison
                ? [branchComparison.base, branchComparison.target].includes(
                    commit.oid,
                  )
                : selected?.oid === commit.oid || compared?.oid === commit.oid;
              return (
                <div
                  key={commit.oid}
                  id={`graph-commit-${page?.snapshotId}-${commit.oid}`}
                  className={`graph-row ${selectedRow ? "is-active" : ""} ${query && !matching.has(item.index) ? "is-dimmed" : ""}`}
                  role="option"
                  aria-selected={selectedRow}
                  aria-posinset={item.index + 1}
                  aria-setsize={commits.length}
                  tabIndex={-1}
                  style={{ transform: `translateY(${item.start}px)` }}
                  onClick={(event) => {
                    select(
                      item.index,
                      event.metaKey || event.ctrlKey || event.shiftKey,
                    );
                    scroll.current?.focus({ preventScroll: true });
                  }}
                  onDoubleClick={() =>
                    onOpenDiff({
                      target: commit.oid,
                      targetLabel: commit.subject,
                      parents: commit.parents,
                      unavailable:
                        commit.boundary === "shallow"
                          ? t("父版本尚未获取。")
                          : undefined,
                    })
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({
                      commit,
                      x: Math.min(event.clientX, window.innerWidth - 230),
                      y: Math.min(event.clientY, window.innerHeight - 120),
                    });
                  }}
                  aria-label={`${commit.subject}，${commit.author}，${commit.oid.slice(0, 8)}${commit.parents.length > 1 ? t("，合并 {v0} 个父提交", { v0: commit.parents.length }) : ""}`}
                >
                  <svg
                    className="graph-lanes"
                    width={graphWidth}
                    height={GRAPH_ROW_HEIGHT}
                    viewBox={`0 0 ${graphWidth} ${GRAPH_ROW_HEIGHT}`}
                    aria-hidden="true"
                  >
                    {row.through.map((line, index) => (
                      <path
                        key={`t${index}`}
                        d={graphPath(line.from, line.to)}
                        className={`lane-color-${line.color % 7}`}
                      />
                    ))}
                    {row.incoming && (
                      <path
                        d={graphPath(
                          row.column,
                          row.column,
                          0,
                          GRAPH_ROW_CENTER,
                        )}
                        className={`lane-color-${row.color % 7}`}
                      />
                    )}
                    {row.parents.map((line) => (
                      <path
                        key={line.parent}
                        d={graphPath(line.from, line.to, GRAPH_ROW_CENTER)}
                        className={`lane-color-${line.color % 7}`}
                      />
                    ))}
                    {selectedRow && (
                      <circle
                        cx={graphX(row.column)}
                        cy={GRAPH_ROW_CENTER}
                        r={9}
                        className={`graph-node-halo lane-color-${row.color % 7}`}
                      />
                    )}
                    <circle
                      cx={graphX(row.column)}
                      cy={GRAPH_ROW_CENTER}
                      r={commit.parents.length > 1 ? 5 : 4}
                      className={`graph-node lane-color-${row.color % 7} ${commit.parents.length > 1 ? "is-merge" : ""}`}
                    />
                  </svg>
                  <span className="graph-subject">
                    {commit.boundary === "shallow" && (
                      <span className="graph-boundary">{t("历史边界")}</span>
                    )}
                    {branches
                      .filter((branch) => branch.oid === commit.oid)
                      .map((branch) => (
                        <Button
                          key={`${branch.remote}:${branch.name}`}
                          className="graph-ref"
                          title={branch.name}
                          aria-label={t("{v0} 的 Branch 操作", {
                            v0: branch.name,
                          })}
                          onClick={(event) => {
                            event.stopPropagation();
                            onBranchMenu(event, branch);
                          }}
                          onDoubleClick={(event) => event.stopPropagation()}
                          onContextMenu={(event) => {
                            event.stopPropagation();
                            onBranchMenu(event, branch);
                          }}
                        >
                          <GitBranch size={12} />
                          {branch.name}
                        </Button>
                      ))}
                    {commit.refs
                      .split(", ")
                      .filter((ref) => ref.startsWith("tag: "))
                      .map((ref) => (
                        <span className="graph-ref" key={ref} title={ref}>
                          {ref}
                        </span>
                      ))}
                    {commit.refs &&
                      !branches.some((branch) => branch.oid === commit.oid) &&
                      !commit.refs.includes("tag: ") && (
                        <span className="graph-ref" title={commit.refs}>
                          {commit.refs}
                        </span>
                      )}
                    <span title={commit.subject}>{commit.subject}</span>
                    {commit.parents.length > 1 && (
                      <GitMerge size={14} className="graph-merge-icon" />
                    )}
                  </span>
                  <span className="graph-author">
                    <span className={`author-avatar avatar-${row.color % 7}`}>
                      {commit.author.slice(0, 1).toUpperCase()}
                    </span>
                    <span title={commit.author}>{commit.author}</span>
                  </span>
                  <time dateTime={commit.date} title={commit.date}>
                    {new Date(commit.date).toLocaleDateString(getLanguage(), {
                      month: "2-digit",
                      day: "2-digit",
                    })}
                  </time>
                  <code>{commit.oid.slice(0, 8)}</code>
                </div>
              );
            })}
          </div>
          {!commits.length && (
            <div className="graph-empty">
              <GitCommit size={28} />
              <strong>
                {busy
                  ? t("正在读取提交关系…")
                  : error
                    ? t("提交图暂不可用")
                    : t("还没有提交")}
              </strong>
              <span>
                {busy
                  ? t("根据本地 Git 对象构建分支图")
                  : t("提交记录会在这里形成可追踪的历史。")}
              </span>
            </div>
          )}
        </div>
        <footer className="graph-table-footer">
          <span>
            {demo
              ? t("演示历史")
              : t("本地历史快照 {v0}", {
                  v0: page
                    ? new Date(page.capturedAt).toLocaleTimeString(
                        getLanguage(),
                        { hour12: false },
                      )
                    : "",
                })}
            {page?.shallow ? t(" · 浅克隆，历史可能不完整") : ""}
            {query ? t(" · 保留完整连线，突出搜索匹配") : ""}
          </span>
          <div className="toolbar-spacer" />
          {page?.hasMore ? (
            <Button
              disabled={busy}
              onClick={() => {
                void more();
              }}
            >
              {busy ? t("正在加载…") : t("加载更早的 100 条提交")}
              <ArrowDown size={13} />
            </Button>
          ) : (
            <span>
              {commits.length
                ? graph.remaining.length ||
                  commits.some((commit) => commit.boundary === "shallow")
                  ? t("已到本地历史边界")
                  : t("全部 {v0} 条已加载", { v0: commits.length })
                : ""}
            </span>
          )}
        </footer>
      </div>
      <section className="history-inspector" aria-label={t("所选提交详情")}>
        <header className="history-selection-header">
          <GitCommit size={16} />
          <div>
            <strong>
              {range
                ? branchComparison
                  ? t("Branch comparison")
                  : t("2 commits selected")
                : (selected?.subject ?? t("选择 Commit"))}
            </strong>
            <small>
              {range
                ? t("比较所选两个版本的文件内容")
                : selected
                  ? `${selected.oid.slice(0, 8)} · ${selected.author} · ${new Date(selected.date).toLocaleString(getLanguage())}`
                  : t(
                      "双击 Commit 查看 Diff；Shift / ⌘ / Ctrl + 点击另一个 Commit 比较",
                    )}
            </small>
          </div>
          {range ? (
            <Button
              className="button compact"
              onClick={() => {
                setCompared(null);
                setBranchComparison(null);
              }}
            >
              {t("结束比较")}
            </Button>
          ) : selected && selected.parents.length > 1 ? (
            <Select
              aria-label={t("比较父提交")}
              value={parent}
              onChange={(e) => setParent(Number(e.target.value))}
            >
              {selected.parents.map((oid, index) => (
                <option key={oid} value={index}>
                  {t("Parent ")}
                  {index + 1} · {oid.slice(0, 8)}
                </option>
              ))}
            </Select>
          ) : (
            <span className="history-select-hint">
              {t("Double-click to open Diff")}
            </span>
          )}
        </header>
        {selected && (
          <HistoryMoreButton
            label={t("所选 Commit 的操作")}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ commit: selected, x: rect.left, y: rect.bottom + 4 });
            }}
          />
        )}
        {comparison && (
          <Button
            className="button compact history-open-diff"
            onClick={() => onOpenDiff(comparison)}
          >
            {t("在新 tab 中查看 Diff")}
          </Button>
        )}
      </section>
      {menu && (
        <GitContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          label={t("Commit 操作")}
        >
          <HistoryTargetActions
            target={{ type: "commit", commit: menu.commit }}
            actions={actions}
            changes={changes}
            onClose={() => setMenu(null)}
          />
          <MenuItem
            role="menuitem"
            disabled={!selected || selected.oid === menu.commit.oid}
            onClick={() => {
              select(
                commits.findIndex((c) => c.oid === menu.commit.oid),
                true,
              );
              setMenu(null);
            }}
          >
            {t("与所选 Commit 比较")}
          </MenuItem>
          <MenuItem
            role="menuitem"
            onClick={() => {
              select(commits.findIndex((c) => c.oid === menu.commit.oid));
              onOpenDiff({
                target: menu.commit.oid,
                targetLabel: menu.commit.subject,
                parents: menu.commit.parents,
                unavailable:
                  menu.commit.boundary === "shallow"
                    ? t("父版本尚未获取。")
                    : undefined,
              });
              setMenu(null);
            }}
          >
            {t("查看此 Commit 的变化")}
          </MenuItem>
        </GitContextMenu>
      )}
    </section>
  );
}
