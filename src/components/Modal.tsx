import { useRef, useState, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "@phosphor-icons/react";
import { t, uiMessage } from "../i18n";
import type { ProofError } from "../types";
import { Button } from "./ui/controls";
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTitle,
  DialogClose,
} from "./ui/dialog";
import { cn } from "../lib/utils";

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  error,
  className = "",
  dismissible = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  error?: ProofError | null;
  className?: string;
  dismissible?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const popup = useRef<HTMLDivElement>(null);
  const focus = useRef(document.activeElement as HTMLElement | null);
  return (
    <Dialog
      open={open}
      disablePointerDismissal={!dismissible}
      onOpenChange={(value, details) => {
        if (!dismissible) {
          details.cancel();
          return;
        }
        setOpen(value);
      }}
      onOpenChangeComplete={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogPortal>
        <DialogOverlay className="proof-dialog-backdrop z-[200] bg-slate-950/35 backdrop-blur-[2px]" />
        <DialogPrimitive.Popup
          ref={popup}
          aria-label={title}
          initialFocus={() =>
            popup.current?.querySelector<HTMLElement>(
              "[data-autofocus], [autofocus]",
            ) ?? true
          }
          finalFocus={() => (focus.current?.isConnected ? focus.current : true)}
          className={cn(
            "modal proof-dialog fixed left-1/2 top-1/2 z-[201] m-0 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover text-[12px] text-popover-foreground shadow-2xl outline-none",
            wide && "modal-wide",
            className,
          )}
          onSubmitCapture={(event) => {
            if (!open) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <div className="modal-content">
            <header className="modal-header">
              <DialogTitle className="text-[15px] font-semibold leading-6">
                {title}
              </DialogTitle>
              <DialogClose
                disabled={!dismissible}
                render={
                  <Button className="icon-button" aria-label={t("关闭")} />
                }
              >
                <X size={17} />
              </DialogClose>
            </header>
            {error && (
              <div className="modal-error" role="alert">
                <strong>{uiMessage(error.message)}</strong>
                <details>
                  <summary>
                    {error.code}
                    {t(" · 查看详情")}
                  </summary>
                  <pre>{error.detail}</pre>
                </details>
              </div>
            )}
            {children}
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
