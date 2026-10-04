import { t } from "../i18n";
import type { ReactNode } from "react";
import { FileTree } from "./FileTree";
import { CardSplit } from "./CardSplit";
import {
  fileKey,
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
  return (
    <section className="commit-workspace" aria-label={t("Commit 工作区")}>
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
            onScope={(value) => {
              onScope(value);
              if (value === "staged") {
                onSearch("");
                const staged = changes.files.filter(
                  (file) => file.side === "staged",
                );
                if (
                  !staged.some((file) => fileKey(file) === selected) &&
                  staged[0]
                )
                  onSelect(staged[0]);
              }
            }}
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
