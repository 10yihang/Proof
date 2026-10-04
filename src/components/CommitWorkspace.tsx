import { t } from "../i18n";
import { Button } from "./ui/controls";
import type { ReactNode } from "react";
import { FileTree } from "./FileTree";
import { CardSplit } from "./CardSplit";
import {
  type ChangedFile,
  type Changes,
  type FileDiff,
  type Side,
} from "../types";

export function CommitWorkspace({
  changes,
  loaded,
  disabled,
  onStage,
  onDiscard,
  onRecovery,
  selected,
  onSelect,
  scope,
  onScope,
  search,
  onSearch,
  children,
}: {
  changes: Changes;
  loaded: Record<string, FileDiff>;
  disabled: boolean;
  onStage: (files: ChangedFile[], side: Side) => void;
  onDiscard: (files: ChangedFile[]) => void;
  onRecovery: () => void;
  selected: string | null;
  onSelect: (file: ChangedFile) => void;
  scope: "all" | Side;
  onScope: (scope: "all" | Side) => void;
  search: string;
  onSearch: (value: string) => void;
  children: ReactNode;
}) {
  const stagedFiles = changes.files.filter((file) => file.side === "staged");
  return (
    <section className="commit-workspace" aria-label={t("Commit 工作区")}>
      <div className="commit-scope-summary">
        <strong>
          {t("已暂存提交范围：{count} 个文件", { count: stagedFiles.length })}
        </strong>
        <span>{t("未暂存变更可在下方切换查看并暂存。")}</span>
        {stagedFiles.length > 0 && (
          <Button
            className="text-button"
            onClick={() => {
              onScope("staged");
              onSearch("");
              onSelect(stagedFiles[0]);
            }}
          >
            {t("查看已暂存变更")}
          </Button>
        )}
      </div>
      <CardSplit
        field="commitDetailsHeight"
        orientation="vertical"
        side="end"
        contentMinSize={120}
        label={t("提交说明与选项")}
        panel={
          <aside className="commit-details" aria-label={t("提交说明与选项")}>
            {children}
          </aside>
        }
      >
        <section className="commit-stage-files" aria-label={t("选择提交文件")}>
          <FileTree
            files={changes.files}
            selected={selected}
            onSelect={onSelect}
            search={search}
            onSearch={onSearch}
            searchId="commit-file-search"
            loaded={loaded}
            scope={scope}
            onScope={onScope}
            disabled={disabled}
            onStage={onStage}
            onDiscard={onDiscard}
            onRecovery={onRecovery}
            workspacePath={changes.workspace.path}
          />
        </section>
      </CardSplit>
    </section>
  );
}
