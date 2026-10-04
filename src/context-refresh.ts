type EventSource = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
>;

/** Observer has no push feed yet: keep its foreground cadence and suspend hidden work. */
export function startContextRefresh<T>({
  workspaceId,
  read,
  receive,
  onError,
  visibility = document,
  events = window,
}: {
  workspaceId: string;
  read: () => Promise<T>;
  receive: (value: T) => void;
  onError: (error: unknown) => void;
  visibility?: EventSource & { readonly visibilityState: string };
  events?: EventSource;
}) {
  let disposed = false;
  let current: object | null = null;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function refresh() {
    if (disposed || visibility.visibilityState === "hidden") return;
    if (current) {
      queued = true;
      return;
    }
    clearTimeout(timer);
    const ticket = {};
    current = ticket;
    try {
      const value = await read();
      if (!disposed && current === ticket) receive(value);
    } catch (error) {
      if (!disposed && current === ticket) onError(error);
    } finally {
      if (!disposed && current === ticket) {
        current = null;
        if (queued) {
          queued = false;
          void refresh();
        } else timer = setTimeout(refresh, 2500);
      }
    }
  }
  const changedVisibility = () => {
    clearTimeout(timer);
    current = null;
    queued = false;
    void refresh();
  };
  const gitChanged = (event: Event) => {
    if (
      (event as CustomEvent<{ workspaceId: string }>).detail?.workspaceId ===
      workspaceId
    )
      void refresh();
  };
  const focused = () => void refresh();
  visibility.addEventListener("visibilitychange", changedVisibility);
  events.addEventListener("focus", focused);
  events.addEventListener("proof:git-updated", gitChanged);
  events.addEventListener("proof:data-session-changed", focused);
  void refresh();
  return () => {
    disposed = true;
    current = null;
    queued = false;
    clearTimeout(timer);
    visibility.removeEventListener("visibilitychange", changedVisibility);
    events.removeEventListener("focus", focused);
    events.removeEventListener("proof:git-updated", gitChanged);
    events.removeEventListener("proof:data-session-changed", focused);
  };
}
