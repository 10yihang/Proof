import { useEffect, useId, useRef, useState } from "react";
import { ArrowsLeftRight, ArrowRight, GitDiff } from "@phosphor-icons/react";
import { asError, useRequest } from "../api";
import { fileKey } from "../types";
import type {
  ChangedFile,
  Changes,
  FileDiff,
  Preferences,
  ProofError,
} from "../types";
import { FileTree } from "./FileTree";
import { DiffView } from "./DiffView";
import { demoChanges, demoDiff } from "../demo";
export interface HistoryComparison {
  base?: string;
  target: string;
  baseLabel?: string;
  targetLabel?: string;
  parent?: number;
  parents?: string[];
  unavailable?: string;
}
interface Comparison {
  baseOid: string;
  targetOid: string;
  files: ChangedFile[];
}
export function HistoryDiff({
  changes,
  demo,
  preferences,
  onPreferences,
  selection,
}: {
  changes: Changes;
  demo: boolean;
  preferences: Preferences;
  onPreferences: (p: Partial<Preferences>) => void;
  selection: HistoryComparison;
}) {
  const request = useRequest();
  const searchId = useId();
  const [result, setResult] = useState<Comparison | null>(null),
    [diff, setDiff] = useState<FileDiff | null>(null);
  const [selected, setSelected] = useState<string | null>(null),
    [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false),
    [loadingFile, setLoadingFile] = useState(false),
    [error, setError] = useState<ProofError | null>(null),
    [reverseKey, setReverseKey] = useState<string | null>(null);
  const sequence = useRef(0),
    fileSequence = useRef(0),
    cache = useRef(new Map<string, FileDiff>());
  const selectionKey = `${selection.base ?? "parent"}:${selection.target}:${selection.parent ?? 0}`;
  const reversed = !!selection.base && reverseKey === selectionKey;
  useEffect(() => {
    const n = ++sequence.current;
    ++fileSequence.current;
    setResult(null);
    setDiff(null);
    setSelected(null);
    setError(null);
    setLoadingFile(false);
    setSearch("");
    if (selection.unavailable) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const base = reversed ? selection.target : selection.base,
      target = reversed ? selection.base! : selection.target;
    const task = demo
      ? Promise.resolve({
          baseOid: base ?? "empty",
          targetOid: target,
          files:
            base === target
              ? []
              : demoChanges.files.filter((f) => f.side === "unstaged"),
        })
      : base
        ? request<Comparison>("compare_refs", {
            workspaceId: changes.workspace.id,
            base,
            target,
          })
        : request<Comparison>("compare_commit", {
            workspaceId: changes.workspace.id,
            oid: target,
            parent: selection.parent ?? 0,
          });
    task
      .then((value) => {
        if (n !== sequence.current) return;
        setResult(value);
        if (value.files[0]) void select(value.files[0], value);
      })
      .catch((e) => {
        if (n === sequence.current) setError(asError(e));
      })
      .finally(() => {
        if (n === sequence.current) setLoading(false);
      });
    return () => {
      ++sequence.current;
      ++fileSequence.current;
    };
  }, [
    changes.workspace.id,
    demo,
    selection.base,
    selection.target,
    selection.parent,
    selection.unavailable,
    reversed,
  ]);
  async function select(file: ChangedFile, scope: Comparison) {
    const n = ++fileSequence.current;
    setSelected(fileKey(file));
    setError(null);
    const key = `${scope.baseOid}:${scope.targetOid}:${file.path}`,
      cached = cache.current.get(key);
    setDiff(cached ?? null);
    setLoadingFile(!cached);
    if (cached) return;
    try {
      const value = demo
        ? demoDiff(file)
        : await request<FileDiff>("compare_file", {
            workspaceId: changes.workspace.id,
            base: scope.baseOid,
            target: scope.targetOid,
            path: file.path,
          });
      if (n !== fileSequence.current) return;
      cache.current.set(key, value);
      if (cache.current.size > 64)
        cache.current.delete(cache.current.keys().next().value!);
      setDiff(value);
    } catch (e) {
      if (n === fileSequence.current) setError(asError(e));
    } finally {
      if (n === fileSequence.current) setLoadingFile(false);
    }
  }
  const short = (id: string) =>
    id === "empty" ? "Empty tree" : id.slice(0, 8);
  const left = reversed ? selection.targetLabel : selection.baseLabel,
    right = reversed ? selection.baseLabel : selection.targetLabel;
  return (
    <section className="history-diff" aria-label="历史文件差异">
      <div className="compare-capture">
        <span className="history-endpoint" title={result?.baseOid}>
          <code>{result ? short(result.baseOid) : "…"}</code>
          {left && <span>{left}</span>}
        </span>
        <ArrowRight size={13} />
        <span className="history-endpoint" title={result?.targetOid}>
          <code>
            {result ? short(result.targetOid) : short(selection.target)}
          </code>
          {right && <span>{right}</span>}
        </span>
        {selection.base && (
          <button
            className="icon-button"
            aria-label="交换比较方向"
            title="交换比较方向"
            onClick={() => setReverseKey(reversed ? null : selectionKey)}
          >
            <ArrowsLeftRight size={14} />
          </button>
        )}
        <span className="toolbar-spacer" />
        <span>
          {loading
            ? "读取中…"
            : result
              ? `${result.files.length} files changed`
              : ""}
        </span>
      </div>
      {error && (
        <div className="inline-notice" role="alert">
          {error.message} · {error.code}
        </div>
      )}
      <div className="compare-content">
        <aside className="compare-files">
          <FileTree
            readOnly
            files={result?.files ?? []}
            selected={selected}
            onSelect={(f) => result && void select(f, result)}
            search={search}
            onSearch={setSearch}
            searchId={`history-file-search-${searchId}`}
            loaded={{}}
            scope="all"
            onScope={() => {}}
            disabled
            onStage={() => {}}
          />
        </aside>
        <div className="center-panel">
          {diff && result ? (
            <DiffView
              diff={diff}
              preferences={preferences}
              pending={loadingFile}
              onPreferences={onPreferences}
              onMark={() => {}}
              onStage={() => {}}
              onDiscard={() => {}}
              onFocus={() => {}}
              onEditor={() => {}}
              openingEditor={false}
              onLoadContext={async () => ({
                snapshotId: diff.id,
                contextLines: 3,
                gaps: [],
              })}
              comparison={{
                base: short(result.baseOid),
                target: short(result.targetOid),
              }}
            />
          ) : (
            <div className="compare-empty">
              <GitDiff size={30} />
              <h3>
                {selection.unavailable ??
                  (loading || loadingFile
                    ? "正在读取 Diff…"
                    : error
                      ? "无法读取 Diff"
                      : result?.files.length
                        ? "选择文件查看 Diff"
                        : "没有文件差异")}
              </h3>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
