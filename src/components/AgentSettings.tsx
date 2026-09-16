import { Button, Select, Input } from "./ui/controls";
import { t, uiMessage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowClockwise,
  FolderOpen,
  Check,
  Terminal,
} from "@phosphor-icons/react";
import { asError, useReadRequest, useRequest } from "../api";
import { agentName, type AgentKind, type AgentProviderInfo } from "../ai";
import type { ProofError } from "../types";
export interface AgentOptions {
  executablePath: string | null;
  model: string | null;
}
export interface AgentSettingsValue {
  revision: number;
  defaultProvider: AgentKind;
  codex: AgentOptions;
  claudeCode: AgentOptions;
  codewiz: AgentOptions;
}
interface ProbeResult {
  provider: AgentKind;
  executablePath: string;
  version: string;
  compatible: boolean;
  authenticated: boolean | null;
  message: string;
  detail: string;
}
const defaults = (): AgentSettingsValue => ({
  revision: 0,
  defaultProvider: "codex",
  codex: { executablePath: null, model: null },
  claudeCode: { executablePath: null, model: null },
  codewiz: { executablePath: null, model: null },
});
export function AgentSettings({ demo }: { demo: boolean }) {
  const request = useRequest(),
    reader = useReadRequest();
  const [draft, setDraft] = useState(defaults),
    [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [saved, setSaved] = useState(false);
  const [error, setError] = useState<ProofError | null>(null),
    [checking, setChecking] = useState<AgentKind | null>(null),
    [results, setResults] = useState<Partial<Record<AgentKind, ProbeResult>>>(
      {},
    );
  const sequence = useRef(0),
    mounted = useRef(true);
  async function load() {
    setLoading(true);
    setError(null);
    setSaved(false);
    const n = ++sequence.current;
    try {
      const [settings, available] = await Promise.all([
        request<AgentSettingsValue>("agent_settings"),
        request<AgentProviderInfo[]>("agent_providers"),
      ]);
      if (n === sequence.current && mounted.current) {
        setDraft({ ...defaults(), ...settings });
        setProviders(available);
        setResults({});
      }
    } catch (e) {
      if (n === sequence.current && mounted.current) setError(asError(e));
    } finally {
      if (n === sequence.current && mounted.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (demo) setLoading(false);
    else void load();
    return () => {
      mounted.current = false;
      ++sequence.current;
      reader.cancel();
    };
  }, [demo]);
  function edit(kind: AgentKind, partial: Partial<AgentOptions>) {
    const key = kind === "claude_code" ? "claudeCode" : kind;
    setDraft((value) => ({ ...value, [key]: { ...value[key], ...partial } }));
    setResults((value) => ({ ...value, [kind]: undefined }));
    setSaved(false);
  }
  async function pick(kind: AgentKind) {
    try {
      const path = await open({
        title: t("选择 {v0} CLI", {
          v0: agentName(kind),
        }),
        multiple: false,
        directory: false,
        defaultPath:
          providers.find((p) => p.id === kind)?.path ?? "/opt/homebrew/bin",
      });
      if (mounted.current && typeof path === "string")
        edit(kind, { executablePath: path });
    } catch (e) {
      if (mounted.current) setError(asError(e));
    }
  }
  async function save() {
    if (saving || demo) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const value = await request<AgentSettingsValue>("set_agent_settings", {
        update: {
          expectedRevision: draft.revision,
          defaultProvider: draft.defaultProvider,
          codex: draft.codex,
          claudeCode: draft.claudeCode,
          codewiz: draft.codewiz,
        },
      });
      if (mounted.current) {
        setDraft(value);
        setSaved(true);
        window.dispatchEvent(new Event("proof:agent-settings-changed"));
      }
    } catch (e) {
      if (mounted.current) setError(asError(e));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  async function probe(kind: AgentKind) {
    if (checking || demo) return;
    setChecking(kind);
    setError(null);
    const n = ++sequence.current;
    try {
      const result = await reader.read<ProbeResult>("probe_ai_agent", {
        provider: kind,
        options: draft[kind === "claude_code" ? "claudeCode" : kind],
      });
      if (n === sequence.current && mounted.current)
        setResults((value) => ({ ...value, [kind]: result }));
    } catch (e) {
      if (n === sequence.current && mounted.current) setError(asError(e));
    } finally {
      if (n === sequence.current && mounted.current) setChecking(null);
    }
  }
  return (
    <section className="agent-settings">
      <header className="agent-settings-heading">
        <div>
          <h3>{t("AI Agents")}</h3>
          <p className="muted">
            {t(
              "通过本机 Coding Agent 执行 Grouping 和 Review，使用 CLI 的现有登录。",
            )}
          </p>
        </div>
        <Button
          className="icon-button"
          aria-label={t("重新读取 Agent 设置")}
          disabled={demo || loading || saving || !!checking}
          onClick={() => void load()}
        >
          <ArrowClockwise size={17} />
        </Button>
      </header>
      <p className="muted">
        {t(
          "这些设置只保存在 Proof，不修改 CLI 配置。Agent 观察在单独的设置页。",
        )}
      </p>
      {demo && (
        <p className="inline-notice">{t("演示模式不检测或保存本机 Agent。")}</p>
      )}
      {error && (
        <div className="agent-settings-error" role="alert">
          <strong>{uiMessage(error.message)}</strong>
          <details>
            <summary>
              {t("Failure details · ")}
              {error.code}
            </summary>
            <pre>{error.detail}</pre>
          </details>
        </div>
      )}
      <label className="field-label" htmlFor="default-ai-provider">
        {t("Default Agent")}
      </label>
      <Select
        id="default-ai-provider"
        value={draft.defaultProvider}
        disabled={loading || saving || demo}
        onChange={(e) => {
          setDraft((value) => ({
            ...value,
            defaultProvider: e.target.value as AgentKind,
          }));
          setSaved(false);
        }}
      >
        <option value="codex">{t("Codex")}</option>
        <option value="claude_code">{t("Claude Code")}</option>
        {providers.some((p) => p.id === "codewiz") && (
          <option value="codewiz">Codewiz</option>
        )}
      </Select>
      {(
        [
          "codex",
          "claude_code",
          ...(providers.some((p) => p.id === "codewiz")
            ? ["codewiz" as const]
            : []),
        ] as const
      ).map((kind) => {
        const options = draft[kind === "claude_code" ? "claudeCode" : kind],
          name = agentName(kind),
          found = providers.find((p) => p.id === kind),
          result = results[kind];
        return (
          <section className="agent-setting-card" key={kind}>
            <header>
              <Terminal size={18} />
              <strong>{name}</strong>
              <span className="tag">{t("Read-only")}</span>
            </header>
            {kind === "codewiz" && (
              <p className="muted">
                {t(
                  "读取 ~/.config/codewiz 的模型配置和现有登录。每次分析使用独立 Session，关闭 MCP 和插件。",
                )}
              </p>
            )}
            <label className="field-label" htmlFor={`${kind}-path`}>
              {t("CLI path")}
            </label>
            <div className="agent-path-input">
              <Input
                id={`${kind}-path`}
                aria-label={t("{v0} CLI path", { v0: name })}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                value={options.executablePath ?? ""}
                placeholder={found?.path ?? t("留空自动查找")}
                disabled={loading || saving || !!checking || demo}
                onChange={(e) =>
                  edit(kind, { executablePath: e.target.value || null })
                }
              />
              <Button
                className="button"
                aria-label={t("选择 {v0} CLI", { v0: name })}
                disabled={loading || saving || !!checking || demo}
                onClick={() => void pick(kind)}
              >
                <FolderOpen size={16} />
              </Button>
              <Button
                className="text-button"
                disabled={loading || saving || !!checking || demo}
                onClick={() => edit(kind, { executablePath: null })}
              >
                {t("Auto")}
              </Button>
            </div>
            <p className="muted agent-detected">
              {options.executablePath
                ? t("使用指定程序路径")
                : found?.path
                  ? `Detected: ${found.path}`
                  : t("未找到 CLI，可手动指定已安装的程序路径。")}
            </p>
            <label className="field-label" htmlFor={`${kind}-model`}>
              {t("Model ")}
              <span className="muted">{t("optional")}</span>
            </label>
            <Input
              id={`${kind}-model`}
              aria-label={t("{v0} model", { v0: name })}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              value={options.model ?? ""}
              placeholder={
                kind === "codewiz" ? "provider/model" : t("CLI default")
              }
              disabled={loading || saving || !!checking || demo}
              onChange={(e) => edit(kind, { model: e.target.value || null })}
            />
            <div className="agent-test-actions">
              <Button
                className="button"
                disabled={loading || saving || !!checking || demo}
                onClick={() => void probe(kind)}
              >
                {checking === kind ? t("Checking…") : t("Test CLI")}
              </Button>
              {checking === kind && (
                <Button className="text-button" onClick={reader.cancel}>
                  {t("Cancel")}
                </Button>
              )}
              <span>{t("检测版本、只读参数和本地登录状态，不调用模型。")}</span>
            </div>
            {result && (
              <div
                className={`agent-probe-result ${result.authenticated && result.compatible ? "ready" : "attention"}`}
                role="status"
              >
                <strong>{uiMessage(result.message)}</strong>
                <code>{result.version}</code>
                <code>{result.executablePath}</code>
                <p>{uiMessage(result.detail)}</p>
              </div>
            )}
          </section>
        );
      })}
      <div className="agent-settings-footer">
        <Button
          className="button primary"
          disabled={loading || saving || !!checking || demo}
          onClick={() => void save()}
        >
          {saving ? t("Saving…") : t("Save Agent settings")}
        </Button>
        {saved && (
          <span role="status">
            <Check size={15} /> {t(" Saved")}
          </span>
        )}
      </div>
    </section>
  );
}
