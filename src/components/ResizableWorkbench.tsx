import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  clamp,
  defaultRepositoryLayout,
  fitPanels,
  panelBounds,
  type PanelWidth,
} from "../repository-layout";
import type { RepositoryLayout } from "../types";

export function ResizableWorkbench({
  layout,
  scopeKey,
  enabled,
  active,
  sidebarVisible,
  contextDocked,
  sidebar,
  context,
  children,
  onChange,
  onCollapse,
}: {
  layout: RepositoryLayout;
  scopeKey: string;
  enabled: boolean;
  active: boolean;
  sidebarVisible: boolean;
  contextDocked: boolean;
  sidebar: ReactNode;
  context: ReactNode;
  children: ReactNode;
  onChange: (partial: Partial<RepositoryLayout>) => void;
  onCollapse: (side: PanelWidth) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(window.innerWidth);
  const [draft, setDraft] = useState<{
    side: PanelWidth;
    value: number;
    start: number;
    x: number;
    pointer: number | null;
    scope: string;
  } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const cancelDraft = useCallback(() => {
    draftRef.current = null;
    setDraft(null);
  }, []);
  const preview =
    draft && draft.scope === scopeKey
      ? { ...layout, [draft.side]: draft.value }
      : layout;
  const fit = fitPanels(width, preview, sidebarVisible, contextDocked);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth) setWidth(node.clientWidth);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    cancelDraft();
  }, [scopeKey, active, sidebarVisible, contextDocked, cancelDraft]);
  useEffect(() => {
    window.addEventListener("blur", cancelDraft);
    document.addEventListener("visibilitychange", cancelDraft);
    return () => {
      window.removeEventListener("blur", cancelDraft);
      document.removeEventListener("visibilitychange", cancelDraft);
    };
  }, [cancelDraft]);
  function limits(side: PanelWidth) {
    const other = side === "sidebarWidth" ? fit.contextWidth : fit.sidebarWidth;
    return {
      min: panelBounds[side].min,
      max: Math.max(
        panelBounds[side].min,
        Math.min(panelBounds[side].max, width - other - 360),
      ),
    };
  }
  function finish() {
    const value = draftRef.current;
    if (
      value &&
      enabled &&
      active &&
      (value.side === "sidebarWidth" ? sidebarVisible : contextDocked) &&
      value.scope === scopeKey &&
      value.value !== value.start
    )
      onChange({ [value.side]: value.value });
    draftRef.current = null;
    setDraft(null);
  }
  function separator(side: PanelWidth) {
    const bounds = limits(side);
    const name = side === "sidebarWidth" ? "变化文件" : "上下文与证据";
    return (
      <div
        key={side}
        className={`panel-separator ${side === "sidebarWidth" ? "for-files" : "for-context"} ${draft?.side === side ? "is-resizing" : ""}`}
        role="separator"
        aria-label={name}
        aria-orientation="vertical"
        aria-controls={
          side === "sidebarWidth" ? "files-panel" : "context-panel"
        }
        aria-valuenow={fit[side]}
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuetext={`${name} ${fit[side]} 像素`}
        aria-disabled={!enabled}
        aria-describedby="resize-help"
        tabIndex={enabled ? 0 : -1}
        style={
          side === "sidebarWidth"
            ? { left: fit.sidebarWidth - 4 }
            : { right: fit.contextWidth - 4 }
        }
        title="拖动或左右方向键调整；Shift 加速；Enter 收起；双击恢复默认宽度"
        onPointerDown={(event) => {
          if (!enabled || !active || event.button !== 0 || !event.isPrimary)
            return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          const next = {
            side,
            start: fit[side],
            value: fit[side],
            x: event.clientX,
            pointer: event.pointerId,
            scope: scopeKey,
          };
          draftRef.current = next;
          setDraft(next);
        }}
        onPointerMove={(event) => {
          const value = draftRef.current;
          if (
            !enabled ||
            !active ||
            !value ||
            value.scope !== scopeKey ||
            value.pointer !== event.pointerId
          )
            return;
          const direction = side === "sidebarWidth" ? 1 : -1;
          const next = {
            ...value,
            value: clamp(
              value.start + (event.clientX - value.x) * direction,
              bounds.min,
              bounds.max,
            ),
          };
          draftRef.current = next;
          setDraft(next);
        }}
        onPointerUp={(event) => {
          if (draftRef.current?.pointer !== event.pointerId) return;
          finish();
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={cancelDraft}
        onLostPointerCapture={cancelDraft}
        onDoubleClick={() => {
          if (enabled && active)
            onChange({ [side]: defaultRepositoryLayout[side] });
        }}
        onKeyDown={(event) => {
          if (
            !enabled ||
            !active ||
            event.nativeEvent.isComposing ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey
          )
            return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancelDraft();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            finish();
            onCollapse(side);
            return;
          }
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          event.stopPropagation();
          const direction =
            (event.key === "ArrowRight" ? 1 : -1) *
            (side === "sidebarWidth" ? 1 : -1);
          const value =
            event.key === "Home"
              ? bounds.min
              : event.key === "End"
                ? bounds.max
                : clamp(
                    fit[side] + direction * (event.shiftKey ? 40 : 10),
                    bounds.min,
                    bounds.max,
                  );
          const next = {
            side,
            value,
            start: draftRef.current?.start ?? fit[side],
            x: 0,
            pointer: null,
            scope: scopeKey,
          };
          draftRef.current = next;
          setDraft(next);
        }}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            finish();
        }}
        onBlur={() => {
          if (draftRef.current?.pointer === null) finish();
        }}
      />
    );
  }
  return (
    <main
      ref={root}
      className={`workbench resizable ${draft ? "is-resizing" : ""}`}
      style={
        {
          gridTemplateColumns: `${sidebarVisible ? `${fit.sidebarWidth}px ` : ""}minmax(0,1fr)${contextDocked ? ` ${fit.contextWidth}px` : ""}`,
          "--saved-context-width": `${layout.contextWidth}px`,
        } as CSSProperties
      }
    >
      {sidebar}
      {sidebarVisible && separator("sidebarWidth")}
      {children}
      {contextDocked && separator("contextWidth")}
      {context}
      <span className="sr-only" id="resize-help">
        左右方向键调整，Shift 加速，Home 和 End 调到边界，Enter 收起面板，Esc
        取消调整。设置中也可直接输入宽度。
      </span>
    </main>
  );
}
