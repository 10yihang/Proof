import { useState } from "react";
import {
  Desktop,
  Database,
  GearSix,
  Info,
  Moon,
  Plug,
  ShieldCheck,
  Sun,
} from "@phosphor-icons/react";
import type { Preferences, ProofError, Workspace } from "../types";
import { Modal } from "./Modal";
import { DataSettings } from "./DataSettings";
import { ObserverSettings } from "./ObserverSettings";

export function Settings({
  preferences,
  error,
  onChange,
  onClose,
  workspaces,
  workspaceId,
  demo,
}: {
  preferences: Preferences;
  error: ProofError | null;
  onChange: (p: Partial<Preferences>) => Promise<void>;
  onClose: () => void;
  workspaces: Workspace[];
  workspaceId?: string;
  demo: boolean;
}) {
  const [tab, setTab] = useState<"appearance" | "review" | "observer" | "data">(
    "appearance",
  );
  return (
    <Modal title="设置" error={error} onClose={onClose} wide>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <button
            className={tab === "appearance" ? "active" : ""}
            onClick={() => setTab("appearance")}
          >
            <GearSix size={17} />
            外观与阅读
          </button>
          <button
            className={tab === "review" ? "active" : ""}
            onClick={() => setTab("review")}
          >
            <ShieldCheck size={17} />
            Git 与审查
          </button>
          <button
            className={tab === "observer" ? "active" : ""}
            onClick={() => setTab("observer")}
          >
            <Plug size={17} />
            Agent 观察
          </button>
          <button
            className={tab === "data" ? "active" : ""}
            onClick={() => setTab("data")}
          >
            <Database size={17} />
            本地数据
          </button>
        </nav>
        <div className="settings-content">
          {tab === "data" && (
            <DataSettings
              workspaces={workspaces}
              workspaceId={workspaceId}
              demo={demo}
            />
          )}
          {tab === "appearance" && (
            <>
              <h3>让代码保持清晰</h3>
              <p className="muted">偏好保存在本机，所有主题均可离线使用。</p>
              <label className="field-label">主题</label>
              <div className="theme-options">
                {(
                  [
                    { value: "light", label: "浅色", icon: <Sun size={22} /> },
                    { value: "dark", label: "深色", icon: <Moon size={22} /> },
                    {
                      value: "system",
                      label: "跟随系统",
                      icon: <Desktop size={22} />,
                    },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    aria-pressed={preferences.theme === option.value}
                    onClick={() => {
                      void onChange({ theme: option.value });
                    }}
                  >
                    {option.icon}
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
              <label className="field-label" htmlFor="font-size">
                代码字号 <span>{preferences.fontSize}px</span>
              </label>
              <input
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
                  <strong>自动换行</strong>
                  <small>长代码行在可用空间内换行</small>
                </span>
                <input
                  type="checkbox"
                  checked={preferences.wrapLines}
                  onChange={(e) => {
                    void onChange({ wrapLines: e.target.checked });
                  }}
                />
              </label>
              <label className="settings-toggle">
                <span>
                  <strong>显示上下文面板</strong>
                  <small>随时核对来源与执行证据</small>
                </span>
                <input
                  type="checkbox"
                  checked={preferences.contextOpen}
                  onChange={(e) => {
                    void onChange({ contextOpen: e.target.checked });
                  }}
                />
              </label>
            </>
          )}
          {tab === "review" && (
            <>
              <h3>人工审查，由你决定</h3>
              <label className="settings-toggle">
                <span>
                  <strong>本应用提交前要求完成审查</strong>
                  <small>只约束 Proof 的提交入口，外部终端仍可提交。</small>
                </span>
                <input
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
                  标记已审查不会暂存代码；暂存不会自动完成审查。每条记录都绑定当时的内容与比较基准。
                </p>
              </div>
              <label className="field-label" htmlFor="git-program">
                Git 可执行文件
              </label>
              <input
                id="git-program"
                defaultValue={preferences.gitPath}
                onBlur={(e) => {
                  if (e.target.value !== preferences.gitPath)
                    void onChange({ gitPath: e.target.value });
                }}
              />
              <p className="inline-help">
                输入程序名称或绝对路径。Git 参数由应用处理，请勿填写 shell
                命令。
              </p>
              <p className="inline-help">
                Proof 保留现有 Git Hook、签名与安全配置。
              </p>
            </>
          )}
          {tab === "observer" && <ObserverSettings demo={demo} />}
        </div>
      </div>
      <div className="settings-version">
        Proof 0.1.0 Alpha <span>本地代码审查工作台</span>
      </div>
    </Modal>
  );
}
