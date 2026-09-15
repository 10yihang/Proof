import { Button } from "./ui/controls";
import { t } from "../i18n";
import { ArrowClockwise } from "@phosphor-icons/react";

/** Out of document flow: loading never changes the shared workbench geometry. */
export function DiffLoading({
  path,
  updating = false,
  onCancel,
}: {
  path?: string;
  updating?: boolean;
  onCancel: () => void;
}) {
  return (
    <div className={`diff-loading-layer ${updating ? "updating" : ""}`}>
      {!updating && (
        <div className="diff-loading-placeholder" aria-hidden="true">
          <div className="diff-loading-header">{path ?? "Diff"}</div>
          <div className="diff-loading-code">
            {[64, 42, 76, 58, 35].map((width, index) => (
              <span key={index} style={{ width: `${width}%` }} />
            ))}
          </div>
          <div className="diff-loading-footer" />
        </div>
      )}
      <div className="diff-loading" role="status">
        <ArrowClockwise size={14} className="spinning" />
        {updating ? t("更新 Diff…") : t("载入 Diff…")}
        <Button className="text-button" onClick={onCancel}>
          {t("取消读取")}
        </Button>
      </div>
    </div>
  );
}
