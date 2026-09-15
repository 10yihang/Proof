import { useEffect, useRef, useState } from "react";
import { asError, useRequest } from "./api";
import type { AiReport, AgentKind } from "./ai";
import type { ProofError } from "./types";
import { publishDiffEvent } from "./diff-events";

export type FindingDecision = "pending" | "accepted" | "dismissed";
export interface AiReviewRecord {
  id: string;
  capturedAt: number;
  provider: AgentKind;
  summary: string;
}
export function useAiReports(
  workspace: string | undefined,
  scope: string,
  demo: boolean,
) {
  const request = useRequest();
  const [report, setReport] = useState<AiReport | null>(null);
  const [reports, setReports] = useState<AiReviewRecord[]>([]);
  const [reportLoading, setLoading] = useState(false);
  const [decisionSaving, setSaving] = useState(false);
  const [reportError, setError] = useState<ProofError | null>(null);
  const current = useRef(report);
  current.current = report;
  const generation = useRef(0),
    sequence = useRef(0),
    saving = useRef(false);
  const refreshAfterSave = useRef(false);
  const refresh = useRef<(() => void) | null>(null);
  useEffect(() => {
    const gen = ++generation.current;
    ++sequence.current;
    current.current = null;
    saving.current = false;
    refreshAfterSave.current = false;
    setReport(null);
    setReports([]);
    setError(null);
    setSaving(false);
    setLoading(false);
    const reload = async (event?: Event) => {
      if (!workspace || !scope || demo) return;
      const detail = (event as CustomEvent | undefined)?.detail;
      if (
        detail &&
        (detail.workspaceId !== workspace ||
          detail.scope !== scope ||
          (detail.reportId === current.current?.id &&
            detail.revision <= (current.current?.revision ?? -1)))
      )
        return;
      if (saving.current) {
        refreshAfterSave.current = true;
        return;
      }
      const seq = ++sequence.current;
      const valid = () =>
        gen === generation.current && seq === sequence.current;
      try {
        setLoading(true);
        const records = await request<AiReviewRecord[]>("ai_review_reports", {
          workspaceId: workspace,
          scope,
        });
        if (!valid()) return;
        setReports(records);
        const id =
          records.find((r) => r.id === current.current?.id)?.id ??
          records[0]?.id;
        const value = id
          ? await request<AiReport>("ai_review_report", {
              workspaceId: workspace,
              reportId: id,
            })
          : null;
        if (valid()) {
          setReport(value);
          current.current = value;
        }
      } catch (error) {
        if (valid()) setError(asError(error));
      } finally {
        if (valid()) setLoading(false);
      }
    };
    refresh.current = () => {
      void reload();
    };
    void reload();
    const onRefresh = (event: Event) => {
      void reload(event);
    };
    window.addEventListener("proof:ai-review-updated", onRefresh);
    window.addEventListener("focus", onRefresh);
    return () => {
      ++generation.current;
      ++sequence.current;
      refresh.current = null;
      window.removeEventListener("proof:ai-review-updated", onRefresh);
      window.removeEventListener("focus", onRefresh);
    };
  }, [workspace, scope, demo, request]);
  function acceptReport(value: AiReport) {
    ++sequence.current;
    setLoading(false);
    setError(null);
    setReport(value);
    current.current = value;
    setReports((previous) =>
      [
        {
          id: value.id,
          capturedAt: value.capturedAt,
          provider: value.provider,
          summary: value.review?.summary ?? "",
        },
        ...previous.filter((r) => r.id !== value.id),
      ].sort((a, b) => b.capturedAt - a.capturedAt),
    );
    publishDiffEvent("proof:ai-review-updated", {
      workspaceId: workspace,
      scope,
      reportId: value.id,
      revision: value.revision,
    });
  }
  async function selectReport(id: string) {
    if (!workspace || demo || saving.current) return;
    const seq = ++sequence.current,
      gen = generation.current;
    setLoading(true);
    setError(null);
    try {
      const value = await request<AiReport>("ai_review_report", {
        workspaceId: workspace,
        reportId: id,
      });
      if (seq === sequence.current && gen === generation.current) {
        setReport(value);
        current.current = value;
      }
    } catch (error) {
      if (seq === sequence.current && gen === generation.current)
        setError(asError(error));
    } finally {
      if (seq === sequence.current && gen === generation.current)
        setLoading(false);
    }
  }
  async function setDecision(index: number, decision: FindingDecision) {
    const value = current.current;
    if (!workspace || !value || demo || saving.current || reportLoading) return;
    const gen = generation.current;
    ++sequence.current;
    saving.current = true;
    setSaving(true);
    setError(null);
    try {
      const next = await request<AiReport>("set_ai_finding_decision", {
        workspaceId: workspace,
        reportId: value.id,
        expectedRevision: value.revision,
        findingIndex: index,
        decision,
      });
      if (gen === generation.current) acceptReport(next);
    } catch (error) {
      if (gen !== generation.current) return;
      setError(asError(error));
      if (asError(error).code === "AI_REVIEW_CHANGED") {
        try {
          const next = await request<AiReport>("ai_review_report", {
            workspaceId: workspace,
            reportId: value.id,
          });
          if (gen === generation.current) {
            setReport(next);
            current.current = next;
          }
        } catch (refreshError) {
          if (gen === generation.current) setError(asError(refreshError));
        }
      }
    } finally {
      if (gen === generation.current) {
        saving.current = false;
        setSaving(false);
        if (refreshAfterSave.current) {
          refreshAfterSave.current = false;
          refresh.current?.();
        }
      }
    }
  }
  return {
    report,
    reports,
    reportLoading,
    reportError,
    decisionSaving,
    acceptReport,
    selectReport,
    setDecision,
  };
}
