/** Coalesce invalidations, retaining one trailing refresh and pausing while hidden. */
export class EditorRefreshLane {
  private enabled = false;
  private dirty = false;
  private disposed = false;
  private running: Promise<void> | undefined;

  constructor(private readonly refresh: () => Promise<void>) {}

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.start();
  }

  invalidate() {
    if (this.disposed) return;
    this.dirty = true;
    this.start();
  }

  async flush() {
    this.invalidate();
    await this.running;
  }

  dispose() {
    this.disposed = true;
    this.dirty = false;
  }

  private start() {
    if (this.disposed || !this.enabled || !this.dirty || this.running) return;
    // A microtask combines notifications received in the same turn.
    this.running = Promise.resolve()
      .then(async () => {
        while (!this.disposed && this.enabled && this.dirty) {
          this.dirty = false;
          // The refresh callback owns its UI error state. A failed read must not
          // prevent a later notification or reactivation from trying again.
          try {
            await this.refresh();
          } catch {
            // No automatic retry loop for a persistent failure.
          }
        }
      })
      .finally(() => {
        this.running = undefined;
        this.start();
      });
  }
}

/** Serialize native reads and drop superseded queued navigation requests. */
export class LatestEditorRead<T> {
  private enabled = true;
  private running = false;
  private disposed = false;
  private queued:
    | {
        read: () => Promise<T>;
        resolve: (value: T | undefined) => void;
        reject: (error: unknown) => void;
      }
    | undefined;

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.start();
  }

  read(read: () => Promise<T>): Promise<T | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    this.queued?.resolve(undefined);
    return new Promise((resolve, reject) => {
      this.queued = { read, resolve, reject };
      this.start();
    });
  }

  dispose() {
    this.disposed = true;
    this.queued?.resolve(undefined);
    this.queued = undefined;
  }

  private start() {
    if (this.disposed || !this.enabled || this.running || !this.queued) return;
    const job = this.queued;
    this.queued = undefined;
    this.running = true;
    void Promise.resolve()
      .then(() => (this.disposed ? undefined : job.read()))
      .then(
        (value) => job.resolve(this.disposed ? undefined : value),
        (error) => {
          if (this.disposed) job.resolve(undefined);
          else job.reject(error);
        },
      )
      .finally(() => {
        this.running = false;
        this.start();
      });
  }
}
