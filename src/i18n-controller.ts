import { useEffect, useSyncExternalStore } from "react";
import { asError, isDesktop, request } from "./api";
import { publishDiffEvent } from "./diff-events";
import { getLanguage, isLanguage, setLanguage, type Language } from "./i18n";
import type { ProofError } from "./types";

let state: { saving: boolean; error: ProofError | null } = {
  saving: false,
  error: null,
};
let revision = 0;
let reloadPending = false;
let reloadCurrent: (() => void) | null = null;
const listeners = new Set<() => void>();
function update(next: typeof state) {
  state = next;
  listeners.forEach((notify) => notify());
}
export function useLanguageStatus() {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => state,
  );
}
export async function saveLanguage(
  language: Language,
  ownedRequest: typeof request,
) {
  if (state.saving) return;
  const version = ++revision;
  update({ saving: true, error: null });
  try {
    if (isDesktop) await ownedRequest("set_ui_language", { language });
    else localStorage.setItem("proof:ui-language", language);
    if (version !== revision) return;
    setLanguage(language);
    publishDiffEvent("proof:language-updated", {});
  } catch (error) {
    if (version === revision) update({ saving: false, error: asError(error) });
  } finally {
    if (version === revision) {
      update({ ...state, saving: false });
      if (reloadPending) {
        reloadPending = false;
        reloadCurrent?.();
      }
    }
  }
}
/** One owner per renderer. Notifications trigger a fresh read from SQLite. */
export function useApplicationLanguage(epoch: number) {
  useEffect(() => {
    let disposed = false,
      read = 0;
    ++revision;
    update({ saving: false, error: null });
    const reload = async () => {
      if (state.saving) {
        reloadPending = true;
        return;
      }
      const seq = ++read,
        version = revision;
      try {
        const value = isDesktop
          ? await request<Language>("ui_language")
          : localStorage.getItem("proof:ui-language");
        if (!disposed && seq === read && version === revision)
          setLanguage(isLanguage(value) ? value : "zh-CN");
      } catch (error) {
        if (!disposed && seq === read && version === revision)
          update({ saving: false, error: asError(error) });
      }
    };
    reloadCurrent = () => {
      void reload();
    };
    void reload();
    const refresh = () => {
      void reload();
    };
    window.addEventListener("proof:language-updated", refresh);
    window.addEventListener("focus", refresh);
    const storageChanged = (event: StorageEvent) => {
      if (
        !isDesktop &&
        (event.key === "proof:ui-language" || event.key === null)
      )
        refresh();
    };
    window.addEventListener("storage", storageChanged);
    document.documentElement.lang = getLanguage();
    return () => {
      disposed = true;
      reloadCurrent = null;
      reloadPending = false;
      ++revision;
      window.removeEventListener("proof:language-updated", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", storageChanged);
    };
  }, [epoch]);
}
