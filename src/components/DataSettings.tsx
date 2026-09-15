import { Button, Select } from "./ui/controls";
import { uiMessage, t, getLanguage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Database, Info, Trash } from "@phosphor-icons/react";
import { HookConfigPreview } from "./ObserverSettings";
import { asError, isDesktop, useRequest } from "../api";
import type {
  DataCleanup,
  DataDeletionPreview,
  DataDeletionResult,
  DataScope,
  DataUsage,
  DataWorkspace,
  ProofError,
  Workspace,
} from "../types";

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

export function DataSettings({
  workspaces,
  workspaceId,
  demo,
  onError,
  onRecentChanged,
}: {
  workspaces: Workspace[];
  workspaceId?: string;
  demo: boolean;
  onError: (error: unknown) => void;
  onRecentChanged?: () => Promise<void>;
}) {
  const request = useRequest();
  const [selected, setSelected] = useState(workspaceId ?? "");
  const [usage, setUsage] = useState<DataUsage | null>(null);
  const [error, setError] = useState<ProofError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [catalog, setCatalog] = useState<DataWorkspace[]>(
    workspaces.map((workspace) => ({ workspace, recent: true })),
  );
  const [deletion, setDeletion] = useState<DataDeletionPreview | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!deletion) return;
    const frame = requestAnimationFrame(() =>
      confirmationRef.current?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [deletion?.id]);
  const mounted = useRef(true),
    generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++generation.current;
    };
  }, []);
  const chosen = catalog.find((entry) => entry.workspace.id === selected);
  function report(cause: unknown) {
    if (mounted.current) setError(asError(cause));
    else onError(cause);
  }
  const available = isDesktop && !demo;
  useEffect(() => {
    if (!available) return;
    let active = true;
    ++generation.current;
    setUsage(null);
    setError(null);
    setConfirming(false);
    Promise.all([
      request<DataUsage>("data_usage", { workspaceId: selected || null }),
      request<DataWorkspace[]>("data_workspaces"),
    ])
      .then(([value, entries]) => {
        if (active) {
          setUsage(value);
          setCatalog(entries);
        }
      })
      .catch((cause) => {
        if (active) setError(asError(cause));
      });
    return () => {
      active = false;
    };
  }, [available, selected, refresh]);

  async function clean(clearWorkspace: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await request<DataCleanup>(
        clearWorkspace ? "clear_observer_data" : "maintain_local_data",
        clearWorkspace ? { workspaceId: selected } : {},
      );
      if (!mounted.current) return;
      setConfirming(false);
      setNotice(
        result.walCheckpointComplete
          ? result.databaseCompactionPending
            ? t("记录已清理；数据库空闲空间尚未收回，请稍后重试清理。")
            : clearWorkspace
              ? t("已暂停此 Worktree 的观察，并清理 {v0} 条事件。", {
                  v0: result.deletedEvents,
                })
              : t("到期记录已清理。")
          : t(
              "记录已从当前数据中移除；旧数据库读取仍占用日志，磁盘副本清理尚未完成。请稍后重试清理。",
            ),
      );
      setUsage(
        await request<DataUsage>("data_usage", {
          workspaceId: selected || null,
        }),
      );
    } catch (cause) {
      report(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function removeRecent() {
    setBusy(true);
    setError(null);
    try {
      await request("remove_recent_workspace", { workspaceId: selected });
      await onRecentChanged?.();
      if (!mounted.current) return;
      setCatalog((entries) =>
        entries.map((entry) =>
          entry.workspace.id === selected ? { ...entry, recent: false } : entry,
        ),
      );
      setNotice(t("已从最近项目移除，Proof 记录和项目文件保留。"));
    } catch (cause) {
      report(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function pauseObservation() {
    setBusy(true);
    setError(null);
    try {
      await request("pause_observer_scope", { workspaceId: selected || null });
      if (!mounted.current) return;
      setNotice(t("观察已暂停，已有记录保留。"));
      setRefresh((value) => value + 1);
    } catch (cause) {
      report(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function prepareDeletion() {
    if (selected && !chosen) return;
    const scope: DataScope = chosen
      ? { kind: "repository", repositoryId: chosen.workspace.repositoryId }
      : { kind: "all" };
    const version = generation.current;
    setBusy(true);
    setError(null);
    setConfirming(false);
    try {
      const next = await request<DataDeletionPreview>("prepare_data_deletion", {
        scope,
      });
      if (mounted.current && version === generation.current) setDeletion(next);
    } catch (cause) {
      report(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function deleteRecords() {
    if (!deletion) return;
    setBusy(true);
    setError(null);
    try {
      await request<DataDeletionResult>("delete_local_data", {
        previewId: deletion.id,
      });
    } catch (cause) {
      report(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function cancelDeletion() {
    const previous = deletion;
    setDeletion(null);
    if (previous)
      void request("cancel_data_deletion", { previewId: previous.id }).catch(
        report,
      );
  }

  return (
    <>
      <h3>{t("本地数据")}</h3>
      <p className="muted">{t("管理最近项目、观察记录与恢复点。")}</p>
      {!available ? (
        <div className="setting-callout">
          <Info size={18} />
          <p>
            {t("演示模式不读取本机存储。请在 Proof 桌面应用中管理真实记录。")}
          </p>
        </div>
      ) : (
        <>
          <div className="data-toolbar">
            <label className="field-label" htmlFor="data-workspace">
              {t("查看范围")}
            </label>
            <Button
              className="button compact"
              disabled={busy}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <ArrowClockwise size={14} />
              {t("刷新用量")}
            </Button>
          </div>
          <Select
            id="data-workspace"
            value={selected}
            disabled={busy}
            onChange={(event) => {
              cancelDeletion();
              setSelected(event.target.value);
              setNotice("");
              setConfirming(false);
            }}
          >
            <option value="">{t("全部 Worktree")}</option>
            {catalog.map(({ workspace, recent }) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} · {workspace.path}
                {recent ? "" : t(" · 已从最近移除")}
              </option>
            ))}
          </Select>
          {error && (
            <div className="data-warning" role="alert">
              <strong>{uiMessage(error.message)}</strong>
              <small>{error.code}</small>
              <p>{t("操作状态尚未确认。请刷新用量后核对，必要时重试。")}</p>
            </div>
          )}
          {notice && (
            <p className="data-notice" role="status">
              {uiMessage(notice)}
            </p>
          )}
          {!usage && !error && (
            <p className="muted" role="status">
              {t("正在读取本地用量…")}
            </p>
          )}
          {usage && (
            <>
              <div className="data-usage-card">
                <Database size={21} />
                <div>
                  <span>{t("全应用数据")}</span>
                  <strong>
                    {usage.applicationBytesLowerBound ? t("至少 ") : ""}
                    {bytes(usage.applicationBytes)}{" "}
                    <small>
                      / {bytes(usage.softLimitBytes)} {t(" 软上限")}
                    </small>
                  </strong>
                </div>
              </div>
              <dl className="privacy-defaults">
                <dt>
                  {selected ? t("此 Worktree") : t("全部 Worktree")}
                  {t("的观察事件")}
                </dt>
                <dd>
                  {usage.observerEvents.toLocaleString(getLanguage())}{" "}
                  {t(" 条")}
                </dd>
                <dt>{t("观察会话")}</dt>
                <dd>
                  {usage.observerSessions.toLocaleString(getLanguage())}{" "}
                  {t(" 个")}
                </dd>
                <dt>{t("观察记录正文")}</dt>
                <dd>{bytes(usage.observationPayloadBytes)}</dd>
              </dl>
              <p className="inline-help">
                {t(
                  "记录正文用量不含数据库索引和共享开销。全应用数据包含数据库与恢复内容。",
                )}
              </p>
              {usage.contentCollectionPaused && (
                <div className="data-warning" role="status">
                  {usage.applicationBytesLowerBound &&
                  usage.applicationBytes < usage.softLimitBytes
                    ? t(
                        "本次用量统计达到读取范围上限，新观察内容采集已暂停。请检查本地数据目录后重试。",
                      )
                    : t(
                        "剩余空间不足以保存下一条事件，新观察内容采集已暂停。清理空间后会重新检查是否可继续采集。",
                      )}
                </div>
              )}
              {usage.cleanupPending && (
                <div className="data-warning" role="status">
                  {t(
                    "磁盘清理尚未完成：旧数据库读取正在占用日志。稍后重试清理；重新打开应用后也会继续尝试。",
                  )}
                </div>
              )}
              {usage.pendingContentDeletions > 0 && (
                <div className="data-warning" role="status">
                  {usage.contentCleanupError === "DATA_INDEX_BUSY"
                    ? t("Git 操作仍在使用临时 Index，请在操作结束后重试清理。")
                    : t(
                        "磁盘副本清理尚未完成，请重试清理。再次打开 Proof 也会继续处理。",
                      )}
                  {usage.contentCleanupError && (
                    <small>{usage.contentCleanupError}</small>
                  )}
                </div>
              )}
              {usage.databaseCompactionPending && (
                <div className="data-warning" role="status">
                  {t(
                    "数据库空闲空间尚未收回。可能仍有其他写入或临时空间不足，请稍后重试清理。",
                  )}
                </div>
              )}
              <h4>{t("保留规则")}</h4>
              <p className="inline-help">
                {usage.activeObserverScopes > 0
                  ? t("当前有 {v0} 项观察授权。", {
                      v0: usage.activeObserverScopes,
                    })
                  : t("当前范围未开启观察。")}
              </p>
              <Button
                className="button compact"
                disabled={busy || !usage.activeObserverScopes}
                onClick={() => void pauseObservation()}
              >
                {t("暂停观察")}
              </Button>
              <dl className="privacy-defaults">
                <dt>{t("已授权命令输出")}</dt>
                <dd>
                  {usage.outputRetentionDays} {t(" 天 · 每事件文本最多 64 KiB")}
                </dd>
                <dt>{t("任务、事件与关联备注")}</dt>
                <dd>
                  {usage.observationRetentionDays} {t(" 天")}
                </dd>
                <dt>{t("Review 报告、处理状态及操作记录")}</dt>
                <dd>
                  {usage.reviewRetentionDays} {t(" 天")}
                </dd>
                <dt>{t("丢弃恢复点")}</dt>
                <dd>{t("7 天 / 256 MiB")}</dd>
              </dl>
              <p className="inline-help">
                {t(
                  "应用运行或读取记录时清理到期数据。采集服务运行期间也会定期检查。未到期的恢复点保留到其独立期限。",
                )}
              </p>
              <Button
                className="button"
                disabled={busy}
                onClick={() => {
                  void clean(false);
                }}
              >
                <ArrowClockwise size={15} />
                {busy ? t("正在处理…") : t("清理到期记录 / 重试磁盘清理")}
              </Button>
              <div className="data-delete-section">
                <h4>{t("清理 Worktree 观察记录")}</h4>
                <p className="inline-help">
                  {t(
                    "删除此 Worktree 的任务、事件、会话与关联备注，并暂停观察。人工审查记录、恢复点、源代码和 Agent 自己的历史保留。",
                  )}
                </p>
                {!confirming ? (
                  <Button
                    className="button danger"
                    disabled={busy || !selected}
                    onClick={() => setConfirming(true)}
                  >
                    <Trash size={15} />
                    {t("暂停并清理观察记录…")}
                  </Button>
                ) : (
                  <div
                    className="data-confirm"
                    role="group"
                    aria-label={t("确认清理观察记录")}
                  >
                    <strong>{t("确认删除此 Worktree 的观察记录？")}</strong>
                    <p>
                      {t(
                        "删除后无法在 Proof 中恢复；再次开启观察不会补回这些历史。系统备份、快照和自行导出的副本需另行处理。",
                      )}
                    </p>
                    <div className="data-actions">
                      <Button
                        className="button"
                        disabled={busy}
                        onClick={() => setConfirming(false)}
                      >
                        {t("取消")}
                      </Button>
                      <Button
                        className="button danger"
                        disabled={busy}
                        onClick={() => {
                          void clean(true);
                        }}
                      >
                        {t("确认暂停并删除")}
                      </Button>
                    </div>
                  </div>
                )}
                {!selected && (
                  <p className="inline-help">
                    {t("先选择一个 Worktree，再清理其观察记录。")}
                  </p>
                )}
              </div>
              <div className="data-delete-section">
                <h4>{t("最近项目")}</h4>
                <p className="inline-help">
                  {t(
                    "从最近项目隐藏此 Worktree，保留所有记录。再次打开仓库时会重新出现。",
                  )}
                </p>
                <Button
                  className="button"
                  disabled={busy || !chosen?.recent}
                  onClick={() => void removeRecent()}
                >
                  {t("从最近项目移除")}
                </Button>
              </div>
              <div className="data-delete-section">
                <h4>
                  {selected
                    ? t("删除仓库记录")
                    : t("删除所有 Proof 记录与设置")}
                </h4>
                <p className="inline-help">
                  {selected
                    ? t(
                        "清理此仓库及关联 Worktree 的 Review、活动记录、恢复点和仓库设置。",
                      )
                    : t(
                        "清理所有仓库记录、Commit 草稿和恢复点，恢复应用默认设置，并停止 Agent 接入。",
                      )}
                  {t("项目文件、Git 历史和 Agent 自己的历史保留。")}
                </p>
                {!deletion ? (
                  <Button
                    className="button danger"
                    disabled={busy || (!!selected && !chosen)}
                    onClick={() => void prepareDeletion()}
                  >
                    <Trash size={15} />
                    {selected
                      ? t("查看此仓库的删除范围…")
                      : t("查看全部删除范围…")}
                  </Button>
                ) : (
                  <div
                    className="data-confirm"
                    role="group"
                    aria-label={t("确认删除 Proof 记录")}
                    ref={confirmationRef}
                  >
                    <strong>
                      {deletion.scope.kind === "all"
                        ? t("删除所有 Proof 记录与设置？")
                        : t("删除这些 Worktree 的 Proof 记录？")}
                    </strong>
                    {deletion.workspaces.length > 0 && (
                      <ul className="data-deletion-targets">
                        {deletion.workspaces.map((workspace) => (
                          <li key={workspace.id}>
                            <strong>{workspace.name}</strong>
                            <code>{workspace.path}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                    {deletion.hookRemovals?.map((preview) => (
                      <HookConfigPreview key={preview.id} preview={preview} />
                    ))}
                    <dl className="privacy-defaults">
                      <dt>{t("Review 记录")}</dt>
                      <dd>{deletion.counts.reviewRecords}</dd>
                      <dt>{t("观察事件")}</dt>
                      <dd>{deletion.counts.observerEvents}</dd>
                      <dt>{t("恢复点")}</dt>
                      <dd>
                        {deletion.counts.recoveryPoints} ·{" "}
                        {bytes(deletion.counts.recoveryBytes)}
                      </dd>
                    </dl>
                    <p>
                      {t(
                        "删除范围包括这些仓库的全部记录。删除后无法从 Proof 恢复，也不能再用这些恢复点撤销丢弃。系统备份、快照和自行导出的副本需另行处理。",
                      )}
                    </p>
                    <div className="data-actions">
                      <Button
                        className="button"
                        disabled={busy}
                        onClick={cancelDeletion}
                      >
                        {t("取消")}
                      </Button>
                      <Button
                        className="button danger"
                        disabled={busy}
                        onClick={() => void deleteRecords()}
                      >
                        {busy ? t("正在删除…") : t("删除 Proof 记录")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
