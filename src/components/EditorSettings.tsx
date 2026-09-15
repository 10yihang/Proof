import { Button, Select, Input } from "./ui/controls";
import { t, uiMessage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowClockwise,
  Check,
  Code,
  FolderOpen,
  Warning,
} from "@phosphor-icons/react";
import { asError, isDesktop, useRequest } from "../api";
import type {
  EditorApplication,
  EditorChoice,
  EditorSettings as Settings,
  ProofError,
} from "../types";

type Draft = { mode: EditorChoice["mode"]; path: string };
const draftFor = (choice: EditorChoice): Draft => ({
  mode: choice.mode,
  path: choice.mode === "application" ? choice.application.path : "",
});
export function EditorSettings({
  workspaceId,
  workspaceName,
  demo,
  onSaveError,
}: {
  workspaceId?: string;
  workspaceName?: string;
  demo: boolean;
  onSaveError: (error: unknown) => void;
}) {
  const request = useRequest();
  const [settings, setSettings] = useState<Settings | null>(null),
    [applications, setApplications] = useState<EditorApplication[]>([]);
  const [scope, setScope] = useState<"application" | "repository">(
    "application",
  );
  const [draft, setDraft] = useState<Draft>({ mode: "disabled", path: "" });
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState<ProofError | null>(null),
    [saved, setSaved] = useState(false);
  const [picking, setPicking] = useState(false);
  const generation = useRef(0);
  const native = isDesktop && !demo;
  async function load() {
    const revision = ++generation.current;
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const [next, apps] = await Promise.all([
        request<Settings>("editor_settings", { workspaceId }),
        request<EditorApplication[]>("editor_applications"),
      ]);
      if (revision !== generation.current) return;
      setSettings(next);
      setApplications(apps);
      setDraft(
        draftFor(
          scope === "repository"
            ? (next.repository ?? { mode: "inherit" })
            : next.application,
        ),
      );
    } catch (error) {
      if (revision === generation.current) setError(asError(error));
    } finally {
      if (revision === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (!native) {
      setLoading(false);
      return;
    }
    void load();
    return () => {
      ++generation.current;
    };
  }, [workspaceId, native]);
  function chooseScope(next: typeof scope) {
    ++generation.current;
    setScope(next);
    setSaved(false);
    setError(null);
    if (settings)
      setDraft(
        draftFor(
          next === "repository"
            ? (settings.repository ?? { mode: "inherit" })
            : settings.application,
        ),
      );
  }
  async function pick() {
    if (picking) return;
    setPicking(true);
    const revision = generation.current;
    try {
      const path = await open({
        title: t("选择外部编辑器"),
        multiple: false,
        directory: false,
        defaultPath:
          settings?.platform === "macos" ? "/Applications" : undefined,
        filters: [
          {
            name: "Editor application",
            extensions: settings?.platform === "macos" ? ["app"] : ["exe"],
          },
        ],
      });
      if (typeof path === "string" && revision === generation.current) {
        setDraft({ mode: "application", path });
        setSaved(false);
      }
    } catch (error) {
      if (revision === generation.current) setError(asError(error));
    } finally {
      if (revision === generation.current) setPicking(false);
    }
  }
  async function save() {
    if (!settings || saving || !native) return;
    const revision = generation.current;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await request<Settings>("set_editor_settings", {
        workspaceId,
        update: {
          scope,
          mode: draft.mode,
          path: draft.mode === "application" ? draft.path : null,
          expectedRevision: settings.revision,
        },
      });
      if (revision !== generation.current) return;
      setSettings(next);
      setDraft(
        draftFor(scope === "repository" ? next.repository! : next.application),
      );
      setSaved(true);
    } catch (error) {
      if (revision === generation.current) setError(asError(error));
      else
        onSaveError({
          ...asError(error),
          message: t("{v0}的编辑器设置未保存。{v1}", {
            v0:
              scope === "application"
                ? t("应用默认")
                : (workspaceName ?? t("此仓库")),
            v1: asError(error).message,
          }),
        });
    } finally {
      if (revision === generation.current) setSaving(false);
    }
  }
  const current =
    settings &&
    draftFor(
      scope === "repository"
        ? (settings.repository ?? { mode: "inherit" })
        : settings.application,
    );
  const dirty =
    current && (current.mode !== draft.mode || current.path !== draft.path);
  const disabled = !native || loading || saving || picking;
  return (
    <section className="editor-settings" aria-label={t("外部编辑器")}>
      <h3>{t("外部编辑器")}</h3>
      <p className="muted">
        {t("从 Diff 打开当前 Worktree 文件，保存后自动更新变化。")}
      </p>
      {!native && (
        <p className="setting-callout">
          <Code size={17} />
          {t("请在桌面应用中选择编辑器。")}
        </p>
      )}
      <div
        className="editor-scope segmented"
        role="group"
        aria-label={t("编辑器设置范围")}
      >
        <Button
          disabled={disabled}
          aria-pressed={scope === "application"}
          onClick={() => chooseScope("application")}
        >
          {t("应用默认")}
        </Button>
        <Button
          disabled={disabled || !workspaceId}
          aria-pressed={scope === "repository"}
          onClick={() => chooseScope("repository")}
        >
          {t("此仓库")}
        </Button>
      </div>
      {scope === "repository" && (
        <p className="inline-help">
          {t("应用于 ")}
          {workspaceName ?? t("此仓库")} {t(" 及关联 Worktree。")}
        </p>
      )}
      {loading && (
        <p role="status" className="inline-help">
          <ArrowClockwise className="spinning" size={14} />
          {t("读取编辑器设置…")}
        </p>
      )}
      {error && (
        <div className="editor-error" role="alert">
          <Warning size={16} />
          <div>
            <strong>{uiMessage(error.message)}</strong>
            <details>
              <summary>{t("查看详情")}</summary>
              <pre>{error.detail}</pre>
            </details>
            <Button
              className="button compact"
              disabled={saving}
              onClick={() => void load()}
            >
              {t("重新读取设置")}
            </Button>
          </div>
        </div>
      )}
      <label className="field-label" htmlFor="editor-mode">
        {scope === "repository" ? t("此仓库使用") : t("默认使用")}
      </label>
      <Select
        id="editor-mode"
        value={draft.mode}
        disabled={disabled}
        onChange={(event) => {
          setDraft({ ...draft, mode: event.target.value as Draft["mode"] });
          setSaved(false);
        }}
      >
        {scope === "repository" && (
          <option value="inherit">{t("继承应用默认")}</option>
        )}
        <option value="disabled">{t("不使用外部编辑器")}</option>
        <option value="application">{t("指定编辑器")}</option>
      </Select>
      {draft.mode === "application" && (
        <>
          <div
            className="editor-application-list"
            role="group"
            aria-label={t("已安装的编辑器")}
          >
            {applications.map((app) => (
              <Button
                key={app.path}
                title={`${app.name}\n${app.path}`}
                disabled={disabled}
                aria-pressed={draft.path === app.path}
                onClick={() => {
                  setDraft({ mode: "application", path: app.path });
                  setSaved(false);
                }}
              >
                <Code size={17} />
                <span>{app.name}</span>
                {draft.path === app.path && <Check size={15} />}
              </Button>
            ))}
          </div>
          <label className="field-label" htmlFor="editor-path">
            {t("编辑器路径")}
          </label>
          <div className="path-input">
            <Input
              id="editor-path"
              value={draft.path}
              disabled={disabled}
              placeholder={
                settings?.platform === "macos"
                  ? "/Applications/Zed.app"
                  : "C:\\…\\Code.exe"
              }
              onChange={(event) => {
                setDraft({ mode: "application", path: event.target.value });
                setSaved(false);
              }}
            />
            <Button
              className="button"
              disabled={disabled}
              onClick={() => void pick()}
            >
              <FolderOpen size={16} />
              {t("选择应用")}
            </Button>
          </div>
        </>
      )}
      {settings && (
        <div className="editor-effective">
          <span>{workspaceId ? t("当前 Worktree") : t("应用默认")}</span>
          <strong>{settings.effective?.name ?? t("未启用")}</strong>
          <small>
            {settings.source === "repository"
              ? t("此仓库覆盖应用默认")
              : t("使用应用默认")}
          </small>
        </div>
      )}
      <div className="editor-settings-actions">
        <span role="status">
          {saving
            ? t("保存中…")
            : saved
              ? t("已保存")
              : dirty
                ? t("有未保存的修改")
                : ""}
        </span>
        <Button
          className="button primary"
          disabled={
            disabled ||
            !dirty ||
            (draft.mode === "application" && !draft.path.trim())
          }
          onClick={() => void save()}
        >
          {t("保存")}
        </Button>
      </div>
    </section>
  );
}
