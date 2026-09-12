import { useLayoutEffect, useRef, useState, type RefObject } from "react";

type Metrics = { old: number; new: number; viewport: number };

// One vertical virtual list, with an independent horizontal viewport for each
// side. Line numbers and Hunk actions stay fixed while all code rows on that
// side move together. Measurements come from the actual rendered font.
export function SplitScrollbars({
  active,
  parent,
  rowKey,
  layoutKey,
}: {
  active: boolean;
  parent: RefObject<HTMLDivElement | null>;
  rowKey: string;
  layoutKey: string;
}) {
  const old = useRef<HTMLDivElement>(null),
    next = useRef<HTMLDivElement>(null);
  const offsets = useRef({ old: 0, new: 0 });
  const [metrics, setMetrics] = useState<Metrics>({
    old: 0,
    new: 0,
    viewport: 0,
  });
  const measuredLayout = useRef("");
  function apply(side: "old" | "new", value: number) {
    offsets.current[side] = value;
    parent.current?.style.setProperty(`--${side}-code-scroll`, `${value}px`);
  }
  function restore() {
    for (const [side, bar] of [
      ["old", old.current],
      ["new", next.current],
    ] as const) {
      if (bar && bar.clientWidth > 0) {
        bar.scrollLeft = offsets.current[side];
        apply(side, bar.scrollLeft);
      }
    }
  }
  useLayoutEffect(() => {
    const element = parent.current;
    if (!active || !element) return;
    function measure() {
      if (!element || element.clientWidth === 0 || element.clientHeight === 0)
        return;
      const measured: Metrics = { old: 0, new: 0, viewport: 0 };
      for (const cell of element.querySelectorAll<HTMLElement>(
        "[data-code-side]",
      )) {
        const side = cell.dataset.codeSide as "old" | "new";
        const content = cell.querySelector<HTMLElement>("code"),
          viewport = cell.querySelector<HTMLElement>(".code-viewport");
        if (content && viewport) {
          measured[side] = Math.max(measured[side], content.scrollWidth);
          measured.viewport = Math.max(measured.viewport, viewport.clientWidth);
        }
      }
      if (measured.viewport === 0) return;
      const changed = measuredLayout.current !== layoutKey;
      measuredLayout.current = layoutKey;
      setMetrics((previous) => {
        const value = {
          old: Math.max(changed ? 0 : previous.old, measured.old),
          new: Math.max(changed ? 0 : previous.new, measured.new),
          viewport: measured.viewport,
        };
        return Object.keys(value).every(
          (key) =>
            value[key as keyof Metrics] === previous[key as keyof Metrics],
        )
          ? previous
          : value;
      });
      // display:none reports zero scrollLeft. Once visible, restore even if the
      // measured sizes equal the last visible sizes and cause no React render.
      restore();
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element
      .querySelectorAll(".code-viewport, code")
      .forEach((node) => observer.observe(node));
    function wheel(event: WheelEvent) {
      if (!event.deltaX && !event.shiftKey) return;
      const side = (event.target as Element | null)?.closest<HTMLElement>(
        "[data-code-side]",
      )?.dataset.codeSide;
      const bar =
        side === "old" ? old.current : side === "new" ? next.current : null;
      if (!bar || bar.scrollWidth <= bar.clientWidth) return;
      event.preventDefault();
      const factor =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element!.clientWidth
            : 1;
      bar.scrollLeft += (event.deltaX || event.deltaY) * factor;
      apply(side as "old" | "new", bar.scrollLeft);
      if (!event.shiftKey && element)
        element.scrollTop += event.deltaY * factor;
    }
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", wheel);
    };
  }, [active, parent, rowKey, layoutKey]);
  useLayoutEffect(() => {
    if (!active) return;
    restore();
  }, [metrics, active]);
  if (!active) return null;
  return (
    <div className="diff-horizontal-controls">
      {(["old", "new"] as const).map((side) => (
        <div
          key={side}
          className="code-horizontal-scroller"
          ref={side === "old" ? old : next}
          tabIndex={0}
          role="region"
          aria-label={`${side === "old" ? "修改前" : "修改后"}代码横向滚动`}
          title="可拖动滚动条、按左右方向键，或在代码栏上横向滚动"
          style={{ width: metrics.viewport || "100%" }}
          onScroll={(event) => {
            if (event.currentTarget.clientWidth > 0)
              apply(side, event.currentTarget.scrollLeft);
          }}
        >
          <div
            style={{
              width: Math.max(metrics[side], metrics.viewport),
              height: 1,
            }}
          />
        </div>
      ))}
    </div>
  );
}
