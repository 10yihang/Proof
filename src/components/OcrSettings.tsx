import { useEffect, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { ArrowClockwise, Check, CircleNotch } from "@phosphor-icons/react";
import { asError, useReadRequest, useRequest } from "../api";
import { t, uiMessage } from "../i18n";
import type { ProofError, Side } from "../types";
import { Button, Input, Select } from "./ui/controls";
import { OcrBuiltinRules, OcrRuleSettings } from "./OcrRuleEditor";

export interface OcrComparison {
  base: string;
  target: string;
}

interface Endpoint {
  url: string;
  protocol: string;
}

interface Provider {
  id: string;
  model: string;
  models: string[];
  savedKey: boolean;
  endpoint: Endpoint | null;
}

interface Configuration {
  fingerprint: string;
  provider: string;
  model: string;
  language: string;
  effort: string;
  providers: Provider[];
}

type ModelDraft = Pick<
  Configuration,
  "provider" | "model" | "language" | "effort"
> & {
  endpoint: Endpoint | null;
};

function modelDraft(config: Configuration): ModelDraft {
  const { provider, model, language, effort } = config;
  return {
    provider,
    model,
    language,
    effort,
    endpoint:
      config.providers.find((entry) => entry.id === provider)?.endpoint ?? null,
  };
}

export function OcrSettings({
  workspaceId,
  workspaceName,
  trusted,
  comparison,
  side,
  demo,
}: {
  workspaceId?: string;
  workspaceName?: string;
  trusted: boolean;
  comparison?: OcrComparison;
  side?: Side;
  demo: boolean;
}) {
  const [tab, setTab] = useState("model");
  const activeTab = tab === "rules" && !workspaceId ? "global" : tab;
  if (demo) return <p className="muted">{t("演示模式不调用本机 Agent。")}</p>;

  return (
    <Tabs.Root
      className="ocr-settings"
      value={activeTab}
      onValueChange={(value) => setTab(String(value))}
    >
      <Tabs.List
        className="ocr-settings-tabs"
        aria-label={t("OpenCodeReview 设置")}
      >
        <Tabs.Tab value="model">{t("模型设置")}</Tabs.Tab>
        {workspaceId && <Tabs.Tab value="rules">{t("仓库规则")}</Tabs.Tab>}
        <Tabs.Tab value="global">{t("全局规则")}</Tabs.Tab>
        <Tabs.Tab value="builtin">{t("内置规则")}</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel className="ocr-settings-panel" value="model" keepMounted>
        <OcrModelSettings />
      </Tabs.Panel>
      {workspaceId && (
        <Tabs.Panel className="ocr-settings-panel" value="rules" keepMounted>
          <OcrRuleSettings
            key={workspaceId}
            workspaceId={workspaceId}
            workspaceName={workspaceName}
            trusted={trusted}
            comparison={comparison}
            side={side}
            active={activeTab === "rules"}
          />
        </Tabs.Panel>
      )}
      <Tabs.Panel className="ocr-settings-panel" value="global" keepMounted>
        <OcrRuleSettings active={activeTab === "global"} />
      </Tabs.Panel>
      <Tabs.Panel className="ocr-settings-panel" value="builtin" keepMounted>
        <OcrBuiltinRules active={activeTab === "builtin"} />
      </Tabs.Panel>
    </Tabs.Root>
  );
}

function OcrModelSettings() {
  const request = useRequest();
  const catalogReader = useReadRequest();
  const connectionReader = useReadRequest();
  const [catalog, setCatalog] = useState<string[]>([]);
  const [config, setConfig] = useState<Configuration | null>(null);
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [manualModel, setManualModel] = useState(false);
  const [busy, setBusy] = useState<"loading" | "saving" | "testing" | null>(
    "loading",
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState<ProofError | null>(null);
  const [revision, reload] = useState(0);
  const [catalogError, setCatalogError] = useState("");

  useEffect(() => {
    let active = true;
    setBusy("loading");
    setError(null);
    setMessage("");
    void request<Configuration>("ocr_settings")
      .then((saved) => {
        if (!active) return;
        setConfig(saved);
        setDraft(modelDraft(saved));
        setApiKey("");
        setAdding(false);
        setManualModel(false);
      })
      .catch((cause) => {
        if (active) setError(asError(cause));
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    setCatalogError("");
    void catalogReader
      .read<string[]>("ocr_provider_catalog", {})
      .then((providers) => {
        if (active) setCatalog(providers);
      })
      .catch((cause) => {
        if (active) setCatalogError(uiMessage(asError(cause).message));
      });
    return () => {
      active = false;
      catalogReader.cancel();
    };
  }, [request, catalogReader, revision]);

  function edit(values: Partial<ModelDraft>) {
    setDraft((previous) => previous && { ...previous, ...values });
    setMessage("");
    setError(null);
  }

  async function perform(
    action: "saving" | "testing",
    task: () => Promise<void>,
  ) {
    setBusy(action);
    setMessage("");
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setBusy(null);
    }
  }

  const providers = config?.providers ?? [];
  const savedIds = providers.map((provider) => provider.id);
  const configured = config?.provider ?? "";
  const ids = [
    ...new Set([...savedIds, ...catalog, ...(configured ? [configured] : [])]),
  ].sort();
  const selected = providers.find(
    (provider) => provider.id === draft?.provider,
  );
  const models = [
    ...new Set([
      ...(draft?.model ? [draft.model] : []),
      ...(selected?.models ?? []),
    ]),
  ];
  const endpointChanged =
    draft?.endpoint &&
    (draft.endpoint.url !== selected?.endpoint?.url ||
      draft.endpoint.protocol !== selected.endpoint?.protocol);
  const dirty =
    !!draft &&
    !!config &&
    (JSON.stringify(draft) !== JSON.stringify(modelDraft(config)) || !!apiKey);
  const providerName = draft?.provider.trim() ?? "";
  const canSave =
    dirty &&
    !busy &&
    (!apiKey || !!providerName) &&
    (!adding || (!!providerName && !ids.includes(providerName))) &&
    (!endpointChanged ||
      !!draft.endpoint?.url.trim() ||
      draft.endpoint?.protocol === "anthropic-bedrock");

  return (
    <>
      <div className="ocr-section-heading">
        <h3>{t("模型连接")}</h3>
        <Button
          className="icon-button"
          title={t("重新读取 OCR 配置")}
          disabled={!!busy}
          onClick={() => reload((value) => value + 1)}
        >
          <ArrowClockwise size={16} aria-hidden="true" />
        </Button>
      </div>
      {busy === "loading" && !draft && (
        <p role="status" className="ocr-inline-status">
          <CircleNotch size={15} className="spinning" aria-hidden="true" />
          {t("正在读取 OCR 配置")}
        </p>
      )}
      {draft && config && (
        <>
          <div className="ocr-settings-fields">
            <label>
              <span>{t("服务商")}</span>
              <Select
                aria-label={t("服务商")}
                className="w-full"
                value={
                  adding
                    ? "custom"
                    : draft.provider
                      ? "provider:" + draft.provider
                      : ""
                }
                disabled={!!busy}
                onChange={(event) => {
                  const value = event.target.value;
                  const custom = value === "custom";
                  const provider = custom
                    ? ""
                    : value.slice("provider:".length);
                  const entry = providers.find((item) => item.id === provider);
                  setAdding(custom);
                  setApiKey("");
                  setManualModel(false);
                  edit({
                    provider,
                    model:
                      provider === config.provider
                        ? config.model
                        : (entry?.model ?? ""),
                    endpoint: custom
                      ? { url: "", protocol: "openai" }
                      : (entry?.endpoint ?? null),
                  });
                }}
              >
                <option value="">{t("OCR 默认")}</option>
                <optgroup label={t("已配置")}>
                  {ids
                    .filter((id) => savedIds.includes(id) || id === configured)
                    .map((id) => (
                      <option key={id} value={"provider:" + id}>
                        {id}
                      </option>
                    ))}
                </optgroup>
                <optgroup label={t("内置服务商")}>
                  {ids
                    .filter((id) => !savedIds.includes(id) && id !== configured)
                    .map((id) => (
                      <option key={id} value={"provider:" + id}>
                        {id}
                      </option>
                    ))}
                </optgroup>
                <option value="custom">{t("添加自定义服务")}</option>
              </Select>
            </label>
            <label>
              <span>{t("OCR 模型")}</span>
              {selected?.models.length && !manualModel ? (
                <Select
                  aria-label={t("OCR 模型")}
                  className="w-full"
                  value={draft.model ? "model:" + draft.model : ""}
                  disabled={!!busy}
                  onChange={(event) => {
                    if (event.target.value === "manual") setManualModel(true);
                    else
                      edit({
                        model: event.target.value.slice("model:".length),
                      });
                  }}
                >
                  <option value="">{t("OCR 默认")}</option>
                  {models.map((model) => (
                    <option key={model} value={"model:" + model}>
                      {model}
                    </option>
                  ))}
                  <option value="manual">{t("输入模型 ID")}</option>
                </Select>
              ) : (
                <Input
                  aria-label={t("OCR 模型")}
                  value={draft.model}
                  spellCheck={false}
                  disabled={!!busy}
                  onChange={(event) => edit({ model: event.target.value })}
                />
              )}
            </label>
          </div>
          {adding && (
            <label className="ocr-settings-field">
              <span>{t("服务名称")}</span>
              <Input
                autoComplete="off"
                spellCheck={false}
                value={draft.provider}
                aria-invalid={!!providerName && ids.includes(providerName)}
                disabled={!!busy}
                onChange={(event) => edit({ provider: event.target.value })}
              />
            </label>
          )}
          {draft.endpoint && (
            <div className="ocr-settings-fields">
              <label>
                <span>{t("服务地址")}</span>
                <Input
                  spellCheck={false}
                  value={draft.endpoint.url}
                  disabled={!!busy}
                  onChange={(event) =>
                    edit({
                      endpoint: { ...draft.endpoint!, url: event.target.value },
                    })
                  }
                />
              </label>
              <label>
                <span>{t("接口协议")}</span>
                <Select
                  aria-label={t("接口协议")}
                  className="w-full"
                  value={draft.endpoint.protocol || ""}
                  disabled={!!busy}
                  onChange={(event) =>
                    edit({
                      endpoint: {
                        ...draft.endpoint!,
                        protocol: event.target.value,
                      },
                    })
                  }
                >
                  {!draft.endpoint.protocol && (
                    <option value="">{t("请选择")}</option>
                  )}
                  <option value="openai">OpenAI Chat Completions</option>
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="anthropic-bedrock">
                    Anthropic on Bedrock
                  </option>
                </Select>
              </label>
            </div>
          )}
          <div className="ocr-settings-fields">
            {draft.provider === "chatgpt" ? (
              <div className="ocr-settings-field">
                <span>{t("身份验证")}</span>
                <span className="ocr-account">ChatGPT</span>
              </div>
            ) : (
              <label>
                <span>API Key</span>
                <Input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  disabled={!!busy || !providerName}
                  placeholder={selected?.savedKey ? t("已保存凭据") : undefined}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setMessage("");
                    setError(null);
                  }}
                />
              </label>
            )}
            <label>
              <span>{t("评论语言")}</span>
              <Input
                value={draft.language}
                disabled={!!busy}
                placeholder={t("OCR 默认")}
                onChange={(event) => edit({ language: event.target.value })}
              />
            </label>
          </div>
          <div className="ocr-settings-field">
            <span>{t("审查深度")}</span>
            <div
              className="ocr-segmented"
              role="group"
              aria-label={t("审查深度")}
            >
              {(
                [
                  ["", "OCR 默认"],
                  ["low", "快速"],
                  ["medium", "标准"],
                  ["high", "深入"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  aria-pressed={draft.effort === value}
                  disabled={!!busy}
                  onClick={() => edit({ effort: value })}
                >
                  {t(label)}
                </Button>
              ))}
            </div>
          </div>
          <div className="ocr-settings-actions">
            <Button
              className="button primary"
              disabled={!canSave}
              onClick={() =>
                void perform("saving", async () => {
                  const saved = await request<Configuration>(
                    "set_ocr_settings",
                    {
                      update: {
                        expectedFingerprint: config.fingerprint,
                        provider: draft.provider,
                        model: draft.model,
                        language: draft.language,
                        effort: draft.effort,
                        apiKey,
                        endpoint: endpointChanged ? draft.endpoint : null,
                      },
                    },
                  );
                  setConfig(saved);
                  setDraft(modelDraft(saved));
                  setApiKey("");
                  setAdding(false);
                  setManualModel(false);
                  setMessage(t("OCR 配置已保存"));
                })
              }
            >
              {busy === "saving" ? t("正在保存…") : t("保存 OCR 配置")}
            </Button>
            <Button
              className="button"
              disabled={!!busy || dirty}
              onClick={() =>
                void perform("testing", async () => {
                  await connectionReader.read("test_ocr_connection", {});
                  setMessage(t("模型连接正常"));
                })
              }
            >
              {busy === "testing" && (
                <CircleNotch
                  size={14}
                  className="spinning"
                  aria-hidden="true"
                />
              )}
              {busy === "testing" ? t("正在测试模型连接") : t("测试模型连接")}
            </Button>
          </div>
        </>
      )}
      {error ? (
        <div className="agent-settings-error" role="alert">
          {uiMessage(error.message)}
          {error.code.startsWith("OCR_CONNECTION_") && error.detail && (
            <details>
              <summary>{t("查看失败详情")}</summary>
              <pre>{error.detail}</pre>
            </details>
          )}
        </div>
      ) : catalogError ? (
        <p className="ai-error" role="alert">
          {catalogError}
        </p>
      ) : null}
      {message && (
        <p className="ocr-inline-status" role="status">
          <Check size={15} aria-hidden="true" />
          {message}
        </p>
      )}
    </>
  );
}
