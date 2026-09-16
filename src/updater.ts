import { Channel, invoke } from "@tauri-apps/api/core";
import { createStore } from "zustand/vanilla";
import { asError } from "./api";
import type { ProofError } from "./types";

export interface UpdateInfo {
  id: string;
  version: string;
  currentVersion: string;
  notes: string;
}
export interface DownloadProgress {
  downloaded: number;
  total: number | null;
}
type Phase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";
interface State extends DownloadProgress {
  phase: Phase;
  update: UpdateInfo | null;
  error: ProofError | null;
}
interface UpdateApi {
  check(): Promise<UpdateInfo | null>;
  download(
    id: string,
    progress: (progress: DownloadProgress) => void,
  ): Promise<void>;
  install(id: string): Promise<void>;
}
export function createUpdater(api: UpdateApi) {
  const store = createStore<State>(() => ({
    phase: "idle",
    update: null,
    error: null,
    downloaded: 0,
    total: null,
  }));
  const busy = () =>
    ["checking", "downloading", "installing"].includes(store.getState().phase);
  return {
    store,
    async check() {
      if (busy()) return;
      store.setState({
        phase: "checking",
        update: null,
        error: null,
        downloaded: 0,
        total: null,
      });
      try {
        const update = await api.check();
        store.setState({ update, phase: update ? "available" : "current" });
      } catch (error) {
        store.setState({ phase: "error", error: asError(error) });
      }
    },
    async download() {
      const { update, phase } = store.getState();
      if (!update || phase !== "available") return;
      store.setState({
        phase: "downloading",
        error: null,
        downloaded: 0,
        total: null,
      });
      try {
        await api.download(update.id, (progress) => store.setState(progress));
        store.setState({ phase: "ready" });
      } catch (error) {
        store.setState({ phase: "available", error: asError(error) });
      }
    },
    async install() {
      const { update, phase } = store.getState();
      if (!update || phase !== "ready") return;
      store.setState({ phase: "installing", error: null });
      try {
        await api.install(update.id);
      } catch (error) {
        store.setState({ phase: "ready", error: asError(error) });
      }
    },
  };
}

// Module lifetime keeps an in-progress download visible after closing Settings.
// No request is made before the user clicks Check for updates.
export const appUpdater = createUpdater({
  check: () => invoke("check_app_update"),
  download: (id, progress) => {
    const onProgress = new Channel<DownloadProgress>();
    onProgress.onmessage = progress;
    return invoke("download_app_update", { id, onProgress });
  },
  install: (id) => invoke("install_app_update", { id }),
});
