import { t, riskLabel } from "../i18n";
import type { AiFinding } from "../ai";
import type { FindingDecision } from "../ai-reports";
import { decisionLabel, FindingActions } from "./FindingActions";
export function findingLocation(finding: AiFinding) {
  const end = finding.endLine ?? finding.line;
  return `${t(finding.lineSide === "old" ? "修改前" : "修改后")} ${finding.line}${end > finding.line ? `–${end}` : ""}`;
}
export function InlineReview({
  finding,
  decision,
  disabled,
  onDecision,
}: {
  finding: AiFinding;
  decision: FindingDecision;
  disabled: boolean;
  onDecision: (decision: FindingDecision) => void;
}) {
  return (
    <details className={`ai-inline-review ${decision}`} open>
      <summary>
        <span className={`ai-risk ${finding.severity}`}>
          {riskLabel(finding.severity)}
        </span>
        <strong>{finding.title}</strong>
        <span className="inline-review-location">
          {findingLocation(finding)} · {decisionLabel[decision]}
        </span>
      </summary>
      <div className="inline-review-body">
        <p>{finding.description}</p>
        <p className="ai-suggestion">{finding.suggestion}</p>
        <FindingActions
          decision={decision}
          disabled={disabled}
          onChange={onDecision}
        />
      </div>
    </details>
  );
}
