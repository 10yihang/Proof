import { GitContextMenu } from "./HistoryActions";
import { DropdownMenuItem } from "./ui/dropdown-menu";
import { toast } from "./ui/toast";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
  useId,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import type * as M from "monaco-editor";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  gitEditorDocument,
  rowAtOffset,
  sourceLineLabel,
  type GitEditorDocument,
  type EditorSide,
} from "../monaco-document";
import {
  rowAnchor,
  type ReadingRow,
  type ReadingAnchor,
  type TextRange,
} from "../diff-reading";
import { inFindingRange } from "../review-annotations";
import type { DiffJump } from "../ai";
import type { DiffLine, Preferences } from "../types";
import type { GitSyntax } from "../monaco-document";
import { t } from "../i18n";

type Runtime = typeof import("../monaco-runtime");
export interface EditorBookmark {
  position: ReadingAnchor;
  row: number;
  offset: number;
  left: number;
  horizontal: Partial<Record<EditorSide, number>>;
  top: number;
  sourceId: string;
  contentKey: string;
  layout: string;
}
export interface DiffSurfaceHandle {
  bookmark: () => EditorBookmark | null;
  scrollToRow: (
    row: number,
    align?: "start" | "center",
    offset?: number,
  ) => void;
  scrollToOffset: (top: number) => void;
  setScrollLeft: (left: number | Partial<Record<EditorSide, number>>) => void;
  rowTop: (row: number) => number;
  rowHeight: (row: number) => number;
  focus: () => void;
}
export interface ReviewWidget {
  side: "old" | "new";
  key: string;
  content: ReactNode;
}
interface Props {
  ref?: Ref<DiffSurfaceHandle>;
  rows: ReadingRow[];
  syntax: GitSyntax;
  sourceId: string;
  contentKey: string;
  layoutKey: string;
  path: string;
  preferences: Preferences;
  visible: boolean;
  search: string;
  searchRow: number | null;
  finding: DiffJump | null;
  highlights: Map<DiffLine, TextRange[]>;
  widgets: Map<number, ReviewWidget[]>;
  renderBlock: (row: ReadingRow, side: EditorSide) => ReactNode;
  onReady: () => void;
  onScroll: () => void;
  onUserScroll: () => void;
  onFind: () => void;
  onHunk: (direction: number) => void;
  onError: (error: unknown) => void;
}
interface Pane {
  side: EditorSide;
  doc: GitEditorDocument;
  editor: M.editor.IStandaloneCodeEditor;
  model: M.editor.ITextModel;
  zones: Map<string, M.editor.IViewZone & { id: string }>;
  decorations: M.editor.IEditorDecorationsCollection;
  disposables: M.IDisposable[];
}
interface PortalTarget {
  id: string;
  row: number;
  side: EditorSide;
  kind: "block" | "review";
  node: HTMLElement;
  contentKey: string;
}
const eps = 0.75;

export default function MonacoDiffSurface(props: Props) {
  const instance = useId().replace(/[^a-zA-Z0-9]/g, "");
  const container = useRef<HTMLDivElement>(null);
  const hosts = useRef<(HTMLDivElement | null)[]>([]);
  const runtime = useRef<Runtime | null>(null);
  const panes = useRef<Pane[]>([]);
  const ready = useRef(false);
  const modelKey = useRef<string | null>(null);
  const applied = useRef<{
    rows: ReadingRow[];
    sourceId: string;
    contentKey: string;
    layout: string;
  } | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const starts = useRef<number[]>([]),
    heights = useRef<number[]>([]);
  const comments = useRef(new Map<string, number>());
  const lastSizes = useRef<string>("");
  const syncing = useRef(false),
    aligning = useRef(false),
    scheduled = useRef(0);
  const [targets, setTargets] = useState<PortalTarget[]>([]);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 40 });
  const [loading, setLoading] = useState(true);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    side: EditorSide;
    contentKey: string;
  } | null>(null);
  const menuPane =
    menu && menu.contentKey === props.contentKey
      ? panes.current.find((pane) => pane.side === menu.side)
      : null;
  const selection = menuPane?.editor.getSelection();
  const selectedText = selection
    ? (menuPane?.model.getValueInRange(selection) ?? "")
    : "";
  function copy(text: string) {
    void navigator.clipboard
      .writeText(text)
      .catch(() => toast.add({ title: t("复制失败"), type: "error" }));
  }
  const split = props.preferences.diffMode === "split";
  const docs = useMemo(
    () =>
      split
        ? [
            gitEditorDocument(props.rows, "old", props.syntax),
            gitEditorDocument(props.rows, "new", props.syntax),
          ]
        : [gitEditorDocument(props.rows, "unified", props.syntax)],
    [props.contentKey, split],
  );
  const sequence = useRef(0),
    modelSequence = useRef(0);

  function bookmark(): EditorBookmark | null {
    const current = applied.current,
      pane = panes.current[split ? 1 : 0] ?? panes.current[0];
    if (
      !current ||
      !ready.current ||
      current.contentKey !== latest.current.contentKey ||
      !pane ||
      !container.current?.clientHeight ||
      !starts.current.length
    )
      return null;
    const top = pane.editor.getScrollTop(),
      row = rowAtOffset(starts.current, top);
    if (!current.rows[row]) return null;
    return {
      position: rowAnchor(current.rows[row]),
      row,
      offset: top - starts.current[row],
      left: pane.editor.getScrollLeft(),
      horizontal: Object.fromEntries(
        panes.current.map((p) => [p.side, p.editor.getScrollLeft()]),
      ),
      top,
      sourceId: current.sourceId,
      contentKey: current.contentKey,
      layout: current.layout,
    };
  }
  function scrollToOffset(top: number, notify = true) {
    syncing.current = true;
    for (const pane of panes.current)
      pane.editor.setScrollTop(Math.max(0, top));
    syncing.current = false;
    updateVisible();
    if (notify) latest.current.onScroll();
  }
  function updateVisible() {
    const pane = panes.current[0];
    if (!pane) return;
    const top = pane.editor.getScrollTop(),
      height = container.current?.clientHeight ?? 0;
    const start = Math.max(0, rowAtOffset(starts.current, top) - 12),
      end = Math.min(
        latest.current.rows.length,
        rowAtOffset(starts.current, top + height) + 14,
      );
    setVisibleRange((previous) =>
      previous.start === start && previous.end === end
        ? previous
        : { start, end },
    );
  }
  useImperativeHandle(props.ref, () => ({
    bookmark,
    scrollToOffset,
    scrollToRow(row, align = "start", offset = 0) {
      const top = starts.current[row];
      if (top === undefined) return;
      scrollToOffset(
        top +
          offset -
          (align === "center"
            ? Math.max(
                0,
                ((container.current?.clientHeight ?? 0) -
                  (heights.current[row] ?? 0)) /
                  2,
              )
            : 0),
      );
    },
    setScrollLeft(left) {
      syncing.current = true;
      for (const pane of panes.current)
        pane.editor.setScrollLeft(
          typeof left === "number" ? left : (left[pane.side] ?? 0),
        );
      syncing.current = false;
    },
    rowTop(row) {
      return starts.current[row] ?? 0;
    },
    rowHeight(row) {
      return heights.current[row] ?? 0;
    },
    focus() {
      (panes.current[split ? 1 : 0] ?? panes.current[0])?.editor.focus();
    },
  }));

  function scheduleAlign() {
    if (scheduled.current) return;
    scheduled.current = requestAnimationFrame(() => {
      scheduled.current = 0;
      align();
    });
  }
  function align() {
    if (
      modelKey.current !== latest.current.contentKey ||
      aligning.current ||
      !panes.current.length ||
      !container.current?.clientHeight
    )
      return;
    const state = latest.current,
      rs = state.rows,
      lineHeight = state.preferences.fontSize + 13;
    const saved = bookmark();
    const lineHeights = panes.current.map((pane) =>
      rs.map((row, index) => {
        const line = pane.doc.rowLines.get(index);
        return row.kind === "line" && line !== undefined
          ? Math.max(
              lineHeight,
              pane.editor.getBottomForLineNumber(line) -
                pane.editor.getTopForLineNumber(line),
            )
          : 0;
      }),
    );
    const base = rs.map((row, index) =>
      row.kind === "header"
        ? 48
        : row.kind === "hidden"
          ? 36
          : row.left?.kind === "note"
            ? lineHeight
            : Math.max(
                lineHeight,
                ...lineHeights.map((values) => values[index]),
              ),
    );
    const next = base.map(
      (height, index) =>
        height +
        (state.widgets.has(index)
          ? Math.max(
              ...panes.current.map(
                (pane) =>
                  comments.current.get(`${pane.side}:${index}`) ??
                  (state.widgets
                    .get(index)
                    ?.some(
                      (widget) =>
                        pane.side === "unified" || widget.side === pane.side,
                    )
                    ? 160
                    : 0),
              ),
            )
          : 0),
    );
    const sizes = panes.current
      .map((pane) => pane.editor.getLayoutInfo().width)
      .join(":");
    if (
      lastSizes.current === sizes &&
      heights.current.length === next.length &&
      next.every(
        (height, index) => Math.abs(height - heights.current[index]) < eps,
      )
    )
      return;
    aligning.current = true;
    lastSizes.current = sizes;
    let cursor = 0;
    starts.current = next.map((height) => {
      const top = cursor;
      cursor += height;
      return top;
    });
    heights.current = next;
    const nextTargets: PortalTarget[] = [];
    panes.current.forEach((pane, sideIndex) => {
      pane.editor
        .getDomNode()
        ?.style.setProperty(
          "--editor-width",
          `${pane.editor.getLayoutInfo().contentWidth}px`,
        );
      pane.editor.changeViewZones((accessor) => {
        const retained = new Set<string>();
        function add(
          row: number,
          after: number,
          height: number,
          kind?: "block" | "review",
          ordinal = 0,
        ) {
          if (height <= 0) return;
          const key = `${row}:${kind ?? "space"}:${ordinal}`;
          retained.add(key);
          let zone = pane.zones.get(key);
          if (!zone) {
            const node = document.createElement("div");
            node.className = kind
              ? `proof-git-zone proof-${kind}-zone`
              : "proof-alignment-zone";
            node.dataset.sourceRow = String(row);
            zone = {
              id: "",
              afterLineNumber: after,
              heightInPx: height,
              ordinal: row * 4 + ordinal,
              domNode: node,
              suppressMouseDown: false,
            };
            zone.id = accessor.addZone(zone);
            pane.zones.set(key, zone);
          } else if (
            zone.heightInPx !== height ||
            zone.afterLineNumber !== after
          ) {
            zone.heightInPx = height;
            zone.afterLineNumber = after;
            accessor.layoutZone(zone.id);
          }
          if (kind)
            nextTargets.push({
              id: `${pane.side}:${row}:${kind}`,
              row,
              side: pane.side,
              kind,
              node: zone.domNode,
              contentKey: state.contentKey,
            });
        }
        rs.forEach((row, index) => {
          const line = pane.doc.rowLines.get(index),
            before = pane.doc.afterLines[index] ?? pane.doc.lines.length;
          if (row.kind !== "line" || row.left?.kind === "note")
            add(index, before, base[index], "block");
          else
            add(
              index,
              line ?? before,
              base[index] - lineHeights[sideIndex][index],
              undefined,
              1,
            );
          if (state.widgets.has(index))
            add(index, line ?? before, next[index] - base[index], "review", 2);
        });
        // An empty Monaco model still has one invisible line. Balance it with
        // a zone in the other pane; never add invented lines to copied text.
        if (
          pane.doc.lines.length &&
          panes.current.some((p) => !p.doc.lines.length)
        )
          add(rs.length, pane.doc.lines.length, lineHeight);
        for (const [key, zone] of pane.zones)
          if (!retained.has(key)) {
            accessor.removeZone(zone.id);
            pane.zones.delete(key);
          }
      });
    });
    applied.current = {
      rows: state.rows,
      sourceId: state.sourceId,
      contentKey: state.contentKey,
      layout: state.layoutKey,
    };
    setTargets(nextTargets);
    aligning.current = false;
    if (
      saved &&
      saved.sourceId === state.sourceId &&
      starts.current[saved.row] !== undefined
    )
      scrollToOffset(
        starts.current[saved.row] +
          Math.min(saved.offset, (heights.current[saved.row] ?? 1) - 1),
        false,
      );
    else updateVisible();
  }
  function decorate() {
    const state = latest.current,
      api = runtime.current?.monaco;
    if (!api) return;
    for (const pane of panes.current) {
      const decorations: M.editor.IModelDeltaDecoration[] = [];
      pane.doc.lines.forEach(({ row, source }, index) => {
        const line = index + 1,
          end = Math.max(1, pane.model.getLineMaxColumn(line));
        const targeted =
            (pane.side === "unified" || pane.side === state.finding?.side) &&
            inFindingRange(source, state.finding),
          selected = state.searchRow === row;
        decorations.push({
          range: new api.Range(line, 1, line, end),
          options: {
            isWholeLine: true,
            className: [
              source.kind === "add"
                ? "proof-added-line"
                : source.kind === "delete"
                  ? "proof-deleted-line"
                  : "",
              targeted ? "is-finding-target" : "",
              selected ? "is-search-result" : "",
            ]
              .filter(Boolean)
              .join(" "),
            glyphMarginClassName:
              source.kind === "add"
                ? "proof-added-glyph"
                : source.kind === "delete"
                  ? "proof-deleted-glyph"
                  : undefined,
          },
        });
        for (const range of state.highlights.get(source) ?? [])
          decorations.push({
            range: new api.Range(
              line,
              range.start + 1,
              line,
              Math.min(end, range.end + 1),
            ),
            options: {
              inlineClassName:
                source.kind === "delete"
                  ? "proof-inline-deletion"
                  : "proof-inline-addition",
            },
          });
        if (state.search) {
          const query = state.search.toLowerCase(),
            text = source.content.toLowerCase();
          let at = text.indexOf(query),
            count = 0;
          while (at >= 0 && count++ < 100) {
            decorations.push({
              range: new api.Range(
                line,
                at + 1,
                line,
                Math.min(end, at + query.length + 1),
              ),
              options: { inlineClassName: "proof-search-match" },
            });
            at = text.indexOf(query, at + Math.max(1, query.length));
          }
        }
        if (state.preferences.showWhitespace && source.content.endsWith("\r"))
          decorations.push({
            range: new api.Range(line, end, line, end),
            options: {
              after: { content: " ␍", inlineClassName: "proof-eol-note" },
            },
          });
      });
      pane.decorations.set(decorations);
    }
  }

  useEffect(() => {
    if (!props.visible) return;
    const generation = ++sequence.current;
    ready.current = false;
    setLoading(true);
    let observer: ResizeObserver | undefined,
      themeObserver: MutationObserver | undefined;
    void import("../monaco-runtime")
      .then((module) => {
        if (generation !== sequence.current || !latest.current.visible) return;
        runtime.current = module;
        const api = module.monaco;
        api.editor.setTheme(
          document.documentElement.dataset.theme === "dark"
            ? "proof-dark"
            : "proof-light",
        );
        panes.current = [];
        applied.current = null;
        starts.current = [];
        modelKey.current = props.contentKey;
        docs.forEach((doc, index) => {
          const host = hosts.current[index];
          if (!host) throw new Error("Missing editor surface");
          ++modelSequence.current;
          const tokens = module.registerGitTokens(doc, props.path);
          const language = tokens.id;
          let model: M.editor.ITextModel;
          try {
            model = api.editor.createModel(
              doc.text,
              language,
              api.Uri.from({
                scheme: "proof",
                path: `/${instance}/${modelSequence.current}/${doc.side}/${props.path}`,
              }),
            );
          } catch (error) {
            tokens.dispose();
            throw error;
          }
          if (model.getLineCount() !== Math.max(1, doc.lines.length)) {
            model.dispose();
            tokens.dispose();
            throw new Error(
              "Git line mapping cannot be represented by this editor",
            );
          }
          let editor: M.editor.IStandaloneCodeEditor;
          try {
            editor = api.editor.create(host, {
              model,
              readOnly: true,
              domReadOnly: true,
              automaticLayout: false,
              contextmenu: false,
              minimap: { enabled: false },
              glyphMargin: true,
              folding: false,
              links: false,
              occurrencesHighlight: "off",
              codeLens: false,
              wordBasedSuggestions: "off",
              quickSuggestions: {
                other: "off",
                comments: "off",
                strings: "off",
              },
              parameterHints: { enabled: false },
              hover: { enabled: "off" },
              renderLineHighlight: "none",
              scrollBeyondLastLine: false,
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              lineNumbers: (n) => sourceLineLabel(doc, n),
              lineNumbersMinChars:
                doc.side === "unified" ? doc.digits * 2 + 2 : doc.digits + 1,
              fontSize: props.preferences.fontSize,
              lineHeight: props.preferences.fontSize + 13,
              fontFamily: "SFMono-Regular, Menlo, Consolas, monospace",
              fontLigatures: false,
              wordWrap: props.preferences.wrapLines ? "on" : "off",
              renderWhitespace: props.preferences.showWhitespace
                ? "all"
                : "none",
              stickyScroll: { enabled: false },
              guides: { indentation: false },
              padding: { top: 0, bottom: 0 },
              scrollbar: {
                vertical: "visible",
                horizontal: "visible",
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
                useShadows: false,
                alwaysConsumeMouseWheel: false,
              },
              ariaLabel: t(
                doc.side === "old"
                  ? "修改前代码，只读"
                  : doc.side === "new"
                    ? "修改后代码，只读"
                    : "Git Diff，只读",
              ),
            });
          } catch (error) {
            model.dispose();
            tokens.dispose();
            throw error;
          }
          // Monaco hides generic view zones from accessibility by default. These
          // zones contain real Hunk actions and Review comments.
          host.querySelector(".view-zones")?.removeAttribute("aria-hidden");
          const pane: Pane = {
            side: doc.side,
            doc,
            editor,
            model,
            zones: new Map(),
            decorations: editor.createDecorationsCollection(),
            disposables: [tokens],
          };
          pane.disposables.push(
            editor.onDidScrollChange((event) => {
              if (event.scrollLeftChanged)
                host.style.setProperty(
                  "--editor-left",
                  `${event.scrollLeft}px`,
                );
              if (
                !syncing.current &&
                !aligning.current &&
                (event.scrollTopChanged || event.scrollLeftChanged)
              ) {
                syncing.current = true;
                if (event.scrollTopChanged)
                  for (const other of panes.current)
                    if (other !== pane)
                      other.editor.setScrollTop(event.scrollTop);
                syncing.current = false;
                updateVisible();
                latest.current.onScroll();
              }
            }),
            editor.onDidContentSizeChange(() => {
              if (!aligning.current) scheduleAlign();
            }),
            editor.onDidLayoutChange(() => {
              if (!aligning.current) scheduleAlign();
            }),
            editor.onMouseDown(() => latest.current.onUserScroll()),
            editor.onKeyDown(() => latest.current.onUserScroll()),
          );
          for (const [name, key, direction] of [
            ["next", api.KeyCode.DownArrow, 1],
            ["previous", api.KeyCode.UpArrow, -1],
          ] as const)
            pane.disposables.push(
              editor.addAction({
                id: `proof.hunk.${name}`,
                label: name,
                keybindings: [api.KeyMod.Alt | key],
                run: () => latest.current.onHunk(direction),
              }),
            );
          pane.disposables.push(
            editor.addAction({
              id: "proof.code-menu",
              label: t("代码操作"),
              keybindings: [api.KeyMod.Shift | api.KeyCode.F10],
              run: () => {
                const at = editor.getPosition(),
                  rect = host.getBoundingClientRect(),
                  point = at && editor.getScrolledVisiblePosition(at);
                setMenu({
                  x: rect.x + (point?.left ?? 20),
                  y: rect.y + (point?.top ?? 20) + 20,
                  side: doc.side,
                  contentKey: latest.current.contentKey,
                });
              },
            }),
          );
          pane.disposables.push(
            editor.addAction({
              id: "proof.find",
              label: t("搜索当前 Diff"),
              keybindings: [api.KeyMod.CtrlCmd | api.KeyCode.KeyF],
              run: () => latest.current.onFind(),
            }),
          );
          panes.current.push(pane);
        });
        const layout = () => {
          for (const pane of panes.current) pane.editor.layout();
          scheduleAlign();
        };
        observer = new ResizeObserver(layout);
        if (container.current) observer.observe(container.current);
        for (const host of hosts.current) if (host) observer.observe(host);
        themeObserver = new MutationObserver(() =>
          api.editor.setTheme(
            document.documentElement.dataset.theme === "dark"
              ? "proof-dark"
              : "proof-light",
          ),
        );
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        applied.current = {
          rows: props.rows,
          sourceId: props.sourceId,
          contentKey: props.contentKey,
          layout: props.layoutKey,
        };
        lastSizes.current = "";
        heights.current = [];
        comments.current.clear();
        layout();
        decorate();
        align();
        ready.current = true;
        setLoading(false);
        latest.current.onReady();
      })
      .catch((error) => {
        if (generation === sequence.current) latest.current.onError(error);
      });
    return () => {
      ++sequence.current;
      ready.current = false;
      modelKey.current = null;
      observer?.disconnect();
      themeObserver?.disconnect();
      cancelAnimationFrame(scheduled.current);
      scheduled.current = 0;
      for (const pane of panes.current) {
        for (const dispose of pane.disposables) dispose.dispose();
        pane.editor.dispose();
        pane.model.dispose();
      }
      panes.current = [];
      applied.current = null;
      setTargets([]);
    };
  }, [props.contentKey, props.visible, split]);
  useLayoutEffect(() => {
    for (const pane of panes.current)
      pane.editor.updateOptions({
        fontSize: props.preferences.fontSize,
        lineHeight: props.preferences.fontSize + 13,
        wordWrap: props.preferences.wrapLines ? "on" : "off",
        renderWhitespace: props.preferences.showWhitespace ? "all" : "none",
      });

    lastSizes.current = "";
    scheduleAlign();
    decorate();
  }, [
    props.preferences.fontSize,
    props.preferences.wrapLines,
    props.preferences.showWhitespace,
    props.layoutKey,
  ]);
  useEffect(decorate, [
    props.search,
    props.searchRow,
    props.finding,
    props.highlights,
  ]);
  useEffect(() => {
    lastSizes.current = "";
    scheduleAlign();
  }, [props.widgets]);

  return (
    <div
      ref={container}
      className="proof-monaco-surface absolute inset-0"
      data-diff-id={props.sourceId}
      onWheel={props.onUserScroll}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest(".proof-git-zone")) return;
        const side = target
          .closest("[data-code-side]")
          ?.getAttribute("data-code-side") as EditorSide | null;
        if (side) {
          event.preventDefault();
          setMenu({
            x: event.clientX,
            y: event.clientY,
            side,
            contentKey: props.contentKey,
          });
        }
      }}
    >
      {menu && menuPane && props.visible && (
        <GitContextMenu
          x={menu.x}
          y={menu.y}
          label={t("代码操作")}
          onClose={() => setMenu(null)}
        >
          <DropdownMenuItem
            disabled={!selectedText}
            onClick={() => {
              copy(selectedText);
              setMenu(null);
            }}
          >
            {t("复制选中代码")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              copy(props.path);
              setMenu(null);
            }}
          >
            {t("复制文件路径")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              menuPane.editor.setSelection(menuPane.model.getFullModelRange());
              menuPane.editor.focus();
              setMenu(null);
            }}
          >
            {t("全选已加载代码")}
          </DropdownMenuItem>
        </GitContextMenu>
      )}
      {split ? (
        <Group
          orientation="horizontal"
          className="h-full min-h-0"
          resizeTargetMinimumSize={{ fine: 8, coarse: 16 }}
        >
          <Panel id={`${instance}-before`} minSize={120}>
            <div
              data-code-side={split ? "old" : "unified"}
              className="proof-code-editor h-full"
              ref={(node) => {
                hosts.current[0] = node;
              }}
            />
          </Panel>
          <Separator
            className="proof-diff-separator w-1 bg-border hover:bg-primary"
            aria-label={t("调整 Diff 两侧宽度")}
          />
          <Panel id={`${instance}-after`} minSize={120}>
            <div
              data-code-side="new"
              className="proof-code-editor h-full"
              ref={(node) => {
                hosts.current[1] = node;
              }}
            />
          </Panel>
        </Group>
      ) : (
        <div
          data-code-side={split ? "old" : "unified"}
          className="proof-code-editor h-full"
          ref={(node) => {
            hosts.current[0] = node;
          }}
        />
      )}
      {loading && (
        <div
          className="absolute inset-0 z-10 grid place-content-center bg-background text-[12px] text-muted-foreground"
          role="status"
        >
          {t("正在打开代码视图…")}
        </div>
      )}
      {targets
        .filter(
          (target) =>
            target.contentKey === props.contentKey &&
            target.row < props.rows.length &&
            target.row >= visibleRange.start &&
            target.row <= visibleRange.end,
        )
        .map((target) =>
          createPortal(
            target.kind === "block" ? (
              props.renderBlock(props.rows[target.row], target.side)
            ) : (
              <MeasuredReview
                onHeight={(height) => {
                  if (
                    Math.abs(
                      (comments.current.get(`${target.side}:${target.row}`) ??
                        160) - height,
                    ) > eps
                  ) {
                    comments.current.set(
                      `${target.side}:${target.row}`,
                      height,
                    );
                    lastSizes.current = "";
                    scheduleAlign();
                  }
                }}
              >
                {props.widgets
                  .get(target.row)
                  ?.filter(
                    (widget) =>
                      target.side === "unified" || widget.side === target.side,
                  )
                  .map((widget) => (
                    <div key={widget.key}>{widget.content}</div>
                  ))}
              </MeasuredReview>
            ),
            target.node,
            target.id,
          ),
        )}
    </div>
  );
}
function MeasuredReview({
  children,
  onHeight,
}: {
  children: ReactNode;
  onHeight: (height: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    callback = useRef(onHeight);
  callback.current = onHeight;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !node.childElementCount) return;
    const measure = () => {
      // Monaco sets offscreen view zones to display:none before React retires
      // their portals. Keep the last real size; zero would remove the zone and
      // leave no portal target when the comment scrolls back into view.
      if (!node.isConnected || !node.getClientRects().length) return;
      const height = node.getBoundingClientRect().height;
      if (height > 0) callback.current(height);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [children]);
  return (
    <div ref={ref} className="proof-review-content">
      {children}
    </div>
  );
}
