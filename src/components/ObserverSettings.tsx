import { Input, Button, Select } from "./ui/controls";
import { uiMessage, t, getLanguage } from "../i18n";
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
        {preview.action === "install" ? t("安装") : t("移除")}{" "}
        {t(" Proof Hook")}
      </strong>
      <code>{preview.configPath}</code>
      <details>
        <summary>{t("当前配置")}</summary>
        <pre>{preview.before ?? t("文件尚不存在")}</pre>
      </details>
      <details open>
        <summary>{t("修改后")}</summary>
        <pre>{preview.after ?? t("移除此文件（仅由 Proof 创建的空配置）")}</pre>
      </details>
      {preview.requiresHookTrust && (
        <p>
          {t("安装后，在 Codex 中运行 ")}
          <code>{t("/hooks")}</code> {t(" 并确认 Proof Hook。")}
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
      <h3>{t("Agent Hook")}</h3>
      <p className="muted">
        {t("将 Agent 的任务与活动保存在本机，在 Diff 旁查看相关记录。")}
      </p>
      {!available && (
        <p className="inline-help">
          {t("请在 Proof 桌面版安装 Hook。演示模式不会修改 Agent 配置。")}
        </p>
      )}
      {error && (
        <p role="alert">
          {uiMessage(error.message)} · {error.code}
        </p>
      )}
      {status?.serviceError && (
        <p role="alert">{uiMessage(status.serviceError.message)}</p>
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
        {t(
          "Hook 只记录已授权的 Worktree。Codex Hook 不限定 CLI 版本；安装前检查配置， 安装后检查连接。Claude Code Hook 暂未开放安装。",
        )}
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
          program_changed: t("Agent 程序或来源不可用，请重新检查接入。"),
          helper_changed: t("Proof 观察程序已变化，请重新安装 Hook。"),
          incomplete: t("Hook 安装未完成，请先卸载并重新安装。"),
          config_changed: t("Hook 配置已变化，请先检查配置。"),
        } as Record<string, string>
      )[installation.state]
    : undefined;
  const state = fault
    ? t("需要处理")
    : installation
      ? installation.issue
        ? t("配置需检查")
        : consent?.enabled
          ? installation.lastEventAt
            ? t("已收到事件")
            : t("等待 Agent 事件")
          : t("已暂停")
      : t("未接入");
  return (
    <section
      className="observer-version-card"
      aria-label={`${agent === "codex" ? "Codex" : t("Claude Code")} Hook`}
    >
      <div className="agent-setting">
        <div className="agent-icon">
          <Plug size={20} />
        </div>
        <div>
          <strong>{agent === "codex" ? "Codex" : t("Claude Code")}</strong>
          <small>
            {installation
              ? t("配置版本 {v0}", { v0: installation.agentVersion })
              : probe
                ? t("检测到 {v0}", { v0: probe.version })
                : t("尚未检测")}
          </small>
        </div>
        <span className="tag">{state}</span>
      </div>
      {!installation && (
        <>
          <label className="field-label" htmlFor={`agent-program-${agent}`}>
            {t("程序路径")}
          </label>
          <Input
            id={`agent-program-${agent}`}
            value={path}
            disabled={!available || busy}
            placeholder={t("Agent 程序的绝对路径")}
            onChange={(e) => {
              setEdited(true);
              setPath(e.target.value);
              setProbe(null);
            }}
          />
          <Button
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
            {t("检测版本")}
          </Button>
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
        {t("Worktree")}
      </label>
      <Select
        id={`hook-worktree-${agent}`}
        value={selected}
        disabled={busy || !!preview}
        onChange={(e) => {
          setDirty(false);
          setSelected(e.target.value);
        }}
      >
        <option value="">{t("选择 Worktree")}</option>
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name} · {w.path}
          </option>
        ))}
      </Select>
      {selected && !trusted && (
        <p className="inline-help">{t("请先信任此 Worktree，再开启观察。")}</p>
      )}
      <p className="inline-help">
        {t("开启后记录 Session、工具名称与文件路径。以下内容单独授权：")}
      </p>
      <div className="hook-field-grid">
        {(
          [
            ["prompt", "Prompt"],
            ["command", t("Command")],
            ["reply", t("Agent reply")],
            ["output", t("Tool output")],
            ["background", t("关闭 Proof 后继续观察")],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <Input
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
            <Button className="button" disabled={busy} onClick={cancel}>
              {t("取消")}
            </Button>
            <Button
              className="button primary"
              disabled={busy}
              onClick={() => void run(apply)}
            >
              {busy
                ? t("应用中…")
                : preview.action === "install"
                  ? t("安装并开启观察")
                  : t("移除 Hook")}
            </Button>
          </div>
          {preview.action === "uninstall" && (
            <p className="inline-help">
              {t(
                "移除该 Agent 的 Proof Hook，会暂停所有已授权 Worktree；已有记录保留。",
              )}
            </p>
          )}
        </>
      ) : (
        <div className="hook-actions">
          {installation ? (
            <>
              <Button
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
                      setNotice(t("此 Worktree 的观察已开启。"));
                      onChanged();
                    }
                  })
                }
              >
                {consent?.enabled ? t("保存采集设置") : t("开启观察")}
              </Button>
              {consent?.enabled && (
                <Button
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
                  {t("暂停")}
                </Button>
              )}
              <Button
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
                {t("卸载…")}
              </Button>
            </>
          ) : (
            <Button
              className="button primary"
              disabled={
                !available ||
                busy ||
                !trusted ||
                agent !== "codex" ||
                !probe?.profile
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
              {t("预览安装…")}
            </Button>
          )}
        </div>
      )}
      {installation?.lastEventAt && (
        <p className="inline-help">
          {t("最近事件 ")}
          {new Date(installation.lastEventAt).toLocaleString(
            getLanguage(),
          )} · {status?.serviceAvailable ? t("采集器在线") : t("采集器未连接")}
        </p>
      )}
      {notice && (
        <p role="status" className="inline-help">
          {uiMessage(notice)}
        </p>
      )}
      {error && (
        <p role="alert" className="data-warning">
          {uiMessage(error.message)}
          <small>{error.code}</small>
        </p>
      )}
    </section>
  );
}
