import { useEffect, useState } from "react";
import { ArrowCounterClockwise, Copy } from "@phosphor-icons/react";
import { asError, request } from "../api";
import type { ProofError, RecoveryAction, RecoveryPoint } from "../types";
import { Modal } from "./Modal";

interface Content {
  point: RecoveryPoint;
  before: string | null;
  after: string | null;
  capturedOriginal: string | null;
  capturedWarning: string | null;
  directory: string;
}
const statusName: Record<string, string> = {
  prepared: "仅预览，尚未丢弃",
  applying: "操作中断，需检查",
  applied: "可撤销丢弃",
  undoing: "恢复中断，需检查",
  undone: "已恢复",
  conflict: "存在变化，需检查",
};

export function RecoveryDialog({
  workspaceId,
  onClose,
  onChanged,
}: {
  workspaceId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [points, setPoints] = useState<RecoveryPoint[]>([]);
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState<ProofError | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<RecoveryPoint | null>(null);
  const [restoreMissing, setRestoreMissing] = useState(false);
  useEffect(() => {
    let active = true;
    request<RecoveryPoint[]>("recovery_points", { workspaceId })
      .then((p) => {
        if (active) setPoints(p);
      })
      .catch((e) => {
        if (active) setError(asError(e));
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);
  async function run(
    action:
      "undo_discard" | "restore_missing_recovery" | "cancel_discard_preview",
    point: RecoveryPoint,
  ) {
    setPending(true);
    setError(null);
    try {
      const result = await request<RecoveryAction | null>(action, {
        recoveryId: point.id,
      });
      if (result) {
        setMessage(result.result.message);
        if (result.result.warning)
          setError({
            code: "RECOVERY_WARNING",
            message: result.result.message,
            detail: result.result.warning,
          });
        onChanged();
      }
      setPoints(
        await request<RecoveryPoint[]>("recovery_points", { workspaceId }),
      );
      setConfirm(null);
      setContent(null);
      setRestoreMissing(false);
    } catch (e) {
      setError(asError(e));
    } finally {
      setPending(false);
    }
  }
  async function inspect(point: RecoveryPoint) {
    setPending(true);
    setError(null);
    try {
      setContent(
        await request<Content>("recovery_content", { recoveryId: point.id }),
      );
    } catch (e) {
      setError(asError(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      title="丢弃恢复点"
      wide
      error={error}
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <p className="modal-description">
        恢复点保留 7 天，总计上限 256 MiB。撤销前会再次核对当前文件及 Git
        基准；有新变化时停止恢复。
      </p>
      {message && <p role="status">{message}</p>}
      {confirm ? (
        <div className="recovery-confirm">
          <h3>
            {restoreMissing ? "在空路径创建保存的文件" : "恢复丢弃前的内容"}：
            {confirm.path}
          </h3>
          <p>
            {confirm.scope} · {new Date(confirm.createdAt).toLocaleString()}
          </p>
          <p>
            {restoreMissing
              ? "这会在当前缺失的路径创建丢弃前保存的文件。如果该路径出现新文件，Proof 会停止，保留新文件。"
              : "当前文件必须仍匹配丢弃后的版本；路径已被删除时不会自动重建。"}
            恢复操作会保留现有 Git 索引。
          </p>
          {error?.code === "RECOVERY_MISSING_PATH" && !restoreMissing && (
            <button
              className="button"
              onClick={() => {
                setRestoreMissing(true);
                setError(null);
              }}
            >
              查看空路径恢复确认
            </button>
          )}
          <footer className="modal-footer">
            <button
              className="button"
              disabled={pending}
              onClick={() => setConfirm(null)}
            >
              返回
            </button>
            <button
              className="button primary"
              disabled={pending}
              onClick={() =>
                void run(
                  restoreMissing ? "restore_missing_recovery" : "undo_discard",
                  confirm,
                )
              }
            >
              {pending
                ? "正在核对…"
                : restoreMissing
                  ? "确认在空路径恢复文件"
                  : "确认恢复"}
            </button>
          </footer>
        </div>
      ) : (
        <div className="recovery-list">
          {!points.length && (
            <p className="muted">当前 Worktree 没有保留中的恢复点。</p>
          )}
          {points.map((p) => (
            <article className="recovery-item" key={p.id}>
              <div>
                <strong>{p.path}</strong>
                <span className="muted">
                  {statusName[p.status] ?? p.status} · {p.scope}
                </span>
                <small>
                  创建 {new Date(p.createdAt).toLocaleString()} · 到期{" "}
                  {new Date(p.expiresAt).toLocaleString()}
                </small>
                {p.message && <p>{p.message}</p>}
              </div>
              <div className="recovery-actions">
                <button
                  className="button compact"
                  disabled={pending}
                  onClick={() => void inspect(p)}
                >
                  查看副本
                </button>
                {p.status === "prepared" ? (
                  <button
                    className="button compact"
                    disabled={pending}
                    onClick={() => void run("cancel_discard_preview", p)}
                  >
                    取消预览
                  </button>
                ) : (
                  ["applied", "applying", "undoing", "conflict"].includes(
                    p.status,
                  ) && (
                    <button
                      className="button compact"
                      disabled={pending}
                      onClick={() => {
                        setConfirm(p);
                        setRestoreMissing(false);
                        setError(null);
                      }}
                    >
                      <ArrowCounterClockwise size={15} />
                      {p.status === "applied" ? "撤销丢弃" : "恢复保存版本"}
                    </button>
                  )
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {content && (
        <div className="recovery-content">
          <h3>{content.point.path} · 保存的副本</h3>
          <p className="muted">{content.directory}</p>
          {content.capturedWarning && (
            <p role="status">{content.capturedWarning}</p>
          )}
          {(
            [
              ["丢弃前", content.before],
              ["丢弃后", content.after],
              ...(content.capturedOriginal !== null &&
              content.capturedOriginal !== content.before
                ? [["捕获的原文件（含后续编辑）", content.capturedOriginal]]
                : []),
            ] as [string, string | null][]
          ).map(([label, value]) => (
            <details key={label}>
              <summary>
                {label}
                {value === null ? " · 文件不存在" : ""}
              </summary>
              {value !== null && (
                <>
                  <button
                    className="button compact"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(value)
                        .then(() => setMessage("已复制完整保存内容。"))
                        .catch((e) => setError(asError(e)))
                    }
                  >
                    <Copy size={14} />
                    复制完整内容
                  </button>
                  {value.length > 200000 && (
                    <p>仅预览前 200,000 个字符；复制包含完整保存内容。</p>
                  )}
                  <pre>{value.slice(0, 200000)}</pre>
                </>
              )}
            </details>
          ))}
        </div>
      )}
    </Modal>
  );
}
