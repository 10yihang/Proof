import { t } from "../i18n";
import { useState, type ReactNode } from "react";
import { FileTree } from "./FileTree";
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
  children: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | Side>("all");
  return (
    <section className="commit-workspace" aria-label={t("Commit 工作区")}>
      <section className="commit-stage-files" aria-label={t("选择提交文件")}>
        <FileTree
          files={changes.files}
          selected={selected}
          onSelect={onSelect}
          search={search}
          onSearch={setSearch}
          searchId="commit-file-search"
          loaded={loaded}
          scope={scope}
          onScope={setScope}
          disabled={disabled}
          onStage={onStage}
          onDiscard={onDiscard}
          onRecovery={onRecovery}
          workspacePath={changes.workspace.path}
        />
      </section>
      <aside className="commit-details" aria-label={t("提交说明与选项")}>
        {children}
      </aside>
    </section>
  );
}
