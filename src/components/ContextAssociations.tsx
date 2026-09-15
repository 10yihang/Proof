import { Button, Input, Textarea } from "./ui/controls";
import { t, getLanguage } from "../i18n";
import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  ClockCounterClockwise,
  Link,
  MagnifyingGlass,
  Terminal,
} from "@phosphor-icons/react";
import { asError, useRequest } from "../api";
import type { ProofError } from "../types";
import { Modal } from "./Modal";
import {
  agentName,
  associationReason,
  associationState,
  fieldState,
  type ContextAction,
  type ContextCandidates,
  type ContextCandidateCursor,
  type ContextChange,
  type ContextHistory,
  type ContextLink,
  type ContextMutation,
} from "./context-types";

type Draft = { link: ContextLink; note: string };
export function ContextAssociations({
  workspaceId,
  path,
  initialLink,
  initialHistory = false,
  onClose,
  onChanged,
  onError,
}: {
  workspaceId: string;
  path: string;
  initialLink?: ContextLink;
  initialHistory?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
}) {
  const request = useRequest(),
    noteId = useId();
  const [section, setSection] = useState<"sessions" | "history">(
    initialHistory ? "history" : "sessions",
  );
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<ContextCandidates | null>(null);
  const [history, setHistory] = useState<ContextHistory | null>(null);
  const [selected, setSelected] = useState(initialLink?.session.id ?? null);
  // Keep the revision from when editing started, separate from live Context polling.
  const [drafts, setDrafts] = useState<Record<string, Draft>>(
    initialLink
      ? {
          [initialLink.session.id]: {
            link: initialLink,
            note: initialLink.userOverride?.note ?? "",
          },
        }
      : {},
  );
  const [error, setError] = useState<ProofError | null>(null);
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const lifetime = useRef(0),
    listSequence = useRef(0),
    historySequence = useRef(0),
    writing = useRef(false);
  useEffect(
    () => () => {
      ++lifetime.current;
      ++listSequence.current;
      ++historySequence.current;
    },
    [],
  );
  async function loadCandidates(before: ContextCandidateCursor | null = null) {
    const n = ++listSequence.current;
    setLoading(true);
    try {
      const result = await request<ContextCandidates>("context_candidates", {
        workspaceId,
        path,
        search,
        before,
      });
      if (n === listSequence.current)
        setCandidates((old) => ({
          ...result,
          links: before
            ? [...(old?.links ?? []), ...result.links].filter(
                (link, i, all) =>
                  all.findIndex((l) => l.session.id === link.session.id) === i,
              )
            : result.links,
        }));
    } catch (cause) {
      if (n === listSequence.current) setError(asError(cause));
    } finally {
      if (n === listSequence.current) setLoading(false);
    }
  }
  async function loadHistory(offset = 0) {
    const n = ++historySequence.current;
    setLoading(true);
    try {
      const result = await request<ContextHistory>("context_history", {
        workspaceId,
        path,
        offset,
      });
      if (n === historySequence.current)
        setHistory((old) => ({
          ...result,
          entries: offset
            ? [...(old?.entries ?? []), ...result.entries].filter(
                (entry, i, all) =>
                  all.findIndex((e) => e.id === entry.id) === i,
              )
            : result.entries,
        }));
    } catch (cause) {
      if (n === historySequence.current) setError(asError(cause));
    } finally {
      if (n === historySequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    ++listSequence.current;
    ++historySequence.current;
    setCandidates(null);
    setLoading(true);
    const timer = setTimeout(
      () => void (section === "sessions" ? loadCandidates() : loadHistory()),
      160,
    );
    return () => {
      clearTimeout(timer);
      ++listSequence.current;
      ++historySequence.current;
    };
  }, [section, search]);
  function choose(link: ContextLink) {
    setSelected(link.session.id);
    setError(null);
    setSaved("");
    setDrafts((old) =>
      old[link.session.id]
        ? old
        : {
            ...old,
            [link.session.id]: { link, note: link.userOverride?.note ?? "" },
          },
    );
  }
  const draft = selected ? drafts[selected] : undefined;
  async function reloadSelected() {
    if (!draft || writing.current) return;
    const sessionId = draft.link.session.id,
      n = lifetime.current;
    setLoading(true);
    setError(null);
    setSaved("");
    try {
      const result = await request<ContextCandidates>("context_candidates", {
        workspaceId,
        path,
        search: sessionId,
        before: null,
      });
      if (n !== lifetime.current) return;
      const link = result.links.find((l) => l.session.id === sessionId);
      if (!link)
        throw {
          code: "CONTEXT_SESSION_EXPIRED",
          message: t("会话记录已清理，请选择其他会话。"),
          detail: "Session unavailable",
        };
      setDrafts((old) => ({
        ...old,
        [sessionId]: { ...old[sessionId], link },
      }));
      setSaved(t("已读取最新关联，你输入的备注仍保留。请核对后保存。"));
    } catch (cause) {
      if (n === lifetime.current) setError(asError(cause));
    } finally {
      if (n === lifetime.current) setLoading(false);
    }
  }
  async function mutate(
    action: Exclude<ContextAction, "undo"> | ContextChange,
  ) {
    if (writing.current || (typeof action === "string" && !draft)) return;
    writing.current = true;
    setSaving(true);
    setError(null);
    setSaved("");
    const n = lifetime.current;
    try {
      const result =
        typeof action === "string"
          ? await request<ContextMutation>("update_context_association", {
              workspaceId,
              path,
              sessionId: draft!.link.session.id,
              action,
              note: draft!.note,
              expectedRevision: draft!.link.revision,
            })
          : await request<ContextMutation>("undo_context_association", {
              workspaceId,
              path,
              changeId: action.id,
              expectedRevision: action.revision,
            });
      // A successful write stands on its own; a subsequent read cannot turn it into a failed save.
      onChanged();
      if (n !== lifetime.current) return;
      if (result.change) {
        const change = result.change;
        setDrafts((old) => {
          const previous = old[change.sessionId];
          if (!previous) return old;
          return {
            ...old,
            [change.sessionId]: {
              note: change.after?.note ?? "",
              link: {
                ...previous.link,
                userOverride: change.after,
                revision: result.revision,
                originalEvidence: change.originalEvidence,
                active:
                  change.after?.enabled ??
                  change.originalEvidence.pathEventCount > 0,
              },
            },
          };
        });
      }
      setSaved(
        typeof action === "string"
          ? t("关联已保存")
          : t("已撤销，原修改保留在历史中"),
      );
      if (section === "history") void loadHistory();
      else void loadCandidates();
    } catch (cause) {
      if (n === lifetime.current) setError(asError(cause));
      else
        onError({
          ...asError(cause),
          message: `${path} · ${asError(cause).message}`,
        });
    } finally {
      writing.current = false;
      if (n === lifetime.current) setSaving(false);
    }
  }
  const disabled = saving || loading;
  return (
    <Modal
      title={t("管理会话关联")}
      wide
      className="context-associations"
      onClose={onClose}
      error={error}
    >
      <div className="association-scope">
        <Link size={16} />
        <code>{path}</code>
      </div>
      <p className="inline-help association-intro">
        {t("关联与备注仅保存在 Proof；原始 Hook 记录保持原样。")}
      </p>
      <nav className="association-navigation" aria-label={t("关联管理")}>
        <Button
          aria-current={section === "sessions" ? "page" : undefined}
          disabled={saving}
          onClick={() => setSection("sessions")}
        >
          <Terminal size={15} />
          {t("会话")}
        </Button>
        <Button
          aria-current={section === "history" ? "page" : undefined}
          disabled={saving}
          onClick={() => setSection("history")}
        >
          <ClockCounterClockwise size={15} />
          {t("修改记录")}
        </Button>
      </nav>
      {section === "sessions" ? (
        <div className="association-workspace">
          <section
            className="association-candidates"
            aria-label={t("当前 Worktree 的会话")}
          >
            <label className="association-search">
              <MagnifyingGlass size={15} />
              <Input
                type="search"
                aria-label={t("搜索当前 Worktree 的会话")}
                maxLength={100}
                placeholder={t("Agent、Session ID 或任务")}
                value={search}
                disabled={saving}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <p className="inline-help">
              {t("当前 Worktree · 按会话开始时间排序")}
            </p>
            <div className="association-list">
              {candidates?.links.map((link) => (
                <Button
                  key={link.session.id}
                  className="association-candidate"
                  aria-pressed={selected === link.session.id}
                  disabled={saving}
                  onClick={() => choose(link)}
                >
                  <span>
                    <strong>{agentName(link.session)}</strong>
                    <small>
                      {link.userOverride
                        ? link.userOverride.enabled
                          ? t("用户指定")
                          : t("已解除")
                        : link.active
                          ? t("已关联")
                          : t("未关联")}
                    </small>
                  </span>
                  <code>{link.session.nativeSessionId ?? link.session.id}</code>
                  <p>
                    {link.session.promptExcerpt ??
                      `Prompt · ${fieldState(link.session.promptStatus)}`}
                  </p>
                </Button>
              ))}
              {loading && <p role="status">{t("读取会话中…")}</p>}
              {candidates && !candidates.links.length && !loading && (
                <p className="association-empty">{t("没有找到会话。")}</p>
              )}
              {candidates?.next != null && (
                <Button
                  className="button compact"
                  disabled={disabled}
                  onClick={() => void loadCandidates(candidates.next!)}
                >
                  {t("加载更多会话")}
                </Button>
              )}
            </div>
          </section>
          <section
            className="association-editor"
            aria-label={t("所选会话的关联")}
          >
            {draft ? (
              <>
                <h3>{agentName(draft.link.session)}</h3>
                <p className="context-path">
                  {draft.link.session.nativeSessionId
                    ? t("Session ID")
                    : t("Proof 本地 Session ID")}{" "}
                  ·{" "}
                  {draft.link.session.nativeSessionId ?? draft.link.session.id}
                </p>
                {draft.link.session.nativeAgentId && (
                  <p className="context-path">
                    {t("Subagent · ")}
                    {draft.link.session.nativeAgentId}
                  </p>
                )}
                <span className="tag">
                  {associationState(draft.link.userOverride)}
                </span>
                <p className="association-reason">
                  {associationReason(draft.link.originalEvidence)}
                </p>
                <p className="inline-help">
                  {t("文件级关联不代表此会话独占当前 Diff 的改动。")}
                </p>
                {draft.link.session.cleared && (
                  <p className="data-warning">
                    {t("原始会话已清理，本地备注仍可查看和修改。")}
                  </p>
                )}
                <label htmlFor={noteId}>{t("本地备注")}</label>
                <Textarea
                  id={noteId}
                  rows={5}
                  maxLength={2000}
                  value={draft.note}
                  disabled={saving}
                  placeholder={t("记录你关联或解除此会话的原因…")}
                  onChange={(e) => {
                    const note = e.target.value;
                    setDrafts((old) => ({
                      ...old,
                      [selected!]: { ...old[selected!], note },
                    }));
                    setSaved("");
                  }}
                />
                <div className="association-note-meta">
                  <span>{t("修改记录保留 30 天，可撤销")}</span>
                  <span>{draft.note.length} / 2000</span>
                </div>
                <div className="association-actions">
                  <Button
                    className="button primary"
                    disabled={
                      disabled ||
                      (draft.link.session.cleared && !draft.link.userOverride)
                    }
                    onClick={() =>
                      void mutate(
                        draft.link.userOverride?.enabled === false
                          ? "exclude"
                          : "link",
                      )
                    }
                  >
                    {saving
                      ? t("保存中…")
                      : draft.link.userOverride
                        ? t("保存备注")
                        : t("关联此会话")}
                  </Button>
                  <Button
                    className="button"
                    disabled={disabled || !draft.link.active}
                    onClick={() => void mutate("exclude")}
                  >
                    {t("解除关联")}
                  </Button>
                </div>
                {draft.link.userOverride?.enabled === false && (
                  <Button
                    className="button compact"
                    disabled={disabled || draft.link.session.cleared}
                    onClick={() => void mutate("link")}
                  >
                    {t("重新关联")}
                  </Button>
                )}
                {draft.link.userOverride && (
                  <Button
                    className="button compact"
                    disabled={disabled}
                    onClick={() => void mutate("automatic")}
                  >
                    {t("恢复原始关联")}
                  </Button>
                )}
                <Button
                  className="button compact"
                  disabled={disabled}
                  onClick={() => void reloadSelected()}
                >
                  {t("读取最新关联")}
                </Button>
              </>
            ) : (
              <div className="association-empty">
                <Link size={25} />
                <strong>{t("选择要关联的会话")}</strong>
                <p>{t("查看原始线索，或添加本地备注。")}</p>
              </div>
            )}
          </section>
        </div>
      ) : (
        <section className="association-history" aria-label={t("关联修改记录")}>
          <div className="context-event-heading">
            <p className="inline-help">
              {t("用户指定 · 最近 30 天。每个会话的最新修改可撤销。")}
            </p>
            <Button
              className="button compact"
              disabled={disabled}
              onClick={() => {
                setError(null);
                void loadHistory();
              }}
            >
              {t("刷新记录")}
            </Button>
          </div>
          {history?.entries.map((entry) => (
            <article key={entry.id}>
              <header>
                <strong>
                  {entry.action === "undo"
                    ? t("撤销修改")
                    : entry.action === "automatic"
                      ? t("恢复原始关联")
                      : entry.action === "exclude"
                        ? t("解除关联")
                        : entry.before?.enabled
                          ? t("修改备注")
                          : t("关联会话")}
                </strong>
                <time>
                  {new Date(entry.createdAt).toLocaleString(getLanguage(), {
                    hour12: false,
                  })}
                </time>
              </header>
              <p className="context-path">
                {t("Proof 本地 Session ID · ")}
                {entry.sessionId}
              </p>
              <p>
                {associationState(entry.before)} →{" "}
                {associationState(entry.after)}
              </p>
              <p className="inline-help">
                {t("修改时的原始依据：")}
                {associationReason(entry.originalEvidence)}
              </p>
              {entry.before?.note && (
                <p className="association-history-note">
                  <strong>{t("原备注")}</strong>
                  {entry.before.note}
                </p>
              )}
              {entry.after?.note && (
                <p className="association-history-note">
                  <strong>{t("新备注")}</strong>
                  {entry.after.note}
                </p>
              )}
              <span className="tag">{t("用户指定")}</span>
              {entry.canUndo && (
                <Button
                  className="button compact"
                  disabled={disabled}
                  onClick={() => void mutate(entry)}
                >
                  <ArrowCounterClockwise size={13} />
                  {t("撤销此修改")}
                </Button>
              )}
            </article>
          ))}
          {loading && <p role="status">{t("读取记录中…")}</p>}
          {history && !history.entries.length && !loading && (
            <p className="association-empty">{t("尚无关联修改。")}</p>
          )}
          {history?.nextOffset != null && (
            <Button
              className="button compact"
              disabled={disabled}
              onClick={() => void loadHistory(history.nextOffset!)}
            >
              {t("加载更早的修改")}
            </Button>
          )}
        </section>
      )}
      <footer className="association-footer">
        <span role="status" aria-label={t("关联保存状态")}>
          {saved}
        </span>
        <Button className="button" onClick={onClose}>
          {t("完成")}
        </Button>
      </footer>
    </Modal>
  );
}
