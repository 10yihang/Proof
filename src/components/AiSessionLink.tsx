import { useState } from "react";
import { Button } from "./ui/controls";
import { t } from "../i18n";
import type { AiReport } from "../ai";

export function AiSessionLink({ session }: { session: AiReport["session"] }) {
  const [copied, setCopied] = useState(false);
  if (!session) return null;
  return (
    <details className="ai-session-link">
      <summary>{t("在 CLI 中继续此会话")}</summary>
      <code>{session.resumeCommand}</code>
      <Button
        className="text-button"
        onClick={() => {
          void navigator.clipboard
            .writeText(session.resumeCommand)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? t("已复制") : t("复制命令")}
      </Button>
    </details>
  );
}
