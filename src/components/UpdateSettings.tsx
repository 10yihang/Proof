import { useStore } from "zustand";
import {
  ArrowClockwise,
  DownloadSimple,
  CheckCircle,
} from "@phosphor-icons/react";
import { appUpdater } from "../updater";
import { APP_VERSION } from "../version";
import { t, uiMessage } from "../i18n";
import { isDesktop } from "../api";
import { Button } from "./ui/controls";

export function UpdateSettings({ demo }: { demo: boolean }) {
  const state = useStore(appUpdater.store);
  const busy = ["checking", "downloading", "installing"].includes(state.phase);
  const percent = state.total
    ? Math.min(100, Math.round((state.downloaded / state.total) * 100))
    : null;
  return (
    <section className="update-settings">
      <header className="agent-settings-heading">
        <div>
          <h3>{t("软件更新")}</h3>
          <p className="muted">Proof {APP_VERSION}</p>
        </div>
        <span className="tag">{t("稳定版")}</span>
      </header>
      <p className="muted">
        {t("从 GitHub Releases 获取更新，下载后校验签名。安装将重启 Proof。")}
      </p>
      {demo || !isDesktop ? (
        <p className="inline-notice">{t("请在 Proof 桌面应用中检查更新。")}</p>
      ) : (
        <>
          <div className="update-actions">
            <Button
              className="button"
              disabled={busy}
              onClick={() => void appUpdater.check()}
            >
              <ArrowClockwise
                size={16}
                className={state.phase === "checking" ? "spin" : undefined}
              />
              {state.phase === "checking" ? t("正在检查更新…") : t("检查更新")}
            </Button>
            {state.phase === "available" && (
              <Button
                className="button primary"
                onClick={() => void appUpdater.download()}
              >
                <DownloadSimple size={16} />
                {t("下载更新")}
              </Button>
            )}
            {(state.phase === "ready" || state.phase === "installing") && (
              <Button
                className="button primary"
                disabled={busy}
                onClick={() => void appUpdater.install()}
              >
                {state.phase === "installing"
                  ? t("正在安装…")
                  : t("安装并重启")}
              </Button>
            )}
          </div>
          <div aria-live="polite" role="status">
            {state.phase === "current" && (
              <p className="update-current">
                <CheckCircle size={18} />
                {t("已是最新版本")}
              </p>
            )}
            {state.update && (
              <p>{t("可用版本：{v0}", { v0: state.update.version })}</p>
            )}
            {state.phase === "ready" && (
              <p>{t("下载完成，签名已验证。可以安装更新。")}</p>
            )}
          </div>
          {state.phase === "downloading" && (
            <div className="update-progress">
              <progress
                aria-label={t("更新下载进度")}
                value={state.total ? state.downloaded : undefined}
                max={state.total ?? 1}
              />
              <span>
                {percent === null
                  ? `${(state.downloaded / 1048576).toFixed(1)} MB`
                  : `${percent}%`}
              </span>
            </div>
          )}
          {state.error && (
            <div className="agent-settings-error" role="alert">
              <strong>{uiMessage(state.error.message)}</strong>
              <p className="muted">{state.error.code}</p>
            </div>
          )}
          {state.update?.notes && (
            <div className="update-release-notes">
              <h4>{t("版本说明")}</h4>
              <pre>{state.update.notes}</pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}
