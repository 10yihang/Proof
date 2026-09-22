import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listen } from "@tauri-apps/api/event";
import {
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  FilePlus,
  FileText,
  FloppyDisk,
  Folder,
  FolderOpen,
  MagnifyingGlass,
  PencilSimple,
  Trash,
  X,
} from "@phosphor-icons/react";
import { asError, useRequest } from "../api";
import { t, uiMessage } from "../i18n";
import type {
  ChangedFile,
  CommitEntry,
  TextFileContent,
  TextFileState,
} from "../types";
import { repoTreeRows } from "../repo-file-tree";
import { formatSize, toDiskEol } from "../editor-text";
import { fileKind } from "../file-kind";
import { languageLabel } from "../syntax";
import { relativeTime } from "../relative-time";
import {
  MonacoTextSurface,
  type EditorCursor,
  type TextSurfaceHandle,
} from "./MonacoTextSurface";
import { Button, Input } from "./ui/controls";
import { Modal } from "./Modal";

/** Git 状态 → 树角标字母（M 改 / A 增 / U 未跟踪 / D 删 / R 改名）。 */
function badgeOf(status: string | undefined): string | null {
  if (!status) return null;
  if (status === "?") return "U";
  return ["M", "A", "D", "R", "C"].includes(status) ? status : null;
}

/**
 * 「文件」页：浏览仓库全部文件、内置编辑（⌘S 保存）、按文件查看历史版本。
 * 保存走后端指纹乐观锁 + 原子写；外部修改经 workspace-invalidated 感知。
 */
export function EditorView({
  workspaceId,
  fontSize,
  trusted,
  active,
  changedFiles,
  onChanged,
}: {
  workspaceId: string;
  fontSize: number;
  trusted: boolean;
  /** 仅在本页可见时响应快捷键。 */
  active: boolean;
  /** 本地变更文件列表，用于树内 Git 状态角标。 */
  changedFiles?: ChangedFile[];
  /** 保存成功后通知外层刷新 Changes。 */
  onChanged: () => void;
}) {
  const request = useRequest();
  const [files, setFiles] = useState<string[] | null>(null);
  const [search, setSearch] = useState("");
  const [expandedFolders, setExpandedFolders] = useState(new Set<string>());
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<TextFileContent | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [staleExternal, setStaleExternal] = useState(false);
  const [staleDialog, setStaleDialog] = useState(false);
  const [pendingRevision, setPendingRevision] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<CommitEntry[] | null>(
    null,
  );
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<EditorCursor | null>(null);
  const [eol, setEol] = useState<"lf" | "crlf">("lf");
  const [autoSave, setAutoSave] = useState(
    () => localStorage.getItem("proof.editor.autoSave") === "1",
  );
  const [editTick, setEditTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const generation = useRef(0);
  const loadSeq = useRef(0);
  const surface = useRef<TextSurfaceHandle | null>(null);
  const listParent = useRef<HTMLDivElement>(null);
  // 供异步回调读取最新文档/状态，避免闭包陈旧。
  const live = useRef({ doc, dirty, saving, selected, eol });
  live.current = { doc, dirty, saving, selected, eol };

  const rows = useMemo(
    () => repoTreeRows(files ?? [], search, expandedFolders),
    [files, search, expandedFolders],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listParent.current,
    estimateSize: () => 26,
    getItemKey: (index) => rows[index].key,
    overscan: 16,
  });

  // 文件树 Git 角标：同一路径 unstaged 优先于 staged。
  const statusByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of changedFiles ?? []) {
      if (file.side === "staged") map.set(file.path, file.status);
    }
    for (const file of changedFiles ?? []) {
      if (file.side === "unstaged") map.set(file.path, file.status);
    }
    return map;
  }, [changedFiles]);

  const refreshFiles = useCallback(async () => {
    try {
      setFiles(await request<string[]>("list_files", { workspaceId }));
    } catch (cause) {
      setError(uiMessage(asError(cause).message));
    }
  }, [request, workspaceId]);
  useEffect(() => {
    setFiles(null);
    setSelected(null);
    setDoc(null);
    setError(null);
    void refreshFiles();
  }, [refreshFiles]);

  async function openPath(path: string) {
    const gen = ++generation.current;
    setSelected(path);
    setDoc(null);
    setError(null);
    setDirty(false);
    setStaleExternal(false);
    setLoadingFile(true);
    try {
      const content = await request<TextFileContent>("read_text_file", {
        workspaceId,
        path,
      });
      if (gen !== generation.current) return;
      ++loadSeq.current;
      setDoc(content);
      setEol(content.eol === "crlf" ? "crlf" : "lf");
    } catch (cause) {
      if (gen !== generation.current) return;
      setDoc(null);
      setError(uiMessage(asError(cause).message));
    } finally {
      if (gen === generation.current) setLoadingFile(false);
    }
  }

  async function viewRevision(revision: string | null) {
    const path = live.current.selected;
    if (!path) return;
    const gen = ++generation.current;
    setError(null);
    setLoadingFile(true);
    try {
      const content = await request<TextFileContent>("read_text_file", {
        workspaceId,
        path,
        revision,
      });
      if (gen !== generation.current) return;
      ++loadSeq.current;
      setDoc(content);
      setEol(content.eol === "crlf" ? "crlf" : "lf");
      setDirty(false);
    } catch (cause) {
      if (gen !== generation.current) return;
      setError(uiMessage(asError(cause).message));
    } finally {
      if (gen === generation.current) setLoadingFile(false);
    }
  }

  function askRevision(oid: string) {
    if (live.current.dirty) setPendingRevision(oid);
    else void viewRevision(oid);
  }

  async function save(raw?: string) {
    const current = live.current.doc;
    if (!current || current.revision || !current.editable) return;
    if (!live.current.dirty || live.current.saving) return;
    const text = raw ?? surface.current?.getValue() ?? "";
    setSaving(true);
    setError(null);
    try {
      const saved = await request<TextFileState>("save_text_file", {
        workspaceId,
        path: current.path,
        content: toDiskEol(text, live.current.eol),
        expectedFingerprint: current.fingerprint,
      });
      surface.current?.markSaved();
      setDoc({ ...current, fingerprint: saved.fingerprint, size: saved.size });
      setDirty(false);
      setStaleExternal(false);
      onChanged();
    } catch (cause) {
      const failure = asError(cause);
      if (failure.code === "STALE_CONTENT") setStaleDialog(true);
      else setError(uiMessage(failure.message));
    } finally {
      setSaving(false);
    }
  }

  // 强制覆盖：跳过指纹校验重发保存（仅 staleDialog 确认后调用）。
  async function forceSave() {
    const current = live.current.doc;
    if (!current || live.current.saving) return;
    const text = surface.current?.getValue() ?? "";
    setSaving(true);
    setError(null);
    try {
      const saved = await request<TextFileState>("save_text_file", {
        workspaceId,
        path: current.path,
        content: toDiskEol(text, live.current.eol),
        expectedFingerprint: null,
      });
      surface.current?.markSaved();
      setDoc({ ...current, fingerprint: saved.fingerprint, size: saved.size });
      setDirty(false);
      setStaleExternal(false);
      onChanged();
    } catch (cause) {
      setError(uiMessage(asError(cause).message));
    } finally {
      setSaving(false);
    }
  }

  async function createFile() {
    const path = newName.trim().replace(/^\/+|\/+$/g, "");
    setCreating(false);
    setNewName("");
    if (!path) return;
    try {
      await request("create_text_file", { workspaceId, path });
      await refreshFiles();
      expandAncestors(path);
      void openPath(path);
    } catch (cause) {
      setError(uiMessage(asError(cause).message));
    }
  }

  async function renameFile() {
    const from = renaming;
    setRenaming(null);
    if (!from) return;
    const name = renameValue.trim();
    if (!name || name === from.split("/").pop()) return;
    const dir = from.includes("/")
      ? from.slice(0, from.lastIndexOf("/") + 1)
      : "";
    const to = dir + name;
    try {
      await request("rename_text_file", { workspaceId, from, to });
      await refreshFiles();
      expandAncestors(to);
      if (live.current.selected === from) void openPath(to);
      onChanged();
    } catch (cause) {
      setError(uiMessage(asError(cause).message));
    }
  }

  async function deleteFile() {
    const path = deleting;
    setDeleting(null);
    if (!path) return;
    try {
      await request("delete_text_file", { workspaceId, path });
      if (live.current.selected === path) {
        ++generation.current;
        setSelected(null);
        setDoc(null);
        setDirty(false);
      }
      await refreshFiles();
      onChanged();
    } catch (cause) {
      setError(uiMessage(asError(cause).message));
    }
  }

  function toggleEol() {
    const next = live.current.eol === "lf" ? "crlf" : "lf";
    setEol(next);
    // setEOL 改写模型行尾，触发内容变化 → 变脏，保存后生效到磁盘。
    surface.current?.setEol(next);
  }

  function toggleAutoSave() {
    setAutoSave((value) => {
      const next = !value;
      localStorage.setItem("proof.editor.autoSave", next ? "1" : "0");
      return next;
    });
  }

  const handleDirtyChange = useCallback((value: boolean) => {
    setDirty(value);
    if (value) setEditTick((tick) => tick + 1);
  }, []);

  const viewingRevision = doc?.revision ?? null;
  const editable = !!doc && !viewingRevision && doc.editable && trusted;

  // 自动保存：每次编辑后 800ms 防抖；冲突弹窗或报错期间暂停，避免失败重试循环。
  useEffect(() => {
    if (!autoSave || !dirty || saving || !editable || staleExternal) return;
    if (staleDialog || error) return;
    const timer = setTimeout(() => void save(), 800);
    return () => clearTimeout(timer);
  }, [autoSave, dirty, saving, editable, staleExternal, staleDialog, error, editTick]);

  // ⌘S 在本页任何焦点位置都可保存（编辑器内由 Monaco action 捕获，不重复触发）。
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // save 经 live ref 读取最新状态，只需随 active 重挂。
  }, [active]);

  // 外部变更：刷新文件列表；当前文件按指纹比对决定静默重载或提示。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("workspace-invalidated", (event) => {
      if (event.payload !== workspaceId) return;
      void refreshFiles();
      const current = live.current.doc;
      if (
        !current ||
        current.revision ||
        live.current.saving ||
        !live.current.selected
      )
        return;
      const path = current.path;
      void request<TextFileContent>("read_text_file", { workspaceId, path })
        .then((fresh) => {
          const now = live.current.doc;
          if (!now || now.path !== path || now.revision) return;
          if (fresh.fingerprint === now.fingerprint) return;
          if (live.current.dirty) {
            setStaleExternal(true);
            return;
          }
          ++generation.current;
          ++loadSeq.current;
          setDoc(fresh);
          setEol(fresh.eol === "crlf" ? "crlf" : "lf");
          setError(null);
        })
        .catch(() => undefined);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [request, workspaceId, refreshFiles]);

  // 历史栏：打开且有选中文件时加载该文件的提交历史。
  useEffect(() => {
    if (!historyOpen || !selected) return;
    let cancelled = false;
    setHistoryEntries(null);
    setHistoryError(null);
    void request<CommitEntry[]>("history", { workspaceId, path: selected })
      .then((entries) => {
        if (!cancelled) setHistoryEntries(entries);
      })
      .catch((cause) => {
        if (!cancelled) setHistoryError(uiMessage(asError(cause).message));
      });
    return () => {
      cancelled = true;
    };
  }, [historyOpen, selected, request, workspaceId]);

  function toggleFolder(key: string) {
    setExpandedFolders((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // 让 path 在树中可见：展开其全部祖先前缀。压缩链的中间 key 不存在也无害
  // （expanded 只是查找集合），所以按原始前缀逐个加入即可。
  function expandAncestors(path: string) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!dir) return;
    setExpandedFolders((previous) => {
      const next = new Set(previous);
      let prefix = "";
      for (const segment of dir.split("/")) {
        prefix = prefix ? `${prefix}/${segment}` : segment;
        next.add(`folder:${prefix}`);
      }
      return next;
    });
  }

  function startRename(path: string) {
    setRenameValue(path.split("/").pop() ?? path);
    setRenaming(path);
  }

  return (
    <section className="editor-view" aria-label={t("Files")}>
      <aside className="editor-sidebar">
        <div className="sidebar-heading editor-file-heading">
          <div className="file-search editor-file-search">
            <MagnifyingGlass size={15} />
            <Input
              aria-label={t("Filter files…")}
              placeholder={t("Filter files…")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {trusted && (
            <Button
              className="icon-button"
              aria-label={t("新建文件")}
              title={t("新建文件")}
              onClick={() => {
                setNewName("");
                setCreating(true);
              }}
            >
              <FilePlus size={16} />
            </Button>
          )}
        </div>
        {creating && (
          <div className="editor-create-row">
            <FileText size={15} />
            <input
              autoFocus
              placeholder={t("新文件路径，如 docs/note.md")}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") void createFile();
                if (event.key === "Escape") setCreating(false);
              }}
              onBlur={() => setCreating(false)}
            />
          </div>
        )}
        <div className="editor-file-list" ref={listParent}>
          {!files && error && (
            <p className="editor-empty-hint" role="alert">
              {error}
            </p>
          )}
          {files && (
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                const badge =
                  row.kind === "file" ? badgeOf(statusByPath.get(row.path)) : null;
                return (
                  <div
                    key={row.key}
                    className={`editor-tree-row ${row.kind}`}
                    style={{
                      transform: `translateY(${item.start}px)`,
                      paddingLeft: row.depth * 14 + 8,
                    }}
                  >
                    {Array.from({ length: row.depth }, (_, guide) => (
                      <i
                        key={guide}
                        className="editor-indent-guide"
                        style={{ left: guide * 14 + 14 }}
                      />
                    ))}
                    {renaming === row.path ? (
                      <input
                        className="editor-rename-input"
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing) return;
                          if (event.key === "Enter") void renameFile();
                          if (event.key === "Escape") setRenaming(null);
                        }}
                        onBlur={() => setRenaming(null)}
                      />
                    ) : (
                      <button
                        className={`editor-tree-item ${row.kind === "file" && row.path === selected ? "selected" : ""}`}
                        onClick={() =>
                          row.kind === "folder"
                            ? toggleFolder(row.key)
                            : void openPath(row.path)
                        }
                      >
                        {row.kind === "folder" ? (
                          <>
                            {row.expanded ? (
                              <CaretDown size={12} />
                            ) : (
                              <CaretRight size={12} />
                            )}
                            {row.expanded ? (
                              <FolderOpen size={15} />
                            ) : (
                              <Folder size={15} />
                            )}
                            <span>{row.label}</span>
                          </>
                        ) : (
                          (() => {
                            const kind = fileKind(row.path);
                            return (
                              <>
                                <kind.Icon size={15} className={kind.className} />
                                <span>{row.label}</span>
                                {badge && (
                                  <i
                                    className="editor-git-badge"
                                    data-badge={badge}
                                  >
                                    {badge}
                                  </i>
                                )}
                                {row.path === selected && dirty && (
                                  <i
                                    className="editor-dirty-dot"
                                    title={t("未保存的更改")}
                                  />
                                )}
                              </>
                            );
                          })()
                        )}
                      </button>
                    )}
                    {row.kind === "file" && trusted && renaming !== row.path && (
                      <span className="editor-row-actions">
                        <button
                          aria-label={t("重命名")}
                          title={t("重命名")}
                          onClick={(event) => {
                            event.stopPropagation();
                            startRename(row.path);
                          }}
                        >
                          <PencilSimple size={12} />
                        </button>
                        <button
                          aria-label={t("删除")}
                          title={t("删除")}
                          onClick={(event) => {
                            event.stopPropagation();
                            setDeleting(row.path);
                          }}
                        >
                          <Trash size={12} />
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {files && !rows.length && (
            <p className="editor-empty-hint">{t("没有匹配的文件")}</p>
          )}
        </div>
      </aside>
      <div className="editor-main">
        {selected && doc && (
          <header className="editor-titlebar">
            {(() => {
              const kind = fileKind(doc.path);
              return <kind.Icon size={16} className={kind.className} />;
            })()}
            <strong className="editor-path" title={doc.path}>
              {doc.path.split("/").map((segment, index, all) => (
                <span key={index} className="editor-path-segment">
                  {index > 0 && <CaretRight size={10} />}
                  <span
                    className={
                      index === all.length - 1
                        ? "editor-path-file"
                        : "editor-path-dir"
                    }
                  >
                    {segment}
                  </span>
                </span>
              ))}
            </strong>
            {(() => {
              const badge = badgeOf(statusByPath.get(doc.path));
              return (
                badge &&
                !viewingRevision && (
                  <i className="editor-git-badge" data-badge={badge}>
                    {badge}
                  </i>
                )
              );
            })()}
            {dirty && (
              <i className="editor-dirty-dot" title={t("未保存的更改")} />
            )}
            {viewingRevision && (
              <span className="editor-revision-badge">
                {viewingRevision.slice(0, 8)}
              </span>
            )}
            <span className="toolbar-spacer" />
            {viewingRevision && (
              <Button
                className="button compact"
                onClick={() => void viewRevision(null)}
              >
                {t("返回当前版本")}
              </Button>
            )}
            {editable && (
              <Button
                className="button compact"
                disabled={!dirty || saving}
                title={t("保存文件")}
                onClick={() => void save()}
              >
                <FloppyDisk size={15} />
                {t("保存")}
              </Button>
            )}
            <Button
              className={`icon-button ${historyOpen ? "selected" : ""}`}
              aria-label={t("文件历史")}
              title={t("文件历史")}
              aria-pressed={historyOpen}
              onClick={() => setHistoryOpen((value) => !value)}
            >
              <ClockCounterClockwise size={17} />
            </Button>
          </header>
        )}
        {viewingRevision && (
          <p className="editor-banner" role="status">
            {t("正在查看历史版本 {v0}", {
              v0: viewingRevision.slice(0, 8),
            })}
          </p>
        )}
        {staleExternal && !viewingRevision && (
          <p className="editor-banner warning" role="alert">
            {t("文件已在磁盘上更改。")}
            <Button
              className="button compact"
              onClick={() => void openPath(selected!)}
            >
              {t("重新加载")}
            </Button>
          </p>
        )}
        {!trusted && doc && !viewingRevision && (
          <p className="editor-banner" role="status">
            {t("此文件当前不可编辑")}
          </p>
        )}
        <div className="editor-body">
          {!selected && (
            <div className="editor-placeholder">
              <span className="editor-placeholder-icon">
                <FileText size={26} />
              </span>
              <p className="editor-placeholder-title">
                {t("选择要查看或编辑的文件")}
              </p>
              <p className="editor-placeholder-hint">{t("⌘P 快速筛选文件")}</p>
            </div>
          )}
          {selected && loadingFile && !doc && (
            <div className="editor-placeholder">
              <p>{t("正在打开代码视图…")}</p>
            </div>
          )}
          {selected && error && (
            <div className="editor-placeholder" role="alert">
              <p>{error}</p>
              <Button
                className="button compact"
                onClick={() => void openPath(selected)}
              >
                {t("重新加载")}
              </Button>
            </div>
          )}
          {doc && (
            <MonacoTextSurface
              key={`${doc.path}|${doc.revision ?? "current"}|${loadSeq.current}`}
              workspaceId={workspaceId}
              path={doc.path}
              contentKey={`${doc.path}|${doc.revision ?? "current"}|${loadSeq.current}`}
              initialContent={doc.content}
              readOnly={!editable}
              fontSize={fontSize}
              handleRef={surface}
              onDirtyChange={handleDirtyChange}
              onCursorChange={setCursor}
              onSave={(content) => void save(content)}
            />
          )}
        </div>
        {doc && !error && (
          <footer className="editor-statusbar">
            <span className="editor-status-group">
              {cursor && (
                <span className="editor-status-item">
                  {t("行 {v0}，列 {v1}", {
                    v0: String(cursor.line),
                    v1: String(cursor.column),
                  })}
                  {cursor.selected > 0 &&
                    ` ${t("（已选择 {v0} 个字符）", {
                      v0: String(cursor.selected),
                    })}`}
                </span>
              )}
              {dirty && !viewingRevision && (
                <span className="editor-status-dirty">{t("未保存")}</span>
              )}
            </span>
            <span className="editor-status-group">
              {editable && (
                <button
                  className={`editor-status-button ${autoSave ? "on" : ""}`}
                  aria-pressed={autoSave}
                  title={t("自动保存：编辑停顿后自动写入磁盘")}
                  onClick={toggleAutoSave}
                >
                  {t("自动保存")}
                </button>
              )}
              <span className="editor-status-item">
                {languageLabel(doc.path) || t("纯文本")}
              </span>
              {editable ? (
                <button
                  className="editor-status-button"
                  title={t("切换行尾")}
                  onClick={toggleEol}
                >
                  {eol.toUpperCase()}
                </button>
              ) : (
                <span className="editor-status-item">{eol.toUpperCase()}</span>
              )}
              <span className="editor-status-item">{formatSize(doc.size)}</span>
            </span>
          </footer>
        )}
      </div>
      {historyOpen && selected && (
        <aside className="editor-history">
          <div className="editor-history-head">
            <span>{t("文件历史")}</span>
            <Button
              className="icon-button"
              aria-label={t("关闭文件历史")}
              onClick={() => setHistoryOpen(false)}
            >
              <X size={14} />
            </Button>
          </div>
          {historyError && (
            <p className="editor-empty-hint" role="alert">
              {historyError}
            </p>
          )}
          {!historyEntries && !historyError && (
            <p className="editor-empty-hint">{t("正在读取提交关系…")}</p>
          )}
          <ul>
            {historyEntries?.map((entry, index) => (
              <li key={entry.oid}>
                <button
                  className={`editor-history-item ${viewingRevision === entry.oid ? "selected" : ""}`}
                  onClick={() => askRevision(entry.oid)}
                >
                  <span className="editor-history-top">
                    <code>{entry.oid.slice(0, 8)}</code>
                    {index === 0 && (
                      <em className="editor-history-latest">{t("最新")}</em>
                    )}
                  </span>
                  <span className="editor-history-subject">{entry.subject}</span>
                  <small>
                    {entry.author} · {relativeTime(entry.date)}
                  </small>
                </button>
              </li>
            ))}
            {historyEntries && !historyEntries.length && (
              <li className="editor-empty-hint">{t("没有提交历史")}</li>
            )}
          </ul>
        </aside>
      )}
      {staleDialog && doc && (
        <Modal
          title={t("文件已在磁盘上更改。")}
          onClose={() => setStaleDialog(false)}
        >
          <p>{t("文件已在磁盘上更改。")}</p>
          <div className="modal-actions">
            <Button
              className="button"
              onClick={() => {
                setStaleDialog(false);
                if (selected) void openPath(selected);
              }}
            >
              {t("重新加载")}
            </Button>
            <Button
              className="button danger"
              onClick={() => {
                setStaleDialog(false);
                void forceSave();
              }}
            >
              {t("强制覆盖磁盘版本")}
            </Button>
          </div>
        </Modal>
      )}
      {pendingRevision && (
        <Modal
          title={t("未保存的更改")}
          onClose={() => setPendingRevision(null)}
        >
          <p>{t("当前文件有未保存的更改，查看历史版本将丢弃这些更改。")}</p>
          <div className="modal-actions">
            <Button className="button" onClick={() => setPendingRevision(null)}>
              {t("取消")}
            </Button>
            <Button
              className="button danger"
              onClick={() => {
                const oid = pendingRevision;
                setPendingRevision(null);
                void viewRevision(oid);
              }}
            >
              {t("继续查看")}
            </Button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal title={t("删除文件")} onClose={() => setDeleting(null)}>
          <p>{t("确定删除 {v0} 吗？", { v0: deleting })}</p>
          <p className="editor-modal-hint">
            {t("删除后 7 天内可从恢复点找回。")}
            {deleting === selected && dirty
              ? ` ${t("当前未保存的更改将一并丢弃。")}`
              : ""}
          </p>
          <div className="modal-actions">
            <Button className="button" onClick={() => setDeleting(null)}>
              {t("取消")}
            </Button>
            <Button
              className="button danger"
              onClick={() => void deleteFile()}
            >
              {t("删除")}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
