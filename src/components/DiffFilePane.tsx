import { Button } from "./ui/controls";
import { t } from "../i18n";
import { useMemo, type ComponentProps, type HTMLAttributes } from "react";
import { fileKey } from "../types";
import { X } from "@phosphor-icons/react";
import type { AiController } from "../ai";
import { FileTree } from "./FileTree";
import { ChangeGroups, GroupingToolbar } from "./ChangeGroups";

/** The same file/group navigation in Local changes, comparisons and windows. */
export function DiffFilePane({
  ai,
  token,
  scopeKey,
  onClose,
  closeDisabled,
  containerProps,
  ...tree
}: ComponentProps<typeof FileTree> & {
  ai: AiController;
  token: string;
  scopeKey: string;
  onClose: () => void;
  closeDisabled?: boolean;
  containerProps?: Pick<
    HTMLAttributes<HTMLElement>,
    "id" | "hidden" | "className" | "onBlurCapture" | "aria-label"
  >;
}) {
  const findingCounts = useMemo(() => {
    if (ai.stale || ai.report?.provider !== "ocr") return undefined;
    const counts = new Map<string, number>();
    for (const finding of ai.report.review?.findings ?? []) {
      const key = fileKey({ path: finding.file, side: finding.side });
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [ai.report, ai.stale]);
  return (
    <aside
      {...containerProps}
      className={`files-panel ${containerProps?.className ?? ""}`}
    >
      <Button
        className="icon-button files-close"
        aria-label={t("收起文件栏")}
        onClick={onClose}
        disabled={closeDisabled}
      >
        <X size={15} />
      </Button>
      <GroupingToolbar
        ai={ai}
        onGroup={() => {
          ai.setView("groups");
          void ai.run("grouping", true);
        }}
      />
      {ai.view === "groups" ? (
        <ChangeGroups
          key={scopeKey}
          ai={ai}
          files={tree.files}
          selected={tree.selected}
          token={token}
          onSelect={tree.onSelect}
          operations={{
            disabled: tree.disabled,
            readOnly: tree.readOnly,
            workspacePath: tree.workspacePath,
            onStage: tree.onStage,
            onDiscard: tree.onDiscard,
            onRecovery: tree.onRecovery,
          }}
        />
      ) : (
        <FileTree key={scopeKey} {...tree} findingCounts={findingCounts} />
      )}
    </aside>
  );
}
