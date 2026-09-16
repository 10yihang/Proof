import { Button } from "./ui/controls";
import { t } from "../i18n";
import type { ComponentProps, HTMLAttributes } from "react";
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
        <FileTree key={scopeKey} {...tree} />
      )}
    </aside>
  );
}
