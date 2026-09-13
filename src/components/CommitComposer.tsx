import { useState } from "react";
import { CaretDown, GitCommit, ArrowClockwise } from "@phosphor-icons/react";

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
}) {
  const [menu, setMenu] = useState(false);
  const all = !amend && staged === 0 && unstaged > 0;
  const label = amend ? "Amend" : all ? "Stage all & Commit" : "Commit";
  return (
    <section className="commit-composer" aria-label="Commit">
      <div className="composer-heading">
        <GitCommit size={16} />
        <strong>{amend ? "Amend last commit" : "Commit"}</strong>
        <span title={branch ?? "Detached HEAD"}>
          {branch ?? "Detached HEAD"}
        </span>
      </div>
      <textarea
        id="quick-commit-message"
        aria-label="Commit message"
        rows={3}
        value={message}
        onChange={(event) => onMessage(event.target.value)}
        disabled={busy}
        placeholder={
          amend
            ? "Update commit message…"
            : "Summary (required)\n\nDescription…"
        }
      />
      <div className="composer-options">
        <label>
          <input
            type="checkbox"
            checked={amend}
            onChange={(event) => onAmend(event.target.checked)}
            disabled={!head || busy || disabled}
          />
          Amend <code>{head?.slice(0, 7)}</code>
        </label>
        {strictReview && (
          <button className="review-policy" onClick={onReviewSettings}>
            Review required
          </button>
        )}
      </div>
      {amend && (
        <p className="amend-note">
          将替换上一条 Commit。已 Push 的提交需要协调后再改写。
        </p>
      )}
      <div className="composer-submit">
        <button
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
          <span>{busy ? "处理中…" : label}</span>
          <span className="button-count">
            {all ? staged + unstaged : staged}
          </span>
        </button>
        <button
          className="button primary composer-menu-trigger"
          aria-label="更多 Commit 操作"
          aria-expanded={menu}
          disabled={busy || disabled}
          onClick={() => setMenu(!menu)}
        >
          <CaretDown size={12} />
        </button>
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
            <button
              disabled={busy || !message.trim() || !unstaged}
              onClick={() => {
                setMenu(false);
                onCommit(true);
              }}
            >
              Stage all & {amend ? "Amend" : "Commit"}
              <small>{staged + unstaged} files</small>
            </button>
          </div>
        )}
      </div>
      <p className="composer-hint">
        {demo
          ? "Demo · 在桌面应用中执行 Git 操作"
          : amend && !staged
            ? "仅更新上一条 Commit 的说明"
            : `${staged} staged · ${unstaged} unstaged`}
      </p>
    </section>
  );
}
