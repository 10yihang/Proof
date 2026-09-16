import { describe, expect, it, vi } from "vitest";
import { createUpdater, type DownloadProgress } from "./updater";

const release = {
  id: "release-1",
  version: "0.1.2",
  currentVersion: "0.1.1",
  notes: "Fixes",
};
describe("application updates", () => {
  it("does no automatic network work and keeps download separate from installation", async () => {
    let progress: ((value: DownloadProgress) => void) | undefined;
    let finish: (() => void) | undefined;
    const api = {
      check: vi.fn(async () => release),
      download: vi.fn(
        (_id: string, callback: (value: DownloadProgress) => void) => {
          progress = callback;
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      ),
      install: vi.fn(async () => {}),
    };
    const updater = createUpdater(api);
    expect(api.check).not.toHaveBeenCalled();
    await updater.install();
    expect(api.install).not.toHaveBeenCalled();
    await updater.check();
    const downloading = updater.download();
    await updater.download();
    await updater.check();
    expect(api.download).toHaveBeenCalledTimes(1);
    expect(api.check).toHaveBeenCalledTimes(1);
    progress!({ downloaded: 512, total: 1024 });
    expect(updater.store.getState().downloaded).toBe(512);
    finish!();
    await downloading;
    expect(updater.store.getState().phase).toBe("ready");
    expect(api.install).not.toHaveBeenCalled();
    await updater.install();
    expect(api.install).toHaveBeenCalledWith(release.id);
  });
  it("does not mark a failed or unsigned download as installable, and supports retry", async () => {
    const api = {
      check: vi.fn(async () => release),
      download: vi.fn(async (): Promise<void> => {
        throw {
          code: "UPDATE_SIGNATURE_INVALID",
          message: "Invalid signature",
          detail: "",
        };
      }),
      install: vi.fn(),
    };
    const updater = createUpdater(api);
    await updater.check();
    await updater.download();
    expect(updater.store.getState().phase).toBe("available");
    expect(updater.store.getState().error?.code).toBe(
      "UPDATE_SIGNATURE_INVALID",
    );
    await updater.install();
    expect(api.install).not.toHaveBeenCalled();
    api.download.mockImplementation(async () => {});
    await updater.download();
    expect(updater.store.getState().phase).toBe("ready");
  });
  it("distinguishes an unavailable feed from an up-to-date result", async () => {
    const api = {
      check: vi.fn(async (): Promise<typeof release | null> => {
        throw {
          code: "UPDATE_FEED_UNAVAILABLE",
          message: "Unavailable",
          detail: "",
        };
      }),
      download: vi.fn(),
      install: vi.fn(),
    };
    const updater = createUpdater(api);
    await updater.check();
    expect(updater.store.getState().phase).toBe("error");
    api.check.mockResolvedValue(null);
    await updater.check();
    expect(updater.store.getState().phase).toBe("current");
    expect(updater.store.getState().error).toBeNull();
  });
  it("preserves a verified download when installation is blocked by an active task", async () => {
    const updater = createUpdater({
      check: async () => release,
      download: async () => {},
      install: async () => {
        throw { code: "UPDATE_WORK_RUNNING", message: "Busy", detail: "" };
      },
    });
    await updater.check();
    await updater.download();
    await updater.install();
    expect(updater.store.getState().phase).toBe("ready");
    expect(updater.store.getState().error?.code).toBe("UPDATE_WORK_RUNNING");
  });
});
