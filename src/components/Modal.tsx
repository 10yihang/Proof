import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import type { ProofError } from "../types";

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  error,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  error?: ProofError | null;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function close() {
    if (closingRef.current) return;
    closingRef.current = true;
    if (ref.current) ref.current.inert = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onClose();
      return;
    }
    setClosing(true);
    closeTimer.current = setTimeout(onClose, 140);
  }
  useEffect(() => {
    const dialog = ref.current;
    const focused = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      dialog?.close();
      focused?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "modal-wide" : ""} ${closing ? "is-closing" : ""} ${className}`}
      aria-label={title}
      onSubmitCapture={(event) => {
        if (closingRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={(event) => {
        if (closingRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="modal-content">
        <header className="modal-header">
          <h2>{title}</h2>
          <button
            className="icon-button"
            title="关闭"
            aria-label="关闭"
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        {error && (
          <div className="modal-error" role="alert">
            <strong>{error.message}</strong>
            <details>
              <summary>{error.code} · 查看详情</summary>
              <pre>{error.detail}</pre>
            </details>
          </div>
        )}
        {children}
      </div>
    </dialog>
  );
}
