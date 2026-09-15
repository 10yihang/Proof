// Keep event-driven refreshes bounded, including an event arriving while a
// previous read or Git write is still in progress.
export type RefreshResult = "done" | "busy" | "failed";

export class WorkspaceRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweep: ReturnType<typeof setInterval> | null = null;
  private watching = false;
  private visible = true;
  private running = false;
  private requested = false;
  private closed = false;

  constructor(
    private readonly read: () => Promise<RefreshResult>,
    private readonly onError: (error: unknown) => void,
  ) {
    this.resetSweep();
  }

  setWatching(watching: boolean) {
    if (this.closed || watching === this.watching) return;
    this.watching = watching;
    this.resetSweep();
    // Reconcile the gap while the watcher was being registered or failing.
    this.request(true);
  }

  setVisible(visible: boolean) {
    if (this.closed || visible === this.visible) return;
    this.visible = visible;
    this.clearTimer();
    this.resetSweep();
    if (visible) this.request(true);
  }

  request(immediate = false) {
    if (this.closed) return;
    this.requested = true;
    if (immediate) this.clearTimer();
    this.schedule(immediate ? 0 : 120);
  }

  close() {
    this.closed = true;
    this.clearTimer();
    if (this.sweep !== null) clearInterval(this.sweep);
    this.sweep = null;
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private resetSweep() {
    if (this.sweep !== null) clearInterval(this.sweep);
    this.sweep = null;
    if (this.closed || !this.visible) return;
    // A slow backstop catches missed events and configuration outside watched
    // roots. When watching is unavailable, retain the responsive fallback.
    this.sweep = setInterval(
      () => this.request(true),
      this.watching ? 30_000 : 1_200,
    );
  }

  private schedule(delay: number) {
    if (this.closed || !this.visible || this.running || this.timer !== null)
      return;
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private async run() {
    this.timer = null;
    if (this.closed || !this.visible || this.running || !this.requested) return;
    this.running = true;
    this.requested = false;
    let result: RefreshResult = "done";
    try {
      result = await this.read();
    } catch (error) {
      result = "failed";
      if (!this.closed) this.onError(error);
    } finally {
      this.running = false;
      this.requested ||= result !== "done";
      if (this.requested)
        this.schedule(
          result === "busy" ? 250 : result === "failed" ? 1200 : 120,
        );
    }
  }
}
