import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowClockwise,
  Check,
  Code,
  FolderOpen,
  Warning,
} from "@phosphor-icons/react";
import { asError, isDesktop, request } from "../api";
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
        title: "选择外部编辑器",
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
          message: `${scope === "application" ? "应用默认" : (workspaceName ?? "此仓库")}的编辑器设置未保存。${asError(error).message}`,
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
    <section className="editor-settings" aria-label="外部编辑器">
      <h3>外部编辑器</h3>
      <p className="muted">
        从 Diff 打开当前 Worktree 文件，保存后自动更新变化。
      </p>
      {!native && (
        <p className="setting-callout">
          <Code size={17} />
          请在桌面应用中选择编辑器。
        </p>
      )}
      <div
        className="editor-scope segmented"
        role="group"
        aria-label="编辑器设置范围"
      >
        <button
          disabled={disabled}
          aria-pressed={scope === "application"}
          onClick={() => chooseScope("application")}
        >
          应用默认
        </button>
        <button
          disabled={disabled || !workspaceId}
          aria-pressed={scope === "repository"}
          onClick={() => chooseScope("repository")}
        >
          此仓库
        </button>
      </div>
      {scope === "repository" && (
        <p className="inline-help">
          应用于 {workspaceName ?? "此仓库"} 及关联 Worktree。
        </p>
      )}
      {loading && (
        <p role="status" className="inline-help">
          <ArrowClockwise className="spinning" size={14} />
          读取编辑器设置…
        </p>
      )}
      {error && (
        <div className="editor-error" role="alert">
          <Warning size={16} />
          <div>
            <strong>{error.message}</strong>
            <details>
              <summary>查看详情</summary>
              <pre>{error.detail}</pre>
            </details>
            <button
              className="button compact"
              disabled={saving}
              onClick={() => void load()}
            >
              重新读取设置
            </button>
          </div>
        </div>
      )}
      <label className="field-label" htmlFor="editor-mode">
        {scope === "repository" ? "此仓库使用" : "默认使用"}
      </label>
      <select
        id="editor-mode"
        value={draft.mode}
        disabled={disabled}
        onChange={(event) => {
          setDraft({ ...draft, mode: event.target.value as Draft["mode"] });
          setSaved(false);
        }}
      >
        {scope === "repository" && (
          <option value="inherit">继承应用默认</option>
        )}
        <option value="disabled">不使用外部编辑器</option>
        <option value="application">指定编辑器</option>
      </select>
      {draft.mode === "application" && (
        <>
          <div
            className="editor-application-list"
            role="group"
            aria-label="已安装的编辑器"
          >
            {applications.map((app) => (
              <button
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
              </button>
            ))}
          </div>
          <label className="field-label" htmlFor="editor-path">
            编辑器路径
          </label>
          <div className="path-input">
            <input
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
            <button
              className="button"
              disabled={disabled}
              onClick={() => void pick()}
            >
              <FolderOpen size={16} />
              选择应用
            </button>
          </div>
        </>
      )}
      {settings && (
        <div className="editor-effective">
          <span>{workspaceId ? "当前 Worktree" : "应用默认"}</span>
          <strong>{settings.effective?.name ?? "未启用"}</strong>
          <small>
            {settings.source === "repository"
              ? "此仓库覆盖应用默认"
              : "使用应用默认"}
          </small>
        </div>
      )}
      <div className="editor-settings-actions">
        <span role="status">
          {saving
            ? "保存中…"
            : saved
              ? "已保存"
              : dirty
                ? "有未保存的修改"
                : ""}
        </span>
        <button
          className="button primary"
          disabled={
            disabled ||
            !dirty ||
            (draft.mode === "application" && !draft.path.trim())
          }
          onClick={() => void save()}
        >
          保存
        </button>
      </div>
    </section>
  );
}
