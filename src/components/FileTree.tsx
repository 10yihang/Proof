import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CaretDown,
  CaretRight,
  Check,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  MagnifyingGlass,
  TreeStructure,
  List,
  Plus,
  Minus,
} from "@phosphor-icons/react";
import { fileKey } from "../types";
import type { ChangedFile, FileDiff, Side } from "../types";
import { treeRows, type TreeRow } from "../file-tree";
import { useClientStorage } from "../api";

export function FileTree({
  files,
  selected,
  onSelect,
  search,
  onSearch,
  loaded,
  scope,
  onScope,
  disabled,
  onStage,
}: {
  files: ChangedFile[];
  selected: string | null;
  onSelect: (file: ChangedFile) => void;
  search: string;
  onSearch: (s: string) => void;
  loaded: Record<string, FileDiff>;
  scope: "all" | Side;
  onScope: (scope: "all" | Side) => void;
  disabled: boolean;
  onStage: (files: ChangedFile[], side: Side) => void;
}) {
  const clientStorage = useClientStorage();
  const parent = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"tree" | "list">(() => {
    try {
      return clientStorage.readFileView() === "list" ? "list" : "tree";
    } catch {
      return "tree";
    }
  });
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [checked, setChecked] = useState(new Set<string>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => {
    setChecked(
      (previous) =>
        new Set(
          [...previous].filter((key) =>
            files.some((file) => fileKey(file) === key),
          ),
        ),
    );
  }, [files]);
  const rows = useMemo(
    () => treeRows(files, scope, search, mode, collapsed),
    [files, scope, search, mode, collapsed],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: (i) => (rows[i].kind === "group" ? 38 : 30),
    getItemKey: (i) => rows[i].key,
    overscan: 14,
  });
  function toggle(key: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function chooseView(value: "tree" | "list") {
    setMode(value);
    try {
      clientStorage.writeFileView(value);
    } catch {
      /* View remains usable for this session. */
    }
  }
  const selectedFiles = files.filter((file) => checked.has(fileKey(file)));
  function focus(index: number) {
    const target = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!target) return;
    setFocusKey(target.key);
    virtualizer.scrollToIndex(index);
    requestAnimationFrame(() => {
      const element = [
        ...(parent.current?.querySelectorAll<HTMLElement>("[data-tree-key]") ??
          []),
      ].find((el) => el.dataset.treeKey === target.key);
      element?.focus();
    });
  }
  function action(row: TreeRow) {
    if (row.kind === "file") onSelect(row.file);
    else toggle(row.key);
  }
  return (
    <>
      <div className="sidebar-heading file-heading">
        <strong>Changes</strong>
        <span className="count-badge">{files.length}</span>
        <span className="toolbar-spacer" />
        <button
          className="icon-button"
          aria-label="文件树视图"
          title="Tree view"
          aria-pressed={mode === "tree"}
          onClick={() => chooseView("tree")}
        >
          <TreeStructure size={16} />
        </button>
        <button
          className="icon-button"
          aria-label="文件列表视图"
          title="List view"
          aria-pressed={mode === "list"}
          onClick={() => chooseView("list")}
        >
          <List size={16} />
        </button>
      </div>
      <div className="file-search">
        <MagnifyingGlass size={15} />
        <input
          id="file-search"
          aria-label="搜索变化文件"
          placeholder="Filter files…"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
        <kbd>⌘ P</kbd>
      </div>
      <div className="file-filters" role="group" aria-label="比较范围">
        {(
          [
            ["all", "All"],
            ["unstaged", "Unstaged"],
            ["staged", "Staged"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            aria-pressed={scope === value}
            onClick={() => onScope(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {selectedFiles.length > 0 && (
        <div className="file-selection-actions">
          <span>{selectedFiles.length} selected</span>
          {(["unstaged", "staged"] as const).map((side) => {
            const batch = selectedFiles.filter((file) => file.side === side);
            return (
              !!batch.length && (
                <button
                  key={side}
                  disabled={disabled}
                  onClick={() => {
                    onStage(batch, side);
                  }}
                  aria-label={`${side === "staged" ? "Unstage" : "Stage"} selected files`}
                >
                  {side === "staged" ? <Minus size={13} /> : <Plus size={13} />}{" "}
                  {side === "staged" ? "Unstage" : "Stage"} {batch.length}
                </button>
              )
            );
          })}
          <button onClick={() => setChecked(new Set())}>清除</button>
        </div>
      )}
      <div
        className="file-tree"
        ref={parent}
        role="tree"
        aria-label="变化文件树"
        onKeyDown={(event) => {
          if (
            !(event.target instanceof HTMLElement) ||
            event.target.matches("input")
          )
            return;
          const target = event.target;
          const index = rows.findIndex(
            (row) =>
              row.key ===
              target.closest<HTMLElement>("[data-tree-key]")?.dataset.treeKey,
          );
          if (index < 0) return;
          const row = rows[index];
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            focus(index + (event.key === "ArrowDown" ? 1 : -1));
          }
          if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            focus(event.key === "Home" ? 0 : rows.length - 1);
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            if (row.kind !== "file" && !row.expanded) toggle(row.key);
            else focus(index + 1);
          }
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (row.kind !== "file" && row.expanded) toggle(row.key);
            else if (row.parent)
              focus(rows.findIndex((item) => item.key === row.parent));
          }
          if (event.key === "Enter" || event.key === " ") {
            if (event.target.matches("[data-tree-key]")) {
              event.preventDefault();
              action(row);
            }
          }
        }}
      >
        <div
          role="none"
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index],
              file = row.kind === "file" ? row.file : null;
            const reviewed =
              file &&
              loaded[fileKey(file)]?.hunks.every(
                (hunk) => hunk.reviewState === "reviewed",
              );
            return (
              <div
                key={row.key}
                role="treeitem"
                aria-level={row.depth}
                aria-expanded={row.kind === "file" ? undefined : row.expanded}
                aria-selected={file ? selected === row.key : undefined}
                data-tree-key={row.key}
                tabIndex={
                  (focusKey ?? selected ?? rows[0]?.key) === row.key ? 0 : -1
                }
                onFocus={() => setFocusKey(row.key)}
                className={`file-tree-row ${row.kind} ${selected === row.key ? "is-selected" : ""}`}
                style={{
                  position: "absolute",
                  top: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                  height: item.size,
                  paddingLeft: 6 + (row.depth - 1) * 12,
                }}
              >
                {row.kind === "file" ? (
                  <>
                    <input
                      type="checkbox"
                      className="file-check"
                      aria-label={`选择 ${row.file.path} (${row.side})`}
                      checked={checked.has(row.key)}
                      onChange={(event) =>
                        setChecked((previous) => {
                          const next = new Set(previous);
                          if (event.target.checked) next.add(row.key);
                          else next.delete(row.key);
                          return next;
                        })
                      }
                    />
                    <button
                      className="tree-file"
                      tabIndex={-1}
                      onClick={() => onSelect(row.file)}
                      title={`${row.file.path}\n${row.side === "staged" ? "HEAD → Index" : "Index → Worktree"}`}
                    >
                      {row.file.path.endsWith(".md") ? (
                        <FileText size={15} />
                      ) : (
                        <FileCode size={15} />
                      )}
                      <span className="tree-filename">
                        {mode === "list"
                          ? row.file.path
                          : row.file.path.split("/").pop()}
                      </span>
                      {reviewed && <Check size={12} className="review-check" />}
                      <span
                        className={`file-status status-${row.file.status === "?" ? "new" : row.file.status}`}
                      >
                        {row.file.status === "?" ? "U" : row.file.status}
                      </span>
                    </button>
                    <button
                      className="row-stage"
                      disabled={disabled || row.file.conflicted}
                      aria-label={`${row.side === "staged" ? "Unstage" : "Stage"} ${row.file.path}`}
                      title={
                        row.side === "staged" ? "Unstage file" : "Stage file"
                      }
                      onClick={() => onStage([row.file], row.side)}
                    >
                      {row.side === "staged" ? (
                        <Minus size={14} />
                      ) : (
                        <Plus size={14} />
                      )}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={
                        row.kind === "group" ? "tree-group" : "tree-folder"
                      }
                      tabIndex={-1}
                      aria-label={`${row.label} 文件夹`}
                      onClick={() => toggle(row.key)}
                    >
                      {row.expanded ? (
                        <CaretDown size={12} />
                      ) : (
                        <CaretRight size={12} />
                      )}{" "}
                      {row.kind === "folder" &&
                        (row.expanded ? (
                          <FolderOpen size={15} />
                        ) : (
                          <Folder size={15} />
                        ))}
                      <span>{row.label}</span>
                      <small>{row.files.length}</small>
                    </button>
                    <button
                      className="row-stage"
                      disabled={disabled || !row.files.length}
                      aria-label={`${row.side === "staged" ? "Unstage" : "Stage"} ${row.kind === "group" ? (search ? "filtered files" : "all") : row.label}`}
                      title={`${row.side === "staged" ? "Unstage" : "Stage"} ${row.files.length} files`}
                      onClick={() => onStage(row.files, row.side)}
                    >
                      {row.side === "staged" ? (
                        <Minus size={14} />
                      ) : (
                        <Plus size={14} />
                      )}{" "}
                      {row.kind === "group" &&
                        (row.side === "staged" ? "Unstage" : "Stage all")}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        {!rows.some((row) => row.kind === "file") && (
          <p className="empty-list">
            {search
              ? "没有匹配的文件"
              : files.length
                ? "展开文件夹查看变化"
                : "Worktree clean"}
          </p>
        )}
      </div>
    </>
  );
}
