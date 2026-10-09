import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowLeft } from "@phosphor-icons/react";
import { asError, useRequest } from "../api";
import type { AiFinding } from "../ai";
import type { ProofError } from "../types";
import { t, uiMessage } from "../i18n";
import {
  findingDisplayRange,
  findingLocationReason,
  findingLocationStatusLabel,
  findingLocationSourceLabel,
  findingWorkspaceInvalidated,
  findingLocationTargetKey,
  type FindingLineRange,
  type FindingLocationResult,
  type FindingLocationTarget,
} from "../finding-location";
import { MonacoTextSurface, type TextSurfaceHandle } from "./MonacoTextSurface";
import { Button } from "./ui/controls";
import "../styles/finding-location.css";

export function FindingLocationBody({
  result,
  mode,
  candidate,
  onCandidate,
  fontSize,
  findingTitle,
}: {
  result: FindingLocationResult;
  mode: "current" | "original";
  candidate: FindingLineRange | null;
  onCandidate: (range: FindingLineRange) => void;
  fontSize: number;
  findingTitle?: string;
}) {
  const handle = useRef<TextSurfaceHandle | null>(null);
  const document = result[mode];
  const range = findingDisplayRange(result, mode, candidate);
  const reason = findingLocationReason(result.reason);
  return (
    <>
      <div className={`finding-location-status ${result.status}`} role="status">
        <div className="finding-location-annotation">
          {findingTitle && (
            <strong className="finding-location-title">{findingTitle}</strong>
          )}
          <span className="finding-location-status-label">
            {findingLocationStatusLabel(result.status)}
          </span>
        </div>
        {reason && <p>{reason}</p>}
      </div>
      {result.status === "ambiguous" && mode === "current" && (
        <div className="finding-location-candidates">
          <p>{t("请选择候选位置后查看，Proof 不会自动选择。")}</p>
          <div>
            {result.candidates.map((value, index) => (
              <Button
                key={`${value.line}:${value.endLine}`}
                className="button compact"
                aria-pressed={
                  candidate?.line === value.line &&
                  candidate.endLine === value.endLine
                }
                onClick={() => onCandidate(value)}
              >
                {t("候选 {v0} · 第 {v1}–{v2} 行", {
                  v0: index + 1,
                  v1: value.line,
                  v2: value.endLine,
                })}
              </Button>
            ))}
          </div>
          {candidate && (
            <p role="status">{t("已选候选位置，仍需人工确认。")}</p>
          )}
        </div>
      )}
      {document && (
        <div className="finding-location-document-meta">
          <span>{findingLocationSourceLabel(document.source, mode)}</span>
          <span>
            {range
              ? t("第 {v0}–{v1} 行", { v0: range.line, v1: range.endLine })
              : t("范围未确认")}
          </span>
        </div>
      )}
      {document ? (
        <div
          className="finding-location-code"
          data-finding-line={range?.line}
          data-finding-end-line={range?.endLine}
          data-finding-source={document.source}
          data-source-start-line={document.startLine}
        >
          <MonacoTextSurface
            key={`${mode}:${document.path}:${document.fingerprint}`}
            workspaceId={result.workspaceId}
            path={document.path}
            contentKey={`finding:${mode}:${document.fingerprint}`}
            initialContent={document.content}
            readOnly
            fontSize={fontSize}
            handleRef={handle}
            range={range}
            lineNumberStart={document.startLine}
          />
        </div>
      ) : (
        <div className="finding-location-empty" role="status">
          {t("此版本没有可显示的文本。")}
        </div>
      )}
      <p className="finding-location-note">
        {mode === "current"
          ? t("当前文件只读，人工 Reviewed 状态不变。")
          : t("原始审查代码，只读。")}
      </p>
    </>
  );
}

export function FindingLocationPane({
  target,
  finding,
  fontSize,
  onClose,
  active = true,
  refreshToken,
}: {
  target: FindingLocationTarget;
  finding: AiFinding;
  fontSize: number;
  onClose: () => void;
  active?: boolean;
  /** Verified workspace token supplies refreshes even when a push invalidation is lost. */
  refreshToken?: string;
}) {
  const request = useRequest();
  const identity = findingLocationTargetKey(target);
  const sequence = useRef(0);
  const [loaded, setLoaded] = useState<{
    identity: string;
    value: FindingLocationResult;
  } | null>(null);
  const [failure, setFailure] = useState<{
    identity: string;
    value: ProofError;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState<"current" | "original">("current");
  const [candidate, setCandidate] = useState<FindingLineRange | null>(null);
  const result = active && loaded?.identity === identity ? loaded.value : null;
  const error = failure?.identity === identity ? failure.value : null;
  useEffect(() => {
    setMode("current");
  }, [identity]);
  useEffect(() => {
    const generation = ++sequence.current;
    setLoaded(null);
    setFailure(null);
    setCandidate(null);
    setLoading(active);
    if (!active) return;
    const invalidated = () => {
      ++sequence.current;
      setLoaded(null);
      setFailure(null);
      setCandidate(null);
      setLoading(true);
      setRefresh((value) => value + 1);
    };
    const workspaceChanged = (event: Event) => {
      if (
        findingWorkspaceInvalidated(
          target.workspaceId,
          (event as CustomEvent).detail,
        )
      )
        invalidated();
    };
    const resumed = () => {
      if (document.visibilityState !== "hidden") invalidated();
    };
    window.addEventListener("proof:data-session-changed", invalidated);
    window.addEventListener("proof:workspace-invalidated", workspaceChanged);
    window.addEventListener("focus", resumed);
    document.addEventListener("visibilitychange", resumed);
    void request<FindingLocationResult>("resolve_finding_location", {
      ...target,
    })
      .then((value) => {
        if (sequence.current !== generation) return;
        if (value.workspaceId !== target.workspaceId)
          throw new Error("Finding workspace mismatch");
        setLoaded({ identity, value });
      })
      .catch((cause) => {
        if (sequence.current === generation)
          setFailure({ identity, value: asError(cause) });
      })
      .finally(() => {
        if (sequence.current === generation) setLoading(false);
      });
    return () => {
      ++sequence.current;
      window.removeEventListener("proof:data-session-changed", invalidated);
      window.removeEventListener(
        "proof:workspace-invalidated",
        workspaceChanged,
      );
      window.removeEventListener("focus", resumed);
      document.removeEventListener("visibilitychange", resumed);
    };
  }, [identity, active, refresh, refreshToken, request]);
  const path = result?.[mode]?.path ?? result?.path ?? finding.file;
  return (
    <div
      className="finding-location-pane"
      data-status={result?.status ?? "loading"}
      aria-label={t("Finding 位置")}
    >
      <header className="finding-location-header">
        <div className="finding-location-topbar">
          <div className="finding-location-path">
            <code title={path}>{path}</code>
            <span className="tag">{t("Read-only")}</span>
          </div>
          <Button
            className="button compact finding-location-back"
            onClick={onClose}
          >
            <ArrowLeft size={14} />
            {t("返回 Diff")}
          </Button>
        </div>
        <div className="finding-location-toolbar">
          <div className="finding-location-versions">
            <Button
              className="button compact"
              aria-pressed={mode === "current"}
              onClick={() => setMode("current")}
            >
              {t("当前位置")}
            </Button>
            <Button
              className="button compact"
              aria-pressed={mode === "original"}
              disabled={!result?.original}
              onClick={() => setMode("original")}
            >
              {t("审查原位置")}
            </Button>
          </div>
          <Button
            className="button compact"
            disabled={loading || !active}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <ArrowClockwise size={14} />
            {t("刷新位置")}
          </Button>
        </div>
        {!result && (
          <strong className="finding-location-title finding-location-pending-title">
            {finding.title}
          </strong>
        )}
      </header>
      {loading && (
        <div className="finding-location-empty" role="status">
          {t("正在定位 Finding…")}
        </div>
      )}
      {error && (
        <div className="finding-location-error" role="alert">
          <strong>{t("定位失败，请刷新重试。")}</strong>
          <p>{uiMessage(error.message)}</p>
        </div>
      )}
      {result && (
        <FindingLocationBody
          key={`${identity}:${refresh}`}
          result={result}
          mode={mode}
          candidate={candidate}
          onCandidate={setCandidate}
          fontSize={fontSize}
          findingTitle={finding.title}
        />
      )}
    </div>
  );
}
