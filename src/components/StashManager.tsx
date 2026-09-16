import { useEffect, useState } from "react";
import { Archive, Plus } from "@phosphor-icons/react";
import { asError, useRequest } from "../api";
import type { ProofError } from "../types";
import type { HistoryActionKind, StashEntry } from "../history-actions";
import { getLanguage, t } from "../i18n";
import { Button } from "./ui/controls";
import { Modal } from "./Modal";

export function StashManager({
  workspaceId,
  disabled,
  canSave,
  onAction,
  onClose,
}: {
  workspaceId: string;
  disabled: boolean;
  canSave: boolean;
  onAction: (kind: HistoryActionKind, selector?: string) => void;
  onClose: () => void;
}) {
  const request = useRequest();
  const [entries, setEntries] = useState<StashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProofError | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void request<StashEntry[]>("stashes", { workspaceId })
      .then((value) => {
        if (!disposed) setEntries(value);
      })
      .catch((error) => {
        if (!disposed) setError(asError(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [workspaceId, revision]);
  return (
    <Modal
      title={t("Stashes")}
      error={error}
      onClose={onClose}
      className="stash-dialog"
    >
      <div className="stash-heading">
        <p className="muted">{t("保存修改，在不同任务之间切换。")}</p>
        <Button
          className="button primary compact"
          disabled={disabled || !canSave}
          onClick={() => onAction("stash")}
        >
          <Plus size={15} />
          {t("保存到 Stash…")}
        </Button>
      </div>
      {loading ? (
        <p className="muted" role="status">
          {t("正在加载…")}
        </p>
      ) : entries.length ? (
        <div className="stash-list">
          {entries.map((entry) => (
            <div className="stash-entry" key={entry.selector}>
              <Archive size={18} />
              <div className="stash-description">
                <strong>{entry.subject}</strong>
                <small>
                  {entry.selector} · {entry.oid.slice(0, 8)} ·{" "}
                  {new Date(entry.createdAt).toLocaleString(getLanguage())}
                </small>
              </div>
              <div className="stash-actions">
                <Button
                  className="button compact"
                  disabled={disabled}
                  onClick={() => onAction("stashApply", entry.selector)}
                >
                  Apply
                </Button>
                <Button
                  className="button compact"
                  disabled={disabled}
                  onClick={() => onAction("stashPop", entry.selector)}
                >
                  Pop
                </Button>
                <Button
                  className="button compact danger-text"
                  disabled={disabled}
                  onClick={() => onAction("stashDrop", entry.selector)}
                >
                  Drop…
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        !error && <p className="empty-list">{t("没有保存的 Stash")}</p>
      )}
      {error && (
        <Button
          className="button"
          onClick={() => setRevision((value) => value + 1)}
        >
          {t("重试")}
        </Button>
      )}
    </Modal>
  );
}
