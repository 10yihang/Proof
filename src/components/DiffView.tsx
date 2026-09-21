import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import MonacoDiffSurface, {
  type DiffSurfaceHandle,
  type ReviewWidget,
} from "./MonacoDiffSurface";
import { canUseMonaco } from "../monaco-document";
import { type ReadingRow } from "../diff-reading";
import { useHotkeys } from "react-hotkeys-hook";
import { Button, Input } from "./ui/controls";
import { t, uiMessage } from "../i18n";
import {
  annotationsForDiff,
  inFindingRange,
  findingEnd,
} from "../review-annotations";
import { InlineReview } from "./InlineReview";
import { hunkSyntax, type SyntaxSpan } from "../syntax";
import type { AiController, DiffJump } from "../ai";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
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
  ArrowsInSimple,
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
import type {
  DiffContext,
  DiffContextRange,
  DiffLine,
  FileDiff,
  Preferences,
} from "../types";
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

export type DiffPosition = {
  contextRange?: DiffContextRange;
  contextLines?: number;
  position: ReadingAnchor;
  offset: number;
  left: number;
  horizontal?: Partial<Record<"old" | "new" | "unified", number>>;
  snapshotId: string;
  top: number;
  layout: string;
  reader: object;
};

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
  onCancelContext,
  onEditor,
  openingEditor,
  comparison,
  focused,
  positionRef,
  jumpTo,
  ai,
  onOpenWindow,
}: {
  jumpTo?: DiffJump | null;
  ai?: AiController;
  onOpenWindow?: () => void;
  diff: FileDiff;
  preferences: Preferences;
  pending: boolean;
  onMark: (hunkId: string | null, reviewed: boolean) => void;
  onStage: (hunkId: string | null) => void;
  onDiscard: (hunkId: string | null) => void;
  onHistory?: () => void;
  onPreferences: (p: Partial<Preferences>) => void;
  onFocus: () => void;
  onLoadContext: (lines: DiffContextRange) => Promise<DiffContext>;
  onCancelContext: () => void;
  onEditor: () => void;
  openingEditor: boolean;
  comparison?: { base: string; target: string };
  focused?: boolean;
  positionRef?: MutableRefObject<DiffPosition | null>;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const editorSurface = useRef<DiffSurfaceHandle>(null);
  const [editorFailure, setEditorFailure] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(0);
  const monaco = canUseMonaco(diff) && editorFailure !== diff.id;
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
  const desiredContext = useRef<DiffContextRange>(
    positionRef?.current?.contextRange ?? 3,
  );
  const lastContextLines = useRef(
    positionRef?.current?.contextLines ??
      (typeof desiredContext.current === "number" ? desiredContext.current : 3),
  );
  const pendingSearch = useRef(false);
  const suspendedContext = useRef(desiredContext.current !== 3);
  const searchInput = useRef<HTMLInputElement>(null);
  const localAnchor = useRef<DiffPosition | null>(null);
  const anchor = positionRef ?? localAnchor;
  const reader = useRef({});
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
  useLayoutEffect(() => {
    ++contextSequence.current;
    desiredContext.current = anchor.current?.contextRange ?? 3;
    lastContextLines.current =
      anchor.current?.contextLines ??
      (typeof desiredContext.current === "number" ? desiredContext.current : 3);
    suspendedContext.current = desiredContext.current !== 3;
    pendingSearch.current = !anchor.current && searchOpen && !!search;
    setContext(null);
    setContextError("");
    setContextBusy(false);
    return () => {
      ++contextSequence.current;
      onCancelContext();
    };
  }, [diff.id, onCancelContext]);
  const split = preferences.diffMode === "split";
  const displayedContext = context?.snapshotId === diff.id ? context : null;
  const syntax = useMemo(
    () =>
      hunkSyntax(
        [
          ...diff.hunks.map((hunk) => ({
            lines: [
              ...(displayedContext?.gaps.find(
                (gap) => gap.beforeHunkId === hunk.id,
              )?.lines ?? []),
              ...hunk.lines,
            ],
          })),
          {
            lines:
              displayedContext?.gaps.find((gap) => gap.beforeHunkId === null)
                ?.lines ?? [],
          },
        ],
        diff.path,
      ),
    [displayedContext, diff.hunks, diff.path],
  );
  const rows = useMemo(
    () =>
      readingRows(
        diff,
        split,
        preferences.ignoreWhitespace && !searchOpen,
        displayedContext,
      ),
    [diff, split, preferences.ignoreWhitespace, searchOpen, displayedContext],
  );
  const annotations = useMemo(
    () => annotationsForDiff(ai?.report ?? null, diff, ai?.stale ?? true),
    [ai?.report, ai?.stale, diff],
  );
  const commentsByRow = useMemo(() => {
    const result = new Map<number, typeof annotations>();
    if (!annotations.length) return result;
    rows.forEach((row, index) => {
      if (row.kind !== "line") return;
      const matches = annotations.filter(
        ({ finding }) =>
          findingEnd(row.left, finding) || findingEnd(row.right, finding),
      );
      if (matches.length) result.set(index, matches);
    });
    return result;
  }, [rows, annotations]);
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
  const readingLayout = `${split}:${preferences.fontSize}:${preferences.wrapLines}:${preferences.ignoreWhitespace && !searchOpen}:${preferences.showWhitespace}:${displayedContext?.fullFile ? "file" : (displayedContext?.contextLines ?? 3)}:${preferences.wrapLines ? paneSize.width : 0}`;
  const editorDocumentKey = `${diff.id}:${split}:${preferences.ignoreWhitespace && !searchOpen}:${displayedContext?.fullFile ? "file" : (displayedContext?.contextLines ?? 3)}`;
  function editorIsReady() {
    return editorSurface.current?.bookmark()?.contentKey === editorDocumentKey;
  }
  const virtualizer = useVirtualizer({
    count: monaco ? 0 : rows.length,
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
  function cancelPositionRestore(user = false) {
    if (user) suspendedContext.current = false;
    restoreGeneration.current++;
    restoringPosition.current = false;
  }
  function rememberPosition() {
    if (restoringPosition.current) return;
    if (waitingForContext()) return;
    if (raw || !parent.current?.clientHeight || !parent.current.clientWidth)
      return;
    if (monaco) {
      const saved = editorSurface.current?.bookmark();
      if (
        saved &&
        saved.sourceId === diff.id &&
        saved.contentKey === editorDocumentKey
      )
        anchor.current = {
          contextRange: desiredContext.current,
          contextLines: lastContextLines.current,
          position: {
            ...saved.position,
            ...(comparison ? { content: null } : {}),
          },
          offset: saved.offset,
          left: saved.left,
          horizontal: saved.horizontal,
          snapshotId: saved.sourceId,
          top: saved.top,
          layout: saved.layout,
          reader: reader.current,
        };
      return;
    }
    const viewport = parent.current;
    const top = viewport.scrollTop;
    const viewportTop =
      viewport.getBoundingClientRect().top + viewport.clientTop;
    const element = [
      ...viewport.querySelectorAll<HTMLElement>(".virtual-row"),
    ].find((row) => row.getBoundingClientRect().bottom > viewportTop + 0.5);
    const index = element ? Number(element.dataset.index) : -1;
    if (element && rows[index])
      anchor.current = {
        contextRange: desiredContext.current,
        contextLines: lastContextLines.current,
        position: {
          ...rowAnchor(rows[index]),
          ...(comparison ? { content: null } : {}),
        },
        offset: viewportTop - element.getBoundingClientRect().top,
        left: parent.current?.scrollLeft ?? 0,
        snapshotId: diff.id,
        top,
        layout: readingLayout,
        reader: reader.current,
      };
  }
  function scrollToRow(index: number, align: "start" | "center" = "center") {
    if (monaco) editorSurface.current?.scrollToRow(index, align);
    else virtualizer.scrollToIndex(index, { align });
  }
  function scrollToOffset(offset: number) {
    if (monaco) editorSurface.current?.scrollToOffset(offset);
    else virtualizer.scrollToOffset(offset);
  }
  function displayPreference(value: Partial<Preferences>) {
    cancelPositionRestore(true);
    rememberPosition();
    onPreferences(value);
  }
  useLayoutEffect(() => {
    if (waitingForContext()) return;
    suspendedContext.current = false;
    if (raw || !paneVisible || !parent.current?.clientHeight || !anchor.current)
      return;
    const saved = anchor.current;
    const freshSnapshot = saved.snapshotId !== diff.id;
    const sameLayout =
      !freshSnapshot &&
      saved.layout === readingLayout &&
      saved.reader === reader.current;
    const index = sameLayout
      ? -1
      : findAnchor(rows, saved.position, freshSnapshot);
    if (!sameLayout && index < 0) {
      if (freshSnapshot) {
        setPositionNotice(
          t("刷新后无法唯一定位原来的代码行，已回到文件开头。"),
        );
        scrollToOffset(0);
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
    let stable = 0;
    let previousTop: number | null = null;
    function restore() {
      if (
        generation !== restoreGeneration.current ||
        !parent.current?.clientHeight
      )
        return;
      // Even an unchanged layout has a new model after a hidden tab is
      // released. Do not finish a no-op restore and save its initial zero.
      if (monaco && !editorIsReady()) {
        frame = requestAnimationFrame(restore);
        return;
      }
      if (sameLayout) scrollToOffset(saved.top);
      else if (monaco) {
        const surface = editorSurface.current;
        if (!surface || !editorIsReady()) return;
        surface.scrollToRow(
          index,
          "start",
          Math.min(saved.offset, surface.rowHeight(index) - 1),
        );
        const top = surface.bookmark()?.top ?? 0;
        stable =
          previousTop !== null && Math.abs(top - previousTop) < 1
            ? stable + 1
            : 0;
        previousTop = top;
      } else {
        const viewport = parent.current;
        const row = viewport.querySelector<HTMLElement>(
          `[data-index="${index}"]`,
        );
        const bounds = row?.getBoundingClientRect();
        const viewportTop =
          viewport.getBoundingClientRect().top + viewport.clientTop;
        const position = bounds
          ? viewport.scrollTop + bounds.top - viewportTop
          : virtualizer.getOffsetForIndex(index, "start")?.[0];
        const offset = Math.max(
          0,
          bounds?.height
            ? Math.min(saved.offset, bounds.height - 1)
            : saved.offset,
        );
        if (position !== undefined)
          virtualizer.scrollToOffset(position + offset);
        const aligned =
          row &&
          Math.abs(viewportTop - row.getBoundingClientRect().top - offset) < 1;
        stable =
          aligned &&
          previousTop !== null &&
          Math.abs(viewport.scrollTop - previousTop) < 1
            ? stable + 1
            : 0;
        previousTop = viewport.scrollTop;
      }
      if (monaco)
        editorSurface.current?.setScrollLeft(saved.horizontal ?? saved.left);
      else parent.current.scrollLeft = saved.left;
      // A rebuilt virtualizer may measure several wrapped batches. Reconcile
      // the actual source row until its position settles, with a bounded retry.
      if (!sameLayout && ++pass < 24 && stable < 2)
        frame = requestAnimationFrame(restore);
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
  }, [
    rows,
    raw,
    readingLayout,
    diff.id,
    virtualizer,
    paneVisible,
    monaco,
    editorReady,
  ]);
  const virtualItems = virtualizer.getVirtualItems();
  useLayoutEffect(() => {
    if (!monaco) rememberPosition();
  }, [virtualItems]);
  const matches = useMemo(
    () =>
      rows.flatMap((row, index) => (rowMatches(row, search) ? [index] : [])),
    [rows, search],
  );
  const [searchIndex, setSearchIndex] = useState<number | null>(null);
  const completedJump = useRef<string | null>(null);
  const [findingRange, setFindingRange] = useState<DiffJump | null>(null);
  useEffect(() => setFindingRange(null), [diff.id, ai?.report?.id, ai?.stale]);
  useEffect(() => {
    if (
      !jumpTo ||
      completedJump.current === jumpTo.id ||
      !paneVisible ||
      (monaco && !editorIsReady())
    )
      return;
    if (
      (jumpTo.comparisonId !== undefined && jumpTo.comparisonId !== diff.id) ||
      diff.token !== jumpTo.snapshotToken ||
      diff.path !== jumpTo.path ||
      diff.side !== jumpTo.fileSide
    )
      return;
    if (raw) {
      setRaw(false);
      return;
    }
    if (preferences.ignoreWhitespace) {
      onPreferences({ ignoreWhitespace: false });
      return;
    }
    const index = rows.findIndex(
      (row) =>
        row.kind === "line" &&
        [row.left, row.right].some(
          (line) =>
            line &&
            (jumpTo.side === "old" ? line.oldLine : line.newLine) ===
              jumpTo.line,
        ),
    );
    if (
      index < 0 &&
      displayedContext &&
      !displayedContext.fullFile &&
      displayedContext.contextLines < 3
    ) {
      void expandContext(3);
      return;
    }
    if (index < 0) return;
    completedJump.current = jumpTo.id;
    cancelPositionRestore(true);
    setFindingRange(jumpTo);
    const frame = requestAnimationFrame(() => {
      scrollToRow(index);
      if (monaco) editorSurface.current?.focus();
      else parent.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    jumpTo,
    diff.id,
    rows,
    paneVisible,
    raw,
    preferences.ignoreWhitespace,
    editorReady,
  ]);
  useEffect(() => {
    if (
      !searchOpen ||
      !search ||
      contextBusy ||
      !pendingSearch.current ||
      (monaco && !editorIsReady())
    )
      return;
    pendingSearch.current = false;
    cancelPositionRestore();
    setSearchIndex(matches[0] ?? null);
    if (matches.length) scrollToRow(matches[0]);
  }, [matches, searchOpen, search, contextBusy, editorReady]);
  useHotkeys(
    "*",
    (event) => {
      if (
        !paneVisible ||
        raw ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "f"
      )
        return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        document.querySelector("[role='dialog'][data-open]") ||
        (target?.closest('input,textarea,select,[contenteditable="true"]') &&
          target !== searchInput.current)
      )
        return;
      event.preventDefault();
      setSearchOpen(true);
      searchInput.current?.focus();
      searchInput.current?.select();
    },
    {
      ignoreModifiers: true,
      enableOnFormTags: true,
      enableOnContentEditable: true,
    },
    [paneVisible, raw],
  );
  function findMatch(direction: number) {
    cancelPositionRestore(true);
    if (!matches.length) return;
    const index = searchIndex ?? -1;
    const next =
      direction > 0
        ? (matches.find((row) => row > index) ?? matches[0])
        : ([...matches].reverse().find((row) => row < index) ??
          matches[matches.length - 1]);
    setSearchIndex(next);
    scrollToRow(next);
  }
  function cancelContext() {
    ++contextSequence.current;
    onCancelContext();
    pendingSearch.current = false;
    suspendedContext.current = false;
    restoreLoadedContextRange();
    setContextBusy(false);
  }
  function restoreLoadedContextRange() {
    desiredContext.current = displayedContext?.fullFile
      ? "file"
      : (displayedContext?.contextLines ?? 3);
    if (typeof desiredContext.current === "number")
      lastContextLines.current = desiredContext.current;
    if (anchor.current) {
      anchor.current.contextRange = desiredContext.current;
      anchor.current.contextLines = lastContextLines.current;
    }
  }
  // Release full text in hidden tabs. Returning reloads the chosen range and
  // restores the source-line bookmark without retaining every large reader.
  useEffect(() => {
    if (!paneVisible || raw) {
      ++contextSequence.current;
      onCancelContext();
      setContextBusy(false);
      if (desiredContext.current === "file") suspendedContext.current = true;
      setContext((value) => (value?.fullFile ? null : value));
    } else {
      const loaded: DiffContextRange = displayedContext?.fullFile
        ? "file"
        : (displayedContext?.contextLines ?? 3);
      if (desiredContext.current !== loaded)
        void expandContext(desiredContext.current, true);
    }
  }, [paneVisible, raw, diff.id, onCancelContext]);
  function waitingForContext() {
    const loaded: DiffContextRange = displayedContext?.fullFile
      ? "file"
      : (displayedContext?.contextLines ?? 3);
    return suspendedContext.current && desiredContext.current !== loaded;
  }
  async function expandContext(lines: DiffContextRange, restore = false) {
    const generation = ++contextSequence.current;
    onCancelContext();
    desiredContext.current = lines;
    if (typeof lines === "number") lastContextLines.current = lines;
    if (!restore) pendingSearch.current = searchOpen && !!search;
    rememberPosition();
    setContextError("");
    if (typeof lines === "number" && lines <= 3) {
      setContext(
        lines === 3
          ? null
          : {
              snapshotId: diff.id,
              contextLines: lines,
              fullFile: false,
              gaps: [],
            },
      );
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
      if (generation === contextSequence.current) {
        pendingSearch.current = false;
        restoreLoadedContextRange();
        if (asError(cause).code !== "READ_CANCELLED")
          setContextError(asError(cause).message);
      }
    } finally {
      if (generation === contextSequence.current) setContextBusy(false);
    }
  }
  const reviewed = diff.hunks.filter(
    (h) => h.reviewState === "reviewed",
  ).length;
  function goHunk(index: number) {
    cancelPositionRestore(true);
    if (!diff.hunks.length || raw) return;
    const next = Math.max(0, Math.min(index, diff.hunks.length - 1));
    setActiveHunk(next);
    scrollToRow(
      rows.findIndex(
        (row) => row.kind === "header" && row.hunk.id === diff.hunks[next].id,
      ),
      "start",
    );
  }
  function renderBlock(row: ReadingRow) {
    if (row.kind === "header")
      return (
        <div
          className={`hunk-header ${row.hunk.reviewState === "reviewed" ? "is-reviewed" : ""}`}
        >
          <Button
            className="hunk-review"
            title={
              (hiddenByHunk.get(row.hunk.id) ?? 0) > 0 &&
              row.hunk.reviewState !== "reviewed"
                ? t("此变化块有隐藏内容，请显示全部后再标记。")
                : row.hunk.reviewState === "reviewed"
                  ? t("撤销审查标记")
                  : t("Mark hunk reviewed")
            }
            aria-label={`${row.hunk.reviewState === "reviewed" ? t("撤销审查") : t("标记已审查")}：${row.hunk.lines.length ? t("第 {v0} 行", { v0: row.hunk.newStart || row.hunk.oldStart }) : t("文件属性与内容变化")}`}
            aria-pressed={row.hunk.reviewState === "reviewed"}
            disabled={
              pending ||
              (row.hunk.reviewState !== "reviewed" &&
                (hiddenByHunk.get(row.hunk.id) ?? 0) > 0)
            }
            onClick={() =>
              onMark(row.hunk.id, row.hunk.reviewState !== "reviewed")
            }
          >
            {row.hunk.reviewState === "reviewed" ? (
              <Check weight="bold" size={16} />
            ) : row.hunk.reviewState === "needs_review" ? (
              <ArrowCounterClockwise size={16} />
            ) : (
              <Circle size={16} />
            )}
          </Button>

          <code>{row.hunk.header}</code>
          {!comparison && (
            <>
              <span className="hunk-state">
                {row.hunk.reviewState === "reviewed"
                  ? t("已审查")
                  : row.hunk.reviewState === "needs_review"
                    ? t("待复核")
                    : t("未审查")}
              </span>
              <Button
                className="hunk-stage"
                disabled={
                  pending || !diff.canStageHunks || !row.hunk.lines.length
                }
                title={
                  diff.canStageHunks && row.hunk.lines.length > 0
                    ? t("仅操作此变化块")
                    : t("当前变化不支持 Hunk 操作")
                }
                onClick={() => onStage(row.hunk.id)}
              >
                {diff.side === "staged" ? (
                  <Minus size={13} />
                ) : (
                  <Plus size={13} />
                )}
                {diff.side === "staged" ? t("Unstage hunk") : t("Stage hunk")}
              </Button>
            </>
          )}
          {!comparison && diff.side === "unstaged" && (
            <Button
              className="icon-button"
              disabled={
                pending || !diff.canDiscardHunks || !row.hunk.lines.length
              }
              title={
                diff.canDiscardHunks
                  ? t("预览丢弃此 Hunk")
                  : (diff.discardReason ?? t("此 Hunk 不支持丢弃"))
              }
              aria-label={t("预览丢弃 Hunk：第 {v0} 行", {
                v0: row.hunk.newStart,
              })}
              onClick={() => onDiscard(row.hunk.id)}
            >
              <Trash size={15} />
            </Button>
          )}
        </div>
      );
    if (row.kind === "hidden")
      return (
        <div className="hidden-diff-lines">
          <span>
            {t("已折叠 ")}
            {row.count} {t(" 行空白变化")}
          </span>
          <Button
            onClick={() => displayPreference({ ignoreWhitespace: false })}
          >
            {t("显示全部真实变化")}
          </Button>
        </div>
      );
    return <div className="proof-eof-note">{row.left?.content}</div>;
  }
  const widgets = useMemo(() => {
    const result = new Map<number, ReviewWidget[]>();
    if (!ai?.report) return result;
    commentsByRow.forEach((findings, row) =>
      result.set(
        row,
        findings.map(({ finding, index }) => ({
          side: finding.lineSide,
          key: `${ai.report!.id}:${index}`,
          content: (
            <InlineReview
              finding={finding}
              decision={ai.report!.decisions[index] ?? "pending"}
              disabled={
                pending || !!ai.pending || ai.decisionSaving || ai.reportLoading
              }
              onDecision={(value) => void ai.setDecision(index, value)}
            />
          ),
        })),
      ),
    );
    return result;
  }, [
    commentsByRow,
    ai?.report,
    ai?.pending,
    ai?.decisionSaving,
    ai?.reportLoading,
    pending,
  ]);
  return (
    <section
      className="diff-panel"
      aria-label={t("代码差异")}
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
            <Button
              aria-pressed={!split}
              onClick={() => displayPreference({ diffMode: "unified" })}
            >
              {t("Unified")}
            </Button>
            <Button
              aria-pressed={split}
              onClick={() => displayPreference({ diffMode: "split" })}
            >
              {t("Split")}
            </Button>
          </div>
          <span className="comparison">
            <span>
              {comparison?.base ?? (diff.side === "staged" ? "HEAD" : "Index")}
            </span>
            <span aria-hidden="true">→</span>
            <span>
              {comparison?.target ??
                (diff.side === "staged" ? "Index" : "Worktree")}
            </span>
          </span>
          <div className="toolbar-spacer" />
          {!comparison && (
            <Button
              className="button compact"
              disabled={!diff.canStage || pending}
              title={
                !diff.canStage
                  ? t("此文件当前不支持 Git 写操作")
                  : t("操作当前整个文件")
              }
              onClick={() => onStage(null)}
            >
              {diff.side === "staged" ? (
                <Minus size={15} />
              ) : (
                <Plus size={15} />
              )}
              {diff.side === "staged" ? t("Unstage file") : t("Stage file")}
            </Button>
          )}
          {!comparison && diff.side === "unstaged" && (
            <Button
              className="icon-button"
              aria-label={t("预览丢弃文件")}
              title={
                diff.canDiscard
                  ? t("预览丢弃整个文件的未暂存变化")
                  : (diff.discardReason ?? t("当前不能丢弃"))
              }
              disabled={pending || !diff.canDiscard}
              onClick={() => onDiscard(null)}
            >
              <Trash size={17} />
            </Button>
          )}
          <div
            className="context-stepper"
            role="group"
            aria-label={t("Diff 上下文")}
          >
            <Button
              className="icon-button"
              aria-label={t("减少一行上下文")}
              title={t("减少一行上下文")}
              disabled={
                raw ||
                contextBusy ||
                pending ||
                !diff.hunks.some((h) => h.lines.length) ||
                (!displayedContext?.fullFile &&
                  (displayedContext?.contextLines ?? 3) === 0)
              }
              onClick={() =>
                void expandContext(Math.max(0, lastContextLines.current - 1))
              }
            >
              <Minus size={14} />
            </Button>
            <output aria-label={t("上下文行数")}>
              {displayedContext?.fullFile
                ? t("All")
                : (displayedContext?.contextLines ?? 3)}
            </output>
            <Button
              className="icon-button"
              aria-label={t("增加一行上下文")}
              title={t("增加一行上下文")}
              disabled={
                raw ||
                contextBusy ||
                pending ||
                !diff.hunks.some((h) => h.lines.length) ||
                lastContextLines.current === 65535
              }
              onClick={() =>
                void expandContext(
                  Math.min(65535, lastContextLines.current + 1),
                )
              }
            >
              <Plus size={14} />
            </Button>
            <Button
              className="button compact"
              aria-pressed={!!displayedContext?.fullFile}
              disabled={
                raw ||
                contextBusy ||
                pending ||
                !diff.hunks.some((h) => h.lines.length)
              }
              onClick={() =>
                void expandContext(
                  displayedContext?.fullFile
                    ? lastContextLines.current
                    : "file",
                )
              }
            >
              {t("Full file")}
            </Button>
          </div>
          {!comparison && (
            <Button
              className="icon-button"
              title={t("文件历史与 Blame")}
              aria-label={t("文件历史与 Blame")}
              disabled={!onHistory || pending}
              onClick={onHistory}
            >
              <ClockCounterClockwise size={17} />
            </Button>
          )}
          {!comparison && (
            <Button
              className="icon-button"
              title={t("Open in editor · 当前 Worktree 文件")}
              aria-label={t("在外部编辑器打开")}
              disabled={openingEditor}
              onClick={onEditor}
            >
              <ArrowSquareOut size={17} />
            </Button>
          )}
          <Button
            className={`icon-button ${preferences.wrapLines ? "selected" : ""}`}
            aria-label={t("切换自动换行")}
            title={t("自动换行")}
            aria-pressed={preferences.wrapLines}
            onClick={() =>
              displayPreference({ wrapLines: !preferences.wrapLines })
            }
          >
            <TextAlignLeft size={17} />
          </Button>
          <Popover
            open={optionsOpen}
            onOpenChange={(open) => {
              rememberPosition();
              setOptionsOpen(open);
            }}
          >
            <PopoverTrigger
              render={
                <Button
                  ref={readingMenu}
                  className={`icon-button ${optionsOpen ? "selected" : ""}`}
                  aria-label={t("Diff 阅读选项")}
                  title={t("阅读选项")}
                  aria-haspopup="dialog"
                >
                  <SlidersHorizontal size={17} />
                </Button>
              }
            />
            <PopoverContent
              align="end"
              className="proof-reading-options w-80 gap-3 rounded-md p-3"
              aria-label={t("Diff 阅读选项")}
            >
              <label>
                <Input
                  type="checkbox"
                  checked={preferences.ignoreWhitespace}
                  onChange={(event) =>
                    displayPreference({
                      ignoreWhitespace: event.target.checked,
                    })
                  }
                />
                <span
                  title={t(
                    "仅折叠成对行中的空格、制表符及 CR 差异；新增/删除空行与末尾换行差异仍显示。空白在代码字符串中也可能有意义。",
                  )}
                >
                  {t("隐藏空白变化")}
                </span>
              </label>
              <label>
                <Input
                  type="checkbox"
                  checked={preferences.showWhitespace}
                  onChange={(event) =>
                    displayPreference({ showWhitespace: event.target.checked })
                  }
                />
                {t("显示空白字符")}
              </label>
              <span role="status">
                {displayedContext?.fullFile
                  ? t("完整文件")
                  : t("仅改变阅读方式")}
              </span>
            </PopoverContent>
          </Popover>
          <Button
            className="icon-button"
            aria-label={t("搜索文件内容")}
            title={raw ? t("返回 Diff 视图后搜索文件内容") : t("搜索文件内容")}
            disabled={raw}
            onClick={() => setSearchOpen(!searchOpen)}
          >
            <MagnifyingGlass size={17} />
          </Button>
          <Button
            className={`icon-button ${raw ? "selected" : ""}`}
            aria-label={t("查看原始 patch")}
            title={t("原始 patch")}
            aria-pressed={raw}
            onClick={() => {
              rememberPosition();
              setSearchOpen(false);
              setSearch("");
              setRaw(!raw);
            }}
          >
            <Code size={17} />
          </Button>
          {onOpenWindow && (
            <Button
              className="icon-button"
              aria-label={t("在独立窗口打开 Diff")}
              title={t("Open in Separate Window")}
              onClick={onOpenWindow}
            >
              <ArrowSquareOut size={17} />
            </Button>
          )}
          {
            <Button
              className={`icon-button ${focused ? "selected" : ""}`}
              aria-label={focused ? t("退出专注审查") : t("进入专注审查")}
              aria-pressed={!!focused}
              title={t("专注审查")}
              onClick={onFocus}
            >
              {focused ? (
                <ArrowsInSimple size={17} />
              ) : (
                <ArrowsOutSimple size={17} />
              )}
            </Button>
          }
        </div>
      </div>
      {preferences.ignoreWhitespace && (
        <div className="diff-scope-notice" role="status">
          <Warning size={15} />
          <span>
            {raw
              ? t("当前原始 Patch 展示全部变化；空白折叠仅用于 Diff 视图。")
              : searchOpen
                ? t("搜索时显示全部代码；关闭搜索后恢复空白筛选。")
                : hiddenLines
                  ? t("正在隐藏空白变化 · {v0} 行被折叠。", { v0: hiddenLines })
                  : t("空白过滤已开启 · 当前文件没有被折叠的变化。")}
          </span>
          <Button
            onClick={() => displayPreference({ ignoreWhitespace: false })}
          >
            {t("显示全部")}
          </Button>
        </div>
      )}
      {contextError && (
        <div className="inline-notice" role="alert">
          <Warning size={16} />
          <span>{uiMessage(contextError)}</span>
        </div>
      )}
      {contextBusy && (
        <div className="inline-notice" role="status">
          <span>
            {desiredContext.current === "file"
              ? t("正在读取完整文件…")
              : t("正在读取上下文…")}
          </span>
          <Button onClick={cancelContext}>{t("取消读取")}</Button>
        </div>
      )}
      {hasLongLines && !raw && (
        <div className="inline-notice">
          <span>
            {t("超过 10,000 字符的长行保留原文，省略行内高亮和空白字符标记。")}
          </span>
        </div>
      )}
      {positionNotice && (
        <div className="inline-notice" role="status">
          <span>{uiMessage(positionNotice)}</span>
          <Button
            aria-label={t("关闭阅读位置提示")}
            onClick={() => setPositionNotice("")}
          >
            <X size={14} />
          </Button>
        </div>
      )}
      {split && !raw && (
        <div className="split-width-hint">
          {t("并排空间较窄，可")}
          <Button onClick={() => displayPreference({ diffMode: "unified" })}>
            {t("切换统一视图")}
          </Button>
          {t("以便阅读长代码行。")}
        </div>
      )}
      {searchOpen && !raw && (
        <div className="diff-search">
          <MagnifyingGlass size={16} />
          <Input
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            ref={searchInput}
            aria-label={t("搜索当前 Diff")}
            placeholder={
              displayedContext?.fullFile
                ? t("在完整文件中查找…")
                : t("在当前 Diff 中查找…")
            }
            value={search}
            onChange={(e) => {
              cancelPositionRestore(true);
              setSearch(e.target.value);
              pendingSearch.current =
                contextBusy || (monaco && !editorIsReady());
              const index = rows.findIndex((row) =>
                rowMatches(row, e.target.value),
              );
              setSearchIndex(index >= 0 ? index : null);
              if (index >= 0) scrollToRow(index);
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
          <span className="search-scope-label">
            {displayedContext?.fullFile ? t("Full file") : "Diff"}
          </span>
          <span aria-live="polite" aria-label={t("匹配行数")}>
            {Math.max(0, matches.indexOf(searchIndex ?? -1) + 1)}/
            {matches.length} {t(" 行")}
          </span>
          <Button
            className="icon-button"
            aria-label={t("上一个匹配行")}
            disabled={!matches.length}
            onClick={() => findMatch(-1)}
          >
            <CaretUp size={15} />
          </Button>
          <Button
            className="icon-button"
            aria-label={t("下一个匹配行")}
            disabled={!matches.length}
            onClick={() => findMatch(1)}
          >
            <CaretDown size={15} />
          </Button>
          <Button
            className="icon-button"
            aria-label={t("关闭文件内容搜索")}
            onClick={() => {
              setSearchOpen(false);
              setSearch("");
            }}
          >
            <X size={15} />
          </Button>
        </div>
      )}
      {diff.notice && (
        <div className="inline-notice">
          <Warning size={16} />
          <span>{uiMessage(diff.notice)}</span>
        </div>
      )}
      {raw ? (
        <div className="raw-patch">
          <Button
            className="button subtle"
            onClick={() => {
              void navigator.clipboard.writeText(diff.patch);
            }}
          >
            <Copy size={15} />
            {t("复制 patch")}
          </Button>
          <pre>{diff.patch}</pre>
        </div>
      ) : (
        <>
          {split && (
            <div className="split-labels">
              <span>
                {comparison?.base ??
                  (diff.side === "staged" ? "HEAD" : "Index")}{" "}
                {t("· 修改前")}
              </span>
              <span>
                {comparison?.target ??
                  (diff.side === "staged" ? "Index" : "Worktree")}{" "}
                {t("· 修改后")}
              </span>
            </div>
          )}
          <div
            ref={parent}
            className={`diff-scroll ${monaco ? "is-monaco" : ""} ${split ? "is-split" : ""} ${preferences.wrapLines ? "wrap-code" : ""}`}
            tabIndex={0}
            onScroll={rememberPosition}
            onWheel={() => cancelPositionRestore(true)}
            onPointerDown={() => cancelPositionRestore(true)}
            aria-label={t("只读代码，按 Alt 加上下方向键切换变化块")}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.defaultPrevented) return;
              if (
                [
                  "ArrowUp",
                  "ArrowDown",
                  "ArrowLeft",
                  "ArrowRight",
                  "PageUp",
                  "PageDown",
                  "Home",
                  "End",
                  " ",
                ].includes(e.key)
              )
                cancelPositionRestore(true);
              if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                goHunk(activeHunk + (e.key === "ArrowDown" ? 1 : -1));
              }
            }}
          >
            {monaco ? (
              <MonacoDiffSurface
                ref={editorSurface}
                rows={rows}
                syntax={syntax}
                sourceId={diff.id}
                contentKey={editorDocumentKey}
                layoutKey={readingLayout}
                path={diff.path}
                preferences={preferences}
                visible={paneVisible}
                search={search}
                searchRow={searchIndex}
                finding={findingRange}
                highlights={highlights}
                widgets={widgets}
                renderBlock={renderBlock}
                onReady={() => {
                  // Hold the saved source anchor until the parent restores this
                  // newly initialized model; initial layout events are not user scrolls.
                  if (anchor.current) restoringPosition.current = true;
                  setEditorReady((value) => value + 1);
                }}
                onScroll={rememberPosition}
                onUserScroll={() => cancelPositionRestore(true)}
                onFind={() => {
                  setSearchOpen(true);
                  requestAnimationFrame(() => {
                    searchInput.current?.focus();
                    searchInput.current?.select();
                  });
                }}
                onHunk={(direction) => goHunk(activeHunk + direction)}
                onError={() => setEditorFailure(diff.id)}
              />
            ) : (
              <>
                <div
                  style={{
                    height: virtualizer.getTotalSize(),
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {virtualItems.map((item) => {
                    const row = rows[item.index];
                    return (
                      <div
                        key={item.key}
                        data-index={item.index}
                        data-row-key={row.key}
                        ref={virtualizer.measureElement}
                        className={`virtual-row ${row.kind === "line" && (inFindingRange(row.left, findingRange) || inFindingRange(row.right, findingRange)) ? "is-finding-target" : ""} ${searchIndex === item.index && rowMatches(row, search) ? "is-search-result" : ""}`}
                        style={{ transform: `translateY(${item.start}px)` }}
                      >
                        {row.kind !== "line" ? (
                          renderBlock(row)
                        ) : split ? (
                          <div className="split-row">
                            <CodeCell
                              path={diff.path}
                              syntaxMap={syntax}
                              line={row.left}
                              side="old"
                              findingTarget={
                                findingRange?.side === "old" &&
                                inFindingRange(row.left, findingRange)
                              }
                              search={search}
                              ranges={
                                row.left ? highlights.get(row.left) : undefined
                              }
                              showWhitespace={preferences.showWhitespace}
                            />
                            <CodeCell
                              path={diff.path}
                              syntaxMap={syntax}
                              line={row.right ?? null}
                              side="new"
                              findingTarget={
                                findingRange?.side === "new" &&
                                inFindingRange(row.right, findingRange)
                              }
                              search={search}
                              ranges={
                                row.right
                                  ? highlights.get(row.right)
                                  : undefined
                              }
                              showWhitespace={preferences.showWhitespace}
                            />
                          </div>
                        ) : (
                          <CodeCell
                            findingTarget={inFindingRange(
                              row.left,
                              findingRange,
                            )}
                            path={diff.path}
                            syntaxMap={syntax}
                            line={row.left}
                            search={search}
                            ranges={
                              row.left ? highlights.get(row.left) : undefined
                            }
                            showWhitespace={preferences.showWhitespace}
                          />
                        )}
                        {ai &&
                          commentsByRow
                            .get(item.index)
                            ?.map(({ finding, index }) => (
                              <div
                                className={`inline-review-slot ${split ? `split-${finding.lineSide}` : ""}`}
                                key={`${ai.report!.id}:${index}`}
                                style={{ width: paneSize.width || "100%" }}
                              >
                                <InlineReview
                                  finding={finding}
                                  decision={
                                    ai.report!.decisions[index] ?? "pending"
                                  }
                                  disabled={
                                    pending ||
                                    !!ai.pending ||
                                    ai.decisionSaving ||
                                    ai.reportLoading
                                  }
                                  onDecision={(value) =>
                                    void ai.setDecision(index, value)
                                  }
                                />
                              </div>
                            ))}
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
                          binary: t("二进制文件发生变化"),
                          symlink: t("符号链接发生变化"),
                          submodule: t("子模块引用发生变化"),
                          metadata: t("文件属性发生变化"),
                          conflict: t("文件存在冲突"),
                        } as Record<string, string>
                      )[diff.kind] ?? t("文件变化")}
                    </h3>
                    <p>{t("查看原始 Patch，核对文件属性变化。")}</p>
                    <Button className="button" onClick={() => setRaw(true)}>
                      {t("查看原始 patch")}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
      <SplitScrollbars
        active={
          split &&
          !monaco &&
          !raw &&
          !preferences.wrapLines &&
          rows.some((row) => row.kind === "line")
        }
        parent={parent}
        layoutKey={`${diff.id}:${preferences.fontSize}:${preferences.showWhitespace}:${preferences.ignoreWhitespace && !searchOpen}:${displayedContext?.fullFile ? "file" : (displayedContext?.contextLines ?? 3)}`}
        rowKey={`${preferences.fontSize}:${virtualizer
          .getVirtualItems()
          .map((item) => item.key)
          .join("|")}`}
      />
      <footer className="diff-footer">
        <div className="hunk-navigation">
          <Button
            className="icon-button"
            title={t("上一个变化块")}
            aria-label={t("上一个变化块")}
            disabled={raw || !diff.hunks.length}
            onClick={() => goHunk(activeHunk - 1)}
          >
            <CaretUp size={15} />
          </Button>
          <Button
            className="icon-button"
            title={t("下一个变化块")}
            aria-label={t("下一个变化块")}
            disabled={raw || !diff.hunks.length}
            onClick={() => goHunk(activeHunk + 1)}
          >
            <CaretDown size={15} />
          </Button>
          <span>
            {diff.hunks.length} {t(" 个变化块")}
          </span>
        </div>
        <div className="toolbar-spacer" />
        <span>
          {reviewed}/{diff.hunks.length} {t(" 已审查")}
        </span>
        <Button
          className="button compact"
          disabled={
            pending || (hiddenLines > 0 && reviewed !== diff.hunks.length)
          }
          title={
            hiddenLines
              ? t("当前隐藏了空白变化，请恢复显示后再标记整个文件。")
              : undefined
          }
          onClick={() => onMark(null, reviewed !== diff.hunks.length)}
        >
          <Check size={15} />
          {reviewed === diff.hunks.length
            ? t("撤销文件标记")
            : t("标记整个文件")}
        </Button>
      </footer>
    </section>
  );
}

function CodeCell({
  findingTarget,
  path,
  syntaxMap,
  line,
  side,
  search,
  ranges,
  showWhitespace,
}: {
  findingTarget?: boolean;
  path: string;
  syntaxMap: {
    old: WeakMap<DiffLine, SyntaxSpan[]>;
    new: WeakMap<DiffLine, SyntaxSpan[]>;
  };
  line: DiffLine | null;
  side?: "old" | "new";
  search: string;
  ranges?: TextRange[];
  showWhitespace: boolean;
}) {
  if (!line) return <div className="code-cell empty-code" />;
  return (
    <div
      className={`code-cell line-${line.kind} ${findingTarget ? "finding-range" : ""}`}
      data-code-side={side}
    >
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
            path={path}
            syntax={syntaxMap[
              side ?? (line.kind === "delete" ? "old" : "new")
            ].get(line)}
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
