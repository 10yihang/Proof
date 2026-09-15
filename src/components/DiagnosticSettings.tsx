import { Fieldset } from "@base-ui/react/fieldset";
import { Input, Button } from "./ui/controls";
import { uiMessage, t, getLanguage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  DownloadSimple,
  FileCode,
  Check,
  Warning,
} from "@phosphor-icons/react";
import { applicationDiagnostic, asError, isDesktop, useRequest } from "../api";
import type { ProofError } from "../types";
import "../styles/diagnostics.css";

type Options = { includePaths: boolean; includeTimeline: boolean };
type Preview = {
  applicationOnly?: boolean;
  id: string;
  fileName: string;
  bytes: number;
  sha256: string;
  capturedAt: number;
  expiresAt: number;
  options: Options;
  content: string;
};
type Saved = { path: string; bytes: number; sha256: string };
const extras = {
  get includePaths() {
    return {
      label: t("本地路径"),
      description: t(
        "包含 Worktree、Git 目录、Hook 配置文件和 Proof 数据目录的位置，可能暴露用户名与项目名称。",
      ),
    };
  },
  get includeTimeline() {
    return {
      label: t("事件缺口时间线"),
      description: t(
        "包含最近 100 条观察缺口的时间、错误码和数量，可能暴露工作时间。",
      ),
    };
  },
};
export function DiagnosticSettings({
  demo,
  onError,
}: {
  demo: boolean;
  onError: (error: unknown) => void;
}) {
  const request = useRequest();
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const [options, setOptions] = useState<Options>({
    includePaths: false,
    includeTimeline: false,
  });
  const [confirm, setConfirm] = useState<keyof Options | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewRef = useRef<Preview | null>(null);
  const [busy, setBusy] = useState<"prepare" | "save" | null>(null);
  const [error, setError] = useState<ProofError | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [expired, setExpired] = useState(false);
  const mounted = useRef(true),
    sequence = useRef(0);
  function forPreview<T>(
    value: Preview,
    action: "validate" | "cancel" | "export",
  ) {
    const args = { previewId: value.id, sha256: value.sha256 };
    return value.applicationOnly
      ? applicationDiagnostic<T>(action, args)
      : request<T>(`${action}_diagnostic`, args);
  }
  function discardPreview() {
    const previous = previewRef.current;
    previewRef.current = null;
    setPreview(null);
    setExpired(false);
    if (previous)
      void forPreview(previous, "cancel").catch((cause) =>
        errorHandler.current(cause),
      );
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++sequence.current;
      if (previewRef.current)
        void forPreview(previewRef.current, "cancel").catch((cause) =>
          errorHandler.current(cause),
        );
    };
  }, [request]);
  useEffect(() => {
    if (!preview || busy === "save") return;
    let disposed = false;
    const invalidate = () => {
      if (disposed || previewRef.current?.id !== preview.id) return;
      previewRef.current = null;
      setPreview(null);
      setExpired(true);
    };
    const monitor = setInterval(() => {
      void forPreview(preview, "validate").catch((cause) => {
        if (!disposed && previewRef.current?.id === preview.id) {
          invalidate();
          setError(asError(cause));
        }
      });
    }, 2000);
    const timer = setTimeout(
      () => {
        invalidate();
        void forPreview(preview, "cancel").catch((cause) =>
          errorHandler.current(cause),
        );
      },
      Math.max(0, preview.expiresAt - Date.now()),
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(monitor);
    };
  }, [preview, request, busy]);
  function choose(key: keyof Options, enabled: boolean) {
    discardPreview();
    setSaved(null);
    setError(null);
    if (enabled) setConfirm(key);
    else {
      setConfirm(null);
      setOptions((value) => ({ ...value, [key]: false }));
    }
  }
  async function prepare(applicationOnly = false) {
    const n = ++sequence.current;
    discardPreview();
    setSaved(null);
    setError(null);
    setBusy("prepare");
    try {
      if (applicationOnly) {
        setOptions({ includePaths: false, includeTimeline: false });
        setConfirm(null);
      }
      const value = applicationOnly
        ? await applicationDiagnostic<Preview>("prepare")
        : await request<Preview>("prepare_diagnostic", { options });
      if (!mounted.current || n !== sequence.current) {
        void forPreview(value, "cancel").catch((cause) =>
          errorHandler.current(cause),
        );
        return;
      }
      previewRef.current = value;
      setPreview(value);
      setExpired(value.expiresAt <= Date.now());
    } catch (cause) {
      if (mounted.current && n === sequence.current) setError(asError(cause));
      else errorHandler.current(cause);
    } finally {
      if (mounted.current && n === sequence.current) setBusy(null);
    }
  }
  async function save() {
    if (!preview || busy || expired) return;
    setBusy("save");
    setError(null);
    try {
      const result = await forPreview<Saved | null>(preview, "export");
      if (result && mounted.current) {
        previewRef.current = null;
        setPreview(null);
        setError(null);
        setExpired(false);
        setSaved(result);
      }
    } catch (cause) {
      const value = asError(cause);
      if (mounted.current) {
        setError(value);
        if (value.code !== "DATA_SESSION_REQUIRED") setExpired(true);
      } else errorHandler.current(cause);
    } finally {
      if (mounted.current) setBusy(null);
    }
  }
  return (
    <section className="diagnostic-settings" aria-label={t("诊断导出")}>
      <h3>{t("诊断")}</h3>
      <p className="muted">
        {t("查看运行状态，并将诊断保存为本地 JSON 文件。")}
      </p>
      <div className="diagnostic-defaults">
        <FileCode size={21} aria-hidden="true" />
        <div>
          <strong>{t("基本诊断")}</strong>
          <p>
            {t(
              "Proof、Git 与适配器版本，能力检测、错误码、观察队列和操作耗时统计。",
            )}
          </p>
          <small>
            {t(
              "不包含源码、prompt、Agent 回复、命令、原始输出、远程 URL 或凭据。",
            )}
          </small>
        </div>
      </div>
      <Fieldset.Root
        className="diagnostic-extras"
        disabled={!!busy || demo || !isDesktop || preview?.applicationOnly}
      >
        <legend>{t("附加内容")}</legend>
        {(Object.keys(extras) as (keyof Options)[]).map((key) => (
          <label key={key} className="diagnostic-option">
            <Input
              type="checkbox"
              checked={options[key]}
              onChange={(e) => choose(key, e.target.checked)}
            />
            <span>
              <strong>{extras[key].label}</strong>
              <small>
                {key === "includePaths"
                  ? t("文件位置，不读取配置内容")
                  : t("缺口发生的时间与数量，不包含会话内容")}
              </small>
            </span>
          </label>
        ))}
      </Fieldset.Root>
      {confirm && (
        <div
          className="diagnostic-confirm"
          role="group"
          aria-label={t("确认包含{v0}", { v0: extras[confirm].label })}
        >
          <Warning size={18} aria-hidden="true" />
          <div>
            <strong>
              {t("包含")}
              {extras[confirm].label}
            </strong>
            <p>{extras[confirm].description}</p>
            <div className="diagnostic-actions">
              <Button
                className="button compact"
                onClick={() => setConfirm(null)}
              >
                {t("取消")}
              </Button>
              <Button
                className="button compact"
                onClick={() => {
                  setOptions((value) => ({ ...value, [confirm]: true }));
                  setConfirm(null);
                }}
              >
                {t("确认包含")}
                {extras[confirm].label}
              </Button>
            </div>
          </div>
        </div>
      )}
      {(demo || !isDesktop) && (
        <p className="inline-notice">{t("请在桌面应用中生成真实诊断。")}</p>
      )}
      {error && (
        <div className="inline-notice" role="alert">
          {uiMessage(error.message)} <code>{error.code}</code>
        </div>
      )}
      {preview?.applicationOnly && (
        <p className="inline-notice">
          {t(
            "这份报告仅包含应用版本、平台与启动错误码。不读取仓库、Agent 记录或历史统计。",
          )}
        </p>
      )}
      {!preview && expired && (
        <p className="inline-notice" role="status">
          {t("预览已失效，请重新生成后保存。")}
        </p>
      )}
      {saved && (
        <div className="diagnostic-saved" role="status">
          <Check size={18} aria-hidden="true" />
          <div>
            <strong>{t("诊断已保存")}</strong>
            <p>{saved.path}</p>
            <small>
              {saved.bytes.toLocaleString(getLanguage())} {t(" bytes")}
            </small>
          </div>
        </div>
      )}
      {preview ? (
        <div className="diagnostic-preview">
          <header>
            <div>
              <strong>{t("导出预览")}</strong>
              <span>
                {preview.fileName} · {(preview.bytes / 1024).toFixed(1)}{" "}
                {t(" KB")}
              </span>
            </div>
            <span>
              {new Date(preview.capturedAt).toLocaleTimeString(getLanguage())}
            </span>
          </header>
          <pre tabIndex={0} aria-label={t("诊断内容预览")}>
            {preview.content}
          </pre>
          {expired ? (
            <p className="inline-notice" role="status">
              {t("预览已失效，请重新生成后保存。")}
            </p>
          ) : (
            <p className="muted">
              {t("将原样保存以上内容。预览有效期为 5 分钟。")}
            </p>
          )}
          <div className="diagnostic-actions">
            <Button
              className="button"
              disabled={!!busy}
              onClick={discardPreview}
            >
              {t("取消预览")}
            </Button>
            <Button
              className="button"
              disabled={!!busy || !!confirm}
              onClick={() => void prepare(!!preview.applicationOnly)}
            >
              <ArrowClockwise size={15} aria-hidden="true" />
              {t("重新生成")}
            </Button>
            <Button
              className="button primary"
              disabled={!!busy || expired || !!confirm}
              onClick={() => void save()}
            >
              <DownloadSimple size={16} aria-hidden="true" />
              {busy === "save" ? t("等待保存…") : t("保存到本地…")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          className="button primary"
          disabled={!!busy || !!confirm || demo || !isDesktop}
          onClick={() => void prepare()}
        >
          <FileCode size={16} aria-hidden="true" />
          {busy === "prepare" ? t("生成中…") : t("生成预览")}
        </Button>
      )}
      <Button
        className="button diagnostic-application-button"
        disabled={!!busy || demo || !isDesktop}
        onClick={() => void prepare(true)}
      >
        {t("仅导出应用信息")}
      </Button>
      <p className="diagnostic-footnote">
        {t(
          "诊断不会自动上传。已导出的文件需要单独删除，清理 Proof 本地数据不会删除这些副本。",
        )}
      </p>
    </section>
  );
}
