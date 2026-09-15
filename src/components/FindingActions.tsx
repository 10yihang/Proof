import { Button } from "./ui/controls";
import { t } from "../i18n";
import type { FindingDecision } from "../ai-reports";
export const decisionLabel = {
  get pending() {
    return t("待处理");
  },
  get accepted() {
    return t("已采纳");
  },
  get dismissed() {
    return t("不采纳");
  },
};
export function FindingActions({
  decision,
  disabled,
  onChange,
}: {
  decision: FindingDecision;
  disabled: boolean;
  onChange: (value: FindingDecision) => void;
}) {
  return (
    <div className="finding-actions" aria-label={t("Finding 处理状态")}>
      <span className={`finding-decision ${decision}`}>
        {decisionLabel[decision]}
      </span>
      <Button
        className="button compact"
        disabled={disabled}
        aria-pressed={decision === "accepted"}
        onClick={() => onChange("accepted")}
      >
        {t("采纳")}
      </Button>
      <Button
        className="button compact"
        disabled={disabled}
        aria-pressed={decision === "dismissed"}
        onClick={() => onChange("dismissed")}
      >
        {t("不采纳")}
      </Button>
      {decision !== "pending" && (
        <Button
          className="text-button"
          disabled={disabled}
          onClick={() => onChange("pending")}
        >
          {t("撤销")}
        </Button>
      )}
    </div>
  );
}
