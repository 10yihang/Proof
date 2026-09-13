import { useState, type ReactNode } from "react";
import { ArrowRight, FileCode } from "@phosphor-icons/react";
import { FileTree } from "./FileTree";
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
  onOpenDiff,
  children,
}: {
  changes: Changes;
  loaded: Record<string, FileDiff>;
  disabled: boolean;
  onStage: (files: ChangedFile[], side: Side) => void;
  onOpenDiff: (file: ChangedFile) => void;
  children: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | Side>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const selectedFile = changes.files.find((file) => fileKey(file) === selected);
  return (
    <main className="commit-workspace" aria-label="Commit 工作区">
      <section className="commit-stage-files" aria-label="选择提交文件">
        <FileTree
          files={changes.files}
          selected={selected}
          onSelect={(file) => setSelected(fileKey(file))}
          search={search}
          onSearch={setSearch}
          searchId="commit-file-search"
          loaded={loaded}
          scope={scope}
          onScope={setScope}
          disabled={disabled}
          onStage={onStage}
        />
        <div className="commit-file-inspector">
          <FileCode size={16} />
          <span>{selectedFile?.path ?? "选择文件以查看 Diff"}</span>
          <button
            className="button compact"
            disabled={!selectedFile}
            onClick={() => selectedFile && onOpenDiff(selectedFile)}
          >
            查看 Diff <ArrowRight size={14} />
          </button>
        </div>
      </section>
      <aside className="commit-details" aria-label="提交说明与选项">
        {children}
      </aside>
    </main>
  );
}
