import { PointerActivationConstraints } from "@dnd-kit/dom";
import {
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type Ref,
} from "react";
import { Tabs } from "@base-ui/react/tabs";
import { DragDropProvider, DragOverlay, PointerSensor } from "@dnd-kit/react";
import { useSortable, isSortable } from "@dnd-kit/react/sortable";
import { useReducedMotion } from "motion/react";
import {
  ClockCounterClockwise,
  FileCode,
  Files,
  GitCommit,
  GitDiff,
  SquaresFour,
  SidebarSimple,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { Button } from "./ui/controls";
import { t } from "../i18n";
import type { HistoryComparison } from "./HistoryDiff";

const tabPointer = PointerSensor.configure({
  activationConstraints: [
    new PointerActivationConstraints.Distance({ value: 6 }),
  ],
});
const sidebarStorageKey = "proof.workspace-sidebar";
const sidebarChangeEvent = "proof-workspace-sidebar-change";
let fallbackSidebarState: "collapsed" | "expanded" | null = null;
function getSidebarState() {
  let preference = fallbackSidebarState;
  try {
    if (preference === null) {
      const stored = localStorage.getItem(sidebarStorageKey);
      if (stored === "collapsed" || stored === "expanded") preference = stored;
    }
  } catch {
    // Keep the control usable when persistence is unavailable.
  }
  return (
    preference ??
    (window.matchMedia("(max-width: 1180px)").matches
      ? "auto-collapsed"
      : "auto-expanded")
  );
}
function subscribeSidebarState(notify: () => void) {
  const viewport = window.matchMedia("(max-width: 1180px)");
  const onStorage = (event: StorageEvent) => {
    if (event.key === sidebarStorageKey || event.key === null) {
      fallbackSidebarState =
        event.newValue === "collapsed" || event.newValue === "expanded"
          ? event.newValue
          : null;
      notify();
    }
  };
  window.addEventListener(sidebarChangeEvent, notify);
  window.addEventListener("storage", onStorage);
  viewport.addEventListener("change", notify);
  return () => {
    window.removeEventListener(sidebarChangeEvent, notify);
    window.removeEventListener("storage", onStorage);
    viewport.removeEventListener("change", notify);
  };
}
function setSidebarState(state: "collapsed" | "expanded") {
  fallbackSidebarState = state;
  try {
    localStorage.setItem(sidebarStorageKey, state);
  } catch {
    // The shared in-memory state still follows the user's choice.
  }
  window.dispatchEvent(new Event(sidebarChangeEvent));
}
export type WorkspaceView =
  "overview" | "changes" | "commit" | "history" | "files" | `diff:${string}`;
export interface ComparisonTab {
  id: `diff:${string}`;
  workspaceId: string;
  selection: HistoryComparison;
}
export function WorkspaceTabs({
  active,
  changesCount,
  stagedCount,
  comparisons,
  onClose,
  onReorder,
}: {
  active: WorkspaceView;
  changesCount: number;
  stagedCount: number;
  comparisons: ComparisonTab[];
  onClose: (id: string) => void;
  onReorder: (source: string, target: string) => void;
}) {
  const listId = useId();
  const root = useRef<HTMLElement>(null);
  const sidebarState = useSyncExternalStore(
    subscribeSidebarState,
    getSidebarState,
    () => "auto-expanded" as const,
  );
  const collapsed =
    sidebarState === "collapsed" || sidebarState === "auto-collapsed";
  const toggleLabel = t(collapsed ? "展开侧边栏" : "收起侧边栏");
  useLayoutEffect(() => {
    const nav = root.current;
    if (!nav) return;
    const reveal = () => {
      const tab = nav.querySelector<HTMLElement>('[aria-current="page"]');
      // Include the close button, and reveal it again when the window narrows.
      const item = tab?.closest<HTMLElement>(".diff-tab-item") ?? tab;
      item?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [active, comparisons.length]);
  const reduced = useReducedMotion();
  const views = [
    { id: "overview", label: t("总览"), icon: SquaresFour },
    {
      id: "changes",
      label: t("Local changes"),
      shortLabel: t("Changes"),
      icon: Files,
      count: changesCount,
    },
    { id: "commit", label: t("Commit"), icon: GitCommit, count: stagedCount },
    { id: "history", label: t("History"), icon: ClockCounterClockwise },
    { id: "files", label: t("Files"), icon: FileCode },
  ] as const;
  return (
    <nav
      ref={root}
      className={`workspace-tabs workspace-sidebar ${collapsed ? "is-collapsed" : "is-expanded"}`}
      data-sidebar-state={collapsed ? "collapsed" : "expanded"}
      aria-label={t("Worktree")}
    >
      <DragDropProvider
        sensors={[tabPointer]}
        onDragEnd={({ operation, canceled }) => {
          const source = operation.source;
          if (!canceled && isSortable(source)) {
            const target = comparisons[source.index];
            if (target) onReorder(String(source.id), target.id);
          }
        }}
      >
        <Tabs.List
          id={listId}
          className="workspace-tab-list flex min-w-0 flex-1 items-stretch"
          activateOnFocus={false}
          aria-label={t("Worktree")}
          aria-orientation="vertical"
          onKeyDownCapture={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.keyCode === 229 ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const tabs = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              ),
            );
            const origin = event.target as HTMLElement;
            const current =
              origin.closest<HTMLButtonElement>('[role="tab"]') ??
              origin
                .closest(".diff-tab-item")
                ?.querySelector<HTMLButtonElement>('[role="tab"]');
            const index = current ? tabs.indexOf(current) : -1;
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      tabs.length) %
                    tabs.length;
            const target = tabs[next];
            target?.focus({ preventScroll: true });
            (target?.closest(".diff-tab-item") ?? target)?.scrollIntoView({
              block: "nearest",
              inline: "nearest",
            });
          }}
        >
          {views.map((view, index) => (
            <WorkspacePageTab
              key={view.id}
              {...view}
              active={active === view.id}
              title={`${view.label} · ⌘${view.id === "overview" ? 5 : index}`}
            />
          ))}
          {comparisons.map((item, index) => (
            <SortableDiffTab
              key={item.id}
              item={item}
              index={index}
              active={active === item.id}
              onClose={onClose}
              onMove={(direction) => {
                const target = comparisons[index + direction];
                if (target) onReorder(item.id, target.id);
              }}
            />
          ))}
          <Tabs.Indicator
            className="workspace-tab-indicator"
            aria-hidden="true"
          />
        </Tabs.List>
        <DragOverlay dropAnimation={reduced ? null : { duration: 150 }}>
          {(source) => (
            <span className="rounded-md border border-border bg-popover px-3 py-2 text-[12px] text-popover-foreground shadow-xl">
              {String(source.data.label ?? "")}
            </span>
          )}
        </DragOverlay>
      </DragDropProvider>
      <Button
        className="workspace-sidebar-toggle"
        aria-label={toggleLabel}
        aria-expanded={!collapsed}
        aria-controls={listId}
        title={toggleLabel}
        onClick={() => setSidebarState(collapsed ? "expanded" : "collapsed")}
      >
        <SidebarSimple size={15} aria-hidden="true" />
        <span className="workspace-sidebar-toggle-label">{toggleLabel}</span>
      </Button>
    </nav>
  );
}

function WorkspacePageTab({
  id,
  label,
  shortLabel = label,
  icon: Icon,
  count,
  active,
  title,
  tabRef,
  className = "",
}: {
  id: WorkspaceView;
  label: string;
  shortLabel?: string;
  icon: Icon;
  count?: number;
  active: boolean;
  title: string;
  tabRef?: Ref<HTMLButtonElement>;
  className?: string;
}) {
  return (
    <Tabs.Tab
      value={id}
      ref={tabRef}
      className={`view-tab${active ? " active" : ""} ${className}`}
      data-workspace-view={id}
      aria-current={active ? "page" : undefined}
      aria-label={count === undefined ? label : `${label} ${count}`}
      title={title}
    >
      <Icon size={15} aria-hidden="true" />
      <span className="view-tab-label">{shortLabel}</span>
      {count !== undefined && <span className="tab-count">{count}</span>}
    </Tabs.Tab>
  );
}

function SortableDiffTab({
  item,
  index,
  active,
  onClose,
  onMove,
}: {
  item: ComparisonTab;
  index: number;
  active: boolean;
  onClose: (id: string) => void;
  onMove: (direction: number) => void;
}) {
  const { base, baseLabel, target, targetLabel } = item.selection;
  const label = targetLabel || target.slice(0, 8);
  const title = base ? `${baseLabel || base.slice(0, 8)} ↔ ${label}` : label;
  const { ref, handleRef, isDragSource } = useSortable({
    id: item.id,
    index,
    group: "comparison-tabs",
    type: "proof-comparison-tab",
    data: { label: title },
  });
  const closeLabel = t("关闭标签页 {v0}", { v0: title });
  return (
    <span
      ref={ref}
      onKeyDownCapture={(event) => {
        if (
          !event.nativeEvent.isComposing &&
          (event.metaKey || event.ctrlKey) &&
          event.shiftKey &&
          ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
            event.key,
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          onMove(["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1);
        }
      }}
      className={`diff-tab-item ${active ? "active" : ""} ${isDragSource ? "is-dragging" : ""}`}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onClose(item.id);
        }
      }}
    >
      <WorkspacePageTab
        id={item.id}
        icon={GitDiff}
        label={title}
        active={active}
        tabRef={handleRef}
        className="diff-tab-button"
        title={`${title}\n${t("拖动排序，⌘/Ctrl Shift ←/→ 调整顺序")}`}
      />
      <Button
        className="diff-tab-close"
        aria-label={closeLabel}
        title={active ? t("关闭标签页 · ⌘W") : closeLabel}
        onClick={() => onClose(item.id)}
      >
        <X size={12} aria-hidden="true" />
      </Button>
    </span>
  );
}
