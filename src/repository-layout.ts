import type { ProofError, RepositoryLayout } from "./types";
import { asError } from "./api";

export const defaultRepositoryLayout: Required<RepositoryLayout> = {
  sidebarWidth: 320,
  contextWidth: 300,
  sidebarOpen: true,
  contextOpen: null,
  historySidebarWidth: 224,
  historyDetailsHeight: 180,
  filesSidebarWidth: 240,
  filesHistoryWidth: 248,
  commitDetailsHeight: 280,
};
export const panelBounds = {
  sidebarWidth: { min: 180, max: 480 },
  contextWidth: { min: 240, max: 520 },
};
export type PanelWidth = keyof typeof panelBounds;
export const cardPanelBounds = {
  historySidebarWidth: { min: 160, max: 560 },
  historyDetailsHeight: { min: 100, max: 640 },
  filesSidebarWidth: { min: 160, max: 560 },
  filesHistoryWidth: { min: 160, max: 560 },
  commitDetailsHeight: { min: 160, max: 640 },
};
export type CardPanelDimension = keyof typeof cardPanelBounds;
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

// Saved widths express intent. Fitting a small window never writes them back.
export function fitPanels(
  width: number,
  layout: RepositoryLayout,
  sidebar: boolean,
  context: boolean,
) {
  let left = sidebar ? clamp(layout.sidebarWidth, 180, 480) : 0;
  let right = context ? clamp(layout.contextWidth, 240, 520) : 0;
  const budget = Math.max(0, width - 360);
  let excess = Math.max(0, left + right - budget);
  if (right) {
    const shrink = Math.min(excess, Math.max(0, right - 240));
    right -= shrink;
    excess -= shrink;
  }
  if (left) left -= Math.min(excess, Math.max(0, left - 180));
  return { sidebarWidth: left, contextWidth: right };
}

export interface LayoutScope {
  key: string;
  workspaceId: string;
  demo: boolean;
}
export interface LayoutSnapshot {
  value: RepositoryLayout;
  ready: boolean;
  saving: boolean;
  error: ProofError | null;
}
const initial: LayoutSnapshot = {
  value: defaultRepositoryLayout,
  ready: false,
  saving: false,
  error: null,
};
type Entry = {
  snapshot: LayoutSnapshot;
  saved: RepositoryLayout;
  load: Promise<void> | null;
  writes: Promise<void>;
  revision: number;
  pending: number;
};

/** A separate queue for each local repository; late work never targets a new tab. */
export class RepositoryLayouts {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  constructor(
    private io: {
      read: (scope: LayoutScope) => Promise<RepositoryLayout>;
      write: (scope: LayoutScope, value: RepositoryLayout) => Promise<void>;
    },
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = (key: string) => this.entries.get(key)?.snapshot ?? initial;
  private emit(entry: Entry, partial: Partial<LayoutSnapshot>) {
    entry.snapshot = { ...entry.snapshot, ...partial };
    for (const listener of this.listeners) listener();
  }
  load(scope: LayoutScope): Promise<void> {
    let entry = this.entries.get(scope.key);
    if (!entry) {
      // Retain pending operations. Idle entries are cheap to reload from SQLite.
      for (const [key, old] of this.entries) {
        if (this.entries.size < 32) break;
        if (!old.load && !old.pending) this.entries.delete(key);
      }
      entry = {
        snapshot: initial,
        saved: defaultRepositoryLayout,
        load: null,
        writes: Promise.resolve(),
        revision: 0,
        pending: 0,
      };
    }
    this.entries.delete(scope.key);
    this.entries.set(scope.key, entry);
    if (entry.snapshot.ready) return Promise.resolve();
    if (entry.load) return entry.load;
    const target = entry;
    this.emit(target, { error: null });
    target.load = this.io
      .read(scope)
      .then((value) => {
        const normalized = { ...defaultRepositoryLayout, ...value };
        target.saved = normalized;
        this.emit(target, { value: normalized, ready: true });
      })
      .catch((error) => {
        this.emit(target, { error: asError(error) });
      })
      .finally(() => {
        target.load = null;
      });
    return target.load;
  }
  update(
    scope: LayoutScope,
    partial: Partial<RepositoryLayout>,
  ): Promise<void> {
    const entry = this.entries.get(scope.key);
    // Controls remain disabled until the real stored layout has been loaded.
    if (!entry?.snapshot.ready) return Promise.resolve();
    const revision = ++entry.revision;
    entry.pending++;
    this.emit(entry, {
      value: { ...entry.snapshot.value, ...partial },
      saving: true,
      error: null,
    });
    entry.writes = entry.writes
      .then(async () => {
        const next = { ...entry.saved, ...partial };
        await this.io.write(scope, next);
        entry.saved = next;
        if (revision === entry.revision) this.emit(entry, { value: next });
      })
      .catch((error) => {
        this.emit(entry, {
          ...(revision === entry.revision ? { value: entry.saved } : {}),
          error: asError(error),
        });
      })
      .finally(() => {
        entry.pending--;
        this.emit(entry, { saving: entry.pending > 0 });
      });
    return entry.writes;
  }
}
