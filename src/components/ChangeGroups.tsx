import { AiTaskProgress } from "./AiTaskProgress";
import { Segmented } from "./ui/segmented";
import { DragDropProvider, DragOverlay } from "@dnd-kit/react";
import { useReducedMotion } from "motion/react";
import { DraggableGroupFile, GroupDropZone } from "./ui/group-drag";
import { toast } from "./ui/toast";
import { Button, Select, Input } from "./ui/controls";
import { uiMessage, t, riskLabel } from "../i18n";
import { useRef, useState } from "react";
import {
  CaretDown,
  CaretRight,
  PencilSimple,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import { moveGroupedFile, type AiController, type AiGroup } from "../ai";
import { fileKey, type ChangedFile } from "../types";
export function GroupingToolbar({
  ai,
  onGroup,
}: {
  ai: AiController;
  onGroup: () => void;
}) {
  return (
    <div className="grouping-toolbar">
      <Segmented
        value={ai.view}
        onChange={ai.setView}
        label={t("Files display")}
        items={[
          { value: "files", label: t("Files") },
          { value: "groups", label: t("Change groups") },
        ]}
      />
      <Button
        className="icon-button"
        aria-label={t("AI Group Changes")}
        title={t("Group changes with {v0}", {
          v0:
            ai.providers.find((p) => p.id === ai.provider)?.name ??
            t("a local Coding Agent"),
        })}
        disabled={!ai.canRun || !ai.groupReady}
        onClick={onGroup}
      >
        <Sparkle size={16} />
      </Button>
    </div>
  );
}
export function ChangeGroups({
  ai,
  files,
  selected,
  onSelect,
  token,
}: {
  ai: AiController;
  files: ChangedFile[];
  selected: string | null;
  onSelect: (file: ChangedFile) => void;
  token: string;
}) {
  const dragVersion = useRef<{ token: string; revision: number } | null>(null);
  const reduced = useReducedMotion();
  const [collapsed, setCollapsed] = useState(new Set<number>());
  const [renaming, setRenaming] = useState<number | null>(null),
    [title, setTitle] = useState("");
  const groups = ai.visibleGroups;
  const grouped = new Set(groups.flatMap((g) => g.files));
  const ungrouped = files.filter((f) => !grouped.has(f.path));
  function save(next: AiGroup[]) {
    void ai.save(
      next.map((g) =>
        ai.groups.sourceToken && ai.groups.sourceToken !== token
          ? { ...g, risk: "unknown" as const }
          : g,
      ),
    );
  }
  function fileRow(file: ChangedFile) {
    const current = groups.findIndex((g) => g.files.includes(file.path));
    const separator = file.path.lastIndexOf("/");
    return (
      <DraggableGroupFile
        key={fileKey(file)}
        id={fileKey(file)}
        path={file.path}
        selected={selected === fileKey(file)}
        disabled={ai.saving}
      >
        <Button
          className="group-file-select"
          aria-label={file.path}
          onClick={() => onSelect(file)}
          title={file.path}
        >
          <span className={`file-status ${file.status}`}>{file.status}</span>
          <span className="group-file-label">
            <span className="group-file-name">
              {file.path.slice(separator + 1)}
            </span>
            {separator > 0 && (
              <span className="group-file-directory">
                {file.path.slice(0, separator)}
              </span>
            )}
          </span>
          {file.side === "staged" && <small>Staged</small>}
        </Button>
        <Select
          className="group-file-move"
          popupClassName="group-file-move-menu"
          aria-label={t("Move {v0} {v1}", { v0: file.path, v1: file.side })}
          title={t("Move file to group")}
          value={current < 0 ? "none" : current}
          disabled={ai.saving}
          onChange={(e) => {
            if (e.target.value === "new")
              save([
                ...moveGroupedFile(groups, file.path, null),
                {
                  title: t("New change"),
                  summary: t("Manual group"),
                  files: [file.path],
                  risk: "unknown",
                  reviewPriority: 3,
                },
              ]);
            else
              save(
                moveGroupedFile(
                  groups,
                  file.path,
                  e.target.value === "none" ? null : Number(e.target.value),
                ),
              );
          }}
        >
          <option value="none">{t("Ungrouped")}</option>
          {groups.map((group, i) => (
            <option value={i} key={i}>
              {group.title}
            </option>
          ))}
          <option value="new">{t("New group…")}</option>
        </Select>
      </DraggableGroupFile>
    );
  }
  return (
    <DragDropProvider
      onDragStart={() => {
        dragVersion.current = { token, revision: ai.groups.revision };
      }}
      onDragEnd={({ operation, canceled }) => {
        const snapshot = dragVersion.current;
        dragVersion.current = null;
        if (
          canceled ||
          !snapshot ||
          !operation.source ||
          !operation.target ||
          ai.saving
        )
          return;
        if (
          snapshot.token !== token ||
          snapshot.revision !== ai.groups.revision
        ) {
          toast.add({
            title: t("分组或 Diff 已更新，请重新拖动。"),
            type: "info",
          });
          return;
        }
        const path = operation.source.data.path,
          group = operation.target.data.group;
        if (
          typeof path !== "string" ||
          !files.some((file) => file.path === path) ||
          (group !== null && (typeof group !== "number" || !groups[group]))
        )
          return;
        save(moveGroupedFile(groups, path, group));
      }}
    >
      <div className="change-groups">
        {ai.pending === "grouping" && <AiTaskProgress ai={ai} />}
        {ai.suggestion && (
          <div className="ai-group-suggestion">
            <p>{t("新的 AI 分组已准备好。")}</p>
            <Button
              className="button"
              disabled={ai.saving || ai.suggestionStale}
              onClick={() => void ai.save(ai.suggestion!.groups)}
            >
              {t("Apply groups")}
            </Button>
            {ai.suggestionStale && <p>{t("Diff 已变化，请重新分组。")}</p>}
          </div>
        )}
        {ai.error && (
          <div className="ai-error" role="alert">
            <span>
              {uiMessage(ai.error.message)}
              <details>
                <summary>
                  {t("Failure details · ")}
                  {ai.error.code}
                </summary>
                <pre>{ai.error.detail}</pre>
              </details>
            </span>
          </div>
        )}
        {groups.length > 0 && (
          <div className="group-list-heading">
            <span>
              {groups.length} {t(" changes")}
            </span>
            <Button
              className="text-button"
              disabled={ai.saving}
              onClick={() => save([])}
            >
              {t("Ungroup all")}
            </Button>
          </div>
        )}
        {groups.length > 0 && ai.groups.sourceToken !== token && (
          <p className="ai-help group-note">
            {t("Diff 已变化，分组风险需重新分析。")}
          </p>
        )}
        {groups.map((group, index) => (
          <GroupDropZone key={index} group={index} disabled={ai.saving}>
            <header>
              <Button
                className="group-toggle"
                aria-expanded={!collapsed.has(index)}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(index)) next.delete(index);
                    else next.add(index);
                    return next;
                  })
                }
              >
                {collapsed.has(index) ? (
                  <CaretRight size={13} />
                ) : (
                  <CaretDown size={13} />
                )}
                {renaming !== index && (
                  <strong title={group.title}>{group.title}</strong>
                )}
              </Button>
              {renaming === index && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (title.trim()) {
                      save(
                        groups.map((g, i) =>
                          i === index ? { ...g, title: title.trim() } : g,
                        ),
                      );
                      setRenaming(null);
                    }
                  }}
                >
                  <Input
                    autoFocus
                    aria-label={t("Group name")}
                    value={title}
                    maxLength={160}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                  <Button className="text-button" type="submit">
                    {t("Save")}
                  </Button>
                </form>
              )}
              <span
                className={`ai-risk ${ai.groups.sourceToken === token ? group.risk : "unknown"}`}
                title={t("{v0} · Review priority {v1}", {
                  v0: riskLabel(
                    ai.groups.sourceToken === token ? group.risk : "unknown",
                  ),
                  v1: group.reviewPriority,
                })}
              >
                {t("P")}
                {group.reviewPriority}
              </span>
              <Button
                className="icon-button"
                aria-label={t("Rename {v0}", { v0: group.title })}
                disabled={ai.saving}
                onClick={() => {
                  setRenaming(index);
                  setTitle(group.title);
                }}
              >
                <PencilSimple size={13} />
              </Button>
              <Button
                className="icon-button"
                aria-label={t("Ungroup {v0}", { v0: group.title })}
                disabled={ai.saving}
                onClick={() => save(groups.filter((_, i) => i !== index))}
              >
                <X size={13} />
              </Button>
            </header>
            {!collapsed.has(index) && (
              <>
                <p className="change-group-summary">{group.summary}</p>
                {files.filter((f) => group.files.includes(f.path)).map(fileRow)}
              </>
            )}
          </GroupDropZone>
        ))}
        {(!!ungrouped.length || groups.length > 0) && (
          <GroupDropZone group={null} disabled={ai.saving} ungrouped>
            <header>
              <strong>{t("Ungrouped")}</strong>
              <span>{new Set(ungrouped.map((f) => f.path)).size}</span>
            </header>
            {ungrouped.map(fileRow)}
          </GroupDropZone>
        )}
        {!files.length && <p className="ai-empty">{t("No local changes")}</p>}
      </div>
      <DragOverlay dropAnimation={reduced ? null : { duration: 150 }}>
        {(source) => (
          <span className="rounded-md border border-border bg-popover px-3 py-2 text-[12px] text-popover-foreground shadow-xl">
            {String(source.data.path)}
          </span>
        )}
      </DragOverlay>
    </DragDropProvider>
  );
}
