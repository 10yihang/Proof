import { Textarea, Input, Button, Select } from "./ui/controls";
import { t, uiMessage } from "../i18n";
import { useAiCommit } from "../ai-commit";
import type { AiController } from "../ai";
import type { Changes } from "../types";
import { AiTaskProgress } from "./AiTaskProgress";
import { AiSessionLink } from "./AiSessionLink";
import { useState } from "react";
import {
  CaretDown,
  GitCommit,
  ArrowClockwise,
  Sparkle,
  GearSix,
} from "@phosphor-icons/react";

export function CommitComposer({
  message,
  onMessage,
  amend,
  onAmend,
  head,
  branch,
  staged,
  unstaged,
  busy,
  disabled,
  demo,
  strictReview,
  onReviewSettings,
  onCommit,
  changes,
  ai,
  onAgentSettings,
}: {
  message: string;
  onMessage: (message: string) => void;
  amend: boolean;
  onAmend: (value: boolean) => void;
  head: string | null;
  branch: string | null;
  staged: number;
  unstaged: number;
  busy: boolean;
  disabled: boolean;
  demo: boolean;
  strictReview: boolean;
  onReviewSettings: () => void;
  onCommit: (all: boolean) => void;
  changes: Changes;
  ai: AiController;
  onAgentSettings: () => void;
}) {
  const commitAi = useAiCommit(changes, ai.provider, amend, message, onMessage);
  const canGenerate =
    !disabled &&
    !demo &&
    !busy &&
    !ai.pending &&
    !commitAi.pending &&
    (staged > 0 || (amend && !!head)) &&
    ai.providers.some(
      (provider) => provider.id === ai.provider && provider.available,
    );
  const [menu, setMenu] = useState(false);
  const all = !amend && staged === 0 && unstaged > 0;
  const label = amend ? "Amend" : all ? t("Stage all & Commit") : "Commit";
  return (
    <section className="commit-composer" aria-label={t("Commit")}>
      <div className="composer-heading">
        <GitCommit size={16} />
        <strong>{amend ? t("Amend last commit") : "Commit"}</strong>
        <span title={branch ?? "Detached HEAD"}>
          {branch ?? "Detached HEAD"}
        </span>
      </div>
      <div className="composer-ai-toolbar">
        <Button
          className="button"
          disabled={!canGenerate}
          onClick={() => void commitAi.generate()}
          title={
            !staged && !amend
              ? t("请先 Stage 要提交的变更。")
              : amend
                ? t("根据上一条 Commit 和 Staged 变更生成。")
                : t("根据 Staged 变更生成，不会执行 Commit。")
          }
        >
          <Sparkle size={15} /> AI Commit
        </Button>
        <Select
          aria-label={t("AI provider")}
          value={ai.provider}
          onChange={(event) =>
            ai.setProvider(event.target.value as typeof ai.provider)
          }
          disabled={!!commitAi.pending || !!ai.pending || demo}
        >
          {(ai.providers.length
            ? ai.providers
            : [{ id: "codex", name: "Codex", available: false }]
          ).map((provider) => (
            <option
              key={provider.id}
              value={provider.id}
              disabled={!provider.available}
            >
              {provider.name}
            </option>
          ))}
        </Select>
        <Button
          className="icon-button"
          aria-label={t("Agent settings")}
          title={t("Agent settings")}
          onClick={onAgentSettings}
        >
          <GearSix size={16} />
        </Button>
      </div>
      <Textarea
        id="quick-commit-message"
        aria-label={t("Commit message")}
        rows={3}
        value={message}
        onChange={(event) => onMessage(event.target.value)}
        disabled={busy}
        placeholder={
          amend
            ? t("Update commit message…")
            : t("Summary (required)\n\nDescription…")
        }
      />
      <AiTaskProgress ai={commitAi} />
      <AiSessionLink session={commitAi.session} />
      {commitAi.error && (
        <div className="composer-ai-error" role="alert">
          <span>{uiMessage(commitAi.error.message)}</span>
          <details>
            <summary>
              {t("Failure details · ")}
              {commitAi.error.code}
            </summary>
            <pre>{commitAi.error.detail}</pre>
          </details>
        </div>
      )}
      {commitAi.suggestion && (
        <section
          className="composer-ai-suggestion"
          aria-label={t("AI 生成的提交说明")}
        >
          <pre>{commitAi.suggestion}</pre>
          <div>
            <Button className="button" onClick={commitAi.apply}>
              {t("使用此说明")}
            </Button>
            <Button className="text-button" onClick={commitAi.dismiss}>
              {t("Cancel")}
            </Button>
          </div>
        </section>
      )}
      <div className="composer-options">
        <label>
          <Input
            type="checkbox"
            checked={amend}
            onChange={(event) => onAmend(event.target.checked)}
            disabled={!head || busy || disabled}
          />
          {t("Amend ")}
          <code>{head?.slice(0, 7)}</code>
        </label>
        {strictReview && (
          <Button className="review-policy" onClick={onReviewSettings}>
            {t("Review required")}
          </Button>
        )}
      </div>
      {amend && (
        <p className="amend-note">
          {t("将替换上一条 Commit。已 Push 的提交需要协调后再改写。")}
        </p>
      )}
      <div className="composer-submit">
        <Button
          className="button primary"
          disabled={
            disabled ||
            busy ||
            !message.trim() ||
            (!amend && !staged && !unstaged)
          }
          onClick={() => onCommit(all)}
        >
          {busy ? (
            <ArrowClockwise className="spinning" size={15} />
          ) : (
            <GitCommit size={15} />
          )}
          <span>{busy ? t("处理中…") : label}</span>
          <span className="button-count">
            {all ? staged + unstaged : staged}
          </span>
        </Button>
        <Button
          className="button primary composer-menu-trigger"
          aria-label={t("更多 Commit 操作")}
          aria-expanded={menu}
          disabled={busy || disabled}
          onClick={() => setMenu(!menu)}
        >
          <CaretDown size={12} />
        </Button>
        {menu && (
          <div
            className="composer-menu"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setMenu(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setMenu(false);
              }
            }}
          >
            <Button
              disabled={busy || !message.trim() || !unstaged}
              onClick={() => {
                setMenu(false);
                onCommit(true);
              }}
            >
              {t("Stage all & ")}
              {amend ? "Amend" : "Commit"}
              <small>
                {staged + unstaged} {t(" files")}
              </small>
            </Button>
          </div>
        )}
      </div>
      <p className="composer-hint">
        {demo
          ? t("Demo · 在桌面应用中执行 Git 操作")
          : amend && !staged
            ? t("仅更新上一条 Commit 的说明")
            : `${staged} staged · ${unstaged} unstaged`}
      </p>
    </section>
  );
}
