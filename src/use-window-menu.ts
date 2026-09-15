import { useEffect, useLayoutEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { isDesktop } from "./api";

export const isMacDesktop = isDesktop && /Mac/.test(navigator.platform);

export function useWindowMenu(
  onClose: () => void,
  onError: (error: unknown) => void,
) {
  const actions = useRef({ onClose, onError });
  useLayoutEffect(() => {
    actions.current = { onClose, onError };
  });
  useEffect(() => {
    if (!isMacDesktop) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("proof:close-active-view", () => {
      if (!disposed && !document.querySelector("[role='dialog'][data-open]"))
        actions.current.onClose();
    })
      .then((remove) => {
        if (disposed) remove();
        else stop = remove;
      })
      .catch((error) => {
        if (!disposed) actions.current.onError(error);
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
}
