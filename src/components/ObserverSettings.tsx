import { useEffect, useState } from "react";
import { ArrowClockwise, Plug, ShieldCheck } from "@phosphor-icons/react";
import { asError, isDesktop, useRequest } from "../api";
import type {
  ObserverProbe,
  ObserverProgramLocation,
  ProofError,
} from "../types";

export function ObserverSettings({ demo }: { demo: boolean }) {
  const request = useRequest();
  const [locations, setLocations] = useState<ObserverProgramLocation[]>([]);
  const [error, setError] = useState<ProofError | null>(null);
  useEffect(() => {
    if (!isDesktop || demo) return;
    let active = true;
    request<ObserverProgramLocation[]>("observer_program_locations")
      .then((value) => {
        if (active) setLocations(value);
      })
      .catch((cause) => {
        if (active) setError(asError(cause));
      });
    return () => {
      active = false;
    };
  }, [demo]);
  return (
    <>
      <h3>保持你的开发方式</h3>
      <p className="muted">
        先核对本机 Agent 版本，再审核允许的仓库、采集字段和配置差异。
      </p>
      {(!isDesktop || demo) && (
        <p className="inline-help">
          演示模式不执行本机程序；版本检测请在 Proof 桌面版进行。
        </p>
      )}
      {error && (
        <p role="alert">
          {error.message} · {error.code}
        </p>
      )}
      {(["claude", "codex"] as const).map((agent) => (
        <AgentVersion
          key={agent}
          agent={agent}
          executable={
            locations.find((item) => item.agent === agent)?.executablePath ?? ""
          }
          available={isDesktop && !demo}
        />
      ))}
      <div className="setting-callout">
        <ShieldCheck size={18} />
        <p>
          当前版本提供接入前检测。配置安装和真实事件验证尚未开放；检测版本不会开启观察。Git
          与人工审查可独立使用。
        </p>
      </div>
      <dl className="privacy-defaults">
        <dt>默认采集等级</dt>
        <dd>L0 · 关闭</dd>
        <dt>默认后台观察</dt>
        <dd>关闭</dd>
        <dt>模型调用</dt>
        <dd>关闭</dd>
        <dt>诊断上传</dt>
        <dd>关闭</dd>
      </dl>
    </>
  );
}

function AgentVersion({
  agent,
  executable,
  available,
}: {
  agent: "codex" | "claude";
  executable: string;
  available: boolean;
}) {
  const request = useRequest();
  const [path, setPath] = useState(executable);
  const [edited, setEdited] = useState(false);
  const [probe, setProbe] = useState<ObserverProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProofError | null>(null);
  useEffect(() => {
    if (!edited) setPath(executable);
  }, [edited, executable]);
  async function detect() {
    setBusy(true);
    setError(null);
    setProbe(null);
    try {
      setProbe(
        await request<ObserverProbe>("probe_observer", {
          agent,
          executablePath: path,
        }),
      );
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="observer-version-card"
      aria-label={agent === "codex" ? "Codex 版本检测" : "Claude Code 版本检测"}
    >
      <div className="agent-setting">
        <div className="agent-icon">
          <Plug size={20} />
        </div>
        <div>
          <strong>{agent === "codex" ? "Codex" : "Claude Code"}</strong>
          <small>{probe ? `检测到 ${probe.version}` : "尚未检测"}</small>
        </div>
        <span className="tag">
          {probe?.status === "unsupported_version" ? "未知版本" : "待兼容验证"}
        </span>
      </div>
      <label className="field-label" htmlFor={`agent-program-${agent}`}>
        程序路径
      </label>
      <input
        id={`agent-program-${agent}`}
        value={path}
        disabled={!available || busy}
        placeholder="Agent 程序的绝对路径"
        onChange={(event) => {
          setEdited(true);
          setPath(event.target.value);
          setProbe(null);
          setError(null);
        }}
      />
      <button
        className="button compact"
        disabled={!available || busy || !path.trim()}
        onClick={() => {
          void detect();
        }}
      >
        <ArrowClockwise size={14} />
        {busy ? "正在检测…" : "检测版本"}
      </button>
      {probe && (
        <p className="inline-help" role="status">
          {probe.profile
            ? "此版本已有候选配置方案；真实 CLI 事件与非干预行为仍待验证。"
            : "尚无匹配的配置方案。此版本不会被当作已验证组合启用。"}
        </p>
      )}
      {probe?.profile?.trustReviewRequired && (
        <p className="inline-help">
          Codex 接入还需要在原 CLI 的 /hooks 中审阅并信任具体条目。
        </p>
      )}
      {error && (
        <p className="data-warning" role="alert">
          {error.message}
          <small>{error.code}</small>
        </p>
      )}
    </section>
  );
}
