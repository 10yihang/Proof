import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Plug } from "@phosphor-icons/react";
import { asError, isDesktop, useRequest } from "../api";
import type {
  ObserverProbe,
  ObserverProgramLocation,
  ProofError,
  Workspace,
  DataWorkspace,
} from "../types";
export interface CaptureFields {
  prompt: boolean;
  command: boolean;
  reply: boolean;
  output: boolean;
  background: boolean;
}
interface Consent extends CaptureFields {
  installationId: string;
  workspaceId: string;
  enabled: boolean;
}
export interface HookPreview {
  id: string;
  action: string;
  agent: string;
  agentVersion: string;
  workspaceId: string | null;
  configPath: string;
  before: string | null;
  after: string | null;
  fields: CaptureFields;
  requiresHookTrust: boolean;
}
interface HookStatus {
  installationId: string;
  agent: string;
  agentVersion: string;
  configPath: string;
  state: string;
  lastEventAt: number | null;
  consents: Consent[];
  issue: string | null;
}
interface Status {
  policyRevision: number;
  serviceAvailable: boolean;
  serviceError: ProofError | null;
  installations: HookStatus[];
}
const empty: CaptureFields = {
  prompt: false,
  command: false,
  reply: false,
  output: false,
  background: false,
};
export function HookConfigPreview({ preview }: { preview: HookPreview }) {
  return (
    <section className="hook-config-preview">
      <strong>
        {preview.action === "install" ? "安装" : "移除"} Proof Hook
      </strong>
      <code>{preview.configPath}</code>
      <details>
        <summary>当前配置</summary>
        <pre>{preview.before ?? "文件尚不存在"}</pre>
      </details>
      <details open>
        <summary>修改后</summary>
        <pre>{preview.after ?? "移除此文件（仅由 Proof 创建的空配置）"}</pre>
      </details>
      {preview.requiresHookTrust && (
        <p>
          安装后，在 Codex 中运行 <code>/hooks</code> 并确认 Proof Hook。
        </p>
      )}
    </section>
  );
}
export function ObserverSettings({
  demo,
  workspaces,
  workspaceId,
  onError,
}: {
  demo: boolean;
  workspaces: Workspace[];
  workspaceId?: string;
  onError: (e: unknown) => void;
}) {
  const request = useRequest();
  const [locations, setLocations] = useState<ObserverProgramLocation[]>([]),
    [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState<ProofError | null>(null);
  const [catalog, setCatalog] = useState(workspaces);
  const [refresh, setRefresh] = useState(0);
  const available = isDesktop && !demo;
  useEffect(() => {
    if (!available) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    request<ObserverProgramLocation[]>("observer_program_locations")
      .then((v) => {
        if (active) setLocations(v);
      })
      .catch((e) => {
        if (active) setError(asError(e));
      });
    async function poll() {
      try {
        const [value, entries] = await Promise.all([
          request<Status>("observer_status"),
          request<DataWorkspace[]>("data_workspaces"),
        ]);
        if (active) {
          setStatus(value);
          setCatalog(entries.map((entry) => entry.workspace));
          setError(null);
        }
      } catch (e) {
        if (active) setError(asError(e));
      } finally {
        if (active) timer = setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [available, refresh]);
  return (
    <>
      <h3>Agent Hook</h3>
      <p className="muted">
        将 Agent 的任务与活动保存在本机，在 Diff 旁查看相关记录。
      </p>
      {!available && (
        <p className="inline-help">
          请在 Proof 桌面版安装 Hook。演示模式不会修改 Agent 配置。
        </p>
      )}
      {error && (
        <p role="alert">
          {error.message} · {error.code}
        </p>
      )}
      {status?.serviceError && (
        <p role="alert">{status.serviceError.message}</p>
      )}
      {(["codex", "claude"] as const).map((agent) => (
        <AgentCard
          key={agent}
          agent={agent}
          executable={
            locations.find((l) => l.agent === agent)?.executablePath ?? ""
          }
          available={available}
          workspaces={catalog}
          workspaceId={workspaceId}
          status={status}
          installation={status?.installations.find((i) => i.agent === agent)}
          onChanged={() => setRefresh((n) => n + 1)}
          onError={onError}
        />
      ))}
      <p className="inline-help">
        默认关闭观察和内容采集。已安装的 Hook 只记录明确授权的 Worktree。Codex
        0.153.4 / macOS 已完成实际会话测试；其他版本可检测，暂不安装。
      </p>
    </>
  );
}
function AgentCard({
  agent,
  executable,
  available,
  workspaces,
  workspaceId,
  status,
  installation,
  onChanged,
  onError,
}: {
  agent: "codex" | "claude";
  executable: string;
  available: boolean;
  workspaces: Workspace[];
  workspaceId?: string;
  status: Status | null;
  installation?: HookStatus;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const request = useRequest();
  const [path, setPath] = useState(executable),
    [edited, setEdited] = useState(false),
    [probe, setProbe] = useState<ObserverProbe | null>(null);
  const [selected, setSelected] = useState(
      workspaceId ?? workspaces[0]?.id ?? "",
    ),
    [fields, setFields] = useState<CaptureFields>(empty),
    [dirty, setDirty] = useState(false),
    [policy, setPolicy] = useState(0);
  const [preview, setPreview] = useState<HookPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<ProofError | null>(null),
    [notice, setNotice] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!edited) setPath(executable);
  }, [executable, edited]);
  const consent = installation?.consents.find(
      (c) => c.workspaceId === selected,
    ),
    trusted = workspaces.find((w) => w.id === selected)?.trusted;
  useEffect(() => {
    if (!dirty) {
      setFields(
        consent
          ? {
              prompt: consent.prompt,
              command: consent.command,
              reply: consent.reply,
              output: consent.output,
              background: consent.background,
            }
          : empty,
      );
      setPolicy(status?.policyRevision ?? 0);
    }
  }, [selected, consent, status?.policyRevision, dirty]);
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await operation();
    } catch (e) {
      if (mounted.current) setError(asError(e));
      else onError(e);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function apply() {
    if (!preview) return;
    const value = await request<{ message: string; warning: string | null }>(
      "apply_observer_config",
      { previewId: preview.id },
    );
    if (mounted.current) {
      setPreview(null);
      setNotice(value.warning ?? value.message);
      setDirty(false);
      onChanged();
    }
  }
  function cancel() {
    const previous = preview;
    setPreview(null);
    if (previous)
      void request("cancel_observer_config", { previewId: previous.id }).catch(
        onError,
      );
  }
  const fault = installation
    ? (
        {
          program_changed: "Agent 程序已变化，请卸载后重新检测。",
          helper_changed: "Proof 观察程序已变化，请重新安装 Hook。",
          incomplete: "Hook 安装未完成，请先卸载并重新安装。",
          config_changed: "Hook 配置已变化，请先检查配置。",
        } as Record<string, string>
      )[installation.state]
    : undefined;
  const state = fault
    ? "需要处理"
    : installation
      ? installation.issue
        ? "配置需检查"
        : consent?.enabled
          ? installation.lastEventAt
            ? "已收到事件"
            : "等待 Agent 事件"
          : "已暂停"
      : "未接入";
  return (
    <section
      className="observer-version-card"
      aria-label={`${agent === "codex" ? "Codex" : "Claude Code"} Hook`}
    >
      <div className="agent-setting">
        <div className="agent-icon">
          <Plug size={20} />
        </div>
        <div>
          <strong>{agent === "codex" ? "Codex" : "Claude Code"}</strong>
          <small>
            {installation
              ? `配置版本 ${installation.agentVersion}`
              : probe
                ? `检测到 ${probe.version}`
                : "尚未检测"}
          </small>
        </div>
        <span className="tag">{state}</span>
      </div>
      {!installation && (
        <>
          <label className="field-label" htmlFor={`agent-program-${agent}`}>
            程序路径
          </label>
          <input
            id={`agent-program-${agent}`}
            value={path}
            disabled={!available || busy}
            placeholder="Agent 程序的绝对路径"
            onChange={(e) => {
              setEdited(true);
              setPath(e.target.value);
              setProbe(null);
            }}
          />
          <button
            className="button compact"
            disabled={!available || busy || !path.trim()}
            onClick={() =>
              void run(async () => {
                const value = await request<ObserverProbe>("probe_observer", {
                  agent,
                  executablePath: path,
                });
                if (mounted.current) setProbe(value);
              })
            }
          >
            <ArrowClockwise size={14} />
            检测版本
          </button>
        </>
      )}
      {fault && (
        <p role="alert" className="data-warning">
          {fault}
        </p>
      )}
      {installation?.issue && (
        <p className="data-warning">{installation.issue}</p>
      )}
      <label className="field-label" htmlFor={`hook-worktree-${agent}`}>
        Worktree
      </label>
      <select
        id={`hook-worktree-${agent}`}
        value={selected}
        disabled={busy || !!preview}
        onChange={(e) => {
          setDirty(false);
          setSelected(e.target.value);
        }}
      >
        <option value="">选择 Worktree</option>
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name} · {w.path}
          </option>
        ))}
      </select>
      {selected && !trusted && (
        <p className="inline-help">请先信任此 Worktree，再开启观察。</p>
      )}
      <p className="inline-help">
        开启后记录 Session、工具名称与文件路径。以下内容单独授权：
      </p>
      <div className="hook-field-grid">
        {(
          [
            ["prompt", "Prompt"],
            ["command", "Command"],
            ["reply", "Agent reply"],
            ["output", "Tool output"],
            ["background", "关闭 Proof 后继续观察"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={fields[key]}
              disabled={!available || busy || !!preview}
              onChange={(e) => {
                setFields((v) => ({ ...v, [key]: e.target.checked }));
                setDirty(true);
              }}
            />
            {label}
          </label>
        ))}
      </div>
      {preview ? (
        <>
          <HookConfigPreview preview={preview} />
          <div className="hook-actions">
            <button className="button" disabled={busy} onClick={cancel}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void run(apply)}
            >
              {busy
                ? "应用中…"
                : preview.action === "install"
                  ? "安装并开启观察"
                  : "移除 Hook"}
            </button>
          </div>
          {preview.action === "uninstall" && (
            <p className="inline-help">
              移除该 Agent 的 Proof Hook，会暂停所有已授权
              Worktree；已有记录保留。
            </p>
          )}
        </>
      ) : (
        <div className="hook-actions">
          {installation ? (
            <>
              <button
                className="button primary"
                disabled={
                  !available ||
                  busy ||
                  !selected ||
                  !trusted ||
                  !!fault ||
                  !!installation.issue
                }
                onClick={() =>
                  void run(async () => {
                    await request("configure_observer_workspace", {
                      installationId: installation.installationId,
                      workspaceId: selected,
                      fields,
                      enabled: true,
                      policyRevision: policy,
                    });
                    if (mounted.current) {
                      setDirty(false);
                      setNotice("此 Worktree 的观察已开启。");
                      onChanged();
                    }
                  })
                }
              >
                {consent?.enabled ? "保存采集设置" : "开启观察"}
              </button>
              {consent?.enabled && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await request("configure_observer_workspace", {
                        installationId: installation.installationId,
                        workspaceId: selected,
                        fields,
                        enabled: false,
                        policyRevision: policy,
                      });
                      if (mounted.current) {
                        setDirty(false);
                        onChanged();
                      }
                    })
                  }
                >
                  暂停
                </button>
              )}
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const value = await request<HookPreview>(
                      "preview_observer_uninstall",
                      { installationId: installation.installationId },
                    );
                    if (mounted.current) setPreview(value);
                  })
                }
              >
                卸载…
              </button>
            </>
          ) : (
            <button
              className="button primary"
              disabled={
                !available ||
                busy ||
                !trusted ||
                agent !== "codex" ||
                probe?.version !== "0.153.4"
              }
              onClick={() =>
                void run(async () => {
                  const value = await request<HookPreview>(
                    "preview_observer_install",
                    {
                      agent,
                      workspaceId: selected,
                      executablePath: path,
                      fields,
                    },
                  );
                  if (mounted.current) setPreview(value);
                })
              }
            >
              预览安装…
            </button>
          )}
        </div>
      )}
      {installation?.lastEventAt && (
        <p className="inline-help">
          最近事件 {new Date(installation.lastEventAt).toLocaleString()} ·{" "}
          {status?.serviceAvailable ? "采集器在线" : "采集器未连接"}
        </p>
      )}
      {notice && (
        <p role="status" className="inline-help">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="data-warning">
          {error.message}
          <small>{error.code}</small>
        </p>
      )}
    </section>
  );
}
