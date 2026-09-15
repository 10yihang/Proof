import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Group,
  Panel,
  Separator,
  type GroupImperativeHandle,
  type Layout,
} from "react-resizable-panels";
import { t } from "../i18n";
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
  sidebarId = "files-panel",
  contextId = "context-panel",
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
  sidebarId?: string;
  contextId?: string;
}) {
  const id = useId(),
    left = `${id}-files`,
    center = `${id}-diff`,
    right = `${id}-context`;
  const root = useRef<HTMLElement>(null),
    group = useRef<GroupImperativeHandle>(null);
  const [width, setWidth] = useState(window.innerWidth);
  const interaction = useRef<{
    scope: string;
    side: PanelWidth;
    before: Layout;
    keyboard: boolean;
    pending?: Layout;
  } | null>(null);
  const latest = useRef({
    scopeKey,
    enabled,
    active,
    layout,
    sidebarVisible,
    contextDocked,
    onChange,
    onCollapse,
  });
  latest.current = {
    scopeKey,
    enabled,
    active,
    layout,
    sidebarVisible,
    contextDocked,
    onChange,
    onCollapse,
  };
  const gap = (Number(sidebarVisible) + Number(contextDocked)) * 4;
  const fit = fitPanels(width - gap, layout, sidebarVisible, contextDocked);
  const desired = useMemo(
    () => ({
      [left]: (fit.sidebarWidth / Math.max(1, width - gap)) * 100,
      [center]:
        (Math.max(0, width - gap - fit.sidebarWidth - fit.contextWidth) /
          Math.max(1, width - gap)) *
        100,
      [right]: (fit.contextWidth / Math.max(1, width - gap)) * 100,
    }),
    [left, center, right, fit.sidebarWidth, fit.contextWidth, width, gap],
  );
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth) setWidth(node.clientWidth);
    });
    observer.observe(node);
    if (node.clientWidth) setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    interaction.current = null;
    if (active) {
      const frame = requestAnimationFrame(() =>
        group.current?.setLayout(desired),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [desired, scopeKey, active]);
  function cancel() {
    const previous = interaction.current;
    interaction.current = null;
    if (previous?.scope === scopeKey) group.current?.setLayout(previous.before);
  }
  useEffect(() => {
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancel);
    };
  }, [scopeKey]);
  function begin(side: PanelWidth, keyboard: boolean) {
    if (!enabled || !active) return;
    if (!interaction.current)
      interaction.current = {
        scope: scopeKey,
        side,
        keyboard,
        before: group.current?.getLayout() ?? desired,
      };
  }
  function commit(value: Layout) {
    const start = interaction.current,
      live = latest.current;
    interaction.current = null;
    if (
      !start ||
      start.scope !== live.scopeKey ||
      !live.enabled ||
      !live.active
    )
      return;
    const key = start.side === "sidebarWidth" ? left : right;
    const pixels = Math.round((value[key] / 100) * (width - gap));
    if (pixels <= 1) {
      live.onCollapse(start.side);
      return;
    }
    const bounds = panelBounds[start.side];
    const next = clamp(pixels, bounds.min, bounds.max);
    if (next !== live.layout[start.side]) live.onChange({ [start.side]: next });
  }
  function separator(side: PanelWidth) {
    const forFiles = side === "sidebarWidth";
    return (
      <Separator
        id={`${id}-${side}`}
        className={`proof-separator ${forFiles ? "for-files" : "for-context"}`}
        disabled={!enabled || !active}
        disableDoubleClick
        aria-label={forFiles ? t("变化文件") : t("上下文与证据")}
        aria-controls={forFiles ? sidebarId : contextId}
        aria-describedby={`${id}-help`}
        title={t(
          "拖动或左右方向键调整；Shift 加速；Enter 收起；双击恢复默认宽度",
        )}
        onPointerDownCapture={(event) => {
          if (event.button === 0) begin(side, false);
        }}
        onPointerCancelCapture={cancel}
        onDoubleClick={() => {
          if (enabled && active)
            onChange({ [side]: defaultRepositoryLayout[side] });
        }}
        onKeyDownCapture={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey
          ) {
            event.stopPropagation();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            if (enabled && active) onCollapse(side);
            return;
          }
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            begin(side, true);
        }}
        onKeyUpCapture={(event) => {
          if (
            ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) &&
            interaction.current?.keyboard
          )
            commit(
              interaction.current.pending ??
                group.current?.getLayout() ??
                desired,
            );
        }}
        onBlur={() => {
          if (interaction.current?.keyboard)
            commit(
              interaction.current.pending ??
                group.current?.getLayout() ??
                desired,
            );
        }}
      />
    );
  }
  return (
    <main
      ref={root}
      className="workbench resizable proof-workbench"
      style={
        { "--saved-context-width": `${layout.contextWidth}px` } as CSSProperties
      }
    >
      <Group
        key={scopeKey}
        groupRef={group}
        orientation="horizontal"
        defaultLayout={desired}
        disabled={!enabled || !active}
        resizeTargetMinimumSize={{ coarse: 16, fine: 8 }}
        className="min-h-0 min-w-0 flex-1"
        onLayoutChanged={(value, meta) => {
          if (!meta.isUserInteraction || !interaction.current) return;
          if (interaction.current.keyboard) interaction.current.pending = value;
          else commit(value);
        }}
      >
        <Panel
          id={left}
          className="proof-panel-slot"
          style={{ overflow: "visible", minWidth: 0, display: "flex" }}
          defaultSize={fit.sidebarWidth}
          minSize={sidebarVisible ? 180 : 0}
          maxSize={sidebarVisible ? 480 : 0}
          disabled={!sidebarVisible}
          collapsible
          groupResizeBehavior="preserve-pixel-size"
        >
          {sidebar}
        </Panel>
        {sidebarVisible && separator("sidebarWidth")}
        <Panel
          id={center}
          className="proof-center-slot"
          style={{
            overflow: "hidden",
            display: "flex",
            minWidth: 0,
            minHeight: 0,
          }}
          minSize={Math.min(360, width - gap)}
        >
          {children}
        </Panel>
        {contextDocked && separator("contextWidth")}
        <Panel
          id={right}
          className="proof-panel-slot"
          style={{ overflow: "visible", minWidth: 0, display: "flex" }}
          defaultSize={fit.contextWidth}
          minSize={contextDocked ? 240 : 0}
          maxSize={contextDocked ? 520 : 0}
          disabled={!contextDocked}
          collapsible
          groupResizeBehavior="preserve-pixel-size"
        >
          {context}
        </Panel>
      </Group>
      <span id={`${id}-help`} className="sr-only">
        {t(
          "左右方向键调整，Shift 加速，Home 和 End 调到边界，Enter 收起面板，Esc 取消调整。设置中也可直接输入宽度。",
        )}
      </span>
    </main>
  );
}
