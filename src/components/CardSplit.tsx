import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Group,
  Panel,
  Separator,
  type GroupImperativeHandle,
  type Layout,
} from "react-resizable-panels";
import {
  cardPanelBounds,
  clamp,
  defaultRepositoryLayout,
  type CardPanelDimension,
} from "../repository-layout";
import type { RepositoryLayout } from "../types";
import { t } from "../i18n";

type CardLayoutController = {
  value: RepositoryLayout;
  ready: boolean;
  scopeKey: string;
  update: (value: Partial<RepositoryLayout>) => Promise<void>;
};
export const CardLayoutContext = createContext<CardLayoutController | null>(
  null,
);
export type CardPanelField = CardPanelDimension;

/** A pixel-sized edge panel. Window fitting never changes saved user intent. */
export function CardSplit({
  field,
  label,
  panel,
  children,
  orientation = "horizontal",
  side = "start",
  hidden = false,
  contentMinSize = 320,
  className = "",
}: {
  field: CardPanelField;
  label: string;
  panel: ReactNode;
  children: ReactNode;
  orientation?: "horizontal" | "vertical";
  side?: "start" | "end";
  hidden?: boolean;
  contentMinSize?: number;
  className?: string;
}) {
  const controller = useContext(CardLayoutContext);
  const id = useId();
  const panelId = `${id}-edge`;
  const contentId = `${id}-content`;
  const root = useRef<HTMLDivElement>(null);
  const group = useRef<GroupImperativeHandle>(null);
  const [extent, setExtent] = useState(0);
  const [pointerCancelled, setPointerCancelled] = useState(false);
  const saved = controller?.value[field] ?? defaultRepositoryLayout[field];
  const bounds = cardPanelBounds[field];
  const available = Math.max(0, extent - (hidden ? 0 : 12));
  const otherMinimum = Math.min(
    contentMinSize,
    Math.max(0, available - Math.min(bounds.min, available / 2)),
  );
  const maximum = hidden ? 0 : Math.min(bounds.max, available - otherMinimum);
  const minimum = Math.min(bounds.min, maximum);
  const fitted = hidden ? 0 : clamp(saved, minimum, maximum);
  const desired = useMemo(() => {
    const edge = available ? (fitted / available) * 100 : hidden ? 0 : 40;
    const content = 100 - edge;
    // The library uses layout insertion order when applying drag deltas.
    return side === "start"
      ? { [panelId]: edge, [contentId]: content }
      : { [contentId]: content, [panelId]: edge };
  }, [available, fitted, hidden, panelId, contentId, side]);
  const interaction = useRef<{
    scopeKey: string;
    before: Layout;
    keyboard: boolean;
    pending?: Layout;
  } | null>(null);
  const live = useRef({
    controller,
    saved,
    available,
    hidden,
    pointerCancelled,
  });
  live.current = { controller, saved, available, hidden, pointerCancelled };

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => {
      setExtent(
        orientation === "horizontal" ? node.clientWidth : node.clientHeight,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [orientation]);
  useLayoutEffect(() => {
    interaction.current = null;
    if (extent > 0) {
      // Panel registration must apply new min/max constraints before restoring
      // a hidden panel or fitting a resized group to the saved pixel size.
      const frame = requestAnimationFrame(() =>
        group.current?.setLayout(desired),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [desired, controller?.scopeKey, extent]);

  function cancel() {
    const previous = interaction.current;
    interaction.current = null;
    if (previous && previous.scopeKey === live.current.controller?.scopeKey) {
      group.current?.setLayout(previous.before);
      // Disabling the Group removes the active pointer registration so later
      // moves cannot overwrite the restored layout before the pointer is up.
      if (!previous.keyboard) setPointerCancelled(true);
    }
  }
  useEffect(() => {
    let releaseFrame = 0;
    const resume = () => setPointerCancelled(false);
    const pointerCancel = () => {
      // Let the disabled state commit before re-enabling a cancelled touch.
      cancelAnimationFrame(releaseFrame);
      releaseFrame = requestAnimationFrame(resume);
    };
    const visibility = () => {
      if (document.hidden) cancel();
      else resume();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("focus", resume);
    window.addEventListener("pointerup", resume);
    window.addEventListener("pointercancel", pointerCancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelAnimationFrame(releaseFrame);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pointerup", resume);
      window.removeEventListener("pointercancel", pointerCancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  function begin(keyboard: boolean) {
    const current = live.current;
    if (
      !current.controller?.ready ||
      current.hidden ||
      current.pointerCancelled ||
      !current.available
    )
      return;
    if (!interaction.current)
      interaction.current = {
        scopeKey: current.controller.scopeKey,
        before: group.current?.getLayout() ?? desired,
        keyboard,
      };
  }
  function finish(value: Layout) {
    const start = interaction.current;
    const current = live.current;
    interaction.current = null;
    if (
      !start ||
      !current.controller?.ready ||
      start.scopeKey !== current.controller.scopeKey ||
      current.hidden ||
      !current.available
    )
      return;
    const pixels = clamp(
      (value[panelId] / 100) * current.available,
      bounds.min,
      bounds.max,
    );
    if (pixels !== current.saved)
      void current.controller.update({ [field]: pixels });
  }

  const edge = (
    <Panel
      key="edge"
      id={panelId}
      className="card-split-pane"
      minSize={minimum}
      maxSize={maximum}
      disabled={hidden}
      groupResizeBehavior="preserve-pixel-size"
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
      style={{ display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}
    >
      <div className="card-split-inner" hidden={hidden}>
        {panel}
      </div>
    </Panel>
  );
  const content = (
    <Panel
      key="content"
      id={contentId}
      className="card-split-content"
      minSize={otherMinimum}
      style={{ display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}
    >
      <div className="card-split-inner">{children}</div>
    </Panel>
  );
  const resizeKeys =
    orientation === "horizontal"
      ? ["ArrowLeft", "ArrowRight", "Home", "End"]
      : ["ArrowUp", "ArrowDown", "Home", "End"];
  return (
    <Group
      elementRef={root}
      groupRef={group}
      className={`card-split ${className}`}
      data-field={field}
      data-orientation={orientation}
      orientation={orientation}
      defaultLayout={desired}
      disabled={!controller?.ready || extent === 0 || pointerCancelled}
      resizeTargetMinimumSize={{ coarse: 12, fine: 12 }}
      onLayoutChanged={(value, meta) => {
        if (!meta.isUserInteraction || !interaction.current) return;
        if (interaction.current.keyboard) interaction.current.pending = value;
        else finish(value);
      }}
    >
      {side === "start" ? edge : content}
      {!hidden && (
        <Separator
          key="separator"
          className="card-split-separator"
          aria-label={label}
          aria-controls={panelId}
          title={t("拖动调整大小；方向键微调；Esc 取消；双击恢复默认")}
          disableDoubleClick
          disabled={!controller?.ready || extent === 0 || pointerCancelled}
          onPointerDownCapture={(event) => {
            if (event.button === 0) begin(false);
          }}
          onPointerCancelCapture={cancel}
          onDoubleClick={() => {
            cancel();
            if (controller?.ready)
              void controller.update({
                [field]: defaultRepositoryLayout[field],
              });
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
            } else if (resizeKeys.includes(event.key)) begin(true);
          }}
          onKeyUpCapture={(event) => {
            if (resizeKeys.includes(event.key) && interaction.current?.keyboard)
              finish(
                interaction.current.pending ??
                  group.current?.getLayout() ??
                  desired,
              );
          }}
          onBlurCapture={() => {
            if (interaction.current?.keyboard)
              finish(
                interaction.current.pending ??
                  group.current?.getLayout() ??
                  desired,
              );
          }}
        />
      )}
      {side === "start" ? content : edge}
    </Group>
  );
}
