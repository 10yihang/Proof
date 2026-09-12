import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  Circle,
  ArrowCounterClockwise,
  Plus,
  Minus,
  Copy,
  CaretDown,
  CaretUp,
  TextAlignLeft,
  ArrowsOutSimple,
  MagnifyingGlass,
  Code,
  Warning,
  Trash,
  ClockCounterClockwise,
} from "@phosphor-icons/react";
import type { DiffLine, FileDiff, Preferences } from "../types";

import { rowsForHunk } from "../diff-model";
import type { DiffRow as Row } from "../diff-model";

export function DiffView({
  diff,
  preferences,
  pending,
  onMark,
  onStage,
  onDiscard,
  onHistory,
  onPreferences,
  onFocus,
}: {
  diff: FileDiff;
  preferences: Preferences;
  pending: boolean;
  onMark: (hunkId: string | null, reviewed: boolean) => void;
  onStage: (hunkId: string | null) => void;
  onDiscard: (hunkId: string | null) => void;
  onHistory?: () => void;
  onPreferences: (p: Partial<Preferences>) => void;
  onFocus: () => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const [raw, setRaw] = useState(false),
    [search, setSearch] = useState(""),
    [searchOpen, setSearchOpen] = useState(false);
  const [activeHunk, setActiveHunk] = useState(0);
  const split = preferences.diffMode === "split";
  const rows = useMemo<Row[]>(
    () =>
      diff.hunks.flatMap((hunk) => [
        { kind: "header" as const, hunk },
        ...rowsForHunk(hunk, split),
      ]),
    [diff, split],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: (index) =>
      rows[index].kind === "header" ? 48 : preferences.fontSize + 13,
    overscan: 25,
  });
  const reviewed = diff.hunks.filter(
    (h) => h.reviewState === "reviewed",
  ).length;
  function goHunk(index: number) {
    const next = Math.max(0, Math.min(index, diff.hunks.length - 1));
    setActiveHunk(next);
    virtualizer.scrollToIndex(
      rows.findIndex(
        (row) => row.kind === "header" && row.hunk.id === diff.hunks[next].id,
      ),
      { align: "start" },
    );
  }
  return (
    <section
      className="diff-panel"
      aria-label="代码差异"
      style={
        { "--code-size": `${preferences.fontSize}px` } as React.CSSProperties
      }
    >
      <div className="diff-topbar">
        <header className="diff-file-header">
          <div className="file-title">
            <Code size={20} />
            <div>
              <strong>{diff.path.split("/").pop()}</strong>
              <span>
                {diff.oldPath ? `${diff.oldPath} → ` : ""}
                {diff.path}
              </span>
            </div>
          </div>
          <div className="diff-tally">
            <span className="addition">+{diff.additions}</span>
            <span className="deletion">−{diff.deletions}</span>
          </div>
        </header>
        <div className="diff-toolbar">
          <div className="segmented small">
            <button
              aria-pressed={!split}
              onClick={() => onPreferences({ diffMode: "unified" })}
            >
              统一
            </button>
            <button
              aria-pressed={split}
              onClick={() => onPreferences({ diffMode: "split" })}
            >
              并排
            </button>
          </div>
          <span className="comparison">
            <span>{diff.side === "staged" ? "HEAD" : "Index"}</span>
            <span aria-hidden="true">→</span>
            <span>{diff.side === "staged" ? "Index" : "工作树"}</span>
          </span>
          <div className="toolbar-spacer" />
          <button
            className="icon-button"
            title="文件历史与 Blame"
            aria-label="文件历史与 Blame"
            disabled={!onHistory || pending}
            onClick={onHistory}
          >
            <ClockCounterClockwise size={17} />
          </button>
          <button
            className={`icon-button ${preferences.wrapLines ? "selected" : ""}`}
            aria-label="切换自动换行"
            title="自动换行"
            aria-pressed={preferences.wrapLines}
            onClick={() => onPreferences({ wrapLines: !preferences.wrapLines })}
          >
            <TextAlignLeft size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="搜索文件内容"
            title="搜索文件内容"
            onClick={() => setSearchOpen(!searchOpen)}
          >
            <MagnifyingGlass size={17} />
          </button>
          <button
            className={`icon-button ${raw ? "selected" : ""}`}
            aria-label="查看原始 patch"
            title="原始 patch"
            aria-pressed={raw}
            onClick={() => setRaw(!raw)}
          >
            <Code size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="进入专注审查"
            title="专注审查"
            onClick={onFocus}
          >
            <ArrowsOutSimple size={17} />
          </button>
        </div>
      </div>
      {searchOpen && (
        <div className="diff-search">
          <MagnifyingGlass size={16} />
          <input
            autoFocus
            aria-label="搜索当前 Diff"
            placeholder="在当前 Diff 中查找…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              const index = rows.findIndex(
                (row) =>
                  row.kind === "line" &&
                  (row.left?.content.includes(e.target.value) ||
                    row.right?.content.includes(e.target.value)),
              );
              if (index >= 0) virtualizer.scrollToIndex(index);
            }}
          />
          <span>
            {search
              ? rows.filter(
                  (row) =>
                    row.kind === "line" &&
                    (row.left?.content.includes(search) ||
                      row.right?.content.includes(search)),
                ).length
              : 0}{" "}
            行
          </span>
        </div>
      )}
      {diff.notice && (
        <div className="inline-notice">
          <Warning size={16} />
          <span>{diff.notice}</span>
        </div>
      )}
      {raw ? (
        <div className="raw-patch">
          <button
            className="button subtle"
            onClick={() => {
              void navigator.clipboard.writeText(diff.patch);
            }}
          >
            <Copy size={15} />
            复制 patch
          </button>
          <pre>{diff.patch}</pre>
        </div>
      ) : (
        <div
          ref={parent}
          className={`diff-scroll ${split ? "is-split" : ""} ${preferences.wrapLines ? "wrap-code" : ""}`}
          tabIndex={0}
          aria-label="只读代码，按 Alt 加上下方向键切换变化块"
          onKeyDown={(e) => {
            if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              goHunk(activeHunk + (e.key === "ArrowDown" ? 1 : -1));
            }
          }}
        >
          {split && (
            <div className="split-labels">
              <span>{diff.side === "staged" ? "HEAD" : "Index"} · 修改前</span>
              <span>
                {diff.side === "staged" ? "Index" : "工作树"} · 修改后
              </span>
            </div>
          )}
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="virtual-row"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === "header" ? (
                    <div
                      className={`hunk-header ${row.hunk.reviewState === "reviewed" ? "is-reviewed" : ""}`}
                    >
                      <button
                        className="hunk-review"
                        title={
                          row.hunk.reviewState === "reviewed"
                            ? "撤销审查标记"
                            : "标记当前变化块已审查"
                        }
                        aria-label={`${row.hunk.reviewState === "reviewed" ? "撤销审查" : "标记已审查"}：第 ${row.hunk.newStart} 行`}
                        aria-pressed={row.hunk.reviewState === "reviewed"}
                        disabled={pending}
                        onClick={() =>
                          onMark(
                            row.hunk.id,
                            row.hunk.reviewState !== "reviewed",
                          )
                        }
                      >
                        {row.hunk.reviewState === "reviewed" ? (
                          <Check weight="bold" size={16} />
                        ) : row.hunk.reviewState === "needs_review" ? (
                          <ArrowCounterClockwise size={16} />
                        ) : (
                          <Circle size={16} />
                        )}
                      </button>
                      <code>{row.hunk.header}</code>
                      <span className="hunk-state">
                        {row.hunk.reviewState === "reviewed"
                          ? "已审查"
                          : row.hunk.reviewState === "needs_review"
                            ? "待复核"
                            : "未审查"}
                      </span>
                      <button
                        className="hunk-stage"
                        disabled={
                          pending ||
                          !diff.canStageHunks ||
                          !row.hunk.lines.length
                        }
                        title={
                          diff.canStageHunks && row.hunk.lines.length > 0
                            ? "仅操作此变化块"
                            : "当前变化不支持 Hunk 操作"
                        }
                        onClick={() => onStage(row.hunk.id)}
                      >
                        {diff.side === "staged" ? (
                          <Minus size={13} />
                        ) : (
                          <Plus size={13} />
                        )}
                        {diff.side === "staged" ? "撤销暂存" : "暂存"}
                      </button>
                      {diff.side === "unstaged" && (
                        <button
                          className="icon-button"
                          disabled={
                            pending ||
                            !diff.canDiscardHunks ||
                            !row.hunk.lines.length
                          }
                          title={
                            diff.canDiscardHunks
                              ? "预览丢弃此 Hunk"
                              : (diff.discardReason ?? "此 Hunk 不支持丢弃")
                          }
                          aria-label={`预览丢弃 Hunk：第 ${row.hunk.newStart} 行`}
                          onClick={() => onDiscard(row.hunk.id)}
                        >
                          <Trash size={15} />
                        </button>
                      )}
                    </div>
                  ) : split ? (
                    <div className="split-row">
                      <CodeCell line={row.left} side="old" search={search} />
                      <CodeCell
                        line={row.right ?? null}
                        side="new"
                        search={search}
                      />
                    </div>
                  ) : (
                    <CodeCell line={row.left} search={search} />
                  )}
                </div>
              );
            })}
          </div>
          {diff.hunks.every((h) => !h.lines.length) && (
            <div className="special-file">
              <Code size={30} />
              <h3>
                {(
                  {
                    binary: "二进制文件发生变化",
                    symlink: "符号链接发生变化",
                    submodule: "子模块引用发生变化",
                    metadata: "文件属性发生变化",
                    conflict: "文件存在冲突",
                  } as Record<string, string>
                )[diff.kind] ?? "文件变化"}
              </h3>
              <p>检查文件属性与原始 patch 后，可以记录本次人工审查。</p>
              <button className="button" onClick={() => setRaw(true)}>
                查看原始 patch
              </button>
            </div>
          )}
        </div>
      )}
      <footer className="diff-footer">
        <div className="hunk-navigation">
          <button
            className="icon-button"
            title="上一个变化块"
            aria-label="上一个变化块"
            onClick={() => goHunk(activeHunk - 1)}
          >
            <CaretUp size={15} />
          </button>
          <button
            className="icon-button"
            title="下一个变化块"
            aria-label="下一个变化块"
            onClick={() => goHunk(activeHunk + 1)}
          >
            <CaretDown size={15} />
          </button>
          <span>{diff.hunks.length} 个变化块</span>
        </div>
        <div className="toolbar-spacer" />
        <span>
          {reviewed}/{diff.hunks.length} 已审查
        </span>
        <button
          className="button compact"
          disabled={pending}
          onClick={() => onMark(null, reviewed !== diff.hunks.length)}
        >
          <Check size={15} />
          {reviewed === diff.hunks.length ? "撤销文件标记" : "标记整个文件"}
        </button>
      </footer>
    </section>
  );
}

function CodeCell({
  line,
  side,
  search,
}: {
  line: DiffLine | null;
  side?: "old" | "new";
  search: string;
}) {
  if (!line) return <div className="code-cell empty-code" />;
  return (
    <div className={`code-cell line-${line.kind}`}>
      {!side && (
        <span className="line-number" aria-hidden="true">
          {line.oldLine}
        </span>
      )}
      <span className="line-number" aria-hidden="true">
        {side === "old" ? line.oldLine : line.newLine}
      </span>
      <span className="line-sign" aria-hidden="true">
        {line.kind === "add" ? "+" : line.kind === "delete" ? "−" : ""}
      </span>
      <code>
        <Highlight text={line.content} search={search} />
      </code>
    </div>
  );
}
function Highlight({ text, search }: { text: string; search: string }) {
  if (search && text.includes(search))
    return (
      <>
        {text.split(search).map((part, i) => (
          <span key={i}>
            {i > 0 && <mark>{search}</mark>}
            {part}
          </span>
        ))}
      </>
    );
  // Conservative lexical color only; original text remains verbatim/selectable.
  if (text.trimStart().startsWith("//") || text.trimStart().startsWith("#"))
    return <span className="syntax-comment">{text}</span>;
  return (
    <>
      {text
        .split(
          /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\b(?:import|from|export|async|await|const|let|function|return|if|else|new|throw|class|interface|type|try|catch|true|false|null|undefined)\b)/g,
        )
        .map((part, index) => (
          <span
            key={index}
            className={
              /^['"]/.test(part)
                ? "syntax-string"
                : /^(import|from|export|async|await|const|let|function|return|if|else|new|throw|class|interface|type|try|catch|true|false|null|undefined)$/.test(
                      part,
                    )
                  ? "syntax-keyword"
                  : undefined
            }
          >
            {part}
          </span>
        ))}
    </>
  );
}
