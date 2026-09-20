import { PointerActivationConstraints } from "@dnd-kit/dom";
import { useId, useLayoutEffect, useRef, type RefObject } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { DragDropProvider, DragOverlay, PointerSensor } from "@dnd-kit/react";
import { useSortable, isSortable } from "@dnd-kit/react/sortable";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import {
  ClockCounterClockwise,
  Files,
  GitCommit,
  GitDiff,
  X,
} from "@phosphor-icons/react";
import { Button } from "./ui/controls";
import { t } from "../i18n";
import type { HistoryComparison } from "./HistoryDiff";

const tabPointer = PointerSensor.configure({
  activationConstraints: [
    new PointerActivationConstraints.Distance({ value: 6 }),
  ],
});
export type WorkspaceView =
  "changes" | "commit" | "history" | `diff:${string}`;
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
  historyRef,
  onClose,
  onReorder,
}: {
  active: WorkspaceView;
  changesCount: number;
  stagedCount: number;
  comparisons: ComparisonTab[];
  historyRef: RefObject<HTMLButtonElement | null>;
  onSelect: (view: WorkspaceView) => void;
  onClose: (id: string) => void;
  onReorder: (source: string, target: string) => void;
}) {
  const group = useId();
  const root = useRef<HTMLElement>(null);
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
    {
      id: "changes",
      label: t("Local changes"),
      icon: Files,
      count: changesCount,
    },
    { id: "commit", label: t("Commit"), icon: GitCommit, count: stagedCount },
    { id: "history", label: t("History"), icon: ClockCounterClockwise },
  ] as const;
  const indicator = (
    <motion.span
      layoutId="workspace-active-tab"
      className="workspace-tab-indicator"
      transition={
        reduced
          ? { duration: 0 }
          : { type: "spring", stiffness: 460, damping: 38 }
      }
    />
  );
  return (
    <nav ref={root} className="workspace-tabs" aria-label={t("Worktree")}>
      <LayoutGroup id={group}>
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
            className="workspace-tab-list flex min-w-0 flex-1 items-stretch"
            activateOnFocus={false}
            aria-label={t("Worktree")}
          >
            {views.map(({ id, label, icon: Icon, ...view }, index) => (
              <Tabs.Tab
                key={id}
                value={id}
                className={`view-tab ${active === id ? "active" : ""}`}
                ref={id === "history" ? historyRef : undefined}
                aria-current={active === id ? "page" : undefined}
                title={`${label} · ⌘${index + 1}`}
              >
                <Icon size={15} aria-hidden="true" />
                {label}
                {"count" in view && (
                  <span className="tab-count">{view.count}</span>
                )}
                {active === id && indicator}
              </Tabs.Tab>
            ))}
            <span className="diff-tab-strip">
              {comparisons.map((item, index) => (
                <SortableDiffTab
                  key={item.id}
                  item={item}
                  index={index}
                  active={active === item.id}
                  indicator={indicator}
                  onClose={onClose}
                  onMove={(direction) => {
                    const target = comparisons[index + direction];
                    if (target) onReorder(item.id, target.id);
                  }}
                />
              ))}
            </span>
          </Tabs.List>
          <DragOverlay dropAnimation={reduced ? null : { duration: 150 }}>
            {(source) => (
              <span className="rounded-md border border-border bg-popover px-3 py-2 text-[12px] text-popover-foreground shadow-xl">
                {String(source.data.label ?? "Diff")}
              </span>
            )}
          </DragOverlay>
        </DragDropProvider>
      </LayoutGroup>
    </nav>
  );
}
function SortableDiffTab({
  item,
  index,
  active,
  indicator,
  onClose,
  onMove,
}: {
  item: ComparisonTab;
  index: number;
  active: boolean;
  indicator: React.ReactNode;
  onClose: (id: string) => void;
  onMove: (direction: number) => void;
}) {
  const { ref, handleRef, isDragSource } = useSortable({
    id: item.id,
    index,
    group: "comparison-tabs",
    type: "proof-comparison-tab",
    data: {
      label: item.selection.targetLabel ?? item.selection.target.slice(0, 8),
    },
  });
  const label = item.selection.base
    ? `${item.selection.baseLabel ?? item.selection.base} ↔ ${item.selection.targetLabel ?? item.selection.target}`
    : (item.selection.targetLabel ?? item.selection.target);
  return (
    <span
      ref={ref}
      onKeyDownCapture={(event) => {
        if (
          !event.nativeEvent.isComposing &&
          (event.metaKey || event.ctrlKey) &&
          event.shiftKey &&
          ["ArrowLeft", "ArrowRight"].includes(event.key)
        ) {
          event.preventDefault();
          event.stopPropagation();
          onMove(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
      className={`diff-tab-item ${active ? "active" : ""} ${isDragSource ? "is-dragging" : ""}`}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onClose(item.id);
        }
      }}
    >
      <Tabs.Tab
        value={item.id}
        ref={handleRef}
        className="diff-tab-button"
        aria-current={active ? "page" : undefined}
        title={`${label}\n${t("拖动排序，⌘/Ctrl Shift ←/→ 调整顺序")}`}
      >
        <GitDiff size={15} aria-hidden="true" />
        {t("Diff")}{" "}
        <code>
          {item.selection.base
            ? `${item.selection.base.slice(0, 5)} ↔ ${item.selection.target.slice(0, 5)}`
            : item.selection.target.slice(0, 8)}
        </code>
      </Tabs.Tab>
      <Button
        className="diff-tab-close"
        aria-label={t("关闭 Diff {v0}", {
          v0: item.selection.target.slice(0, 8),
        })}
        title={t("关闭 Diff · ⌘W")}
        onClick={() => onClose(item.id)}
      >
        <X size={12} aria-hidden="true" />
      </Button>
      {active && indicator}
    </span>
  );
}
