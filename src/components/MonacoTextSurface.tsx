import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { MutableRefObject } from "react";

/** 文本编辑器实例的句柄（父组件读取当前内容/聚焦/重置脏基线）。 */
export interface TextSurfaceHandle {
  getValue(): string;
  focus(): void;
  /** 保存成功后调用：当前内容成为新的脏判定基线。 */
  markSaved(): void;
  /** 切换模型行尾（状态栏 LF/CRLF 切换；会使内容变脏）。 */
  setEol(eol: "lf" | "crlf"): void;
}

export interface EditorCursor {
  line: number;
  column: number;
  /** 当前选中的字符数（0 = 无选区）。 */
  selected: number;
}

interface Runtime {
  monaco: typeof import("monaco-editor/editor/editor.api");
  registerTextTokens(path: string): { id: string; dispose(): void };
}

/**
 * 轻量 Monaco 文本编辑器：懒加载 monaco-runtime、Prism 语法高亮（proof.* token
 * 主题与 Diff 视图一致）、⌘S 保存动作、主题跟随。仅承担展示与事件，内容的所有权
 * 在父组件（EditorView）——通过 key 重建切换文件/版本。
 */
export function MonacoTextSurface({
  workspaceId,
  path,
  contentKey,
  initialContent,
  readOnly,
  fontSize,
  handleRef,
  onDirtyChange,
  onCursorChange,
  onSave,
}: {
  workspaceId: string;
  path: string;
  /** 内容代际：变化时重建 model（切文件/版本/外部重载）。 */
  contentKey: string;
  initialContent: string;
  readOnly: boolean;
  fontSize: number;
  handleRef: MutableRefObject<TextSurfaceHandle | null>;
  onDirtyChange?: (dirty: boolean) => void;
  onCursorChange?: (cursor: EditorCursor) => void;
  onSave?: (content: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // 回调随渲染更新，编辑器实例始终调最新版本（避免闭包陈旧）。
  const latest = useRef({ onDirtyChange, onCursorChange, onSave });
  latest.current = { onDirtyChange, onCursorChange, onSave };
  useEffect(() => {
    const hostEl = host.current;
    if (!hostEl) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    setLoading(true);
    setFailed(false);
    void import("../monaco-runtime")
      .then((runtime: Runtime) => {
        if (cancelled || !host.current) return;
        const api = runtime.monaco;
        api.editor.setTheme(
          document.documentElement.dataset.theme === "dark"
            ? "proof-dark"
            : "proof-light",
        );
        const tokens = runtime.registerTextTokens(path);
        const uri = api.Uri.from({
          scheme: "proof-file",
          path: `/${workspaceId}/${contentKey}/${path}`,
        });
        const existing = api.editor.getModel(uri);
        const model =
          existing ?? api.editor.createModel(initialContent, tokens.id, uri);
        if (existing) {
          existing.setValue(initialContent);
          // 语言随文件路径更新（同一 uri 复用场景）。
          api.editor.setModelLanguage(existing, tokens.id);
        }
        const editor = api.editor.create(hostEl, {
          model,
          readOnly,
          domReadOnly: readOnly,
          automaticLayout: false,
          contextmenu: true,
          fixedOverflowWidgets: true,
          minimap: { enabled: true, renderCharacters: false, maxColumn: 80 },
          folding: true,
          links: false,
          occurrencesHighlight: "off",
          codeLens: false,
          wordBasedSuggestions: "off",
          quickSuggestions: { other: "off", comments: "off", strings: "off" },
          parameterHints: { enabled: false },
          hover: { enabled: "off" },
          scrollBeyondLastLine: false,
          hideCursorInOverviewRuler: true,
          fontSize,
          lineHeight: fontSize + 13,
          fontFamily: "SFMono-Regular, Menlo, Consolas, monospace",
          fontLigatures: false,
          renderWhitespace: "none",
          stickyScroll: { enabled: false },
          guides: { indentation: true },
          padding: { top: 8, bottom: 8 },
          scrollbar: {
            vertical: "visible",
            horizontal: "visible",
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
            useShadows: false,
            alwaysConsumeMouseWheel: false,
          },
          ariaLabel: readOnly ? t("文件内容，只读") : t("编辑文件内容"),
        });
        // 用 Monaco 的版本号追踪脏状态：undo 回到保存点时自动消除 dirty。
        let savedVersion = model.getAlternativeVersionId();
        const reportCursor = () => {
          const position = editor.getPosition();
          const selection = editor.getSelection();
          if (!position) return;
          latest.current.onCursorChange?.({
            line: position.lineNumber,
            column: position.column,
            selected:
              selection && !selection.isEmpty()
                ? model.getValueLengthInRange(selection)
                : 0,
          });
        };
        const disposables = [
          editor.onDidChangeModelContent(() => {
            latest.current.onDirtyChange?.(
              model.getAlternativeVersionId() !== savedVersion,
            );
          }),
          editor.onDidChangeCursorPosition(reportCursor),
          editor.onDidChangeCursorSelection(reportCursor),
        ];
        if (onSave)
          disposables.push(
            editor.addAction({
              id: "proof.save-text-file",
              label: t("保存文件"),
              keybindings: [api.KeyMod.CtrlCmd | api.KeyCode.KeyS],
              run: (instance) => latest.current.onSave?.(instance.getValue()),
            }),
          );
        disposables.push(
          editor.addAction({
            id: "proof.copy-file-path",
            label: t("复制文件路径"),
            contextMenuGroupId: "9_proof",
            run: () => void navigator.clipboard.writeText(path),
          }),
        );
        reportCursor();
        const observer = new ResizeObserver(() => editor.layout());
        observer.observe(hostEl);
        const themeObserver = new MutationObserver(() =>
          api.editor.setTheme(
            document.documentElement.dataset.theme === "dark"
              ? "proof-dark"
              : "proof-light",
          ),
        );
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        handleRef.current = {
          getValue: () => model.getValue(),
          focus: () => editor.focus(),
          // 保存后父组件调 markSaved 重置脏基线。
          markSaved: () => {
            savedVersion = model.getAlternativeVersionId();
            latest.current.onDirtyChange?.(false);
          },
          setEol: (eol) =>
            model.setEOL(
              eol === "crlf"
                ? api.editor.EndOfLineSequence.CRLF
                : api.editor.EndOfLineSequence.LF,
            ),
        };
        setLoading(false);
        cleanup = () => {
          for (const disposable of disposables) disposable.dispose();
          observer.disconnect();
          themeObserver.disconnect();
          editor.dispose();
          model.dispose();
          tokens.dispose();
          handleRef.current = null;
        };
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
      cleanup?.();
    };
    // contentKey 变化 = 父组件要求整体重建（切文件/版本/重载）。
  }, [contentKey]);
  return (
    <div className="editor-surface" data-loading={loading || undefined}>
      {loading && !failed && (
        <div className="editor-loading">{t("正在打开代码视图…")}</div>
      )}
      {failed && (
        <div className="editor-loading" role="alert">
          {t("编辑器加载失败，请重试。")}
        </div>
      )}
      <div className="editor-host" ref={host} />
    </div>
  );
}
