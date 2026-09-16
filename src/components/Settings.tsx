import { ScrollArea } from "./ui/scroll-area";
import { APP_VERSION } from "../version";
import { Switch } from "./ui/controls";
import { Tabs } from "@base-ui/react/tabs";
import { Button, Select, Input } from "./ui/controls";
import { useLanguageStatus, saveLanguage } from "../i18n-controller";
import { useRequest } from "../api";
import { t, useLanguage, uiMessage, type Language } from "../i18n";
import { useEffect, useRef, useState } from "react";
import {
  Desktop,
  Database,
  GearSix,
  Info,
  Moon,
  Plug,
  ShieldCheck,
  Sun,
  Code,
  Sparkle,
} from "@phosphor-icons/react";
import type {
  Preferences,
  ProofError,
  RepositoryLayout,
  Workspace,
} from "../types";
import type { LayoutSnapshot } from "../repository-layout";
import { RepositoryLayoutSettings } from "./RepositoryLayoutSettings";
import { Modal } from "./Modal";
import { DataSettings } from "./DataSettings";
import { ObserverSettings } from "./ObserverSettings";
import { EditorSettings } from "./EditorSettings";
import { UpdateSettings } from "./UpdateSettings";
import { AgentSettings } from "./AgentSettings";
import { DiagnosticSettings } from "./DiagnosticSettings";

export function Settings({
  preferences,
  error,
  onChange,
  onClose,
  workspaces,
  workspaceId,
  demo,
  layout,
  initialSection = "appearance",
  onError,
  onRecentChanged,
}: {
  preferences: Preferences;
  error: ProofError | null;
  onChange: (p: Partial<Preferences>) => Promise<void>;
  onClose: () => void;
  workspaces: Workspace[];
  workspaceId?: string;
  demo: boolean;
  layout?: {
    snapshot: LayoutSnapshot;
    name: string;
    key: string;
    onChange: (value: Partial<RepositoryLayout>) => void;
    onReset: () => void;
    onRetry: () => void;
  };
  initialSection?:
    | "appearance"
    | "review"
    | "observer"
    | "data"
    | "editor"
    | "diagnostics"
    | "updates"
    | "agents";
  onError: (error: unknown) => void;
  onRecentChanged?: () => Promise<void>;
}) {
  const [tab, setTab] = useState<
    | "appearance"
    | "review"
    | "observer"
    | "data"
    | "editor"
    | "diagnostics"
    | "updates"
    | "agents"
  >(initialSection);
  const language = useLanguage();
  const languageStatus = useLanguageStatus();
  const request = useRequest();
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
  }, [tab]);
  return (
    <Modal
      title={t("设置")}
      error={error}
      onClose={onClose}
      wide
      className="settings-modal"
    >
      <Tabs.Root
        value={tab}
        onValueChange={(value) => setTab(value as typeof tab)}
        orientation="vertical"
        className="settings-layout"
      >
        <Tabs.List className="settings-nav" aria-label={t("设置分类")}>
          <Tabs.Tab
            value={"appearance"}
            className={tab === "appearance" ? "active" : ""}
          >
            <GearSix size={17} />
            {t("外观与阅读")}
          </Tabs.Tab>
          <Tabs.Tab
            value={"review"}
            className={tab === "review" ? "active" : ""}
          >
            <ShieldCheck size={17} />
            {t("Git 与审查")}
          </Tabs.Tab>
          <Tabs.Tab
            value={"agents"}
            className={tab === "agents" ? "active" : ""}
          >
            <Sparkle size={17} />
            {t("AI Agents")}
          </Tabs.Tab>
          <Tabs.Tab
            value={"observer"}
            className={tab === "observer" ? "active" : ""}
          >
            <Plug size={17} />
            {t("Agent 观察")}
          </Tabs.Tab>
          <Tabs.Tab
            value={"editor"}
            className={tab === "editor" ? "active" : ""}
          >
            <Code size={17} />
            {t("外部编辑器")}
          </Tabs.Tab>
          <Tabs.Tab value={"data"} className={tab === "data" ? "active" : ""}>
            <Database size={17} />
            {t("本地数据")}
          </Tabs.Tab>
          <Tabs.Tab
            value={"diagnostics"}
            className={tab === "diagnostics" ? "active" : ""}
          >
            <Info size={17} />
            {t("诊断")}
          </Tabs.Tab>
          <Tabs.Tab
            value="updates"
            className={tab === "updates" ? "active" : ""}
          >
            <Desktop size={17} />
            {t("软件更新")}
          </Tabs.Tab>
        </Tabs.List>
        <ScrollArea
          className="settings-scroll-root min-h-0 min-w-0"
          viewportRef={content}
          viewportClassName="settings-content"
        >
          <Tabs.Panel value={tab}>
            {tab === "agents" && <AgentSettings demo={demo} />}
            {tab === "updates" && <UpdateSettings demo={demo} />}
            {tab === "diagnostics" && (
              <DiagnosticSettings demo={demo} onError={onError} />
            )}
            {tab === "editor" && (
              <EditorSettings
                key={workspaceId ?? "application"}
                workspaceId={workspaceId}
                workspaceName={
                  workspaces.find((workspace) => workspace.id === workspaceId)
                    ?.name
                }
                demo={demo}
                onSaveError={onError}
              />
            )}
            {tab === "data" && (
              <DataSettings
                workspaces={workspaces}
                workspaceId={workspaceId}
                demo={demo}
                onError={onError}
                onRecentChanged={onRecentChanged}
              />
            )}
            {tab === "appearance" && (
              <>
                <h3>{t("外观与阅读")}</h3>
                <p className="muted">
                  {t("应用默认设置。仓库布局可单独调整。")}
                </p>
                <label className="field-label" htmlFor="ui-language">
                  {t("语言 / Language")}
                </label>
                <Select
                  id="ui-language"
                  aria-label={t("界面语言")}
                  value={language}
                  disabled={languageStatus.saving}
                  onChange={(event) =>
                    void saveLanguage(event.target.value as Language, request)
                  }
                >
                  <option value="zh-CN" lang="zh-CN">
                    简体中文
                  </option>
                  <option value="en" lang="en">
                    English
                  </option>
                </Select>
                <p className="inline-help">
                  {t("立即生效，不改变代码、Commit message 或已有 AI 报告。")}
                </p>
                {languageStatus.error && (
                  <p className="inline-notice" role="alert">
                    {t("语言设置未保存，请重试。")}{" "}
                    {uiMessage(languageStatus.error.message)}
                  </p>
                )}
                <label className="field-label">{t("主题")}</label>
                <div className="theme-options">
                  {(
                    [
                      {
                        value: "light",
                        label: t("浅色"),
                        icon: <Sun size={22} />,
                      },
                      {
                        value: "dark",
                        label: t("深色"),
                        icon: <Moon size={22} />,
                      },
                      {
                        value: "system",
                        label: t("跟随系统"),
                        icon: <Desktop size={22} />,
                      },
                    ] as const
                  ).map((option) => (
                    <Button
                      key={option.value}
                      aria-pressed={preferences.theme === option.value}
                      onClick={() => {
                        void onChange({ theme: option.value });
                      }}
                    >
                      {option.icon}
                      <span>{option.label}</span>
                    </Button>
                  ))}
                </div>
                <label className="field-label" htmlFor="font-size">
                  {t("代码字号 ")}
                  <span>
                    {preferences.fontSize}
                    {t("px")}
                  </span>
                </label>
                <Input
                  id="font-size"
                  type="range"
                  min="10"
                  max="26"
                  value={preferences.fontSize}
                  onChange={(e) => {
                    void onChange({ fontSize: Number(e.target.value) });
                  }}
                />
                <label className="settings-toggle">
                  <span>
                    <strong>{t("自动换行")}</strong>
                    <small>{t("长代码行在可用空间内换行")}</small>
                  </span>
                  <Switch
                    type="checkbox"
                    checked={preferences.wrapLines}
                    onChange={(e) => {
                      void onChange({ wrapLines: e.target.checked });
                    }}
                  />
                </label>
                <label className="settings-toggle">
                  <span>
                    <strong>{t("显示 Context 面板")}</strong>
                    <small>{t("应用默认；仓库单独设置时优先使用仓库值")}</small>
                  </span>
                  <Switch
                    type="checkbox"
                    checked={preferences.contextOpen}
                    onChange={(e) => {
                      void onChange({ contextOpen: e.target.checked });
                    }}
                  />
                </label>
                {layout && (
                  <RepositoryLayoutSettings
                    key={layout.key}
                    snapshot={layout.snapshot}
                    name={layout.name}
                    demo={demo}
                    onChange={layout.onChange}
                    onReset={layout.onReset}
                    onRetry={layout.onRetry}
                  />
                )}
              </>
            )}
            {tab === "review" && (
              <>
                <h3>{t("人工审查，由你决定")}</h3>
                <label className="settings-toggle">
                  <span>
                    <strong>{t("本应用提交前要求完成审查")}</strong>
                    <small>
                      {t("只约束 Proof 的提交入口，外部终端仍可提交。")}
                    </small>
                  </span>
                  <Switch
                    type="checkbox"
                    checked={preferences.strictReview}
                    onChange={(e) => {
                      void onChange({ strictReview: e.target.checked });
                    }}
                  />
                </label>
                <div className="setting-callout">
                  <Info size={17} />
                  <p>
                    {t(
                      "标记已审查不会暂存代码；暂存不会自动完成审查。每条记录都绑定当时的内容与比较基准。",
                    )}
                  </p>
                </div>
                <label className="field-label" htmlFor="git-program">
                  {t("Git 可执行文件")}
                </label>
                <Input
                  id="git-program"
                  defaultValue={preferences.gitPath}
                  onBlur={(e) => {
                    if (e.target.value !== preferences.gitPath)
                      void onChange({ gitPath: e.target.value });
                  }}
                />
                <p className="inline-help">
                  {t(
                    "输入程序名称或绝对路径。Git 参数由应用处理，请勿填写 shell 命令。",
                  )}
                </p>
                <p className="inline-help">
                  {t("Proof 保留现有 Git Hook、签名与安全配置。")}
                </p>
              </>
            )}
            {tab === "observer" && (
              <ObserverSettings
                demo={demo}
                workspaces={workspaces}
                workspaceId={workspaceId}
                onError={onError}
              />
            )}
          </Tabs.Panel>
        </ScrollArea>
      </Tabs.Root>
      <div className="settings-version">
        Proof {APP_VERSION} <span>{t("本地代码审查工作台")}</span>
      </div>
    </Modal>
  );
}
