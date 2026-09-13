import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  Circle,
  ArrowCounterClockwise,
  Plus,
  Minus,
  Copy,
  CaretDown,
  CaretUp,
  TextAlignLeft,
  ArrowsOutSimple,
  MagnifyingGlass,
  Code,
  Warning,
  Trash,
  ClockCounterClockwise,
  SlidersHorizontal,
  X,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import type { DiffContext, DiffLine, FileDiff, Preferences } from "../types";
import { asError } from "../api";
import { CodeText } from "./CodeText";
import { SplitScrollbars } from "./SplitScrollbars";

import {
  findAnchor,
  hiddenWhitespace,
  inlineChanges,
  readingRows,
  rowAnchor,
  rowMatches,
  type ReadingAnchor,
  type TextRange,
} from "../diff-reading";

export function DiffView({
  diff,
  preferences,
  pending,
  onMark,
  onStage,
  onDiscard,
  onHistory,
  onPreferences,
  onFocus,
  onLoadContext,
  onEditor,
  openingEditor,
}: {
  diff: FileDiff;
  preferences: Preferences;
  pending: boolean;
  onMark: (hunkId: string | null, reviewed: boolean) => void;
  onStage: (hunkId: string | null) => void;
  onDiscard: (hunkId: string | null) => void;
  onHistory?: () => void;
  onPreferences: (p: Partial<Preferences>) => void;
  onFocus: () => void;
  onLoadContext: (lines: number) => Promise<DiffContext>;
  onEditor: () => void;
  openingEditor: boolean;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const [raw, setRaw] = useState(false),
    [search, setSearch] = useState(""),
    [searchOpen, setSearchOpen] = useState(false);
  const [activeHunk, setActiveHunk] = useState(0);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [context, setContext] = useState<DiffContext | null>(null);
  const [contextBusy, setContextBusy] = useState(false);
  const [contextError, setContextError] = useState("");
  const [positionNotice, setPositionNotice] = useState("");
  const contextSequence = useRef(0);
  const anchor = useRef<{
    position: ReadingAnchor;
    offset: number;
    left: number;
    snapshotId: string;
    top: number;
    layout: string;
  } | null>(null);
  const restoringPosition = useRef(false);
  const restoreGeneration = useRef(0);
  const readingMenu = useRef<HTMLButtonElement>(null);
  const rowHeights = useRef(new Map<string, number>());
  const heightSnapshot = useRef(diff.id);
  if (heightSnapshot.current !== diff.id) {
    rowHeights.current.clear();
    heightSnapshot.current = diff.id;
  }
  const [paneSize, setPaneSize] = useState({ visible: true, width: 0 });
  const paneVisible = paneSize.visible;
  useLayoutEffect(() => {
    const element = parent.current;
    if (!element) return;
    const update = () =>
      setPaneSize((previous) => {
        const visible = element.clientWidth > 0 && element.clientHeight > 0;
        const width = visible ? element.clientWidth : previous.width;
        return visible === previous.visible && width === previous.width
          ? previous
          : { visible, width };
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [raw]);
  useEffect(() => {
    ++contextSequence.current;
    setContext(null);
    setContextError("");
    setContextBusy(false);
    return () => {
      ++contextSequence.current;
    };
  }, [diff.id]);
  const split = preferences.diffMode === "split";
  const displayedContext = context?.snapshotId === diff.id ? context : null;
  const rows = useMemo(
    () =>
      readingRows(diff, split, preferences.ignoreWhitespace, displayedContext),
    [diff, split, preferences.ignoreWhitespace, displayedContext],
  );
  const hiddenByHunk = useMemo(
    () =>
      new Map(
        diff.hunks.map((hunk) => [
          hunk.id,
          preferences.ignoreWhitespace ? hiddenWhitespace(hunk).size : 0,
        ]),
      ),
    [diff.hunks, preferences.ignoreWhitespace],
  );
  const hiddenLines = [...hiddenByHunk.values()].reduce(
    (total, count) => total + count,
    0,
  );
  const highlights = useMemo(
    () => new Map(diff.hunks.flatMap((hunk) => [...inlineChanges(hunk)])),
    [diff.hunks],
  );
  const hasLongLines = rows.some(
    (row) =>
      row.kind === "line" &&
      [row.left, row.right].some(
        (line) => line && line.content.length > 10_000,
      ),
  );
  const readingLayout = `${split}:${preferences.fontSize}:${preferences.wrapLines}:${preferences.ignoreWhitespace}:${preferences.showWhitespace}:${displayedContext?.contextLines ?? 3}:${preferences.wrapLines ? paneSize.width : 0}`;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: (index) =>
      rows[index].kind === "header"
        ? 48
        : rows[index].kind === "hidden"
          ? 36
          : preferences.fontSize + 13,
    overscan: 25,
    getItemKey: (index) => rows[index].key,
    measureElement: (element) => {
      const key = element.getAttribute("data-row-key") ?? "";
      const measured = element.getBoundingClientRect().height;
      // Hidden mounted pages report zero sizes. Keep their last real row sizes
      // so the virtualizer cannot compensate for a fictitious collapsed list.
      if (measured > 0 && parent.current?.clientHeight) {
        rowHeights.current.delete(key);
        rowHeights.current.set(key, measured);
        if (rowHeights.current.size > 10_000)
          rowHeights.current.delete(rowHeights.current.keys().next().value!);
        return measured;
      }
      const row = rows[Number(element.getAttribute("data-index"))];
      return (
        rowHeights.current.get(key) ??
        (row?.kind === "header"
          ? 48
          : row?.kind === "hidden"
            ? 36
            : preferences.fontSize + 13)
      );
    },
  });
  function cancelPositionRestore() {
    restoreGeneration.current++;
    restoringPosition.current = false;
  }
  function rememberPosition() {
    if (restoringPosition.current) return;
    if (raw || !parent.current?.clientHeight || !parent.current.clientWidth)
      return;
    const top = parent.current?.scrollTop ?? 0;
    const item = virtualizer.getVirtualItems().find((item) => item.end > top);
    if (item && rows[item.index])
      anchor.current = {
        position: rowAnchor(rows[item.index]),
        offset: top - item.start,
        left: parent.current?.scrollLeft ?? 0,
        snapshotId: diff.id,
        top,
        layout: readingLayout,
      };
  }
  function displayPreference(value: Partial<Preferences>) {
    cancelPositionRestore();
    rememberPosition();
    onPreferences(value);
  }
  useLayoutEffect(() => {
    if (raw || !paneVisible || !parent.current?.clientHeight || !anchor.current)
      return;
    const saved = anchor.current;
    const freshSnapshot = saved.snapshotId !== diff.id;
    const sameLayout = !freshSnapshot && saved.layout === readingLayout;
    const index = sameLayout
      ? -1
      : findAnchor(rows, saved.position, freshSnapshot);
    if (!sameLayout && index < 0) {
      if (freshSnapshot) {
        setPositionNotice("刷新后无法唯一定位原来的代码行，已回到文件开头。");
        virtualizer.scrollToOffset(0);
        anchor.current = null;
      }
      return;
    }
    // A hidden page has not changed layout. Retain measured row sizes and the
    // complete offset within wrapped lines; clearing sizes causes compensation
    // scrolls to overwrite the very anchor we are trying to restore.
    const generation = ++restoreGeneration.current;
    restoringPosition.current = true;
    let frame = 0;
    let pass = 0;
    function restore() {
      if (
        generation !== restoreGeneration.current ||
        !parent.current?.clientHeight
      )
        return;
      if (sameLayout) virtualizer.scrollToOffset(saved.top);
      else {
        const position = virtualizer.getOffsetForIndex(index, "start");
        const height = parent.current
          .querySelector<HTMLElement>(`[data-index="${index}"]`)
          ?.getBoundingClientRect().height;
        const offset = Math.max(
          0,
          height ? Math.min(saved.offset, height - 1) : saved.offset,
        );
        if (position) virtualizer.scrollToOffset(position[0] + offset);
      }
      parent.current.scrollLeft = saved.left;
      // Reconcile once after the target's actual wrapped height is available.
      if (!sameLayout && pass++ === 0) frame = requestAnimationFrame(restore);
      else
        frame = requestAnimationFrame(() => {
          if (generation !== restoreGeneration.current) return;
          restoringPosition.current = false;
          rememberPosition();
        });
    }
    frame = requestAnimationFrame(restore);
    return () => {
      cancelAnimationFrame(frame);
      if (generation === restoreGeneration.current) cancelPositionRestore();
    };
  }, [rows, raw, readingLayout, diff.id, virtualizer, paneVisible]);
  const matches = useMemo(
    () =>
      rows.flatMap((row, index) => (rowMatches(row, search) ? [index] : [])),
    [rows, search],
  );
  const [searchIndex, setSearchIndex] = useState<number | null>(null);
  function findMatch(direction: number) {
    cancelPositionRestore();
    if (!matches.length) return;
    const index = searchIndex ?? -1;
    const next =
      direction > 0
        ? (matches.find((row) => row > index) ?? matches[0])
        : ([...matches].reverse().find((row) => row < index) ??
          matches[matches.length - 1]);
    setSearchIndex(next);
    virtualizer.scrollToIndex(next, { align: "center" });
  }
  async function expandContext(lines: number) {
    const generation = ++contextSequence.current;
    rememberPosition();
    setContextError("");
    if (lines === 3) {
      setContext(null);
      setContextBusy(false);
      return;
    }
    setContextBusy(true);
    try {
      const value = await onLoadContext(lines);
      if (
        generation !== contextSequence.current ||
        value.snapshotId !== diff.id
      )
        return;
      rememberPosition();
      setContext(value);
    } catch (cause) {
      if (generation === contextSequence.current)
        setContextError(asError(cause).message);
    } finally {
      if (generation === contextSequence.current) setContextBusy(false);
    }
  }
  const reviewed = diff.hunks.filter(
    (h) => h.reviewState === "reviewed",
  ).length;
  function goHunk(index: number) {
    cancelPositionRestore();
    if (!diff.hunks.length || raw) return;
    const next = Math.max(0, Math.min(index, diff.hunks.length - 1));
    setActiveHunk(next);
    virtualizer.scrollToIndex(
      rows.findIndex(
        (row) => row.kind === "header" && row.hunk.id === diff.hunks[next].id,
      ),
      { align: "start" },
    );
  }
  return (
    <section
      className="diff-panel"
      aria-label="代码差异"
      style={
        { "--code-size": `${preferences.fontSize}px` } as React.CSSProperties
      }
    >
      <div className="diff-topbar">
        <header className="diff-file-header">
          <div className="file-title">
            <Code size={20} />
            <div>
              <strong>{diff.path.split("/").pop()}</strong>
              <span>
                {diff.oldPath ? `${diff.oldPath} → ` : ""}
                {diff.path}
              </span>
            </div>
          </div>
          <div className="diff-tally">
            <span className="addition">+{diff.additions}</span>
            <span className="deletion">−{diff.deletions}</span>
          </div>
        </header>
        <div className="diff-toolbar">
          <div className="segmented small">
            <button
              aria-pressed={!split}
              onClick={() => displayPreference({ diffMode: "unified" })}
            >
              Unified
            </button>
            <button
              aria-pressed={split}
              onClick={() => displayPreference({ diffMode: "split" })}
            >
              Split
            </button>
          </div>
          <span className="comparison">
            <span>{diff.side === "staged" ? "HEAD" : "Index"}</span>
            <span aria-hidden="true">→</span>
            <span>{diff.side === "staged" ? "Index" : "Worktree"}</span>
          </span>
          <div className="toolbar-spacer" />
          <button
            className="icon-button"
            title="文件历史与 Blame"
            aria-label="文件历史与 Blame"
            disabled={!onHistory || pending}
            onClick={onHistory}
          >
            <ClockCounterClockwise size={17} />
          </button>
          <button
            className="icon-button"
            title="Open in editor · 当前 Worktree 文件"
            aria-label="在外部编辑器打开"
            disabled={openingEditor}
            onClick={onEditor}
          >
            <ArrowSquareOut size={17} />
          </button>
          <button
            className={`icon-button ${preferences.wrapLines ? "selected" : ""}`}
            aria-label="切换自动换行"
            title="自动换行"
            aria-pressed={preferences.wrapLines}
            onClick={() =>
              displayPreference({ wrapLines: !preferences.wrapLines })
            }
          >
            <TextAlignLeft size={17} />
          </button>
          <button
            ref={readingMenu}
            className={`icon-button ${optionsOpen ? "selected" : ""}`}
            aria-label="Diff 阅读选项"
            title="阅读选项"
            aria-expanded={optionsOpen}
            onClick={() => {
              rememberPosition();
              setOptionsOpen(!optionsOpen);
            }}
          >
            <SlidersHorizontal size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="搜索文件内容"
            title={raw ? "返回 Diff 视图后搜索文件内容" : "搜索文件内容"}
            disabled={raw}
            onClick={() => setSearchOpen(!searchOpen)}
          >
            <MagnifyingGlass size={17} />
          </button>
          <button
            className={`icon-button ${raw ? "selected" : ""}`}
            aria-label="查看原始 patch"
            title="原始 patch"
            aria-pressed={raw}
            onClick={() => {
              rememberPosition();
              setSearchOpen(false);
              setSearch("");
              setRaw(!raw);
            }}
          >
            <Code size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="进入专注审查"
            title="专注审查"
            onClick={onFocus}
          >
            <ArrowsOutSimple size={17} />
          </button>
        </div>
      </div>
      {optionsOpen && (
        <div
          className="diff-reading-options"
          role="group"
          aria-label="Diff 阅读选项"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOptionsOpen(false);
              readingMenu.current?.focus();
            }
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={preferences.ignoreWhitespace}
              onChange={(event) =>
                displayPreference({ ignoreWhitespace: event.target.checked })
              }
            />
            <span title="仅折叠成对行中的空格、制表符及 CR 差异；新增/删除空行与末尾换行差异仍显示。空白在代码字符串中也可能有意义。">
              隐藏空白变化
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={preferences.showWhitespace}
              onChange={(event) =>
                displayPreference({ showWhitespace: event.target.checked })
              }
            />
            显示空白字符
          </label>
          <label className="context-size">
            上下文{" "}
            <select
              aria-label="每处上下文行数"
              value={displayedContext?.contextLines ?? 3}
              disabled={
                contextBusy ||
                pending ||
                !["text", "rename"].includes(diff.kind)
              }
              onChange={(event) => {
                void expandContext(Number(event.target.value));
              }}
            >
              {[3, 10, 25, 100].map((value) => (
                <option key={value} value={value}>
                  {value} 行
                </option>
              ))}
            </select>
          </label>
          <span role="status">
            {contextBusy ? "读取上下文…" : "仅改变阅读方式"}
          </span>
        </div>
      )}
      {preferences.ignoreWhitespace && (
        <div className="diff-scope-notice" role="status">
          <Warning size={15} />
          <span>
            {raw
              ? "当前原始 Patch 展示全部变化；空白折叠仅用于 Diff 视图。"
              : hiddenLines
                ? `正在隐藏空白变化 · ${hiddenLines} 行被折叠。暂存包含完整原始变化；审查隐藏内容前需恢复显示。`
                : "空白过滤已开启 · 当前文件没有被折叠的变化。"}
          </span>
          <button
            onClick={() => displayPreference({ ignoreWhitespace: false })}
          >
            显示全部
          </button>
        </div>
      )}
      {contextError && (
        <div className="inline-notice" role="alert">
          <Warning size={16} />
          <span>{contextError}</span>
        </div>
      )}
      {hasLongLines && !raw && (
        <div className="inline-notice">
          <span>
            超过 10,000 字符的长行保留原文，省略行内高亮和空白字符标记。
          </span>
        </div>
      )}
      {positionNotice && (
        <div className="inline-notice" role="status">
          <span>{positionNotice}</span>
          <button
            aria-label="关闭阅读位置提示"
            onClick={() => setPositionNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {split && !raw && (
        <div className="split-width-hint">
          并排空间较窄，可
          <button onClick={() => displayPreference({ diffMode: "unified" })}>
            切换统一视图
          </button>
          以便阅读长代码行。
        </div>
      )}
      {searchOpen && !raw && (
        <div className="diff-search">
          <MagnifyingGlass size={16} />
          <input
            autoFocus
            aria-label="搜索当前 Diff"
            placeholder="在当前 Diff 中查找…"
            value={search}
            onChange={(e) => {
              cancelPositionRestore();
              setSearch(e.target.value);
              const index = rows.findIndex((row) =>
                rowMatches(row, e.target.value),
              );
              setSearchIndex(index >= 0 ? index : null);
              if (index >= 0)
                virtualizer.scrollToIndex(index, { align: "center" });
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                findMatch(event.shiftKey ? -1 : 1);
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setSearchOpen(false);
                setSearch("");
                parent.current?.focus();
              }
            }}
          />
          <span>
            {Math.max(0, matches.indexOf(searchIndex ?? -1) + 1)}/
            {matches.length} 行
          </span>
          <button
            className="icon-button"
            aria-label="上一个匹配行"
            disabled={!matches.length}
            onClick={() => findMatch(-1)}
          >
            <CaretUp size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="下一个匹配行"
            disabled={!matches.length}
            onClick={() => findMatch(1)}
          >
            <CaretDown size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="关闭文件内容搜索"
            onClick={() => {
              setSearchOpen(false);
              setSearch("");
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {diff.notice && (
        <div className="inline-notice">
          <Warning size={16} />
          <span>{diff.notice}</span>
        </div>
      )}
      {raw ? (
        <div className="raw-patch">
          <button
            className="button subtle"
            onClick={() => {
              void navigator.clipboard.writeText(diff.patch);
            }}
          >
            <Copy size={15} />
            复制 patch
          </button>
          <pre>{diff.patch}</pre>
        </div>
      ) : (
        <>
          {split && (
            <div className="split-labels">
              <span>{diff.side === "staged" ? "HEAD" : "Index"} · 修改前</span>
              <span>
                {diff.side === "staged" ? "Index" : "Worktree"} · 修改后
              </span>
            </div>
          )}
          <div
            ref={parent}
            className={`diff-scroll ${split ? "is-split" : ""} ${preferences.wrapLines ? "wrap-code" : ""}`}
            tabIndex={0}
            onScroll={rememberPosition}
            onWheel={cancelPositionRestore}
            onPointerDown={cancelPositionRestore}
            aria-label="只读代码，按 Alt 加上下方向键切换变化块"
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.defaultPrevented) return;
              if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                goHunk(activeHunk + (e.key === "ArrowDown" ? 1 : -1));
              }
            }}
          >
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: "100%",
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    data-row-key={row.key}
                    ref={virtualizer.measureElement}
                    className={`virtual-row ${searchIndex === item.index && rowMatches(row, search) ? "is-search-result" : ""}`}
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {row.kind === "header" ? (
                      <div
                        className={`hunk-header ${row.hunk.reviewState === "reviewed" ? "is-reviewed" : ""}`}
                      >
                        <button
                          className="hunk-review"
                          title={
                            (hiddenByHunk.get(row.hunk.id) ?? 0) > 0 &&
                            row.hunk.reviewState !== "reviewed"
                              ? "此变化块有隐藏内容，请显示全部后再标记。"
                              : row.hunk.reviewState === "reviewed"
                                ? "撤销审查标记"
                                : "Mark hunk reviewed"
                          }
                          aria-label={`${row.hunk.reviewState === "reviewed" ? "撤销审查" : "标记已审查"}：第 ${row.hunk.newStart} 行`}
                          aria-pressed={row.hunk.reviewState === "reviewed"}
                          disabled={
                            pending ||
                            (row.hunk.reviewState !== "reviewed" &&
                              (hiddenByHunk.get(row.hunk.id) ?? 0) > 0)
                          }
                          onClick={() =>
                            onMark(
                              row.hunk.id,
                              row.hunk.reviewState !== "reviewed",
                            )
                          }
                        >
                          {row.hunk.reviewState === "reviewed" ? (
                            <Check weight="bold" size={16} />
                          ) : row.hunk.reviewState === "needs_review" ? (
                            <ArrowCounterClockwise size={16} />
                          ) : (
                            <Circle size={16} />
                          )}
                        </button>
                        <code>{row.hunk.header}</code>
                        <span className="hunk-state">
                          {row.hunk.reviewState === "reviewed"
                            ? "已审查"
                            : row.hunk.reviewState === "needs_review"
                              ? "待复核"
                              : "未审查"}
                        </span>
                        <button
                          className="hunk-stage"
                          disabled={
                            pending ||
                            !diff.canStageHunks ||
                            !row.hunk.lines.length
                          }
                          title={
                            diff.canStageHunks && row.hunk.lines.length > 0
                              ? "仅操作此变化块"
                              : "当前变化不支持 Hunk 操作"
                          }
                          onClick={() => onStage(row.hunk.id)}
                        >
                          {diff.side === "staged" ? (
                            <Minus size={13} />
                          ) : (
                            <Plus size={13} />
                          )}
                          {diff.side === "staged"
                            ? "Unstage hunk"
                            : "Stage hunk"}
                        </button>
                        {diff.side === "unstaged" && (
                          <button
                            className="icon-button"
                            disabled={
                              pending ||
                              !diff.canDiscardHunks ||
                              !row.hunk.lines.length
                            }
                            title={
                              diff.canDiscardHunks
                                ? "预览丢弃此 Hunk"
                                : (diff.discardReason ?? "此 Hunk 不支持丢弃")
                            }
                            aria-label={`预览丢弃 Hunk：第 ${row.hunk.newStart} 行`}
                            onClick={() => onDiscard(row.hunk.id)}
                          >
                            <Trash size={15} />
                          </button>
                        )}
                      </div>
                    ) : row.kind === "hidden" ? (
                      <div className="hidden-diff-lines">
                        <span>已折叠 {row.count} 行空白变化</span>
                        <button
                          onClick={() =>
                            displayPreference({ ignoreWhitespace: false })
                          }
                        >
                          显示全部真实变化
                        </button>
                      </div>
                    ) : split ? (
                      <div className="split-row">
                        <CodeCell
                          line={row.left}
                          side="old"
                          search={search}
                          ranges={
                            row.left ? highlights.get(row.left) : undefined
                          }
                          showWhitespace={preferences.showWhitespace}
                        />
                        <CodeCell
                          line={row.right ?? null}
                          side="new"
                          search={search}
                          ranges={
                            row.right ? highlights.get(row.right) : undefined
                          }
                          showWhitespace={preferences.showWhitespace}
                        />
                      </div>
                    ) : (
                      <CodeCell
                        line={row.left}
                        search={search}
                        ranges={row.left ? highlights.get(row.left) : undefined}
                        showWhitespace={preferences.showWhitespace}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            {diff.hunks.every((h) => !h.lines.length) && (
              <div className="special-file">
                <Code size={30} />
                <h3>
                  {(
                    {
                      binary: "二进制文件发生变化",
                      symlink: "符号链接发生变化",
                      submodule: "子模块引用发生变化",
                      metadata: "文件属性发生变化",
                      conflict: "文件存在冲突",
                    } as Record<string, string>
                  )[diff.kind] ?? "文件变化"}
                </h3>
                <p>检查文件属性与原始 patch 后，可以记录本次人工审查。</p>
                <button className="button" onClick={() => setRaw(true)}>
                  查看原始 patch
                </button>
              </div>
            )}
          </div>
        </>
      )}
      <SplitScrollbars
        active={
          split &&
          !raw &&
          !preferences.wrapLines &&
          rows.some((row) => row.kind === "line")
        }
        parent={parent}
        layoutKey={`${diff.id}:${preferences.fontSize}:${preferences.showWhitespace}:${preferences.ignoreWhitespace}:${displayedContext?.contextLines ?? 3}`}
        rowKey={`${preferences.fontSize}:${virtualizer
          .getVirtualItems()
          .map((item) => item.key)
          .join("|")}`}
      />
      <footer className="diff-footer">
        <div className="hunk-navigation">
          <button
            className="icon-button"
            title="上一个变化块"
            aria-label="上一个变化块"
            disabled={raw || !diff.hunks.length}
            onClick={() => goHunk(activeHunk - 1)}
          >
            <CaretUp size={15} />
          </button>
          <button
            className="icon-button"
            title="下一个变化块"
            aria-label="下一个变化块"
            disabled={raw || !diff.hunks.length}
            onClick={() => goHunk(activeHunk + 1)}
          >
            <CaretDown size={15} />
          </button>
          <span>{diff.hunks.length} 个变化块</span>
        </div>
        <div className="toolbar-spacer" />
        <span>
          {reviewed}/{diff.hunks.length} 已审查
        </span>
        <button
          className="button compact"
          disabled={
            pending || (hiddenLines > 0 && reviewed !== diff.hunks.length)
          }
          title={
            hiddenLines
              ? "当前隐藏了空白变化，请恢复显示后再标记整个文件。"
              : undefined
          }
          onClick={() => onMark(null, reviewed !== diff.hunks.length)}
        >
          <Check size={15} />
          {reviewed === diff.hunks.length ? "撤销文件标记" : "标记整个文件"}
        </button>
      </footer>
    </section>
  );
}

function CodeCell({
  line,
  side,
  search,
  ranges,
  showWhitespace,
}: {
  line: DiffLine | null;
  side?: "old" | "new";
  search: string;
  ranges?: TextRange[];
  showWhitespace: boolean;
}) {
  if (!line) return <div className="code-cell empty-code" />;
  return (
    <div className={`code-cell line-${line.kind}`} data-code-side={side}>
      {!side && (
        <span className="line-number" aria-hidden="true">
          {line.oldLine}
        </span>
      )}
      <span className="line-number" aria-hidden="true">
        {side === "old" ? line.oldLine : line.newLine}
      </span>
      <span className="line-sign" aria-hidden="true">
        {line.kind === "add" ? "+" : line.kind === "delete" ? "−" : ""}
      </span>
      <div className="code-viewport">
        <code>
          <CodeText
            text={line.content}
            search={search}
            ranges={ranges}
            showWhitespace={showWhitespace}
          />
        </code>
      </div>
    </div>
  );
}
