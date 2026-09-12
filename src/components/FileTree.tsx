import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CaretDown,
  Check,
  Circle,
  FileCode,
  FileText,
  Folder,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { fileKey } from "../types";
import type { ChangedFile, FileDiff } from "../types";

export function FileTree({
  files,
  selected,
  onSelect,
  search,
  onSearch,
  loaded,
  scope,
  onScope,
}: {
  files: ChangedFile[];
  selected: string | null;
  onSelect: (file: ChangedFile) => void;
  search: string;
  onSearch: (s: string) => void;
  loaded: Record<string, FileDiff>;
  scope: "all" | "unstaged" | "staged";
  onScope: (scope: "all" | "unstaged" | "staged") => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const visible = useMemo(
    () =>
      files.filter(
        (f) =>
          (scope === "all" || f.side === scope) &&
          f.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
      ),
    [files, scope, search],
  );
  const rows = useMemo(() => {
    const result: (
      | { kind: "group"; label: string; count: number }
      | { kind: "folder"; label: string }
      | { kind: "file"; file: ChangedFile }
    )[] = [];
    for (const side of ["unstaged", "staged"]) {
      const sideFiles = visible
        .filter((f) => f.side === side)
        .sort((a, b) => a.path.localeCompare(b.path));
      if (!sideFiles.length) continue;
      result.push({
        kind: "group",
        label: side === "staged" ? "已暂存" : "未暂存",
        count: sideFiles.length,
      });
      let lastDirectory = "";
      for (const file of sideFiles) {
        const dir = file.path.includes("/")
          ? file.path.slice(0, file.path.lastIndexOf("/"))
          : "";
        if (dir && dir !== lastDirectory)
          result.push({ kind: "folder", label: dir });
        lastDirectory = dir;
        result.push({ kind: "file", file });
      }
    }
    return result;
  }, [visible]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: (i) => (rows[i].kind === "group" ? 42 : 34),
    overscan: 12,
  });
  return (
    <>
      <div className="sidebar-heading">
        <strong>变化文件</strong>
        <span className="count-badge">{files.length}</span>
      </div>
      <div className="file-search">
        <MagnifyingGlass size={16} />
        <input
          id="file-search"
          aria-label="搜索变化文件"
          placeholder="查找文件…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        <kbd>⌘ P</kbd>
      </div>
      <div className="file-filters" role="group" aria-label="比较范围">
        {(
          [
            ["all", "全部"],
            ["unstaged", "未暂存"],
            ["staged", "已暂存"],
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
      <div className="file-tree" ref={parent} aria-label="变化文件列表">
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            return (
              <div
                key={item.key}
                style={{
                  position: "absolute",
                  top: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                  height: item.size,
                }}
              >
                {row.kind === "group" ? (
                  <div className="tree-group">
                    <CaretDown size={12} />
                    <span>{row.label}</span>
                    <span>{row.count}</span>
                  </div>
                ) : row.kind === "folder" ? (
                  <div className="tree-folder">
                    <Folder size={14} />
                    <span>{row.label}</span>
                  </div>
                ) : (
                  (() => {
                    const file = row.file,
                      key = fileKey(file),
                      diff = loaded[key];
                    const reviewed =
                      diff &&
                      diff.hunks.every((h) => h.reviewState === "reviewed");
                    return (
                      <button
                        className={`tree-file ${selected === key ? "is-selected" : ""}`}
                        aria-current={selected === key ? "true" : undefined}
                        onClick={() => onSelect(file)}
                        title={`${file.path}\n${file.side === "staged" ? "HEAD → Index" : "Index → 工作树"}`}
                      >
                        {file.path.endsWith(".md") ? (
                          <FileText size={16} />
                        ) : (
                          <FileCode size={16} />
                        )}
                        <span className="tree-filename">
                          {file.path.split("/").pop()}
                        </span>
                        <span
                          className={`file-status status-${file.status === "?" ? "new" : file.status}`}
                          aria-label={
                            (
                              {
                                M: "修改",
                                A: "新增",
                                D: "删除",
                                R: "重命名",
                                "?": "未跟踪",
                                U: "冲突",
                              } as Record<string, string>
                            )[file.status]
                          }
                        >
                          {file.status === "?" ? "U" : file.status}
                        </span>
                        {reviewed ? (
                          <Check
                            className="review-check"
                            size={13}
                            weight="bold"
                          />
                        ) : (
                          <Circle className="review-empty" size={12} />
                        )}
                      </button>
                    );
                  })()
                )}
              </div>
            );
          })}
        </div>
        {!visible.length && (
          <p className="empty-list">
            {files.length ? "没有匹配的变化文件" : "当前工作区没有代码变化"}
          </p>
        )}
      </div>
      <div className="sidebar-footnote">
        <Circle size={12} />
        <span>审查标记绑定当前代码版本</span>
      </div>
    </>
  );
}
