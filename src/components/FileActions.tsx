import { useState } from "react";
import { t } from "../i18n";
import type { ChangedFile, Side } from "../types";
import { GitContextMenu, HistoryMoreButton } from "./HistoryActions";
import { DropdownMenuItem as MenuItem } from "./ui/dropdown-menu";
import { toast } from "./ui/toast";

export interface FileOperations {
  disabled: boolean;
  readOnly?: boolean;
  workspacePath?: string;
  onStage: (files: ChangedFile[], side: Side) => void;
  onDiscard?: (files: ChangedFile[]) => void;
  onRecovery?: () => void;
}
export function FileActionItems({
  files,
  onClose,
  disabled,
  readOnly,
  workspacePath,
  onStage,
  onDiscard,
  onRecovery,
}: FileOperations & { files: ChangedFile[]; onClose: () => void }) {
  const unstaged = files.filter((file) => file.side === "unstaged");
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.add({ title: t("已复制"), type: "success" });
    } catch {
      toast.add({ title: t("复制失败，请重试。"), type: "error" });
    }
  }
  return (
    <>
      <div className="history-menu-label">
        {files.length === 1
          ? files[0].path
          : t("{v0} 个文件", { v0: files.length })}
      </div>
      {!readOnly && (
        <>
          {(["unstaged", "staged"] as const).map((side) => {
            const batch = files.filter((file) => file.side === side);
            return (
              batch.length > 0 && (
                <MenuItem
                  key={side}
                  disabled={disabled || batch.some((file) => file.conflicted)}
                  onClick={() => {
                    onStage(batch, side);
                    onClose();
                  }}
                >
                  {side === "staged" ? "Unstage" : "Stage"}
                  {batch.length > 1 ? ` (${batch.length})` : ""}
                </MenuItem>
              )
            );
          })}
          {onDiscard && unstaged.length > 0 && (
            <MenuItem
              className="danger-text"
              disabled={disabled || unstaged.some((file) => file.conflicted)}
              onClick={() => {
                onDiscard(unstaged);
                onClose();
              }}
            >
              {unstaged.length > 1
                ? t("Discard {v0} 个文件…", { v0: unstaged.length })
                : t("Discard 文件修改…")}
            </MenuItem>
          )}
          <hr />
        </>
      )}
      <MenuItem
        onClick={() => {
          void copy([...new Set(files.map((file) => file.path))].join("\n"));
          onClose();
        }}
      >
        {t("复制相对路径")}
      </MenuItem>
      {workspacePath && (
        <MenuItem
          onClick={() => {
            void copy(
              [
                ...new Set(
                  files.map(
                    (file) =>
                      `${workspacePath.replace(/\/$/, "")}/${file.path}`,
                  ),
                ),
              ].join("\n"),
            );
            onClose();
          }}
        >
          {t("复制绝对路径")}
        </MenuItem>
      )}
      <MenuItem
        onClick={() => {
          void copy(
            [
              ...new Set(
                files.map((file) => file.path.split("/").pop() ?? file.path),
              ),
            ].join("\n"),
          );
          onClose();
        }}
      >
        {t("复制文件名")}
      </MenuItem>
      {!readOnly && onRecovery && (
        <>
          <hr />
          <MenuItem
            onClick={() => {
              onRecovery();
              onClose();
            }}
          >
            {t("恢复已 Discard 的修改…")}
          </MenuItem>
        </>
      )}
    </>
  );
}
export function FileActionsButton({
  files,
  label,
  ...operations
}: FileOperations & { files: ChangedFile[]; label?: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!files.length) return null;
  return (
    <>
      <HistoryMoreButton
        label={
          label ??
          t("{v0} 的文件操作", {
            v0: files.length === 1 ? files[0].path : t("所选文件"),
          })
        }
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
      />
      {menu && (
        <GitContextMenu
          {...menu}
          label={t("文件操作")}
          onClose={() => setMenu(null)}
        >
          <FileActionItems
            files={files}
            {...operations}
            onClose={() => setMenu(null)}
          />
        </GitContextMenu>
      )}
    </>
  );
}
