import { Button, Input } from "./ui/controls";
import { t } from "../i18n";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
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
import { FileActionItems, FileActionsButton } from "./FileActions";
import { GitContextMenu } from "./HistoryActions";

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
  searchId = "file-search",
  readOnly = false,
  onDiscard,
  onRecovery,
  workspacePath,
  reviewProgress,
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
  searchId?: string;
  readOnly?: boolean;
  onDiscard?: (files: ChangedFile[]) => void;
  onRecovery?: () => void;
  workspacePath?: string;
  reviewProgress?: { reviewed: number; total: number };
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
  const selectionAnchor = useRef<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    files: ChangedFile[];
    x: number;
    y: number;
  } | null>(null);
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
    () =>
      treeRows(files, readOnly ? "unstaged" : scope, search, mode, collapsed),
    [files, scope, search, mode, collapsed, readOnly],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: (i) => (rows[i].kind === "group" ? 36 : 32),
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
  const operations = {
    disabled,
    readOnly,
    workspacePath,
    onStage,
    onDiscard,
    onRecovery,
  };
  function menuFiles(row: TreeRow) {
    return row.kind === "file"
      ? checked.has(row.key)
        ? selectedFiles
        : [row.file]
      : row.files;
  }
  function openMenu(row: TreeRow, x: number, y: number) {
    setMenu({ files: menuFiles(row), x, y });
  }
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
  function selectFile(
    file: ChangedFile,
    event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey">,
  ) {
    const key = fileKey(file);
    if (!readOnly) {
      if (event.shiftKey) {
        const anchor = rows.findIndex(
          (row) => row.key === (selectionAnchor.current ?? selected),
        );
        const end = rows.findIndex((row) => row.key === key);
        const range = rows.slice(
          Math.min(anchor < 0 ? end : anchor, end),
          Math.max(anchor, end) + 1,
        );
        setChecked(
          new Set(
            range.filter((row) => row.kind === "file").map((row) => row.key),
          ),
        );
      } else if (event.metaKey || event.ctrlKey) {
        setChecked((previous) => {
          const next = new Set(
            previous.size ? previous : selected ? [selected] : [],
          );
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        selectionAnchor.current = key;
      } else {
        setChecked(new Set());
        selectionAnchor.current = key;
      }
    }
    onSelect(file);
  }
  return (
    <>
      <div
        className="sidebar-heading file-heading"
        role="group"
        aria-label={readOnly ? t("Changed files") : t("Local changes")}
      >
        <div className="file-search">
          <MagnifyingGlass size={15} />
          <Input
            id={searchId}
            aria-label={t("搜索变化文件")}
            placeholder={t("Filter files…")}
            value={search}
            onChange={(event) => onSearch(event.target.value)}
          />
          {!readOnly && <kbd>{t("⌘ P")}</kbd>}
        </div>

        {!readOnly && reviewProgress && (
          <span
            className="review-progress"
            title={`${t("Review")} ${reviewProgress.reviewed}/${reviewProgress.total} ${t("hunks reviewed")}`}
          >
            <span
              className="progress-circle"
              style={
                {
                  "--progress": `${reviewProgress.total ? (reviewProgress.reviewed / reviewProgress.total) * 100 : 0}%`,
                } as CSSProperties
              }
            />
            <span>
              {reviewProgress.reviewed}/{reviewProgress.total}
            </span>
          </span>
        )}

        <Button
          className="icon-button"
          aria-label={t("文件树视图")}
          title={t("Tree view")}
          aria-pressed={mode === "tree"}
          onClick={() => chooseView("tree")}
        >
          <TreeStructure size={16} />
        </Button>
        <Button
          className="icon-button"
          aria-label={t("文件列表视图")}
          title={t("List view")}
          aria-pressed={mode === "list"}
          onClick={() => chooseView("list")}
        >
          <List size={16} />
        </Button>
      </div>
      {!readOnly && (
        <div className="file-filters" role="group" aria-label={t("比较范围")}>
          {(
            [
              ["all", t("All")],
              ["unstaged", "Unstaged"],
              ["staged", "Staged"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              aria-pressed={scope === value}
              onClick={() => onScope(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      <div
        className="file-tree"
        ref={parent}
        role="tree"
        aria-label={t("变化文件树")}
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
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            const rect = target.getBoundingClientRect();
            openMenu(row, rect.left, rect.bottom + 4);
            return;
          }
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
                onContextMenu={(event) => {
                  event.preventDefault();
                  openMenu(row, event.clientX, event.clientY);
                }}
                className={`file-tree-row ${row.kind} ${selected === row.key ? "is-selected" : ""}`}
                style={{
                  position: "absolute",
                  top: 0,
                  width: "max-content",
                  minWidth: "100%",
                  transform: `translateY(${item.start}px)`,
                  height: item.size,
                  paddingLeft: 8 + (row.depth - 1) * 20,
                }}
              >
                {row.kind === "file" ? (
                  <>
                    {!readOnly && (
                      <Input
                        type="checkbox"
                        className="file-check absolute left-1.5 after:-inset-1"
                        aria-label={t("选择 {v0} ({v1})", {
                          v0: row.file.path,
                          v1: row.side,
                        })}
                        checked={checked.has(row.key)}
                        onChange={(event) => {
                          selectionAnchor.current = row.key;
                          setChecked((previous) => {
                            const next = new Set(previous);
                            if (event.target.checked) next.add(row.key);
                            else next.delete(row.key);
                            return next;
                          });
                        }}
                      />
                    )}
                    <Button
                      className="tree-file"
                      tabIndex={-1}
                      onClick={(event) => selectFile(row.file, event)}
                      title={
                        readOnly
                          ? row.file.path
                          : `${row.file.path}\n${row.side === "staged" ? t("HEAD → Index") : t("Index → Worktree")}`
                      }
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
                    </Button>
                    {!readOnly && (
                      <Button
                        className="row-stage"
                        disabled={disabled || row.file.conflicted}
                        aria-label={`${row.side === "staged" ? "Unstage" : "Stage"} ${row.file.path}`}
                        title={
                          row.side === "staged"
                            ? t("Unstage file")
                            : t("Stage file")
                        }
                        onClick={() => onStage([row.file], row.side)}
                      >
                        {row.side === "staged" ? (
                          <Minus size={14} />
                        ) : (
                          <Plus size={14} />
                        )}
                      </Button>
                    )}
                    <FileActionsButton files={menuFiles(row)} {...operations} />
                  </>
                ) : (
                  <>
                    <Button
                      className={
                        row.kind === "group" ? "tree-group" : "tree-folder"
                      }
                      tabIndex={-1}
                      aria-label={t("{v0} 文件夹", {
                        v0:
                          readOnly && row.kind === "group"
                            ? t("Files")
                            : row.label,
                      })}
                      onClick={() => toggle(row.key)}
                    >
                      {row.expanded ? (
                        <CaretDown size={12} />
                      ) : (
                        <CaretRight size={12} />
                      )}{" "}
                      {row.kind === "folder" &&
                        (row.expanded ? (
                          <FolderOpen size={17} weight="duotone" />
                        ) : (
                          <Folder size={17} weight="duotone" />
                        ))}
                      <span>
                        {readOnly && row.kind === "group"
                          ? t("Files")
                          : row.label}
                      </span>
                      <small>{row.files.length}</small>
                    </Button>
                    {!readOnly && (
                      <Button
                        className="row-stage"
                        disabled={disabled || !row.files.length}
                        aria-label={`${row.side === "staged" ? "Unstage" : "Stage"} ${row.kind === "group" ? (search ? t("filtered files") : t("all")) : row.label}`}
                        title={t("{v0} {v1} files", {
                          v0: row.side === "staged" ? "Unstage" : "Stage",
                          v1: row.files.length,
                        })}
                        onClick={() => onStage(row.files, row.side)}
                      >
                        {row.side === "staged" ? (
                          <Minus size={14} />
                        ) : (
                          <Plus size={14} />
                        )}{" "}
                        {row.kind === "group" &&
                          (row.side === "staged" ? "Unstage" : t("Stage all"))}
                      </Button>
                    )}
                    <FileActionsButton
                      files={row.files}
                      label={t("{v0} 的目录操作", { v0: row.label })}
                      {...operations}
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
        {!rows.some((row) => row.kind === "file") && (
          <p className="empty-list">
            {search
              ? t("没有匹配的文件")
              : files.length
                ? t("展开文件夹查看变化")
                : t("Worktree clean")}
          </p>
        )}
      </div>
      {!readOnly && (
        <div className="file-selection-actions">
          <span>
            {selectedFiles.length ? (
              <>
                {selectedFiles.length} {t(" selected")}
              </>
            ) : (
              <>
                {files.length} {t(" files")}
              </>
            )}
          </span>
          {(["unstaged", "staged"] as const).map((side) => {
            const batch = selectedFiles.filter((file) => file.side === side);
            return (
              !!batch.length && (
                <Button
                  key={side}
                  disabled={disabled}
                  onClick={() => {
                    onStage(batch, side);
                  }}
                  aria-label={t("{v0} selected files", {
                    v0: side === "staged" ? "Unstage" : "Stage",
                  })}
                >
                  {side === "staged" ? <Minus size={13} /> : <Plus size={13} />}{" "}
                  {side === "staged" ? "Unstage" : "Stage"} {batch.length}
                </Button>
              )
            );
          })}
          {onDiscard &&
            selectedFiles.some((file) => file.side === "unstaged") && (
              <Button
                className="danger-text"
                disabled={
                  disabled ||
                  selectedFiles.some(
                    (file) => file.side === "unstaged" && file.conflicted,
                  )
                }
                onClick={() =>
                  onDiscard(
                    selectedFiles.filter((file) => file.side === "unstaged"),
                  )
                }
              >
                {t("Discard…")}
              </Button>
            )}
          {selectedFiles.length > 0 ? (
            <Button onClick={() => setChecked(new Set())}>{t("清除")}</Button>
          ) : (
            <small>{t("⌘/Ctrl 点击多选")}</small>
          )}
        </div>
      )}
      {menu && (
        <GitContextMenu
          x={menu.x}
          y={menu.y}
          label={t("文件操作")}
          onClose={() => setMenu(null)}
        >
          <FileActionItems
            files={menu.files}
            {...operations}
            onClose={() => setMenu(null)}
          />
        </GitContextMenu>
      )}
    </>
  );
}
