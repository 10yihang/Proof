import type { ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/react";
import { DotsSixVertical } from "@phosphor-icons/react";
import { Button } from "./controls";
import { t } from "../../i18n";

export function DraggableGroupFile({
  id,
  path,
  selected,
  disabled,
  children,
}: {
  id: string;
  path: string;
  selected: boolean;
  disabled: boolean;
  children: ReactNode;
}) {
  const { ref, handleRef, isDragSource } = useDraggable({
    id,
    type: "proof-group-file",
    data: { path },
    disabled,
  });
  return (
    <div
      ref={ref}
      className={`change-group-file ${selected ? "selected" : ""} ${isDragSource ? "is-dragging" : ""}`}
    >
      <Button
        ref={handleRef}
        className="icon-button group-drag-handle"
        disabled={disabled}
        aria-label={t("拖动 {v0} 到其他分组", { v0: path })}
        title={t("拖动文件调整分组，也可使用右侧菜单")}
      >
        <DotsSixVertical size={13} />
      </Button>
      {children}
    </div>
  );
}
export function GroupDropZone({
  group,
  disabled,
  children,
  ungrouped = false,
}: {
  group: number | null;
  disabled: boolean;
  children: ReactNode;
  ungrouped?: boolean;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `group:${group ?? "none"}`,
    type: "proof-change-group",
    accept: ["proof-group-file"],
    data: { group },
    disabled,
  });
  return (
    <section
      ref={ref}
      data-drop-group={group ?? "none"}
      className={`change-group ${ungrouped ? "ungrouped" : ""} ${isDropTarget ? "is-drop-target" : ""}`}
    >
      {children}
    </section>
  );
}
