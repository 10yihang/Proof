import { useHotkeys } from "react-hotkeys-hook";
import { Button } from "./ui/controls";
import { t, uiMessage } from "../i18n";
import { DiffLoading } from "./DiffLoading";
import { publishDiffEvent } from "../diff-events";
import { useAi, type DiffJump } from "../ai";
import { AiReviewPanel } from "./AiReviewPanel";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowsLeftRight,
  ArrowRight,
  GitDiff,
  SidebarSimple,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import { asError, useReadRequest, useRequest } from "../api";
import { fileKey } from "../types";
import type {
  ChangedFile,
  Changes,
  FileDiff,
  DiffRead,
  DiffContext,
  DiffSummary,
  Preferences,
  ProofError,
} from "../types";
import { DiffFilePane } from "./DiffFilePane";
import { ResizableWorkbench } from "./ResizableWorkbench";
import type { useRepositoryLayout } from "../use-repository-layout";
import { DiffView, type DiffPosition } from "./DiffView";
import { DeferredDiff } from "./DeferredDiff";
import { DiffReadBudget, diffReadBytes } from "../diff-budget";
import { demoChanges, demoDiff, demoDiffContext } from "../demo";
import { hiddenWhitespace } from "../diff-reading";
export interface HistoryComparison {
  base?: string;
  target: string;
  baseLabel?: string;
  targetLabel?: string;
  parent?: number;
  parents?: string[];
  unavailable?: string;
  path?: string;
}
interface Comparison {
  baseOid: string;
  targetOid: string;
  files: ChangedFile[];
}
interface ComparisonReviewUpdate {
  workspaceId: string;
  base: string;
  target: string;
  path: string;
  demoMark?: { hunkId: string | null; reviewed: boolean };
}
export function HistoryDiff({
  changes,
  demo,
  preferences,
  onPreferences,
  selection,
  toolbar,
  active = true,
  onAgentSettings,
  panelLayout,
  onOpenWindow,
}: {
  changes: Changes;
  demo: boolean;
  preferences: Preferences;
  onPreferences: (p: Partial<Preferences>) => void;
  selection: HistoryComparison;
  toolbar?: ReactNode;
  active?: boolean;
  onAgentSettings?: () => void;
  panelLayout: ReturnType<typeof useRepositoryLayout>;
  onOpenWindow?: (selection: {
    base: string;
    target: string;
    path: string | null;
  }) => void;
}) {
  const fileReader = useReadRequest();
  const comparisonReader = useReadRequest();
  const contextReader = useReadRequest();
  const request = useRequest();
  const [marking, setMarking] = useState(false);
  const [, setReviewRevision] = useState(0);
  const searchId = useId();
  const [result, setResult] = useState<Comparison | null>(null),
    [diff, setDiff] = useState<FileDiff | null>(null);
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const ai = useAi(changes, diff, demo, result);
  const [aiOpen, setAiOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);
  const [focused, setFocused] = useState(false);
  const filesToggle = useRef<HTMLButtonElement>(null),
    aiToggle = useRef<HTMLButtonElement>(null);
  const filesId = `comparison-files-${searchId}`,
    contextId = `comparison-context-${searchId}`;
  const filesVisible = filesOpen && !focused,
    contextVisible = aiOpen && !focused;
  function closeFiles() {
    setFilesOpen(false);
    requestAnimationFrame(() => filesToggle.current?.focus());
  }
  function closeContext() {
    setAiOpen(false);
    requestAnimationFrame(() => aiToggle.current?.focus());
  }
  useHotkeys(
    "*",
    (event) => {
      if (
        !active ||
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector("[role='dialog'][data-open]")
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setFocused(false);
        setFilesOpen(true);
        ai.setView("files");
        requestAnimationFrame(() =>
          document.getElementById(`history-file-search-${searchId}`)?.focus(),
        );
      } else if (event.key === "Escape") setFocused(false);
    },
    {
      ignoreModifiers: true,
      enableOnFormTags: true,
      enableOnContentEditable: true,
    },
    [active, searchId],
  );
  const [aiJump, setAiJump] = useState<DiffJump | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const loadedLarge = useRef(new Set<string>());
  const reconcilingReview = useRef(false);
  const demoMarks = useRef(new Map<string, Record<string, boolean>>());
  const retryComparison = useRef(false);
  const [comparisonRevision, setComparisonRevision] = useState(0);
  const positions = useRef(new Map<string, { current: DiffPosition | null }>());
  function positionFor(key: string) {
    let position = positions.current.get(key);
    if (!position) {
      position = { current: null };
      positions.current.set(key, position);
    }
    if (positions.current.size > 64)
      positions.current.delete(positions.current.keys().next().value!);
    return position;
  }
  function showReading(read: DiffRead | null) {
    setDiff(read?.state === "ready" ? read.diff : null);
    setSummary(read?.state === "deferred" ? read.summary : null);
  }
  function cacheKey(file: Pick<ChangedFile, "path">, scope: Comparison) {
    return `${changes.workspace.id}:${scope.baseOid}:${scope.targetOid}:${file.path}`;
  }
  const [selected, setSelected] = useState<string | null>(null),
    [search, setSearch] = useState("");
  const live = useRef({ diff, result, selected });
  live.current = { diff, result, selected };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [loading, setLoading] = useState(false),
    [loadingFile, setLoadingFile] = useState(false),
    [error, setError] = useState<ProofError | null>(null),
    [reverseKey, setReverseKey] = useState<string | null>(null);
  const sequence = useRef(0),
    fileSequence = useRef(0),
    cache = useRef(new DiffReadBudget(8 * 1024 * 1024, 64));
  const selectionKey = `${selection.base ?? "parent"}:${selection.target}:${selection.parent ?? 0}`;
  const reversed = !!selection.base && reverseKey === selectionKey;
  useEffect(() => {
    const n = ++sequence.current;
    fileReader.cancel();
    comparisonReader.cancel();
    ++fileSequence.current;
    setResult(null);
    showReading(null);
    setSelected(null);
    setError(null);
    setLoadingFile(false);
    setSearch("");
    if (selection.unavailable) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const base = reversed ? selection.target : selection.base,
      target = reversed ? selection.base! : selection.target;
    const task = demo
      ? Promise.resolve({
          baseOid:
            base ?? selection.parents?.[selection.parent ?? 0] ?? "empty",
          targetOid: target,
          files:
            base === target
              ? []
              : demoChanges.files.filter((f) => f.side === "unstaged"),
        })
      : base
        ? comparisonReader.read<Comparison>("compare_refs", {
            workspaceId: changes.workspace.id,
            base,
            target,
          })
        : comparisonReader.read<Comparison>("compare_commit", {
            workspaceId: changes.workspace.id,
            oid: target,
            parent: selection.parent ?? 0,
          });
    task
      .then((value) => {
        if (n !== sequence.current) return;
        setResult(value);
        if (value.files[0]) {
          const initial =
            value.files.find((file) => file.path === selection.path) ??
            value.files[0];
          if (activeRef.current) void select(initial, value);
          else setSelected(fileKey(initial));
        }
      })
      .catch((e) => {
        if (n === sequence.current) setError(asError(e));
      })
      .finally(() => {
        if (n === sequence.current) setLoading(false);
      });
    return () => {
      fileReader.cancel();
      comparisonReader.cancel();
      ++sequence.current;
      ++fileSequence.current;
    };
  }, [
    changes.workspace.id,
    demo,
    selection.base,
    selection.target,
    selection.parent,
    selection.parents,
    selection.unavailable,
    selection.path,
    reversed,
    comparisonRevision,
  ]);
  useEffect(() => {
    if (!active) {
      ++fileSequence.current;
      fileReader.cancel();
      if (!result && loading) {
        ++sequence.current;
        comparisonReader.cancel();
        retryComparison.current = true;
        setLoading(false);
      }
      if (
        reconcilingReview.current ||
        (diff && diffReadBytes({ state: "ready", diff }) > 8 * 1024 * 1024)
      )
        showReading(null);
      reconcilingReview.current = false;
      setLoadingFile(false);
      return;
    }
    if (retryComparison.current) {
      retryComparison.current = false;
      setComparisonRevision((value) => value + 1);
      return;
    }
    if (diff || summary) return;
    const file =
      result?.files.find((file) => fileKey(file) === selected) ??
      result?.files[0];
    if (file && result)
      void select(
        file,
        result,
        loadedLarge.current.has(cacheKey(file, result)),
      );
  }, [active]);
  async function select(
    file: ChangedFile,
    scope: Comparison,
    loadLarge = false,
    preserveCurrent = false,
  ) {
    const n = ++fileSequence.current;
    fileReader.cancel();
    setSelected(fileKey(file));
    setError(null);
    const key = cacheKey(file, scope),
      cached = cache.current.get(key);
    const usable = cached && (!loadLarge || cached.state === "ready");
    reconcilingReview.current = preserveCurrent && !usable;
    if (!preserveCurrent || cached) showReading(cached ?? null);
    setLoadingFile(!usable);
    if (usable) return;
    if (loadLarge) {
      loadedLarge.current.add(key);
      if (loadedLarge.current.size > 64)
        loadedLarge.current.delete(loadedLarge.current.values().next().value!);
    }
    try {
      const demoDiffValue = demo ? demoDiff(file) : null;
      const value: DiffRead = demoDiffValue
        ? {
            state: "ready",
            diff: {
              ...demoDiffValue,
              hunks: demoDiffValue.hunks.map((hunk) => ({
                ...hunk,
                reviewState: demoMarks.current.get(key)?.[hunk.id]
                  ? "reviewed"
                  : "unreviewed",
              })),
            },
          }
        : await fileReader.read<DiffRead>("read_compare_file", {
            workspaceId: changes.workspace.id,
            base: scope.baseOid,
            target: scope.targetOid,
            path: file.path,
            loadLarge,
          });
      if (n !== fileSequence.current) return;
      cache.current.set(key, value);
      if (value.state === "deferred" && !value.summary.canLoad)
        loadedLarge.current.delete(key);
      showReading(value);
    } catch (e) {
      if (n === fileSequence.current) {
        if (!preserveCurrent) loadedLarge.current.delete(key);
        // A failed reconciliation must not keep displaying a superseded mark.
        showReading(null);
        setError(asError(e));
      }
    } finally {
      if (n === fileSequence.current) {
        reconcilingReview.current = false;
        setLoadingFile(false);
      }
    }
  }
  useEffect(() => {
    function acceptReview(event: Event) {
      const update = (event as CustomEvent<ComparisonReviewUpdate>).detail;
      const scope = live.current.result;
      if (!update || update.workspaceId !== changes.workspace.id) return;
      const key = `${update.workspaceId}:${update.base}:${update.target}:${update.path}`;
      if (demo && update.demoMark) {
        const marks = demoMarks.current.get(key) ?? {};
        const file = demoChanges.files.find(
          (file) => file.path === update.path,
        );
        if (file) {
          for (const hunk of demoDiff(file).hunks)
            if (!update.demoMark.hunkId || hunk.id === update.demoMark.hunkId)
              marks[hunk.id] = update.demoMark.reviewed;
          demoMarks.current.set(key, marks);
        }
      }
      // Mutation replies may arrive out of order. They invalidate cached marks;
      // only a sequenced read is allowed to install the authoritative state.
      cache.current.delete(key);
      setReviewRevision((value) => value + 1);
      if (
        !scope ||
        update.base !== scope.baseOid ||
        update.target !== scope.targetOid
      )
        return;
      const file = scope.files.find((file) => file.path === update.path);
      if (!file) return;
      if (live.current.selected !== fileKey(file)) return;
      if (activeRef.current) {
        void select(file, scope, loadedLarge.current.has(key), true);
      } else {
        ++fileSequence.current;
        fileReader.cancel();
        showReading(null);
        reconcilingReview.current = false;
        setLoadingFile(false);
      }
    }
    window.addEventListener("proof:comparison-reviewed", acceptReview);
    return () =>
      window.removeEventListener("proof:comparison-reviewed", acceptReview);
  }, [changes.workspace.id, demo, fileReader]);
  async function mark(hunkId: string | null, reviewed: boolean) {
    if (!diff || !result || marking) return;
    const target = diff,
      scope = result,
      generation = sequence.current;
    if (
      reviewed &&
      preferences.ignoreWhitespace &&
      target.hunks.some(
        (h) => (!hunkId || h.id === hunkId) && hiddenWhitespace(h).size,
      )
    ) {
      setError({
        code: "REVIEW_HIDDEN",
        message: t("关闭空白筛选后再标记。"),
        detail: "Hidden changes cannot receive new Review marks",
      });
      return;
    }
    setMarking(true);
    setError(null);
    try {
      if (!demo)
        await request<void>("mark_comparison_reviewed", {
          workspaceId: changes.workspace.id,
          base: scope.baseOid,
          target: scope.targetOid,
          path: target.path,
          snapshotId: target.id,
          hunkId,
          reviewed,
        });
      publishDiffEvent("proof:comparison-reviewed", {
        workspaceId: target.workspaceId,
        base: scope.baseOid,
        target: scope.targetOid,
        path: target.path,
        ...(demo ? { demoMark: { hunkId, reviewed } } : {}),
      } satisfies ComparisonReviewUpdate);
    } catch (error) {
      if (
        mounted.current &&
        generation === sequence.current &&
        live.current.diff?.id === target.id
      )
        setError(asError(error));
    } finally {
      if (mounted.current) setMarking(false);
    }
  }
  const scopePrefix = result ? cacheKey({ path: "" }, result) : null;
  const loadedFiles: Record<string, FileDiff> = Object.fromEntries(
    cache.current
      .values()
      .flatMap(([key, read]) =>
        scopePrefix && key.startsWith(scopePrefix) && read.state === "ready"
          ? [[fileKey(read.diff), read.diff]]
          : [],
      ),
  );
  if (diff) loadedFiles[fileKey(diff)] = diff;
  const short = (id: string) =>
    id === "empty" ? t("Empty tree") : id.slice(0, 8);
  const left = reversed ? selection.targetLabel : selection.baseLabel,
    right = reversed ? selection.baseLabel : selection.targetLabel;
  return (
    <section className="history-diff" aria-label={t("历史文件差异")}>
      <div className="compare-capture">
        <span className="history-endpoint" title={result?.baseOid}>
          <code>{result ? short(result.baseOid) : "…"}</code>
          {left && <span>{left}</span>}
        </span>
        <ArrowRight size={13} />
        <span className="history-endpoint" title={result?.targetOid}>
          <code>
            {result ? short(result.targetOid) : short(selection.target)}
          </code>
          {right && <span>{right}</span>}
        </span>
        {selection.base && (
          <Button
            className="icon-button"
            aria-label={t("交换比较方向")}
            title={t("交换比较方向")}
            onClick={() => setReverseKey(reversed ? null : selectionKey)}
          >
            <ArrowsLeftRight size={14} />
          </Button>
        )}
        <span className="toolbar-spacer" />
        <Button
          ref={filesToggle}
          className="icon-button"
          aria-label={filesVisible ? t("隐藏文件栏") : t("显示文件栏")}
          title={t("Files")}
          aria-controls={filesId}
          aria-expanded={filesVisible}
          onClick={() => {
            setFocused(false);
            setFilesOpen(!filesVisible);
          }}
        >
          <SidebarSimple size={17} />
        </Button>
        {onOpenWindow && (
          <Button
            className="button compact diff-open-window"
            aria-label={t("在独立窗口打开 Diff")}
            title={t("Open in Separate Window")}
            disabled={!result}
            onClick={() => {
              if (result)
                onOpenWindow({
                  base: result.baseOid,
                  target: result.targetOid,
                  path:
                    result.files.find((file) => fileKey(file) === selected)
                      ?.path ?? null,
                });
            }}
          >
            <ArrowSquareOut size={15} />
            {t("Open in Window")}
          </Button>
        )}
        <span>
          {loading
            ? t("读取中…")
            : result
              ? `${result.files.length} files changed`
              : ""}
        </span>
        <Button
          className="button subtle"
          ref={aiToggle}
          aria-controls={contextId}
          aria-expanded={contextVisible}
          onClick={() => {
            setFocused(false);
            setAiOpen(!contextVisible);
          }}
        >
          {t("AI Review")}
        </Button>
        {toolbar && <div className="comparison-actions">{toolbar}</div>}
      </div>
      {error && (
        <div className="inline-notice" role="alert">
          {uiMessage(error.message)} · {error.code}
          {(result || error.code === "READ_CANCELLED") && (
            <Button
              className="text-button"
              onClick={() => {
                const file = result?.files.find(
                  (file) => fileKey(file) === selected,
                );
                if (file && result)
                  void select(
                    file,
                    result,
                    loadedLarge.current.has(cacheKey(file, result)),
                  );
                else if (!result) setComparisonRevision((value) => value + 1);
              }}
            >
              {t("重新读取")}
            </Button>
          )}
        </div>
      )}

      <div
        className={`compare-content ${contextVisible ? "with-ai-review" : ""}`}
      >
        <ResizableWorkbench
          layout={panelLayout.value}
          scopeKey={`${panelLayout.scopeKey}:${selectionKey}`}
          enabled={panelLayout.ready}
          active={active}
          sidebarId={filesId}
          contextId={contextId}
          sidebarVisible={filesVisible}
          contextDocked={contextVisible}
          onChange={(partial) => {
            void panelLayout.update(partial);
          }}
          onCollapse={(side) =>
            side === "sidebarWidth" ? closeFiles() : closeContext()
          }
          sidebar={
            <DiffFilePane
              ai={ai}
              token={ai.sourceToken}
              scopeKey={`${changes.workspace.id}:${ai.sourceToken}`}
              containerProps={{
                id: filesId,
                "aria-label": t("变化文件"),
                className: "compare-files",
                hidden: !filesVisible,
              }}
              onClose={closeFiles}
              closeDisabled={!panelLayout.ready}
              readOnly
              files={result?.files ?? []}
              selected={selected}
              onSelect={(file) => result && void select(file, result)}
              search={search}
              onSearch={setSearch}
              searchId={`history-file-search-${searchId}`}
              loaded={loadedFiles}
              scope="all"
              onScope={() => {}}
              disabled
              onStage={() => {}}
            />
          }
          context={
            contextVisible && (
              <aside
                id={contextId}
                className="comparison-ai"
                aria-label={t("AI Review")}
              >
                <header>
                  <strong>{t("AI Review")}</strong>
                  <Button
                    className="text-button"
                    aria-label={t("收起上下文")}
                    onClick={closeContext}
                  >
                    {t("Close")}
                  </Button>
                </header>
                <AiReviewPanel
                  onSettings={onAgentSettings}
                  ai={ai}
                  hasDiff={!!diff && !!result}
                  demo={demo}
                  onFinding={(finding) => {
                    const captured = ai.report?.files.find(
                      (file) =>
                        file.path === finding.file &&
                        file.side === finding.side,
                    );
                    const file = result?.files.find(
                      (file) => file.path === finding.file,
                    );
                    if (!captured || !file || !result || ai.stale) return;
                    setAiJump({
                      id: crypto.randomUUID(),
                      comparisonId: captured.snapshotId,
                      snapshotToken: captured.snapshotToken,
                      path: captured.path,
                      fileSide: captured.side,
                      line: finding.line,
                      endLine: finding.endLine,
                      side: finding.lineSide,
                    });
                    void select(file, result);
                  }}
                />
              </aside>
            )
          }
        >
          <div className="center-panel">
            {(loading || loadingFile) && (
              <DiffLoading
                path={
                  result?.files.find((file) => fileKey(file) === selected)?.path
                }
                updating={!!diff || !!summary}
                onCancel={() => {
                  ++fileSequence.current;
                  fileReader.cancel();
                  if (loading) {
                    ++sequence.current;
                    comparisonReader.cancel();
                    setLoading(false);
                  }
                  setLoadingFile(false);
                  if (loadingFile) showReading(null);
                  const file = result?.files.find(
                    (file) => fileKey(file) === selected,
                  );
                  if (file && result)
                    loadedLarge.current.delete(cacheKey(file, result));
                  setError({
                    code: "READ_CANCELLED",
                    message: t("读取已取消。"),
                    detail: "Cancelled by user",
                  });
                }}
              />
            )}
            {summary && result ? (
              <DeferredDiff
                summary={summary}
                pending={loadingFile || marking}
                comparison={{
                  base: short(result.baseOid),
                  target: short(result.targetOid),
                }}
                onLoad={() => {
                  const file = result.files.find(
                    (file) => fileKey(file) === selected,
                  );
                  if (file) void select(file, result, true);
                }}
              />
            ) : diff && result ? (
              <DiffView
                jumpTo={aiJump}
                ai={ai}
                key={diff.id}
                positionRef={positionFor(
                  `${result.baseOid}:${result.targetOid}:${diff.path}`,
                )}
                diff={diff}
                preferences={preferences}
                pending={loadingFile || marking}
                onPreferences={onPreferences}
                onMark={(hunkId, reviewed) => void mark(hunkId, reviewed)}
                onStage={() => {}}
                onDiscard={() => {}}
                onFocus={() => setFocused((value) => !value)}
                focused={focused}
                onEditor={() => {}}
                openingEditor={false}
                onLoadContext={async (contextLines) =>
                  demo
                    ? demoDiffContext(diff, contextLines)
                    : contextReader.read<DiffContext>("compare_context", {
                        workspaceId: changes.workspace.id,
                        base: result.baseOid,
                        target: result.targetOid,
                        path: diff.path,
                        snapshotId: diff.id,
                        ...(contextLines === "file"
                          ? { fullFile: true }
                          : { contextLines }),
                      })
                }
                onCancelContext={contextReader.cancel}
                comparison={{
                  base: short(result.baseOid),
                  target: short(result.targetOid),
                }}
              />
            ) : (
              <div className="compare-empty" hidden={loading || loadingFile}>
                <GitDiff size={30} />
                <h3>
                  {selection.unavailable ??
                    (loading || loadingFile
                      ? t("正在读取 Diff…")
                      : error
                        ? t("无法读取 Diff")
                        : result?.files.length
                          ? t("选择文件查看 Diff")
                          : t("没有文件差异"))}
                </h3>
              </div>
            )}
          </div>
        </ResizableWorkbench>
      </div>
    </section>
  );
}
