import { test, expect, type Page } from "@playwright/test";
import { chooseOption } from "./controls";

async function open(page: Page, failVersionInitially = false) {
  await page.addInitScript((failVersionInitially) => {
    const commits = Array.from({ length: 250 }, (_, i) => ({
      oid: (i + 1).toString(16).padStart(40, "0"),
      parents: i < 249 ? [(i + 2).toString(16).padStart(40, "0")] : [],
      author: "Fixture",
      date: "2026-09-23",
      subject: `Commit ${i}`,
      refs: "",
    }));
    const state = {
      commits,
      head: commits[0].oid,
      feature: commits[20].oid,
      tag: commits[40].oid,
      calls: [] as { command: string; offset?: number }[],
      snapshots: 0,
      refsChanged: false,
      failVersion: failVersionInitially,
      holdVersion: false,
      releaseVersion: null as null | (() => void),
      holdGraph: false,
      release: null as null | (() => void),
    };
    Object.assign(window, {
      historyPerformance: state,
      __TAURI_INTERNALS__: {
        invoke: async (_name: string, payload: any) => {
          const { command, args } = payload;
          state.calls.push({ command, offset: args.offset });
          if (command === "data_session")
            return { epoch: 0, wipeEpoch: 0, deletedWorkspaceIds: [] };
          if (command === "history_auto_fetch") {
            const changed = state.refsChanged;
            state.refsChanged = false;
            return changed;
          }
          if (command === "history_graph_version") {
            if (state.holdVersion) {
              state.holdVersion = false;
              await new Promise<void>((resolve) => {
                state.releaseVersion = resolve;
              });
            }
            if (state.failVersion)
              throw {
                code: "GIT_FAILED",
                message: "Version temporarily unavailable",
                detail: "fixture",
              };
            return JSON.stringify([state.head, state.feature, state.tag]);
          }
          if (command === "history_repository_state")
            return {
              remotes: [],
              upstream: null,
              ahead: 0,
              behind: 0,
              operation: null,
              conflicts: [],
            };
          if (command === "branches")
            return [
              { name: "main", oid: state.head, current: true, remote: false },
              {
                name: "feature",
                oid: state.feature,
                current: false,
                remote: false,
              },
            ];
          if (command === "worktrees") return [];
          if (command === "commit_graph") {
            const offset = args.offset ?? 0;
            const snapshotId =
              args.snapshotId ?? `snapshot-${++state.snapshots}`;
            if (state.holdGraph) {
              state.holdGraph = false;
              await new Promise<void>((resolve) => {
                state.release = resolve;
              });
            }
            return {
              snapshotId,
              workspaceId: args.workspaceId,
              scope: args.scope,
              offset,
              head: state.head,
              commits: commits.slice(offset, offset + 100).map((commit) => ({
                ...commit,
                refs: commit.oid === state.tag ? "tag: v-test" : "",
              })),
              branches: [
                { name: "main", oid: state.head, current: true, remote: false },
                {
                  name: "feature",
                  oid: state.feature,
                  current: false,
                  remote: false,
                },
              ],
              hasMore: offset + 100 < commits.length,
              capturedAt: 0,
              shallow: false,
            };
          }
          throw new Error(`Unexpected fixture command: ${command}`);
        },
      },
    });
  }, failVersionInitially);
  await page.goto("/tests/ui/fixtures/history-performance.html");
  if (!failVersionInitially)
    await expect(page.locator(".graph-row").first()).toBeVisible();
}

const graphOffsets = (page: Page) =>
  page.evaluate(() =>
    (window as any).historyPerformance.calls
      .filter((call: any) => call.command === "commit_graph")
      .map((call: any) => call.offset ?? 0),
  );

async function loadAndSelectSecondPage(page: Page) {
  await page.locator(".graph-table-footer button").click();
  await expect.poll(() => graphOffsets(page)).toEqual([0, 100]);
  const list = page.locator(".graph-scroll");
  await list.focus();
  await list.press("End");
  await expect(page.locator(".graph-row.is-active")).toContainText(
    "Commit 199",
  );
  return list.evaluate((element) => element.scrollTop);
}

test("hidden History coalesces dirty revisions and restores selection and scroll", async ({
  page,
}) => {
  await open(page);
  const top = await loadAndSelectSecondPage(page);
  await page
    .getByRole("button", { name: "Local changes", exact: true })
    .click();
  await page.getByRole("button", { name: "Invalidate history" }).click();
  await page.getByRole("button", { name: "Invalidate history" }).click();
  await expect(page.getByTestId("revision")).toHaveText("2");
  expect(await graphOffsets(page)).toEqual([0, 100]);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(() => graphOffsets(page)).toEqual([0, 100, 0, 100]);
  await expect(page.locator(".graph-row.is-active")).toContainText(
    "Commit 199",
  );
  await expect
    .poll(() =>
      page.locator(".graph-scroll").evaluate((element) => element.scrollTop),
    )
    .toBe(top);
  // A clean tab switch retains the existing snapshot/pages.
  await page
    .getByRole("button", { name: "Local changes", exact: true })
    .click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  expect(await graphOffsets(page)).toEqual([0, 100, 0, 100]);
});

test("no-op Fetch keeps pages, changed refs refresh once, hidden window defers HEAD reload", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).historyPerformance.calls.filter(
            (c: any) => c.command === "history_auto_fetch",
          ).length,
      ),
    )
    .toBe(2);
  expect(await graphOffsets(page)).toEqual([0]);
  await page.evaluate(() => {
    (window as any).historyPerformance.refsChanged = true;
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => graphOffsets(page)).toEqual([0, 0]);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.getByRole("button", { name: "Change HEAD" }).click();
  expect(await graphOffsets(page)).toEqual([0, 0]);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => graphOffsets(page)).toEqual([0, 0, 0]);
});

test("hiding during a paged refresh rejects its late reply and resumes from a coherent snapshot", async ({
  page,
}) => {
  await open(page);
  await loadAndSelectSecondPage(page);
  await page.evaluate(() => {
    (window as any).historyPerformance.holdGraph = true;
  });
  await page.getByRole("button", { name: "Invalidate history" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => !!(window as any).historyPerformance.release),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Local changes", exact: true })
    .click();
  await page.evaluate(() => (window as any).historyPerformance.release());
  expect(await graphOffsets(page)).toEqual([0, 100, 0]);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(() => graphOffsets(page)).toEqual([0, 100, 0, 0, 100]);
  await expect(page.locator(".graph-row.is-active")).toContainText(
    "Commit 199",
  );
});

test("returning to a previous scope while a new scope is pending reloads its cleared data", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    (window as any).historyPerformance.holdGraph = true;
  });
  await chooseOption(
    page.getByRole("combobox", { name: "Commit graph scope" }),
    "current",
  );
  await expect
    .poll(() =>
      page.evaluate(() => !!(window as any).historyPerformance.release),
    )
    .toBe(true);
  await chooseOption(
    page.getByRole("combobox", { name: "Commit graph scope" }),
    "all",
  );
  await expect.poll(() => graphOffsets(page)).toEqual([0, 0, 0]);
  await expect(page.locator(".graph-row").first()).toContainText("Commit 0");
  await page.evaluate(() => (window as any).historyPerformance.release());
  await expect(page.locator(".graph-row").first()).toContainText("Commit 0");
  await expect(
    page.getByRole("combobox", { name: "Commit graph scope" }),
  ).toContainText("All Branches");
});

test("external branch and tag moves invalidate history even when HEAD and automatic Fetch are unchanged", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("button", { name: "Local changes", exact: true })
    .click();
  await page.evaluate(() => {
    const state = (window as any).historyPerformance;
    state.feature = state.commits[30].oid;
  });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(() => graphOffsets(page)).toEqual([0, 0]);
  await expect(
    page.locator(".graph-row").filter({ hasText: "Commit 30" }),
  ).toContainText("feature");
  await expect(page.locator(".graph-head-location")).toContainText("0000000");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).historyPerformance.calls.filter(
            (c: any) => c.command === "history_auto_fetch",
          ).length,
      ),
    )
    .toBe(3);
  expect(await graphOffsets(page)).toEqual([0, 0]);
  await page.evaluate(() => {
    const state = (window as any).historyPerformance;
    state.tag = state.commits[10].oid;
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => graphOffsets(page)).toEqual([0, 0, 0]);
  await expect(
    page.locator(".graph-row").filter({ hasText: "Commit 10" }),
  ).toContainText("tag: v-test");
});

test("a failed initial version read cannot establish a stale graph baseline", async ({
  page,
}) => {
  await open(page, true);
  await expect(page.locator(".graph-error")).toContainText(
    "Version temporarily unavailable",
  );
  expect(await graphOffsets(page)).toEqual([]);
  await page.evaluate(() => {
    const state = (window as any).historyPerformance;
    state.feature = state.commits[30].oid;
    state.tag = state.commits[10].oid;
    state.failVersion = false;
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => graphOffsets(page)).toEqual([0]);
  await expect(
    page.locator(".graph-row").filter({ hasText: "Commit 30" }),
  ).toContainText("feature");
  await expect(
    page.locator(".graph-row").filter({ hasText: "Commit 10" }),
  ).toContainText("tag: v-test");
});

test("version read failure preserves loaded pages and selection until a successful retry", async ({
  page,
}) => {
  await open(page);
  await loadAndSelectSecondPage(page);
  await page.evaluate(() => {
    const state = (window as any).historyPerformance;
    state.failVersion = true;
    state.tag = state.commits[10].oid;
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.locator(".graph-error")).toContainText(
    "Version temporarily unavailable",
  );
  expect(await graphOffsets(page)).toEqual([0, 100]);
  await expect(page.locator(".graph-row.is-active")).toContainText(
    "Commit 199",
  );
  await page.evaluate(() => {
    (window as any).historyPerformance.failVersion = false;
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => graphOffsets(page)).toEqual([0, 100, 0, 100]);
  await expect(page.locator(".graph-error")).toHaveCount(0);
  await expect(page.locator(".graph-row.is-active")).toContainText(
    "Commit 199",
  );
});

test("quiet version checks cannot append a page from the superseded snapshot", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const state = (window as any).historyPerformance;
    state.holdVersion = true;
    state.tag = state.commits[10].oid;
    window.dispatchEvent(new Event("focus"));
  });
  await expect
    .poll(() =>
      page.evaluate(() => !!(window as any).historyPerformance.releaseVersion),
    )
    .toBe(true);
  await expect(page.locator(".graph-scroll")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.locator(".graph-table-footer button").click();
  expect(await graphOffsets(page)).toEqual([0]);
  await page.evaluate(() =>
    (window as any).historyPerformance.releaseVersion(),
  );
  await expect.poll(() => graphOffsets(page)).toEqual([0, 0]);
  await expect(
    page.locator(".graph-row").filter({ hasText: "Commit 10" }),
  ).toContainText("tag: v-test");
  await page.locator(".graph-table-footer button").click();
  await expect.poll(() => graphOffsets(page)).toEqual([0, 0, 100]);
  await page.locator(".graph-scroll").focus();
  await page.locator(".graph-scroll").press("End");
  await expect(page.locator(".graph-row.is-active")).toContainText(
    "Commit 199",
  );
});
