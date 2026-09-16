import { editorState, setEditorScroll, visibleSourcePosition } from "./editor";
import { chooseOption } from "./controls";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { demoChanges, demoDiff } from "../../src/demo";
import { demoGraphPage } from "../../src/graph-demo";
import { defaultPreferences } from "../../src/types";

async function openCommit(page: Page) {
  await page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("tab", { name: /^Commit/ })
    .click();
}

async function prepareFileHistoryFixture(
  page: Page,
  failure: "historical" | "both",
) {
  await openFixture(page);
  await page.evaluate((failure) => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    const oid = "a".repeat(40);
    w.blameReads = [];
    w.historyReads = 0;
    w.retryReady = { history: false, blame: false };
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      const { command, args } = payload ?? {};
      if (command === "history") {
        ++w.historyReads;
        if (failure === "both" && !w.retryReady.history)
          throw {
            code: "GIT_FAILED",
            message: "Temporary history read failure",
            detail: "fixture",
          };
        return [
          {
            oid,
            parents: [],
            author: "Fixture author",
            date: "2026-09-14T00:00:00Z",
            subject: "Saved version",
            refs: "",
          },
        ];
      }
      if (command === "file_blame") {
        w.blameReads.push(structuredClone(args));
        if (
          (failure === "historical" &&
            args.revision &&
            w.blameReads.filter((a: any) => a.revision).length === 1) ||
          (failure === "both" && !args.revision && !w.retryReady.blame)
        )
          throw {
            code: "GIT_FAILED",
            message: "Temporary Git read failure",
            detail: "fixture",
          };
        return {
          workspaceId: args.workspaceId,
          path: args.path,
          revision: args.revision,
          head: oid,
          lines: [
            {
              oid,
              originalLine: 1,
              line: 1,
              author: "Fixture author",
              authorTime: 0,
              summary: "Saved version",
              content: args.revision
                ? "restored historical source"
                : "current Worktree source",
              originPath: args.path,
              uncommitted: false,
            },
          ],
          totalLines: 1,
          offset: 0,
          hasMore: false,
          notice: "",
        };
      }
      return original(name, payload);
    };
  }, failure);
}

test("File history retries the same version and path after a transient Blame failure", async ({
  page,
}) => {
  await prepareFileHistoryFixture(page, "historical");
  await page
    .getByRole("button", { name: "文件历史与 Blame", exact: true })
    .click();
  const modal = page.getByRole("dialog", {
    name: "文件历史与 Blame",
    exact: true,
  });
  await modal.getByRole("button", { name: /Saved version/ }).click();
  await expect(modal.getByRole("alert").filter({hasText:/\S/})).toContainText(
    "Temporary Git read failure",
  );
  await modal.getByRole("button", { name: "读取", exact: true }).click();
  await expect(
    modal.getByRole("region", { name: "所选版本的逐行归属" }),
  ).toContainText("restored historical source");
  const reads = await page.evaluate(() =>
    (window as any).blameReads.filter((a: any) => a.revision),
  );
  expect(reads).toHaveLength(2);
  expect(reads[1]).toEqual(reads[0]);
});

test("File history and current Worktree Blame recover independently after failed reads", async ({
  page,
}) => {
  await prepareFileHistoryFixture(page, "both");
  await page
    .getByRole("button", { name: "文件历史与 Blame", exact: true })
    .click();
  const modal = page.getByRole("dialog", {
    name: "文件历史与 Blame",
    exact: true,
  });
  await expect(modal.getByRole("alert").filter({hasText:/\S/})).toContainText(
    "Temporary Git read failure",
  );
  await expect(modal).toContainText("文件历史读取失败");
  const before = await page.evaluate(() => {
    const w = window as any;
    w.retryReady.blame = true;
    return { history: w.historyReads, blame: w.blameReads.length };
  });
  await modal
    .getByRole("button", { name: "重新读取 Blame", exact: true })
    .click();
  await expect(
    modal.getByRole("region", { name: "所选版本的逐行归属" }),
  ).toContainText("current Worktree source");
  await expect(modal.getByRole("alert").filter({hasText:/\S/})).toContainText(
    "Temporary history read failure",
  );
  expect(await page.evaluate(() => (window as any).historyReads)).toBe(
    before.history,
  );
  await page.evaluate(() => {
    (window as any).retryReady.history = true;
  });
  await modal
    .getByRole("button", { name: "重新读取历史", exact: true })
    .click();
  await expect(
    modal.getByRole("button", { name: /Saved version/ }),
  ).toBeVisible();
  await expect(modal.getByRole("alert").filter({hasText:/\S/})).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      history: (window as any).historyReads,
      blame: (window as any).blameReads.length,
    })),
  ).toEqual({ history: before.history + 1, blame: before.blame + 1 });
});

test("Local changes uses one-line context controls and a standalone Full file button", async ({
  page,
}) => {
  await openFixture(page);
  await expect(
    page
      .locator(".workspace-tabs .view-tab")
      .filter({hasText:/^本地变更/}),
  ).toBeVisible();
  const context = page.getByLabel("上下文行数");
  await expect(context).toHaveText("3");
  await page
    .getByRole("button", { name: "减少一行上下文", exact: true })
    .click();
  await expect(context).toHaveText("2");
  await page
    .getByRole("button", { name: "增加一行上下文", exact: true })
    .click();
  await expect(context).toHaveText("3");
  await page
    .getByRole("button", { name: "增加一行上下文", exact: true })
    .click();
  await expect(context).toHaveText("4");
  const actions = await page.evaluate(() =>
    (window as any).fixture.actions.filter(
      (a: any) => a.command === "diff_context",
    ),
  );
  expect(actions.map((a: any) => a.args.contextLines)).toEqual([4]);
  await page.getByRole("button", { name: "全文", exact: true }).click();
  await expect(context).toHaveText("全部");
  await page.getByRole("button", { name: "全文", exact: true }).click();
  await expect(context).toHaveText("4");
  for (const n of [3, 2, 1, 0]) {
    await page
      .getByRole("button", { name: "减少一行上下文", exact: true })
      .click();
    await expect(context).toHaveText(String(n));
  }
  await expect(
    page.getByRole("button", { name: "减少一行上下文", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter((a: any) =>
        ["stage", "mark_reviewed"].includes(a.command),
      ),
    ),
  ).toHaveLength(0);
});

test("committed Diff starts unreviewed and supports explicit Review without Git writes", async ({
  page,
}) => {
  await openFixture(page);
  await page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  const tab = page.locator(".diff-tab-page").last();
  await expect(tab.locator(".hunk-review").first()).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter(
        (a: any) => a.command === "mark_comparison_reviewed",
      ),
    ),
  ).toHaveLength(0);
  await tab.locator(".hunk-review").first().click();
  await expect(tab.locator(".hunk-review").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(tab.locator(".diff-footer")).toContainText("1/2 已审查");
  await expect(tab.locator(".hunk-stage")).toHaveCount(0);
  await tab.getByRole("button", { name: "response.ts M", exact: true }).click();
  await tab.getByRole("button", { name: "requests.ts M", exact: true }).click();
  await expect(tab.locator(".hunk-review").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await tab.locator(".hunk-review").first().click();
  await expect(tab.locator(".hunk-review").first()).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter((a: any) =>
        ["stage", "commit", "mark_reviewed"].includes(a.command),
      ),
    ),
  ).toHaveLength(0);
});

test("comparison Review reconciles late replies across two tabs without restoring an undone mark", async ({
  page,
}) => {
  await openFixture(page);
  const navigation = page.getByRole("navigation", { name: "Worktree" });
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  const graph = page.getByRole("listbox", { name: "提交列表与分支关系" });
  await graph.getByRole("option").first().dblclick();
  const tabs = page.locator(".diff-tab-page");
  await tabs.first().locator(".hunk-review").nth(0).click();
  await expect(tabs.first().locator(".hunk-review").nth(0)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await tabs.first().locator(".hunk-review").nth(1).click();
  await expect(tabs.first().locator(".hunk-review").nth(1)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "返回 History", exact: true }).click();
  await graph
    .getByRole("option")
    .nth(1)
    .click({ modifiers: ["Meta"] });
  await expect(tabs).toHaveCount(2);
  await expect(tabs.last().locator(".hunk-review").nth(0)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(tabs.last().locator(".hunk-review").nth(1)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.deferReview = true;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      const value = await original(name, payload);
      if (payload?.command === "mark_comparison_reviewed" && w.deferReview) {
        w.deferReview = false;
        return new Promise((resolve) => {
          w.releaseReview = () => resolve(value);
        });
      }
      if (payload?.command === "read_compare_file" && w.deferReviewRead) {
        w.deferReviewRead = false;
        return new Promise((resolve) => {
          w.releaseReviewRead = () => resolve(value);
        });
      }
      return value;
    };
  });
  await navigation.locator(".diff-tab-button").first().click();
  await tabs.first().locator(".hunk-review").nth(0).click();
  await expect
    .poll(() => page.evaluate(() => !!(window as any).releaseReview))
    .toBe(true);
  await navigation.locator(".diff-tab-button").last().click();
  await page.evaluate(() => {
    (window as any).deferReviewRead = true;
  });
  await tabs.last().locator(".hunk-review").nth(1).click();
  await expect
    .poll(() => page.evaluate(() => !!(window as any).releaseReviewRead))
    .toBe(true);
  // Code remains readable while the authoritative Review state is being loaded.
  await expect(tabs.last().locator(".diff-scroll")).toContainText(
    "validateRequest",
  );
  await expect(tabs.last().locator(".hunk-review").first()).toBeDisabled();
  await page.evaluate(() => {
    (window as any).releaseReview();
  });
  // The superseded read also arrives late and must be ignored.
  await page.evaluate(() => {
    (window as any).releaseReviewRead();
  });
  for (const tabIndex of [0, 1]) {
    await navigation.locator(".diff-tab-button").nth(tabIndex).click();
    for (const index of [0, 1])
      await expect(
        tabs.nth(tabIndex).locator(".hunk-review").nth(index),
      ).toHaveAttribute("aria-pressed", "false");
  }
  const marks = await page.evaluate(() =>
    Object.values((window as any).fixture.comparisonMarks),
  );
  expect(marks).toHaveLength(1);
  expect(Object.values(marks[0] as object)).toEqual([
    "unreviewed",
    "unreviewed",
  ]);
});

test("Review invalidates cached comparison directions even while another direction is open", async ({
  page,
}) => {
  await openFixture(page);
  const navigation = page.getByRole("navigation", { name: "Worktree" });
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  const graph = page.getByRole("listbox", { name: "提交列表与分支关系" });
  await graph.getByRole("option").first().dblclick();
  await page.getByRole("button", { name: "返回 History", exact: true }).click();
  await graph
    .getByRole("option")
    .nth(1)
    .click({ modifiers: ["Meta"] });
  const tabs = page.locator(".diff-tab-page");
  await expect(tabs.last().locator(".hunk-review").first()).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await tabs
    .last()
    .getByRole("button", { name: "交换比较方向", exact: true })
    .click();
  await expect(tabs.last().locator(".hunk-review").first()).toBeVisible();
  await navigation.locator(".diff-tab-button").first().click();
  await tabs.first().locator(".hunk-review").first().click();
  await expect(tabs.first().locator(".hunk-review").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await navigation.locator(".diff-tab-button").last().click();
  await expect(tabs.last().locator(".hunk-review").first()).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await tabs
    .last()
    .getByRole("button", { name: "交换比较方向", exact: true })
    .click();
  await expect(tabs.last().locator(".hunk-review").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("Review reconciliation resumes after its tab is hidden during a read", async ({
  page,
}) => {
  await openFixture(page);
  const navigation = page.getByRole("navigation", { name: "Worktree" });
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  const tab = page.locator(".diff-tab-page").last();
  await expect(tab.locator(".hunk-review").first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.deferReadOnce = true;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      const value = await original(name, payload);
      if (payload?.command === "read_compare_file" && w.deferReadOnce) {
        w.deferReadOnce = false;
        return new Promise((resolve) => {
          w.releaseReviewRead = () => resolve(value);
        });
      }
      return value;
    };
  });
  await tab.locator(".hunk-review").first().click();
  await expect
    .poll(() => page.evaluate(() => !!(window as any).releaseReviewRead))
    .toBe(true);
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await navigation.locator(".diff-tab-button").last().click();
  await page.evaluate(() => {
    (window as any).releaseReviewRead();
  });
  await expect(tab.locator(".hunk-review").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).fixture.actions.filter(
            (a: any) => a.command === "read_compare_file",
          ).length,
      ),
    )
    .toBeGreaterThanOrEqual(3);
});

test("failed Review reconciliation exposes retry and never presents stale marks as current", async ({
  page,
}) => {
  await openFixture(page);
  await page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  const tab = page.locator(".diff-tab-page").last();
  await expect(tab.locator(".hunk-review").first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.failReviewRead = true;
    w.__TAURI_INTERNALS__.invoke = (name: string, payload: any) => {
      if (payload?.command === "read_compare_file" && w.failReviewRead)
        return Promise.reject({
          code: "STORE_BUSY",
          message: "Review 状态读取失败",
          detail: "fixture",
        });
      return original(name, payload);
    };
  });
  await tab.locator(".hunk-review").first().click();
  await expect(tab.getByRole("alert").filter({hasText:/\S/})).toContainText("Review 状态读取失败");
  await expect(tab.locator(".hunk-review")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).failReviewRead = false;
  });
  await tab.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(tab.locator(".hunk-review").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("full-file search cancels without accepting late text and keeps its scope honest on failure", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (name: string, payload: any) => {
      if (name === "cancel_read_request" && payload.ticket === w.contextTicket)
        w.contextCancelled = true;
      if (payload?.command === "diff_context") {
        if (w.failContext)
          return Promise.reject({
            code: "CONTEXT_TOO_LARGE",
            message: "完整内容超过读取上限",
            detail: "bounded fixture",
          });
        w.contextTicket = payload.args._readTicket;
        return new Promise((resolve) => {
          w.releaseContext = () =>
            resolve({
              snapshotId: payload.args.snapshotId,
              contextLines: 3,
              fullFile: true,
              gaps: [
                {
                  beforeHunkId: null,
                  lines: [
                    {
                      kind: "context",
                      content: "late full file text",
                      oldLine: 100,
                      newLine: 100,
                    },
                  ],
                },
              ],
            });
        });
      }
      return original(name, payload);
    };
  });
  await page.getByRole("button", { name: "搜索文件内容", exact: true }).click();
  await page.getByRole("button", { name: "全文", exact: true }).click();
  await expect(
    page.getByText("正在读取完整文件…", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消读取", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).contextCancelled))
    .toBe(true);
  await page.evaluate(() => (window as any).releaseContext());
  await expect(
    page.getByRole("button", { name: "全文", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page
    .getByLabel("搜索当前 Diff", { exact: true })
    .fill("late full file text");
  await expect(page.getByLabel("匹配行数")).toContainText("0/0");
  await page.evaluate(() => {
    (window as any).failContext = true;
  });
  await page.getByRole("button", { name: "全文", exact: true }).click();
  await expect(page.getByRole("alert").filter({hasText:/\S/})).toContainText("完整内容超过读取上限");
  await expect(
    page.getByRole("button", { name: "全文", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".diff-scroll")).toContainText("validateRequest");
});

test("full-file search restores its range after leaving a historical tab", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.fullContextReads = 0;
    w.__TAURI_INTERNALS__.invoke = (name: string, payload: any) => {
      if (payload?.command === "compare_context") {
        w.fullContextReads++;
        return Promise.resolve({
          snapshotId: payload.args.snapshotId,
          contextLines: 3,
          fullFile: true,
          gaps: [
            {
              beforeHunkId: null,
              lines: Array.from({ length: 3 }, (_, n) => ({
                kind: "context",
                content: `unchanged searchable tail ${n}`,
                oldLine: 100 + n,
                newLine: 100 + n,
              })),
            },
          ],
        });
      }
      return original(name, payload);
    };
  });
  const navigation = page.getByRole("navigation", { name: "Worktree" });
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  const tab = page.locator(".diff-tab-page").last();
  await tab.getByRole("button", { name: "搜索文件内容", exact: true }).click();
  await tab.getByRole("button", { name: "全文", exact: true }).click();
  await tab
    .getByLabel("搜索当前 Diff", { exact: true })
    .fill("unchanged searchable tail");
  await expect(tab.locator(".view-line:has(.proof-search-match)").first()).toContainText(
    "unchanged searchable tail",
  );
  await tab.getByRole("button", { name: "下一个匹配行", exact: true }).click();
  await expect(tab.getByLabel("匹配行数")).toContainText("2/3");
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await expect(tab.locator(".diff-scroll")).not.toContainText(
    "unchanged searchable tail",
  );
  await navigation.locator(".diff-tab-button").last().click();
  await expect(
    tab.getByRole("button", { name: "全文", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(tab.getByLabel("匹配行数")).toContainText("2/3");
  await expect(tab.locator(".view-line:has(.proof-search-match)").first()).toContainText(
    "unchanged searchable tail",
  );
  expect(await page.evaluate(() => (window as any).fullContextReads)).toBe(2);
});

for (const route of [
  "raw",
  "history",
  "unmounted",
  "fresh-snapshot",
] as const) {
  test(`Full file keeps an unchanged source position through ${route}`, async ({
    page,
  }) => {
    await openFixture(page);
    if (route === "unmounted")
      await installLargeDiff(page, "src/api/requests.ts");
    await page.evaluate(() => {
      const w = window as any,
        original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
        if (["compare_context", "diff_context"].includes(payload?.command)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return {
            snapshotId: payload.args.snapshotId,
            fullFile: true,
            contextLines: 3,
            gaps: [
              {
                beforeHunkId: null,
                lines: Array.from({ length: 600 }, (_, n) => ({
                  kind: "context",
                  content: `unchanged context line ${n}`,
                  oldLine: 100 + n,
                  newLine: 100 + n,
                })),
              },
            ],
          };
        }
        return original(name, payload);
      };
    });
    const navigation = page.getByRole("navigation", { name: "Worktree" });
    if (route !== "fresh-snapshot") {
      await navigation
        .getByRole("tab", { name: "History", exact: true })
        .click();
      await page
        .getByRole("listbox", { name: "提交列表与分支关系" })
        .getByRole("option")
        .first()
        .dblclick();
    }
    const tab =
      route === "fresh-snapshot"
        ? page.getByRole("region", { name: "代码差异", exact: true })
        : page.locator(".diff-tab-page").last();
    if (route === "unmounted")
      await tab.getByRole("button", { name: "加载 Diff", exact: true }).click();
    await tab
      .getByRole("button", { name: "Diff 阅读选项", exact: true })
      .click();
    await tab.getByRole("button", { name: "全文", exact: true }).click();
    await expect(
      tab.getByRole("button", { name: "全文", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const scroll = tab.locator(".diff-scroll");
    await setEditorScroll(scroll,{scrollTop:9000});
    const visiblePosition = () => visibleSourcePosition(scroll);
    const before = await visiblePosition();
    expect(Number(before?.key.split(" ").at(-1))).toBeGreaterThanOrEqual(100);
    if (route === "fresh-snapshot") {
      await page.evaluate(() => {
        const state = (window as any).fixture;
        state.diffs["src/api/requests.ts"].hunks[0].lines.find(
          (line: any) => line.kind === "add",
        ).content += " updated hunk";
        state.changes.token += ":updated-hunk";
        window.dispatchEvent(new Event("focus"));
      });
      await expect
        .poll(() => page.evaluate(() => (window as any).fixture.reads))
        .toBeGreaterThan(1);
    } else if (route === "raw") {
      await tab
        .getByRole("button", { name: "查看原始 patch", exact: true })
        .click();
      await expect(tab.locator(".raw-patch")).toBeVisible();
      await tab
        .getByRole("button", { name: "查看原始 patch", exact: true })
        .click();
    } else {
      await navigation
        .getByRole("tab", { name: "History", exact: true })
        .click();
      if (route === "unmounted") await expect(scroll).toHaveCount(0);
      await navigation.locator(".diff-tab-button").last().click();
    }
    if (route === "unmounted")
      await tab
        .getByRole("button", { name: "Diff 阅读选项", exact: true })
        .click();
    await expect(
      tab.getByRole("button", { name: "全文", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect.poll(visiblePosition).toEqual(before);
  });
}

for (const outcome of ["cancel", "failure"] as const) {
  test(`Full file ${outcome} does not restart after revisiting the file`, async ({
    page,
  }) => {
    await openFixture(page);
    await page.evaluate((outcome) => {
      const w = window as any,
        original = w.__TAURI_INTERNALS__.invoke;
      w.contextAttempts = 0;
      w.__TAURI_INTERNALS__.invoke = (name: string, payload: any) => {
        if (payload?.command === "compare_context") {
          w.contextAttempts++;
          if (outcome === "failure")
            return Promise.reject({
              code: "CONTEXT_TOO_LARGE",
              message: "Context limit fixture",
              detail: "test",
            });
          return new Promise((resolve) => {
            w.releaseContext = () =>
              resolve({
                snapshotId: payload.args.snapshotId,
                contextLines: 3,
                fullFile: true,
                gaps: [],
              });
          });
        }
        return original(name, payload);
      };
    }, outcome);
    await page
      .getByRole("navigation", { name: "Worktree" })
      .getByRole("tab", { name: "History", exact: true })
      .click();
    await page
      .getByRole("listbox", { name: "提交列表与分支关系" })
      .getByRole("option")
      .first()
      .dblclick();
    const tab = page.locator(".diff-tab-page").last();
    await tab
      .getByRole("button", { name: "Diff 阅读选项", exact: true })
      .click();
    await tab.getByRole("button", { name: "全文", exact: true }).click();
    if (outcome === "cancel") {
      await tab.getByRole("button", { name: "取消读取", exact: true }).click();
      await page.evaluate(() => (window as any).releaseContext());
    } else
      await expect(tab.getByRole("alert").filter({hasText:/\S/})).toContainText(
        "Context limit fixture",
      );
    await tab
      .getByRole("button", { name: "response.ts M", exact: true })
      .click();
    await tab
      .getByRole("button", { name: "requests.ts M", exact: true })
      .click();
    await expect(tab.locator(".diff-file-header")).toContainText("requests.ts");
    await tab
      .getByRole("button", { name: "Diff 阅读选项", exact: true })
      .click();
    await expect(
      tab.getByRole("button", { name: "全文", exact: true }),
    ).toBeEnabled();
    await expect(tab.getByLabel("上下文行数")).toHaveText("3");
    expect(await page.evaluate(() => (window as any).contextAttempts)).toBe(1);
  });
}

test("file search includes whitespace-only changes and restores the reading filter", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const state = (window as any).fixture,
      diff = state.diffs["src/api/requests.ts"];
    diff.hunks = [
      {
        ...diff.hunks[0],
        header: "@@ -1 +1 @@",
        oldStart: 1,
        newStart: 1,
        lines: [
          {
            kind: "delete",
            content: "const  whitespaceToken = 1;",
            oldLine: 1,
            newLine: null,
          },
          {
            kind: "add",
            content: "const whitespaceToken = 1;",
            oldLine: null,
            newLine: 1,
          },
        ],
      },
    ];
    state.changes.token += ":whitespace";
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.locator(".diff-scroll")).toContainText("whitespaceToken");
  await page
    .getByRole("button", { name: "Diff 阅读选项", exact: true })
    .click();
  await page.getByRole("checkbox",{name:"隐藏空白变化",exact:true}).check();
  await expect(page.locator(".hidden-diff-lines")).toBeVisible();
  await page.getByRole("button", { name: "搜索文件内容", exact: true }).click();
  await page
    .getByLabel("搜索当前 Diff", { exact: true })
    .fill("const  whitespaceToken");
  await expect(page.getByLabel("匹配行数")).toContainText("1/1");
  await expect(page.locator(".hidden-diff-lines")).toHaveCount(0);
  await page
    .getByRole("button", { name: "关闭文件内容搜索", exact: true })
    .click();
  await page.getByRole("button",{name:"Diff 阅读选项",exact:true}).click();
  await expect(page.getByRole("checkbox",{name:"隐藏空白变化",exact:true})).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.locator(".hidden-diff-lines")).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter((a: any) =>
        ["stage", "mark_reviewed"].includes(a.command),
      ),
    ),
  ).toHaveLength(0);
});

test("Full file shrinking resets split widths and horizontal offsets", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (name: string, payload: any) =>
      payload?.command === "diff_context"
        ? Promise.resolve({
            snapshotId: payload.args.snapshotId,
            contextLines: 3,
            fullFile: true,
            gaps: [
              {
                beforeHunkId: null,
                lines: [
                  {
                    kind: "context",
                    content: "long unchanged " + "x".repeat(10000),
                    oldLine: 100,
                    newLine: 100,
                  },
                ],
              },
            ],
          })
        : original(name, payload);
  });
  await page.getByRole("button", { name: "并排视图", exact: true }).click();
  await page.getByRole("button", { name: "搜索文件内容", exact: true }).click();
  await page.getByRole("button", { name: "全文", exact: true }).click();
  await page
    .getByLabel("搜索当前 Diff", { exact: true })
    .fill("long unchanged");
  await expect(page.locator(".view-line:has(.proof-search-match)").first()).toContainText(
    "long unchanged",
  );
  const bar=page.locator(".diff-scroll");
  await expect.poll(async()=> (await editorState(bar,"old"))?.width??0).toBeGreaterThan(10000);
  await setEditorScroll(bar,{scrollLeft:20000},"old");
  await expect.poll(async()=> (await editorState(bar,"old"))?.left??0).toBeGreaterThan(10000);
  await page.getByRole("button", { name: "全文", exact: true }).click();
  await expect.poll(async()=> (await editorState(bar,"old"))?.width??Infinity).toBeLessThan(3000);
  await expect.poll(async()=> (await editorState(bar,"old"))?.left??Infinity).toBeLessThan(3000);
});

test("healthy file watching refreshes on events without continuous Git polling", async ({
  page,
}) => {
  await openFixture(page, true);
  await expect
    .poll(() => page.evaluate(() => (window as any).fixture.watchStarts))
    .toBe(1);
  // An absence assertion needs a bounded observation window covering the old
  // 1.2 second timer. Other tests retain the unavailable-watch fallback.
  const calls = () =>
    page.evaluate(
      () =>
        (window as any).fixture.actions.filter(
          (a: any) => a.command === "changes",
        ).length,
    );
  await page.waitForTimeout(300);
  const before = await calls();
  await page.waitForTimeout(3000);
  expect(await calls()).toBe(before);
  await page.evaluate(() => {
    const state = (window as any).fixture;
    state.diffs["src/api/requests.ts"].hunks[0].lines.find(
      (line: any) => line.kind === "add",
    ).content = "Event-driven file update";
    state.changes.token += ":watch-event";
    state.emitNativeEvent("workspace-invalidated", state.changes.workspace.id);
  });
  await expect(page.locator(".diff-scroll")).toContainText(
    "Event-driven file update",
  );
  expect(await calls()).toBe(before + 1);
});

test("a runtime watcher failure resumes fallback refresh", async ({ page }) => {
  await openFixture(page, true);
  await expect
    .poll(() => page.evaluate(() => (window as any).fixture.watchStarts))
    .toBe(1);
  await page.evaluate(() => {
    const state = (window as any).fixture;
    state.emitNativeEvent("workspace-watch-failed", {
      workspaceId: state.changes.workspace.id,
      generation: state.watchGeneration,
    });
    state.diffs["src/api/requests.ts"].hunks[0].lines.find(
      (line: any) => line.kind === "add",
    ).content = "Fallback file update";
    state.changes.token += ":fallback-save";
  });
  await expect(page.getByRole("alert").filter({hasText:/\S/})).toHaveCount(0);
  await expect(page.locator(".diff-scroll")).toContainText(
    "Fallback file update",
  );
});

test("background changes stay readable without a loading overlay or toast", async ({ page }) => {
  await openFixture(page, true);
  await expect.poll(() => page.evaluate(() => (window as any).fixture.watchStarts)).toBe(1);
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke, state = w.fixture;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (payload?.command === "read_file_diff") {
        await new Promise<void>((resolve) => { w.finishBackgroundDiff = resolve; });
      }
      return original(name, payload);
    };
    state.diffs["src/api/requests.ts"].hunks[0].lines.find((line: any) => line.kind === "add").content = "Quietly refreshed content";
    state.changes.token += ":quiet-refresh";
    state.emitNativeEvent("workspace-invalidated", state.changes.workspace.id);
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishBackgroundDiff)).toBe("function");
  await expect(page.locator(".diff-scroll")).toBeVisible();
  await expect(page.locator(".diff-loading-layer")).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
  await expect(page.locator(".live-status")).toHaveText("实时");
  await page.evaluate(() => (window as any).finishBackgroundDiff());
  await expect(page.locator(".diff-scroll")).toContainText("Quietly refreshed content");
});

for (const command of ["changes", "read_file_diff"] as const) {
  test(`one watch event recovers after a transient ${command} failure`, async ({
    page,
  }) => {
    await openFixture(page, true);
    await expect
      .poll(() => page.evaluate(() => (window as any).fixture.watchStarts))
      .toBe(1);
    await page.waitForTimeout(400);
    await page.evaluate((command) => {
      const w = window as any,
        original = w.__TAURI_INTERNALS__.invoke;
      let remaining = 1;
      w.__TAURI_INTERNALS__.invoke = (name: string, payload: any) => {
        if (payload?.command === command && remaining-- > 0)
          return Promise.reject({
            code: command === "changes" ? "GIT_FAILED" : "STALE_CONTENT",
            message: "临时读取失败",
            detail: "one-shot fixture failure",
          });
        return original(name, payload);
      };
      const state = w.fixture;
      state.diffs["src/api/requests.ts"].hunks[0].lines.find(
        (line: any) => line.kind === "add",
      ).content = "Recovered without another event";
      state.changes.token += ":single-event";
      state.emitNativeEvent(
        "workspace-invalidated",
        state.changes.workspace.id,
      );
    }, command);
    await expect(page.locator(".diff-scroll")).toContainText(
      "Recovered without another event",
    );
  });
}

async function installLargeDiff(page: Page, path: string) {
  await page.evaluate((path) => {
    const diff = (window as any).fixture.diffs[path];
    const body = "x".repeat(1_300_000);
    diff.patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old ${body}\n+new ${body}\n`;
    diff.hunks = [
      {
        ...diff.hunks[0],
        header: "@@ -1 +1 @@",
        oldStart: 1,
        newStart: 1,
        reviewState: "unreviewed",
        lines: [
          { kind: "delete", content: `old ${body}`, oldLine: 1, newLine: null },
          { kind: "add", content: `new ${body}`, oldLine: null, newLine: 1 },
        ],
      },
    ];
    diff.additions = 1;
    diff.deletions = 1;
  }, path);
}

test("a failed explicit large-file load retries past its cached summary", async ({
  page,
}) => {
  await openFixture(page, true);
  await installLargeDiff(page, "src/api/response.ts");
  await page
    .getByRole("button", { name: "response.ts M", exact: true })
    .click();
  const summary = page.getByRole("region", {
    name: "Diff 尚未加载",
    exact: true,
  });
  await expect(summary).toBeVisible();
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.largeLoadAttempts = 0;
    w.__TAURI_INTERNALS__.invoke = (name: string, payload: any) => {
      if (
        payload?.command === "read_file_diff" &&
        payload.args.loadLarge &&
        ++w.largeLoadAttempts === 1
      )
        return Promise.reject({
          code: "GIT_FAILED",
          message: "临时读取失败",
          detail: "explicit load fixture",
        });
      return original(name, payload);
    };
  });
  await summary.getByRole("button", { name: "加载 Diff", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "代码差异", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).largeLoadAttempts)).toBe(2);
});

test("large Changes waits for explicit loading and keeps Stage independent of Review", async ({
  page,
}) => {
  await openFixture(page);
  await installLargeDiff(page, "src/api/response.ts");
  await page
    .getByRole("button", { name: "response.ts M", exact: true })
    .click();
  const summary = page.getByRole("region", {
    name: "Diff 尚未加载",
    exact: true,
  });
  await expect(summary).toContainText("未计入 Review");
  await expect(
    page.getByRole("region", { name: "代码差异", exact: true }),
  ).toHaveCount(0);
  await expect(
    summary.getByRole("button", { name: "Stage 文件", exact: true }),
  ).toBeEnabled();
  await summary.getByRole("button", { name: "加载 Diff", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "代码差异", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "标记已 Review：第 1 行", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  const actions = await page.evaluate(() => (window as any).fixture.actions);
  expect(
    actions.some(
      (a: any) => a.command === "read_file_diff" && a.args.loadLarge === true,
    ),
  ).toBe(true);
  expect(
    actions.filter((a: any) => a.command === "mark_reviewed"),
  ).toHaveLength(0);
});

test("large historical Diff loads in its tab and releases its hidden rendered body", async ({
  page,
}) => {
  await openFixture(page);
  await installLargeDiff(page, "src/api/requests.ts");
  const navigation = page.getByRole("navigation", { name: "Worktree" });
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  const tab = page.locator(".diff-tab-page").last();
  await tab.getByRole("button", { name: "加载 Diff", exact: true }).click();
  await expect(
    tab.getByRole("region", { name: "代码差异", exact: true }),
  ).toBeVisible();
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await expect(
    tab.getByRole("region", { name: "代码差异", exact: true }),
  ).toHaveCount(0);
  await navigation.locator(".diff-tab-button").last().click();
  await expect(
    tab.getByRole("region", { name: "代码差异", exact: true }),
  ).toBeVisible();
  const actions = await page.evaluate(() => (window as any).fixture.actions);
  expect(
    actions.filter(
      (a: any) =>
        a.command === "read_compare_file" && a.args.loadLarge === true,
    ),
  ).toHaveLength(2);
  expect(
    actions.filter((a: any) =>
      ["stage", "stage_files", "mark_reviewed"].includes(a.command),
    ),
  ).toHaveLength(0);
});

test("an unrelated file refresh preserves an explicit large Diff read", async ({
  page,
}) => {
  await openFixture(page);
  await installLargeDiff(page, "src/api/response.ts");
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.changes.fileVersions = Object.fromEntries(
      w.fixture.changes.files.map((f: any) => [`${f.side}:${f.path}`, "v1"]),
    );
    w.fixture.changes.token += ":versions";
  });
  // Let the repository accept per-file versions before selecting the large file.
  await expect
    .poll(() => page.evaluate(() => (window as any).fixture.reads))
    .toBeGreaterThan(1);
  await page
    .getByRole("button", { name: "response.ts M", exact: true })
    .click();
  const summary = page.getByRole("region", {
    name: "Diff 尚未加载",
    exact: true,
  });
  await expect(summary).toBeVisible();
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.fullRead = {
      ticket: null,
      pending: false,
      cancelled: false,
      refreshed: false,
    };
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (payload?.command === "changes" && w.fullRead.pending)
        w.fullRead.refreshed = true;
      if (payload?.command === "read_file_diff" && payload.args.loadLarge) {
        w.fullRead.ticket = payload.args._readTicket;
        w.fullRead.pending = true;
        await new Promise<void>((resolve) => {
          w.releaseLargeRead = resolve;
        });
        w.fullRead.pending = false;
      }
      if (
        name === "cancel_read_request" &&
        w.fullRead.pending &&
        payload.ticket === w.fullRead.ticket
      )
        w.fullRead.cancelled = true;
      return original(name, payload);
    };
  });
  await summary.getByRole("button", { name: "加载 Diff", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).fullRead.pending))
    .toBe(true);
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.changes.fileVersions["unstaged:src/api/requests.ts"] = "v2";
    w.fixture.changes.token += ":other-file";
    window.dispatchEvent(new Event("focus"));
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).fullRead.refreshed))
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "取消读取", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).releaseLargeRead());
  await expect(
    page.getByRole("region", { name: "代码差异", exact: true }),
  ).toContainText("response.ts");
  expect(await page.evaluate(() => (window as any).fullRead.cancelled)).toBe(
    false,
  );
});

test("a released large historical Diff restores its wrapped source line", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 650 });
  await openFixture(page);
  await page.evaluate(() => {
    const diff = (window as any).fixture.diffs["src/api/requests.ts"];
    const lines = ["delete", "add"].flatMap((kind) =>
      Array.from({ length: 2200 }, (_, n) => ({
        kind,
        content: `${kind} ${n} ${"wrapped content ".repeat(40)}`,
        oldLine: kind === "delete" ? n + 1 : null,
        newLine: kind === "add" ? n + 1 : null,
      })),
    );
    diff.patch =
      `diff --git a/${diff.path} b/${diff.path}\n--- a/${diff.path}\n+++ b/${diff.path}\n@@ -1,2200 +1,2200 @@\n` +
      lines
        .map((line) => `${line.kind === "delete" ? "-" : "+"}${line.content}\n`)
        .join("");
    diff.hunks = [
      {
        ...diff.hunks[0],
        header: "@@ -1,2200 +1,2200 @@",
        oldStart: 1,
        newStart: 1,
        lines,
      },
    ];
  });
  const navigation = page.getByRole("navigation", { name: "Worktree" });
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  const tab = page.locator(".diff-tab-page").last();
  await tab.getByRole("button", { name: "加载 Diff", exact: true }).click();
  await tab.getByRole("button", { name: "切换自动换行", exact: true }).click();
  const scroll = tab.locator(".diff-scroll");
  await setEditorScroll(scroll,{scrollTop:12000});
  const visiblePosition=()=>visibleSourcePosition(scroll);
  let before: Awaited<ReturnType<typeof visiblePosition>> = null;
  await expect
    .poll(async () => (before = await visiblePosition()))
    .not.toBeNull();
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await expect(scroll).toHaveCount(0);
  await navigation.locator(".diff-tab-button").last().click();
  await expect(scroll).toBeVisible();
  await expect.poll(visiblePosition).toEqual(before);
});

test("Commit preview labels unread coverage and permits an ordinary Commit", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      const value = await original(name, payload);
      if (payload?.command === "commit_preview")
        return {
          ...value,
          coverageComputed: true,
          unreadFiles: value.files.map((file: any) => file.path),
          reviewed: 0,
          total: 0,
        };
      return value;
    };
  });
  await openCommit(page);
  await page.getByRole("button", { name: "打开命令面板", exact: true }).click();
  await page
    .getByRole("dialog", { name: "命令面板", exact: true })
    .getByRole("option", { name: "提交预览", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "提交预览", exact: true });
  await expect(dialog.locator(".commit-unread")).toHaveCount(1);
  await expect(dialog.locator(".commit-coverage")).toContainText(
    "Review 未完成",
  );
  await expect(dialog.locator(".commit-coverage.complete")).toHaveCount(0);
  await dialog.getByLabel("提交说明").fill("Commit the selected large file");
  await dialog.getByRole("button", { name: "确认提交", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).fixture.actions.filter(
          (a: any) => a.command === "commit",
        ).length,
    ),
  ).toBe(1);
});

test("a regular historical Diff preserves its reading position across tabs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 580 });
  await openFixture(page);
  const navigation = page.getByRole("navigation", { name: "Worktree" });
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  const scroll = page.locator(".diff-tab-page .diff-scroll");
  await setEditorScroll(scroll,{scrollTop:180});
  await expect.poll(async()=> (await editorState(scroll))?.top ?? 0).toBeGreaterThan(100);
  const top=(await editorState(scroll))!.top;
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await navigation.locator(".diff-tab-button").last().click();
  await expect
    .poll(() =>
      editorState(scroll).then(state=>state?Math.abs(state.top-top):Infinity),
    )
    .toBeLessThan(5);
});

test("cancelling an active file read releases the next selection without Review or Stage", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    const pending = new Map<string, (error: unknown) => void>();
    w.cancelledReads = [];
    w.__TAURI_INTERNALS__.invoke = (name: string, payload: any) => {
      if (
        name === "proof_command" &&
        payload.command === "read_file_diff" &&
        payload.args.path === "src/api/response.ts"
      ) {
        w.readEntered = true;
        return new Promise((_resolve, reject) =>
          pending.set(payload.args._readTicket, reject),
        );
      }
      if (name === "cancel_read_request") {
        const reject = pending.get(payload.ticket);
        if (reject) {
          pending.delete(payload.ticket);
          w.cancelledReads.push(payload.ticket);
          reject({
            code: "READ_CANCELLED",
            message: "读取已取消。",
            detail: "fixture",
          });
        }
      }
      return original(name, payload);
    };
  });
  await page
    .getByRole("button", { name: "response.ts M", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).readEntered))
    .toBe(true);
  await page.getByRole("button", { name: "取消读取", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).cancelledReads.length))
    .toBe(1);
  await page
    .getByRole("button", { name: "requests.ts M", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "代码差异", exact: true }),
  ).toContainText("requests.ts");
  const writes = await page.evaluate(() =>
    (window as any).fixture.actions.filter((a: any) =>
      ["stage", "stage_files", "mark_reviewed"].includes(a.command),
    ),
  );
  expect(writes).toEqual([]);
});

test("a Diff from a newer Branch waits for matching repository state before review", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    const head = "1234567890abcdef1234567890abcdef12345678";
    const race = { released: false, reads: 0, release: () => {} };
    const waiting: Array<(value: unknown) => void> = [];
    race.release = () => {
      race.released = true;
      Object.assign(w.fixture.changes, {
        head,
        branch: "other",
        token: "other-branch",
      });
      for (const diff of Object.values(w.fixture.diffs) as any[])
        diff.base = `${head}:other`;
      for (const resolve of waiting)
        resolve(structuredClone(w.fixture.changes));
    };
    w.branchReadingRace = race;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (name !== "proof_command") return original(name, payload);
      if (payload.command === "changes" && !race.released)
        return new Promise((resolve) => waiting.push(resolve));
      const result = await original(name, payload);
      if (payload.command === "read_file_diff") {
        race.reads++;
        result.diff.base = `${head}:other`;
      }
      return result;
    };
  });
  await page
    .getByRole("button", { name: "response.ts M", exact: true })
    .click();
  await expect.poll(() => page.evaluate(() => (window as any).branchReadingRace.reads)).toBeGreaterThan(0);
  await expect(
    page.getByText("仓库已更新，正在刷新…", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "代码差异", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Stage 文件",
      exact: true,
      disabled: false,
    }),
  ).toHaveCount(0);
  await page.evaluate(() => (window as any).branchReadingRace.release());
  await expect(
    page.getByRole("combobox", { name: "切换 Branch，当前 other", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "代码差异", exact: true }),
  ).toContainText("response.ts");
  await expect(
    page.getByRole("button", { name: "Stage 文件", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => (window as any).branchReadingRace.reads),
  ).toBeGreaterThanOrEqual(2);
});

async function openContextFixture(page: Page) {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    const makeLink = (id: string, observed: boolean) => ({
      session: {
        id,
        agent: "codex",
        nativeSessionId: `native-${id}`,
        nativeAgentId: null,
        firstReceivedAt: Date.now(),
        lastReceivedAt: Date.now(),
        eventCount: 1,
        promptExcerpt: observed
          ? "Check request validation"
          : "Task in another file",
        promptStatus: "recorded",
        cleared: false,
      },
      originalEvidence: {
        pathEventCount: observed ? 1 : 0,
        eventIds: observed ? [`event-${id}`] : [],
        matchedAtCapture: false,
      },
      userOverride: null,
      revision: "initial",
      active: observed,
    });
    const state = {
      links: [makeLink("session-a", true), makeLink("session-b", false)],
      history: [] as any[],
      calls: [] as any[],
      pending: false,
      reject: undefined as any,
    };
    w.contextFixture = state;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      const command = payload?.command,
        args = payload?.args;
      if (
        name !== "proof_command" ||
        ![
          "context_overview",
          "context_candidates",
          "context_history",
          "context_session_events",
          "update_context_association",
          "undo_context_association",
        ].includes(command)
      )
        return original(name, payload);
      state.calls.push({ command, args: structuredClone(args) });
      if (command === "context_overview")
        return {
          workspaceId: args.workspaceId,
          path: args.path,
          links: structuredClone(state.links.filter((l) => l.active)),
          excludedCount: state.links.filter(
            (l) => (l.userOverride as any)?.enabled === false,
          ).length,
          historyCount: state.history.length,
          hasMore: false,
        };
      if (command === "context_candidates")
        return {
          links: structuredClone(
            state.links.filter((l) =>
              JSON.stringify(l.session)
                .toLowerCase()
                .includes(args.search.toLowerCase()),
            ),
          ),
          next: null,
        };
      if (command === "context_history")
        return {
          entries: structuredClone(
            [...state.history].reverse().map((entry) => ({
              ...entry,
              canUndo:
                [...state.history]
                  .reverse()
                  .find((e) => e.sessionId === entry.sessionId)?.id ===
                entry.id,
              revision: state.links.find(
                (l) => l.session.id === entry.sessionId,
              )!.revision,
            })),
          ),
          nextOffset: null,
        };
      if (command === "context_session_events")
        return {
          events: [
            {
              id: "event",
              sessionId: args.sessionId,
              kind: "Stop",
              toolName: null,
              toolRef: null,
              turnId: null,
              receivedAt: Date.now(),
              paths: [],
              prompt: null,
              command: null,
              output: null,
              reply: "Agent says: all tests passed",
              exitCode: null,
              commandState: "not_applicable",
              fieldStatus: {
                prompt: "not_authorized",
                command: "not_provided",
              },
              truncated: false,
              possiblyDuplicate: false,
            },
          ],
          next: null,
          cleared: false,
        };
      if (state.pending)
        return new Promise((_resolve, reject) => {
          state.reject = reject;
        });
      const undo =
        command === "undo_context_association"
          ? state.history.find((e) => e.id === args.changeId)
          : null;
      const link = state.links.find(
        (l) => l.session.id === (undo?.sessionId ?? args.sessionId),
      )!;
      if (args.expectedRevision !== link.revision)
        throw {
          code: "CONTEXT_CHANGED",
          message: "关联已更新，请重新读取后再保存。",
          detail: "fixture conflict",
        };
      const entry = {
        id: `change-${state.history.length}`,
        sessionId: link.session.id,
        createdAt: Date.now(),
        action: undo ? "undo" : args.action,
        before: structuredClone(link.userOverride),
        after: undo
          ? undo.before
          : args.action === "automatic"
            ? null
            : { enabled: args.action === "link", note: args.note },
        originalEvidence: structuredClone(link.originalEvidence),
        undoOf: undo?.id ?? null,
        source: "user",
        canUndo: true,
        revision: `changed-${state.history.length}`,
      };
      state.history.push(entry);
      Object.assign(link, {
        userOverride: entry.after,
        revision: entry.revision,
        active:
          entry.after?.enabled ?? link.originalEvidence.pathEventCount > 0,
      });
      return structuredClone({ change: entry, revision: entry.revision });
    };
  });
  await page.getByRole("button", { name: "显示上下文", exact: true }).click();
  await expect(page.locator(".context-linked-session")).toContainText(
    "Check request validation",
  );
}

async function openFixture(
  page: Page,
  watchAvailable = false,
  aiEnabled = false,
) {
  const workspace = {
    ...demoChanges.workspace,
    id: "workflow-test",
    repositoryId: "workflow-test",
    trusted: true,
  };
  const changes = { ...demoChanges, workspace };
  const diffs = Object.fromEntries(
    changes.files.map((file) => [
      file.path,
      {
        ...demoDiff(file),
        workspaceId: workspace.id,
        canStage: true,
        canStageHunks: true,
      },
    ]),
  );
  await page.addInitScript(
    ({ changes, diffs, preferences, graph, watchAvailable, aiEnabled }) => {
      const state = {
        changes,
        diffs,
        calls: [] as string[],
        actions: [] as any[],
        delay: 0,
        failCommit: false,
        expireStage: false,
        reads: 0,
        windowCloses: 0,
        watchStarts: 0,
        watchGeneration: 0,
        comparisonMarks: {} as Record<string, Record<string, string>>,
        aiGroups: { revision: 0, groups: [] as any[], sourceToken: "" },
        returnedDiffs: {} as Record<string, any>,
        agentSettings: {
          revision: 0,
          defaultProvider: "codex",
          codex: {
            executablePath: null as string | null,
            model: null as string | null,
          },
          claudeCode: {
            executablePath: null as string | null,
            model: null as string | null,
          },
          codewiz: { executablePath: null as string | null, model: null as string | null },
        },
        codewizEnabled: false,
        agentAuthenticated: false,
        aiHold: false,
        aiRelease: null as (() => void) | null,
        aiReject: null as ((error: unknown) => void) | null,
        aiTicket: "",
      };
      const callbacks = new Map<number, (event: any) => void>();
      const listeners = new Map<number, { event: string; handler: number }>();
      let identifier = 0;
      Object.assign(window, {
        fixture: Object.assign(state, {
          emitNativeEvent: (event: string, payload: unknown = null) => {
            for (const [id, entry] of listeners) {
              if (entry.event === event)
                callbacks.get(entry.handler)?.({ event, id, payload });
            }
          },
        }),
        __TAURI_EVENT_PLUGIN_INTERNALS__: {
          unregisterListener: (_: string, id: number) => listeners.delete(id),
        },
        __TAURI_INTERNALS__: {
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { label: "main" },
          },
          unregisterCallback: (id: number) => callbacks.delete(id),
          transformCallback: (callback: (event: any) => void) => {
            const id = ++identifier;
            callbacks.set(id, callback);
            return id;
          },
          invoke: async (_: string, payload: any = {}) => {
            if (_ === "prepare_read_request") return `read-${++identifier}`;
            if (_ === "cancel_read_request") {
              if (payload.ticket === state.aiTicket) {
                state.aiReject?.({ code: "AI_CANCELLED", message: "AI 分析已取消。", detail: "Owned fixture task cancelled" });
                state.aiReject = null;
              }
              return true;
            }
            const { command, args } = payload;
            if (command === "ui_language")
              return sessionStorage.getItem("proof-test-language") ?? "zh-CN";
            if (command === "set_ui_language") {
              sessionStorage.setItem("proof-test-language", args.language);
              return args.language;
            }

            if (_ === "plugin:event|listen") {
              const id = ++identifier;
              listeners.set(id, payload);
              return id;
            }
            if (_.startsWith("plugin:event|")) return;
            if (_ === "plugin:window|close") {
              state.windowCloses++;
              return;
            }
            if (_ === "watch_workspace") {
              if (payload.workspaceId) {
                state.watchStarts++;
                state.watchGeneration = payload.generation;
              }
              return watchAvailable;
            }
            state.calls.push(command + (args.path ? ":" + args.path : ""));
            state.actions.push({ command, args: structuredClone(args) });
            if (command === "history_auto_fetch") return false;
            if (command === "data_session")
              return { epoch: 0, wipeEpoch: 0, deletedWorkspaceIds: [] };
            if (command === "agent_settings")
              return structuredClone(state.agentSettings);
            if (command === "set_agent_settings") {
              if (args.update.expectedRevision !== state.agentSettings.revision)
                throw {
                  code: "AI_SETTINGS_CHANGED",
                  message: "Agent 设置已更新",
                  detail: "fixture CAS",
                };
              state.agentSettings = {
                revision: state.agentSettings.revision + 1,
                defaultProvider: args.update.defaultProvider,
                codex: args.update.codex,
                claudeCode: args.update.claudeCode,
                codewiz: args.update.codewiz ?? state.agentSettings.codewiz,
              };
              return structuredClone(state.agentSettings);
            }
            if (command === "probe_ai_agent")
              return {
                provider: args.provider,
                executablePath: args.options.executablePath ?? "/fixture/agent",
                version:
                  args.provider === "codex"
                    ? "codex-cli 0.153.4"
                    : "2.1.236 (Claude Code)",
                compatible: true,
                authenticated: state.agentAuthenticated,
                message: state.agentAuthenticated
                  ? "CLI 已就绪，已检测到现有登录。"
                  : "CLI 已找到，但当前没有可用登录。",
                detail: state.agentAuthenticated
                  ? "未调用模型。"
                  : args.provider === "codex"
                    ? "请在终端运行 codex login。"
                    : "请在终端运行 claude auth login。",
              };
            const reportStore = ((state as any).aiReports ??= JSON.parse(
              sessionStorage.getItem("proof-test-reports") ?? "{}",
            ));
            const reportScope = (report: any) =>
              report.scope.kind === "local"
                ? "local"
                : `comparison:${report.scope.base}:${report.scope.target}`;
            if (command === "ai_review_reports")
              return Object.values(reportStore)
                .filter(
                  (r: any) =>
                    r.scope.workspaceId === args.workspaceId &&
                    reportScope(r) === args.scope,
                )
                .sort((a: any, b: any) => b.capturedAt - a.capturedAt)
                .map((r: any) => ({
                  id: r.id,
                  capturedAt: r.capturedAt,
                  provider: r.provider,
                  summary: r.review.summary,
                }));
            if (command === "ai_review_report")
              return structuredClone(reportStore[args.reportId]);
            if (command === "set_ai_finding_decision") {
              const r = reportStore[args.reportId];
              if (r.revision !== args.expectedRevision)
                throw {
                  code: "AI_REVIEW_CHANGED",
                  message: "此 Review 已在其他窗口更新，请重新操作。",
                  detail: "fixture",
                };
              r.decisions[args.findingIndex] = args.decision;
              r.revision++;
              sessionStorage.setItem(
                "proof-test-reports",
                JSON.stringify(reportStore),
              );
              return structuredClone(r);
            }
            if (command === "agent_providers")
              return aiEnabled
                ? ["codex", "claude_code", ...(state.codewizEnabled ? ["codewiz"] : [])].map((id) => {
                    const options =
                      id === "codex"
                        ? state.agentSettings.codex
                        : id === "codewiz" ? state.agentSettings.codewiz : state.agentSettings.claudeCode;
                    return {
                      id,
                      name: id === "codex" ? "Codex" : id === "codewiz" ? "Codewiz" : "Claude Code",
                      available: true,
                      path:
                        options.executablePath ??
                        (id === "codex" ? "/fixture/codex" : "/fixture/claude"),
                      reason: null,
                      model: options.model,
                      isDefault: state.agentSettings.defaultProvider === id,
                    };
                  })
                : [];
            if (command === "open_diff_window") {
              (state as any).windowSelection = structuredClone(args.selection);
              return { label: "diff-fixture" };
            }
            if (command === "diff_window_context")
              return {
                selection: (state as any).windowSelection ?? {
                  kind: "comparison",
                  workspaceId: state.changes.workspace.id,
                  base: "a".repeat(40),
                  target: "b".repeat(40),
                  path: null,
                },
                changes: structuredClone(state.changes),
              };
            if (
              [
                "comparison_change_groups",
                "set_comparison_change_groups",
              ].includes(command)
            ) {
              const store = ((state as any).comparisonGroups ??= {}),
                key = `${args.base}:${args.target}`;
              const previous = store[key] ?? {
                revision: 0,
                groups: [],
                sourceToken: "",
              };
              if (command === "comparison_change_groups")
                return structuredClone(previous);
              if (previous.revision !== args.expectedRevision)
                throw {
                  code: "GROUPS_CHANGED",
                  message: "分组已更新",
                  detail: "fixture",
                };
              return structuredClone(
                (store[key] = {
                  revision: previous.revision + 1,
                  groups: args.groups,
                  sourceToken: `comparison:${args.base}:${args.target}`,
                }),
              );
            }
            if (command === "change_groups")
              return structuredClone(state.aiGroups);
            if (command === "set_change_groups") {
              if (args.expectedRevision !== state.aiGroups.revision)
                throw {
                  code: "GROUPS_CHANGED",
                  message: "分组已更新",
                  detail: "fixture",
                };
              state.aiGroups = {
                revision: state.aiGroups.revision + 1,
                groups: args.groups,
                sourceToken: args.expectedToken,
              };
              return structuredClone(state.aiGroups);
            }
            if (command === "run_ai_task") {
              if (!aiEnabled)
                throw new Error("Real AI is forbidden in fixtures");
              state.aiTicket = args._readTicket;
              const input = args.request,
                scope = input.scope;
              const files =
                scope.kind === "local"
                  ? (scope.files ?? state.changes.files)
                  : state.changes.files.filter(
                      (f) =>
                        f.side === "unstaged" &&
                        (!scope.path || f.path === scope.path) &&
                        (!scope.paths || scope.paths.includes(f.path)),
                    );
              const refs = files.map((f: any) => ({
                path: f.path,
                side: f.side,
                snapshotToken:
                  state.returnedDiffs[f.side + ":" + f.path]?.token ??
                  state.diffs[f.path].token,
                snapshotId:
                  scope.kind === "local"
                    ? "captured-other-uuid"
                    : (state.returnedDiffs[f.side + ":" + f.path]?.id ??
                      state.diffs[f.path].id),
              }));
              const first = files[0];
              const source =
                state.returnedDiffs[first.side + ":" + first.path] ??
                state.diffs[first.path];
              const line = source.hunks
                .flatMap((h: any) => h.lines)
                .find((l: any) => l.newLine && l.kind === "add");
              const report = {
                id: crypto.randomUUID(),
                revision: 0,
                decisions: input.task === "review" ? ["pending"] : [],
                provider: input.provider,
                task: input.task,
                scope,
                fingerprint: "fixture-snapshot",
                capturedAt: Date.now(),
                files: refs,
                groups:
                  input.task === "grouping"
                    ? [
                        {
                          title: "Authentication",
                          summary: "Request validation",
                          files: [...new Set(files.map((f: any) => f.path))],
                          risk: "medium",
                          reviewPriority: 1,
                        },
                      ]
                    : [],
                review:
                  input.task === "review"
                    ? {
                        summary: "Check boundary handling",
                        overallRisk: "high",
                        findings: [
                          {
                            severity: "high",
                            title: "Missing boundary validation",
                            description: "Input can bypass validation.",
                            file: first.path,
                            side: first.side,
                            line: line.newLine,
                            endLine: source.hunks
                              .flatMap((h: any) => h.lines)
                              .some((l: any) => l.newLine === line.newLine + 1)
                              ? line.newLine + 1
                              : line.newLine,
                            lineSide: "new",
                            suggestion: "Validate before handling.",
                          },
                        ],
                        behaviorChanges: ["Changes request validation"],
                        missingTests: ["Malformed input"],
                        reviewPriority: [first.path],
                      }
                    : null,
                limitations: ["Fixture Agent; no model was called."],
              };
              if (state.aiHold)
                await new Promise<void>((resolve, reject) => {
                  state.aiRelease = resolve;
                  state.aiReject = reject;
                });
              state.aiReject = null;
              if (input.task === "review") {
                reportStore[report.id] = structuredClone(report);
                sessionStorage.setItem(
                  "proof-test-reports",
                  JSON.stringify(reportStore),
                );
              }
              return report;
            }
            if (command === "preferences") return preferences;
            if (command === "recent_workspaces") return [changes.workspace];
            if (command === "open_workspace") return changes.workspace;
            if (command === "repository_layout")
              return {
                sidebarWidth: 280,
                contextWidth: 300,
                sidebarOpen: true,
                contextOpen: false,
              };
            if (command === "changes") return structuredClone(state.changes);
            if (command === "read_file_diff") {
              await new Promise((r) => setTimeout(r, state.delay));
              const diff = structuredClone(state.diffs[args.path]);
              diff.id += `:${++state.reads}`;
              diff.side = args.side;
              diff.base = `${state.changes.head ?? "unborn"}:${state.changes.branch ?? "detached"}`;
              if (!args.loadLarge && diff.patch.length > 1024 * 1024)
                return {
                  state: "deferred",
                  summary: {
                    workspaceId: diff.workspaceId,
                    path: diff.path,
                    oldPath: diff.oldPath,
                    side: diff.side,
                    base: diff.base,
                    capturedAt: Date.now(),
                    patchBytes: diff.patch.length,
                    reason: "patch_size",
                    canLoad: true,
                  },
                };
              state.returnedDiffs[diff.side + ":" + diff.path] =
                structuredClone(diff);
              return { state: "ready", diff };
            }
            if (command === "observer_file_context") return [];
            if (command === "context_overview")
              return {
                workspaceId: args.workspaceId,
                path: args.path,
                links: [],
                excludedCount: 0,
                historyCount: 0,
                hasMore: false,
              };
            if (command === "commit_graph") return graph;
            if (command === "compare_commit")
              return {
                baseOid:
                  graph.commits.find((c) => c.oid === args.oid)?.parents[
                    args.parent ?? 0
                  ] ?? "empty",
                targetOid: args.oid,
                files: state.changes.files.filter((f) => f.side === "unstaged"),
              };
            if (command === "compare_refs")
              return {
                baseOid: args.base,
                targetOid: args.target,
                files: state.changes.files.filter((f) => f.side === "unstaged"),
              };
            if (command === "diff_context")
              return {
                snapshotId: args.snapshotId,
                contextLines: args.contextLines ?? 3,
                fullFile: !!args.fullFile,
                gaps: [],
              };
            if (
              command === "read_compare_file" ||
              command === "mark_comparison_reviewed"
            ) {
              await new Promise((r) => setTimeout(r, state.delay));
              const diff = {
                ...structuredClone(state.diffs[args.path]),
                canStage: false,
                canStageHunks: false,
                canDiscard: false,
                canDiscardHunks: false,
              };
              state.returnedDiffs[diff.side + ":" + diff.path] =
                structuredClone(diff);
              const reviewKey = `${args.base}:${args.target}:${args.path}`;
              const marks = (state.comparisonMarks[reviewKey] ??= {});
              if (command === "mark_comparison_reviewed") {
                for (const hunk of diff.hunks)
                  if (!args.hunkId || hunk.id === args.hunkId)
                    marks[hunk.id] = args.reviewed ? "reviewed" : "unreviewed";
              }
              diff.hunks = diff.hunks.map((hunk) => ({
                ...hunk,
                reviewState: marks[hunk.id] ?? "unreviewed",
              }));
              if (command === "mark_comparison_reviewed") return null;
              if (!args.loadLarge && diff.patch.length > 1024 * 1024)
                return {
                  state: "deferred",
                  summary: {
                    workspaceId: diff.workspaceId,
                    path: diff.path,
                    oldPath: diff.oldPath,
                    side: diff.side,
                    base: args.base,
                    capturedAt: Date.now(),
                    patchBytes: diff.patch.length,
                    reason: "patch_size",
                    canLoad: true,
                  },
                };
              return { state: "ready", diff };
            }
            if (command === "history_repository_state")
              return {
                remotes: ["origin"],
                upstream: null,
                upstreamRemote: null,
                upstreamBranch: null,
                ahead: 0,
                behind: 0,
                operation: null,
                conflicts: [],
              };
            if (command === "branches")
              return [
                {
                  name: "main",
                  current: true,
                  remote: false,
                  oid: changes.head,
                },
                {
                  name: "feature/ui",
                  current: false,
                  remote: false,
                  oid: changes.head,
                },
              ];
            if (command === "switch_branch") {
              state.changes.branch = args.name;
              state.changes.token += ":branch";
              return {
                ok: true,
                message: `Switched to ${args.name}`,
                actualHead: state.changes.head,
                actualBranch: args.name,
                warning: null,
              };
            }
            if (command === "stage") {
              if (state.expireStage) {
                state.expireStage = false;
                throw {
                  code: "SNAPSHOT_EXPIRED",
                  message: "Expired",
                  detail: "fixture",
                };
              }
              return { ok: true, message: "Staged", warning: null };
            }
            if (command === "stage_files") {
              state.changes.files = state.changes.files.map((file) =>
                args.paths.includes(file.path) && file.side === args.side
                  ? {
                      ...file,
                      side: args.side === "staged" ? "unstaged" : "staged",
                    }
                  : file,
              );
              state.changes.token += ":stage";
              return {
                ok: true,
                message: `Stage ${args.paths.length}`,
                token: state.changes.token,
                warning: null,
              };
            }
            if (command === "commit_preview")
              return {
                id: "preview",
                workspaceId: changes.workspace.id,
                branch: state.changes.branch,
                head: state.changes.head,
                files: state.changes.files.filter(
                  (file) => file.side === "staged",
                ),
                reviewed: 0,
                total: 2,
                coverageComputed:
                  args.coverage !== false || preferences.strictReview,
                unreadFiles: [],
                indexFingerprint: "index",
                capturedAt: Date.now(),
                amend: !!args.amend,
                message: args.amend ? "Previous commit message" : "",
              };
            if (command === "commit") {
              if (state.failCommit)
                throw {
                  code: "COMMIT_FAILED",
                  message: "Commit failed",
                  detail: "Fixture Hook rejected",
                };
              state.changes.files = state.changes.files.filter(
                (file) => file.side !== "staged",
              );
              state.changes.token += ":commit";
              return {
                ok: true,
                message: "Commit complete",
                actualHead: state.changes.head,
                actualBranch: state.changes.branch,
                warning: null,
              };
            }
            if (command === "mark_reviewed") return;
            if (command === "worktrees") return [];
            if (command.startsWith("set_")) return;
            throw {
              code: "TEST_UNHANDLED",
              message: command,
              detail: JSON.stringify(args),
            };
          },
        },
      });
    },
    {
      changes,
      diffs,
      preferences: defaultPreferences,
      graph: demoGraphPage(),
      watchAvailable,
      aiEnabled,
    },
  );
  await page.goto("/");
  await page.locator(".recent-projects button").first().click();
  await expect(page.locator(".diff-file-header")).toContainText("requests.ts");
}

test("Changes focuses on Diff while Commit keeps staging and the draft in its own tab", async ({
  page,
}) => {
  await openFixture(page);
  await expect(page.getByLabel("Commit message")).toHaveCount(0);
  const initialFile = await page.locator(".diff-file-header").innerText();
  await openCommit(page);
  await page.getByLabel("Commit message").fill("Independent commit draft");
  await expect(page.locator(".commit-workspace")).toBeVisible();
  await page
    .getByRole("tab", { name: /本地变更/, exact: false })
    .filter({ has: page.locator(".tab-count") })
    .click();
  await expect(page.locator(".diff-file-header")).toHaveText(initialFile, {
    useInnerText: true,
  });
  await expect(page.getByLabel("Commit message")).not.toBeVisible();
  await openCommit(page);
  await expect(page.getByLabel("Commit message")).toHaveValue(
    "Independent commit draft",
  );
  await page.screenshot({
    path: ".artifacts/commit-tab-desktop.png",
    animations: "disabled",
  });
  const file = page
    .locator(".commit-workspace .tree-file")
    .filter({ hasText: "response.ts" })
    .first();
  await file.click();
  await page.getByRole("button", { name: "查看 Diff", exact: true }).click();
  await expect(page.locator(".diff-file-header")).toContainText("response.ts");
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter((a: any) =>
        ["stage", "stage_files", "commit"].includes(a.command),
      ),
    ),
  ).toEqual([]);
});

test("returning to a loaded file does not wait for another Git diff", async ({
  page,
}) => {
  await openFixture(page);
  await page
    .locator(".tree-file")
    .filter({ hasText: "response.ts" })
    .first()
    .click();
  await expect(page.locator(".diff-file-header")).toContainText("response.ts");
  await page.evaluate(() => {
    (window as any).fixture.delay = 1000;
  });
  await page
    .locator(".tree-file")
    .filter({ hasText: "requests.ts" })
    .first()
    .click();
  await expect(page.locator(".diff-file-header")).toContainText("requests.ts", {
    timeout: 300,
  });
  const calls = await page.evaluate(
    () =>
      (window as any).fixture.calls.filter(
        (s: string) => s === "read_file_diff:src/api/requests.ts",
      ).length,
  );
  expect(calls).toBe(1);
});

test("external edits refresh the selected diff without a manual refresh", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.changes.token = "external-save";
    f.diffs["src/api/requests.ts"].token = "external-save";
    f.diffs["src/api/requests.ts"].id = "external-save";
    f.diffs["src/api/requests.ts"].hunks[0].lines[0].content =
      "// external edit visible now";
  });
  await expect(page.locator(".diff-scroll")).toContainText(
    "external edit visible now",
    { timeout: 5500 },
  );
});

test("a late Review reply preserves a newer file version on the same Branch", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.reviewReplyRace = { pending: false, release: () => {} };
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (name === "proof_command" && payload.command === "mark_reviewed") {
        w.reviewReplyRace.pending = true;
        return new Promise<void>((resolve) => {
          w.reviewReplyRace.release = () => {
            w.reviewReplyRace.pending = false;
            resolve();
          };
        });
      }
      return original(name, payload);
    };
  });
  await page
    .getByRole("button", { name: /^标记已 Review：第/ })
    .first()
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).reviewReplyRace.pending))
    .toBe(true);
  // Git base stays the same. Only the file's content version changes while
  // the accepted Review request is waiting to return to the renderer.
  await page.evaluate(() => {
    const state = (window as any).fixture;
    state.changes.token = "new-content";
    state.changes.fileVersions = {
      "unstaged:src/api/requests.ts": "new-content",
    };
    const diff = state.diffs["src/api/requests.ts"];
    diff.id = "new-content";
    diff.token = "new-content";
    diff.hunks[0].lines[0].content = "// changed while Review was pending";
  });
  await page.getByRole("button", { name: "打开命令面板", exact: true }).click();
  await page
    .getByRole("dialog", { name: "命令面板", exact: true })
    .getByRole("option", { name: "刷新 Worktree", exact: true })
    .click();
  await expect(page.locator(".diff-scroll")).toContainText(
    "changed while Review was pending",
  );
  await page.evaluate(() => (window as any).reviewReplyRace.release());
  await page
    .getByRole("button", { name: "response.ts M", exact: true })
    .click();
  await expect(page.locator(".diff-file-header")).toContainText("response.ts");
  await page
    .getByRole("button", { name: "requests.ts M", exact: true })
    .click();
  await expect(page.locator(".diff-scroll")).toContainText(
    "changed while Review was pending",
  );
  await expect(
    page.getByRole("button", { name: /^标记已 Review：第/ }).first(),
  ).toHaveAttribute("aria-pressed", "false");
});

test("branch dropdown switches in place and ignores IME confirmation", async ({
  page,
}) => {
  await openFixture(page);
  await openCommit(page);
  await page.getByLabel("Commit message").fill("Keep this draft");
  await page.getByRole("combobox", { name: /切换 Branch/ }).click();
  await page.getByLabel("搜索 Branch").fill("feature/ui");
  await page.getByLabel("搜索 Branch").dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
    bubbles: true,
  });
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter(
        (action: any) => action.command === "switch_branch",
      ),
    ),
  ).toHaveLength(0);
  await page
    .locator(".branch-option")
    .filter({ hasText: "feature/ui" })
    .click();
  await expect(page.locator(".branch-picker")).toContainText("feature/ui");
  await expect(
    page.locator(".workspace-page").filter({ visible: true }),
  ).toContainText("本地变更");
  await expect(page.getByLabel("Commit message")).toHaveValue(
    "Keep this draft",
  );
});

test("tree selection stages only selected files and Commit bypasses Review", async ({
  page,
}) => {
  await openFixture(page);
  await page
    .getByRole("checkbox", {
      name: "选择 src/api/response.ts (unstaged)",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Stage 所选文件", exact: true })
    .click();
  await openCommit(page);
  await expect(page.locator(".composer-hint")).toContainText("2 staged");
  const action = await page.evaluate(() =>
    (window as any).fixture.actions.find(
      (action: any) => action.command === "stage_files",
    ),
  );
  expect(action.args.paths).toEqual(["src/api/response.ts"]);
  await page.getByLabel("Commit message").fill("Selected files");
  await page.locator(".composer-submit > button").first().click();
  await expect(page.locator(".composer-hint")).toContainText("0 staged");
  await expect(page.getByLabel("Commit message")).toHaveValue("");
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter(
        (action: any) => action.command === "mark_reviewed",
      ),
    ),
  ).toHaveLength(0);
});

test("Amend restores draft when unchecked and failed Commit preserves message", async ({
  page,
}) => {
  await openFixture(page);
  await openCommit(page);
  await page.getByLabel("Commit message").fill("Ordinary draft");
  await page.getByRole("checkbox", { name: /Amend/ }).check();
  await expect(page.getByLabel("Commit message")).toHaveValue(
    "Previous commit message",
  );
  await page.getByRole("checkbox", { name: /Amend/ }).uncheck();
  await expect(page.getByLabel("Commit message")).toHaveValue("Ordinary draft");
  await page.evaluate(() => {
    (window as any).fixture.failCommit = true;
  });
  await page.locator(".composer-submit > button").first().click();
  await expect(page.getByRole("alert").filter({hasText:/\S/})).toContainText("提交 failed");
  await expect(page.getByLabel("Commit message")).toHaveValue("Ordinary draft");
});

test("whole-file Review confirmation never follows a different live file", async ({
  page,
}) => {
  await openFixture(page);
  await page.getByRole("button", { name: "标记整个文件", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "标记整个文件已审查" });
  await expect(dialog).toContainText("src/api/requests.ts");
  await page.evaluate(() => {
    const state = (window as any).fixture;
    state.changes.files = state.changes.files.filter(
      (file: any) => file.path !== "src/api/requests.ts",
    );
    state.changes.token = "removed";
  });
  await expect(page.locator(".diff-file-header")).toContainText("response.ts", {
    timeout: 5000,
  });
  await expect(dialog).toContainText("src/api/requests.ts");
  await expect(
    dialog.getByRole("button", { name: "确认已审查全部内容" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter(
        (action: any) => action.command === "mark_reviewed",
      ),
    ),
  ).toHaveLength(0);
});

test("expired native snapshots reload once and allow a new explicit action", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    (window as any).fixture.expireStage = true;
  });
  await page
    .getByRole("button", { name: "Stage Hunk", exact: true })
    .first()
    .click();
  await expect(page.getByRole("alert").filter({hasText:/\S/})).toContainText("Diff 已更新");
  await expect(
    page.getByRole("button", { name: "Stage Hunk", exact: true }).first(),
  ).toBeEnabled();
  const calls = await page.evaluate(() =>
    (window as any).fixture.actions.filter(
      (action: any) => action.command === "read_file_diff",
    ),
  );
  expect(calls).toHaveLength(2);
  await page
    .getByRole("button", { name: "Stage Hunk", exact: true })
    .first()
    .click();
  const stages = await page.evaluate(() =>
    (window as any).fixture.actions.filter(
      (action: any) => action.command === "stage",
    ),
  );
  expect(stages).toHaveLength(2);
  expect(stages[0].args.snapshotId).not.toBe(stages[1].args.snapshotId);
});

test("file tree folds and filters paths; workflow fits desktop and narrow panels", async ({
  page,
}) => {
  await openFixture(page);
  await page.getByRole("button", { name: "api 文件夹", exact: true }).click();
  await expect(
    page.locator(".tree-file").filter({ hasText: "response.ts" }),
  ).toHaveCount(0);
  await page.getByLabel("搜索变化文件").fill("response.ts");
  await expect(
    page.locator(".tree-file").filter({ hasText: "response.ts" }),
  ).toBeVisible();
  await page.getByLabel("搜索变化文件").fill("");
  await page.getByRole("button", { name: "api 文件夹", exact: true }).click();
  await page.screenshot({
    animations: "disabled",
    path: ".artifacts/workflow-desktop-light.png",
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "深色", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "设置", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    path: ".artifacts/workflow-desktop-dark.png",
  });
  await page.getByRole("combobox", { name: /切换 Branch/ }).click();
  await expect(page.getByRole("dialog", { name: "切换 Branch" })).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: ".artifacts/workflow-branches-dark.png",
  });
  await page.getByLabel("搜索 Branch").press("Escape");
  await page.setViewportSize({ width: 640, height: 450 });
  await page.getByRole("button", { name: "显示文件栏", exact: true }).click();
  await expect(page.getByLabel("Commit message")).toHaveCount(0);
  await openCommit(page);
  await expect(page.getByLabel("Commit message")).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: ".artifacts/workflow-narrow.png",
  });
});

test("late context reply cannot evict the next workspace cache or show its error", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (payload?.command === "diff_context")
        return new Promise((resolve, reject) => {
          w.fixture.rejectContext = reject;
        });
      if (
        payload?.command === "open_workspace" &&
        payload.args.path === "/fixture-second"
      ) {
        w.fixture.changes.workspace = {
          ...w.fixture.changes.workspace,
          id: "second",
          repositoryId: "second",
          name: "Second",
          path: "/fixture-second",
        };
        for (const diff of Object.values(w.fixture.diffs) as any[])
          diff.workspaceId = "second";
      }
      return original(name, payload);
    };
  });
  await page
    .getByRole("button", { name: "Diff 阅读选项", exact: true })
    .click();
  await page
    .getByRole("button", { name: "增加一行上下文", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).fixture.rejectContext),
    )
    .toBe("function");
  await page.locator(".workspace-picker").click();
  await page.getByLabel("本地目录", { exact: true }).fill("/fixture-second");
  await page
    .getByRole("dialog", { name: "打开仓库", exact: true })
    .getByRole("button", { name: "打开仓库", exact: true })
    .click();
  await expect(page.locator(".workspace-picker")).toContainText("Second");
  await expect(page.locator(".diff-file-header")).toContainText("requests.ts");
  await page.evaluate(async () => {
    (window as any).fixture.rejectContext({
      code: "SNAPSHOT_EXPIRED",
      message: "OLD A request expired",
      detail: "old workspace",
    });
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await expect(page.getByRole("alert").filter({hasText:/\S/})).toHaveCount(0);
  const readsBefore = await page.evaluate(
    () =>
      (window as any).fixture.actions.filter(
        (action: any) =>
          action.command === "read_file_diff" &&
          action.args.path === "src/api/requests.ts",
      ).length,
  );
  await page
    .locator(".tree-file")
    .filter({ hasText: "response.ts" })
    .first()
    .click();
  await expect(page.locator(".diff-file-header")).toContainText("response.ts");
  await page
    .locator(".tree-file")
    .filter({ hasText: "requests.ts" })
    .first()
    .click();
  await expect(page.locator(".diff-file-header")).toContainText("requests.ts");
  expect(
    await page.evaluate(
      () =>
        (window as any).fixture.actions.filter(
          (action: any) =>
            action.command === "read_file_diff" &&
            action.args.path === "src/api/requests.ts",
        ).length,
    ),
  ).toBe(readsBefore);
});

async function editorFixture(page: Page) {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      state = w.fixture,
      original = w.__TAURI_INTERNALS__.invoke;
    const apps = [
      { name: "Zed", path: "/Applications/Zed.app", bundleId: "dev.zed.Zed" },
      {
        name: "Visual Studio Code",
        path: "/Applications/Visual Studio Code.app",
        bundleId: "com.microsoft.VSCode",
      },
    ];
    state.editor = {
      revision: 0,
      application: { mode: "disabled" },
      repository: { mode: "inherit" },
      effective: null,
      source: "application",
      platform: "macos",
    };
    function settings() {
      const choice =
        state.editor.repository.mode === "inherit"
          ? state.editor.application
          : state.editor.repository;
      return {
        ...state.editor,
        effective: choice.mode === "application" ? choice.application : null,
        source:
          state.editor.repository.mode === "inherit"
            ? "application"
            : "repository",
      };
    }
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      const { command, args } = payload;
      if (
        ![
          "editor_settings",
          "editor_applications",
          "set_editor_settings",
          "open_in_editor",
        ].includes(command)
      )
        return original(name, payload);
      state.actions.push({ command, args: structuredClone(args) });
      if (command === "editor_settings") return structuredClone(settings());
      if (command === "editor_applications") return apps;
      if (command === "set_editor_settings") {
        if (state.deferEditorSave)
          return new Promise((_, reject) => {
            state.rejectEditorSave = reject;
          });
        if (state.editorConflict)
          throw {
            code: "EDITOR_SETTINGS_CHANGED",
            message: "编辑器设置已在其他窗口更新，请重新读取。",
            detail: "revision mismatch",
          };
        const change = args.update;
        state.editor[change.scope] =
          change.mode === "application"
            ? {
                mode: "application",
                application: apps.find((app) => app.path === change.path),
              }
            : { mode: change.mode };
        state.editor.revision++;
        return structuredClone(settings());
      }
      if (state.deferEditorOpen)
        return new Promise((_, reject) => {
          state.rejectEditorOpen = reject;
        });
      const app = settings().effective;
      if (!app)
        throw {
          code: "EDITOR_NOT_CONFIGURED",
          message: "请选择外部编辑器。",
          detail: "No editor",
        };
      state.editorLaunched = true;
      return {
        application: app,
        path: state.changes.workspace.path + "/src/api/requests.ts",
        message: "已交给 " + app.name + " 打开 Worktree 文件",
      };
    };
  });
}
async function chooseEditor(page: Page) {
  await page
    .getByRole("button", { name: "在外部编辑器打开", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "外部编辑器", exact: true }),
  ).toBeVisible();
  await chooseOption(page
    .getByLabel("默认使用", { exact: true }),"application");
  await page.getByRole("button", { name: "Zed", exact: true }).click();
}

test("editor configuration is explicit, scoped, and only the open button launches", async ({
  page,
}) => {
  await editorFixture(page);
  await chooseEditor(page);
  expect(
    await page.evaluate(() => (window as any).fixture.editorLaunched ?? false),
  ).toBe(false);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".editor-settings-actions")).toContainText(
    "已保存",
  );
  await expect(page.locator(".editor-effective")).toContainText("Zed");
  expect(
    await page.evaluate(() => (window as any).fixture.editorLaunched ?? false),
  ).toBe(false);
  await page.screenshot({
    path: ".artifacts/editor-settings-light.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "设置", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "在外部编辑器打开", exact: true })
    .click();
  await expect(
    page.locator('[data-slot="toast"]').filter({ hasText: "已交给 Zed" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).fixture.editorLaunched),
  ).toBe(true);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("tab", { name: "外部编辑器", exact: true })
    .click();
  await page.getByRole("button", { name: "此仓库", exact: true }).click();
  await expect(page.getByLabel("此仓库使用", { exact: true })).toHaveAttribute("data-value","inherit");
  await chooseOption(page.getByLabel("此仓库使用", { exact: true }),"disabled");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".editor-effective")).toContainText("未启用");
  await expect(page.locator(".editor-effective")).toContainText(
    "此仓库覆盖应用默认",
  );
});

test("editor save conflict keeps draft, and a late failed save remains visible after closing", async ({
  page,
}) => {
  await editorFixture(page);
  await chooseEditor(page);
  await page.evaluate(() => {
    (window as any).fixture.editorConflict = true;
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".editor-error")).toContainText("其他窗口更新");
  await expect(page.getByLabel("编辑器路径", { exact: true })).toHaveValue(
    "/Applications/Zed.app",
  );
  await page.evaluate(() => {
    (window as any).fixture.editorConflict = false;
    (window as any).fixture.deferEditorSave = true;
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).fixture.rejectEditorSave),
    )
    .toBe("function");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "设置", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).fixture.rejectEditorSave({
      code: "STORAGE_ERROR",
      message: "磁盘不可写。",
      detail: "fixture",
    }),
  );
  await expect(page.getByRole("alert").filter({hasText:/\S/})).toContainText("编辑器设置未保存");
});

test("an editor launch failure stays visible when the same file refreshes in the background", async ({
  page,
}) => {
  await editorFixture(page);
  await page.evaluate(() => {
    (window as any).fixture.deferEditorOpen = true;
  });
  await page
    .getByRole("button", { name: "在外部编辑器打开", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).fixture.rejectEditorOpen),
    )
    .toBe("function");
  await page.evaluate(() => {
    (window as any).fixture.changes.token = "while-opening";
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).fixture.actions.filter(
            (action: any) => action.command === "read_file_diff",
          ).length,
      ),
    )
    .toBe(2);
  await page.evaluate(() =>
    (window as any).fixture.rejectEditorOpen({
      code: "EDITOR_LAUNCH_FAILED",
      message: "编辑器不可用。",
      detail: "fixture",
    }),
  );
  await expect(page.getByRole("alert").filter({hasText:/\S/})).toContainText(
    "无法打开 src/api/requests.ts",
  );
  await expect(
    page.getByRole("button", { name: "在外部编辑器打开", exact: true }),
  ).toBeEnabled();
});

test("editor Command is disabled in History and never uses hidden Changes content", async ({
  page,
}) => {
  await editorFixture(page);
  await page.evaluate((graph) => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (payload?.command === "commit_graph") return graph;
      if (payload?.command === "graph_commit_diff")
        return "diff --git a/history-only.txt b/history-only.txt\n--- a/history-only.txt\n+++ b/history-only.txt\n@@ -1 +1 @@\n-old\n+new\n";
      return original(name, payload);
    };
  }, demoGraphPage());
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "所选提交详情", exact: true }),
  ).toContainText(demoGraphPage().commits[0].subject);
  await page.getByRole("button", { name: "打开命令面板", exact: true }).click();
  const command = page
    .getByRole("dialog", { name: "命令面板", exact: true })
    .getByRole("option", { name: /在外部编辑器打开/ });
  await expect(command).toBeDisabled();
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter(
        (action: any) => action.command === "open_in_editor",
      ),
    ),
  ).toHaveLength(0);
});

test("editor Command keeps its displayed file target when live Changes moves to another file", async ({
  page,
}) => {
  await editorFixture(page);
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.editor.application = {
      mode: "application",
      application: {
        name: "Zed",
        path: "/Applications/Zed.app",
        bundleId: "dev.zed.Zed",
      },
    };
  });
  await page.getByRole("button", { name: "打开命令面板", exact: true }).click();
  const command = page
    .getByRole("dialog", { name: "命令面板", exact: true })
    .getByRole("option", { name: /在外部编辑器打开/ });
  await expect(command).toContainText("src/api/requests.ts");
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.changes.files = f.changes.files.filter(
      (file: any) => file.path !== "src/api/requests.ts",
    );
    f.changes.token = "moved-selection";
  });
  await expect(page.locator(".diff-file-header")).toContainText("response.ts");
  await expect(command).toContainText("src/api/requests.ts");
  await command.click();
  const [request] = await page.evaluate(() =>
    (window as any).fixture.actions.filter(
      (action: any) => action.command === "open_in_editor",
    ),
  );
  expect(request.args.snapshotId).toContain("src/api/requests.ts");
});

async function dataFixture(page: Page) {
  await openFixture(page);
  await page.evaluate((defaults) => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke,
      base = w.fixture.changes.workspace;
    const cleanup = {
      pendingContentDeletions: 0,
      contentCleanupError: null,
      walCheckpointComplete: true,
      databaseCompactionPending: false,
    };
    const state = (w.dataFixture = {
      epoch: 0,
      wipeEpoch: 0,
      deleted: [] as string[],
      hidden: [] as string[],
      calls: [] as any[],
      holdDelete: false,
      plan: null as any,
      catalog: [
        base,
        {
          ...base,
          id: "linked-workspace",
          name: "linked",
          path: "/fixture/linked",
        },
        {
          ...base,
          id: "other-workspace",
          repositoryId: "other-repository",
          name: "Other project",
          path: "/fixture/other",
        },
      ],
    });
    const session = () => ({
      epoch: state.epoch,
      wipeEpoch: state.wipeEpoch,
      deletedWorkspaceIds: state.deleted,
    });
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (name !== "proof_command") return original(name, payload);
      const { command, args } = payload;
      if (command === "data_session") return session();
      if (args._dataEpoch !== state.epoch)
        throw {
          code: "DATA_EPOCH_CHANGED",
          message: "Records changed",
          detail: "fixture",
        };
      const known = [
        "preferences",
        "recent_workspaces",
        "data_workspaces",
        "data_usage",
        "remove_recent_workspace",
        "prepare_data_deletion",
        "cancel_data_deletion",
        "delete_local_data",
        "maintain_local_data",
      ];
      if (!known.includes(command)) return original(name, payload);
      state.calls.push({ command, args: structuredClone(args) });
      if (command === "preferences") return defaults;
      if (command === "recent_workspaces")
        return state.catalog.filter(
          (item: any) => !state.hidden.includes(item.id),
        );
      if (command === "data_workspaces")
        return state.catalog.map((workspace: any) => ({
          workspace,
          recent: !state.hidden.includes(workspace.id),
        }));
      if (command === "data_usage")
        return {
          applicationBytes: 1048576,
          applicationBytesLowerBound: false,
          softLimitBytes: 2147483648,
          observerEvents: state.catalog.length ? 12 : 0,
          observerSessions: 3,
          observationPayloadBytes: 1024,
          contentCollectionPaused: false,
          cleanupPending: false,
          databaseCompactionPending: false,
          outputRetentionDays: 7,
          observationRetentionDays: 30,
          reviewRetentionDays: 180,
          activeObserverScopes: 0,
          pendingContentDeletions: 0,
          contentCleanupError: null,
        };
      if (command === "remove_recent_workspace") {
        state.hidden.push(args.workspaceId);
        return;
      }
      if (command === "prepare_data_deletion")
        return (state.plan = {
          id: "data-preview",
          scope: args.scope,
          workspaces: state.catalog.filter(
            (item: any) =>
              args.scope.kind === "all" ||
              item.repositoryId === args.scope.repositoryId,
          ),
          capturedAt: Date.now(),
          counts: {
            observerEvents: 12,
            reviewRecords: 4,
            operations: 2,
            recoveryPoints: 1,
            recoveryBytes: 4096,
          },
        });
      if (command === "cancel_data_deletion") {
        state.plan = null;
        return;
      }
      if (command === "delete_local_data") {
        if (state.holdDelete)
          await new Promise<void>((resolve) => {
            state.finishDelete = resolve;
          });
        const all = state.plan.scope.kind === "all",
          removed = state.plan.workspaces.map((item: any) => item.id);
        ++state.epoch;
        state.deleted = all ? [] : [...state.deleted, ...removed];
        if (all) state.wipeEpoch = state.epoch;
        state.catalog = state.catalog.filter(
          (item: any) => !removed.includes(item.id),
        );
        return {
          session: session(),
          deletedWorkspaceIds: removed,
          all,
          cleanup,
          cleanupError: null,
        };
      }
      return cleanup;
    };
  }, defaultPreferences);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("tab", { name: "本地数据", exact: true })
    .click();
  await expect(page.locator(".data-usage-card")).toBeVisible();
}

test("data: removing a recent project keeps its records and current diff", async ({
  page,
}) => {
  await dataFixture(page);
  await page.evaluate(() =>
    localStorage.setItem("proof:draft:workflow-test", "keep draft"),
  );
  await page
    .getByRole("button", { name: "从最近项目移除", exact: true })
    .click();
  await expect(page.locator(".data-notice")).toContainText("保留");
  await expect(
    page.getByRole("button", { name: "从最近项目移除", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => ({
      draft: localStorage.getItem("proof:draft:workflow-test"),
      count: (window as any).dataFixture.catalog.length,
      epoch: (window as any).dataFixture.epoch,
    })),
  ).toEqual({ draft: "keep draft", count: 3, epoch: 0 });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".diff-file-header")).toContainText("requests.ts");
});

test("data: repository deletion previews linked Worktrees, cancels, and clears only their drafts", async ({
  page,
}) => {
  await dataFixture(page);
  await page.evaluate(() => {
    localStorage.setItem("proof:draft:workflow-test", "PRIVATE draft");
    localStorage.setItem("proof:draft:linked-workspace", "PRIVATE linked");
    localStorage.setItem("proof:draft:other-workspace", "keep other");
  });
  await page
    .getByRole("button", { name: "查看此仓库的删除范围…", exact: true })
    .click();
  const confirmation = page.getByRole("group", {
    name: "确认删除 Proof 记录",
    exact: true,
  });
  await expect(confirmation).toContainText("/fixture/linked");
  await expect(confirmation).not.toContainText("/fixture/other");
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).dataFixture.epoch)).toBe(0);
  await page
    .getByRole("button", { name: "查看此仓库的删除范围…", exact: true })
    .click();
  await page.screenshot({
    path: ".artifacts/data-delete-preview-light.png",
    animations: "disabled",
  });
  await confirmation
    .getByRole("button", { name: "删除 Proof 记录", exact: true })
    .click();
  await expect(page.locator(".diff-file-header")).toHaveCount(0);
  await page.getByLabel("查看范围", {exact:true}).click();
  await expect(page.getByRole("listbox").getByRole("option",{name:"Other project",exact:false})).toBeVisible();
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => [
      localStorage.getItem("proof:draft:workflow-test"),
      localStorage.getItem("proof:draft:linked-workspace"),
      localStorage.getItem("proof:draft:other-workspace"),
    ]),
  ).toEqual([null, null, "keep other"]);
});

test("data: completing deletion after Settings closes still clears the renderer and all Proof drafts", async ({
  page,
}) => {
  await dataFixture(page);
  await page.evaluate(() => {
    (window as any).dataFixture.holdDelete = true;
    localStorage.setItem("proof:draft:orphan", "PRIVATE orphan");
    localStorage.setItem("unrelated-key", "keep unrelated");
    localStorage.setItem("proof:file-view", "list");
  });
  await chooseOption(page.getByLabel("查看范围", { exact: true }),"");
  await page
    .getByRole("button", { name: "查看全部删除范围…", exact: true })
    .click();
  await page
    .getByRole("button", { name: "删除 Proof 记录", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).dataFixture.finishDelete),
    )
    .toBe("function");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".diff-file-header")).toBeVisible();
  await page.evaluate(() => (window as any).dataFixture.finishDelete());
  await expect(page.locator(".diff-file-header")).toHaveCount(0);
  await expect(page.locator(".data-usage-card")).toBeVisible();
  expect(
    await page.evaluate(() => [
      localStorage.getItem("proof:draft:orphan"),
      localStorage.getItem("unrelated-key"),
      localStorage.getItem("proof:data-wipe:1"),
      localStorage.getItem("proof:file-view"),
    ]),
  ).toEqual([null, "keep unrelated", "1", null]);
});

test("data: startup completes a deletion whose renderer never acknowledged it", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    localStorage.setItem("proof:draft:workflow-test", "PRIVATE old draft");
    localStorage.setItem("proof:draft:other-workspace", "keep other");
  });
  await page.addInitScript(() => {
    const w = window as any;
    const wrap = (bridge: any) => {
      const original = bridge.invoke;
      bridge.invoke = (name: string, payload: any) => {
        if (name === "proof_command" && payload.command === "data_session")
          return Promise.resolve({
            epoch: 1,
            wipeEpoch: 0,
            deletedWorkspaceIds: ["workflow-test"],
          });
        if (name === "proof_command" && payload.command === "recent_workspaces")
          return Promise.resolve([]);
        return original(name, payload);
      };
      return bridge;
    };
    let bridge = w.__TAURI_INTERNALS__;
    if (bridge) bridge = wrap(bridge);
    Object.defineProperty(w, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => bridge,
      set: (value) => {
        bridge = wrap(value);
      },
    });
  });
  await page.reload();
  await expect(page.locator(".recent-projects button")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("proof:draft:workflow-test")),
    )
    .toBeNull();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("proof:draft:other-workspace"),
    ),
  ).toBe("keep other");
});

test("standards old queued preferences cannot borrow the deletion epoch", async ({
  page,
}) => {
  await dataFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      orig = w.__TAURI_INTERNALS__.invoke;
    w.prefWrites = [];
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (name === "proof_command" && payload.command === "set_preferences") {
        if (payload.args._dataEpoch !== w.dataFixture.epoch)
          throw {
            code: "DATA_EPOCH_CHANGED",
            message: "stale",
            detail: "fixture",
          };
        w.prefWrites.push(structuredClone(payload.args));
        if (w.prefWrites.length === 1)
          return new Promise((resolve) => {
            w.finishOldPreferences = resolve;
          });
        return null;
      }
      return orig(name, payload);
    };
  });
  await page
    .locator(".settings-nav")
    .getByRole("tab", { name: "外观与阅读", exact: true })
    .click();
  await page.getByRole("button", { name: "深色", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).finishOldPreferences),
    )
    .toBe("function");
  await page.getByRole("button", { name: "浅色", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("tab", { name: "本地数据", exact: true })
    .click();
  await chooseOption(page.getByLabel("查看范围", { exact: true }),"");
  await page
    .getByRole("button", { name: "查看全部删除范围…", exact: true })
    .click();
  await page
    .getByRole("button", { name: "删除 Proof 记录", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).dataFixture.epoch))
    .toBe(1);
  await expect(page.locator(".diff-file-header")).toHaveCount(0);
  await page.evaluate(async () => {
    (window as any).finishOldPreferences(null);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  const writes = await page.evaluate(() => (window as any).prefWrites);
  console.log("old queued preference writes", JSON.stringify(writes));
  expect(writes).toHaveLength(1);
});

test("standards delayed deletion cannot roll back the session and erase new drafts", async ({
  page,
}) => {
  await openFixture(page);
  const actual = await page.evaluate(async () => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    let epoch = 0,
      firstResolve: any;
    const session = () => ({
      epoch,
      wipeEpoch: epoch === 2 ? 2 : 0,
      deletedWorkspaceIds: [],
    });
    const cleanup = {
      pendingContentDeletions: 0,
      walCheckpointComplete: true,
      databaseCompactionPending: false,
    };
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (name !== "proof_command") return original(name, payload);
      if (payload.command === "data_session") return session();
      if (payload.args._dataEpoch !== epoch)
        throw {
          code: "DATA_EPOCH_CHANGED",
          message: "stale",
          detail: "fixture",
        };
      if (payload.command === "delete_local_data") {
        epoch++;
        const result = {
          session: session(),
          deletedWorkspaceIds: [],
          all: epoch === 2,
          cleanup,
          cleanupError: null,
        };
        if (epoch === 1)
          return new Promise((resolve) => {
            firstResolve = () => resolve(result);
          });
        return result;
      }
      if (payload.command === "recent_workspaces") return [];
      return original(name, payload);
    };
    const { request } = await import("/src/api.ts");
    const first = request("delete_local_data", { previewId: "first" });
    while (!firstResolve)
      await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      await request("preferences");
    } catch {}
    await request("delete_local_data", { previewId: "second" });
    localStorage.setItem("proof:draft:v2:fresh-after-delete", "new user work");
    firstResolve();
    await first.catch(() => {});
    return {
      draft: localStorage.getItem("proof:draft:v2:fresh-after-delete"),
      wipe: (await import("/src/client-storage.ts")).readClientWipeEpoch(),
    };
  });
  console.log("delayed deletion state", JSON.stringify(actual));
  expect(actual).toEqual({ draft: "new user work", wipe: 2 });
});

test("standards automatic restoration after deletion must not replace a newer workspace selection", async ({
  page,
}) => {
  await dataFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    let held = false;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (name !== "proof_command") return original(name, payload);
      const { command, args } = payload;
      if (
        command === "changes" &&
        args._dataEpoch === 1 &&
        args.workspaceId === "workflow-test" &&
        !held
      ) {
        held = true;
        const value = structuredClone(w.fixture.changes);
        return new Promise((resolve) => {
          w.finishOldRestore = () => resolve(value);
        });
      }
      if (command === "open_workspace" && args.path === "/fixture/linked")
        return w.dataFixture.catalog.find(
          (entry: any) => entry.id === "linked-workspace",
        );
      if (command === "changes" && args.workspaceId === "linked-workspace")
        return {
          ...structuredClone(w.fixture.changes),
          workspace: w.dataFixture.catalog.find(
            (entry: any) => entry.id === "linked-workspace",
          ),
        };
      const value = await original(name, payload);
      if (command === "read_file_diff")
        value.diff.workspaceId = args.workspaceId;
      return value;
    };
  });
  await chooseOption(page
    .getByLabel("查看范围", { exact: true }),"other-workspace");
  await page
    .getByRole("button", { name: "查看此仓库的删除范围…", exact: true })
    .click();
  await page
    .getByRole("button", { name: "删除 Proof 记录", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).finishOldRestore))
    .toBe("function");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .locator(".recent-projects button")
    .filter({ hasText: "/fixture/linked" })
    .click();
  await expect(page.locator(".workspace-picker")).toContainText("linked");
  await expect(page.locator(".diff-file-header")).toContainText("requests.ts");
  await page.evaluate(async () => {
    (window as any).finishOldRestore();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await expect(page.locator(".workspace-picker")).toContainText("linked");
});

test("standards peer window wipe marker must not be rolled back by a late session", async ({
  page,
}) => {
  await openFixture(page);
  const actual = await page.evaluate(async () => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    let provideSession: any,
      first = true;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (name !== "proof_command") return original(name, payload);
      if (payload.command === "preferences" && first) {
        first = false;
        throw {
          code: "DATA_EPOCH_CHANGED",
          message: "deleted",
          detail: "fixture",
        };
      }
      if (payload.command === "data_session")
        return new Promise((resolve) => {
          provideSession = () =>
            resolve({ epoch: 1, wipeEpoch: 1, deletedWorkspaceIds: [] });
        });
      return original(name, payload);
    };
    const { request } = await import("/src/api.ts");
    const pending = request("preferences").catch(() => {});
    while (!provideSession)
      await new Promise((resolve) => setTimeout(resolve, 1));
    // A peer renderer has already handled the later global wipe and saved new work.
    localStorage.setItem("proof:data-wipe-epoch", "2");
    localStorage.setItem("proof:draft:peer-new-work", "new work after wipe 2");
    provideSession();
    await pending;
    return {
      wipe: localStorage.getItem("proof:data-wipe-epoch"),
      draft: localStorage.getItem("proof:draft:peer-new-work"),
    };
  });
  console.log("peer wipe after late session", JSON.stringify(actual));
  expect(actual).toEqual({ wipe: "2", draft: "new work after wipe 2" });
});

async function expectJoinedGraphRows(rows: Locator) {
  const geometry = await rows.evaluateAll((elements) =>
    elements.map((element) => {
      const svg = element.querySelector("svg.graph-lanes") as SVGSVGElement;
      const node = svg.querySelector(".graph-node") as SVGCircleElement;
      const rect = element.getBoundingClientRect();
      return {
        index: Number(element.getAttribute("aria-posinset")),
        height: rect.height,
        svgHeight: svg.getBoundingClientRect().height,
        nodeOffset:
          node.getBoundingClientRect().top +
          node.getBoundingClientRect().height / 2 -
          rect.top,
        edges: [...svg.querySelectorAll("path")].map((path) => {
          const bounds = path.getBBox(),
            length = path.getTotalLength();
          const start = path.getPointAtLength(0),
            end = path.getPointAtLength(length);
          return {
            top: bounds.y,
            bottom: bounds.y + bounds.height,
            start: { x: start.x, y: start.y },
            end: { x: end.x, y: end.y },
            // Curves must meet the adjacent vertical segments with vertical tangents.
            startDx: path.getPointAtLength(0.1).x - start.x,
            endDx: end.x - path.getPointAtLength(length - 0.1).x,
            color: getComputedStyle(path).color,
          };
        }),
      };
    }),
  );
  for (const [index, row] of geometry.entries()) {
    expect(row.svgHeight).toBe(row.height);
    expect(row.nodeOffset).toBeCloseTo(row.height / 2);
    for (const edge of row.edges) {
      expect(edge.top).toBeGreaterThanOrEqual(0);
      expect(edge.bottom).toBeLessThanOrEqual(row.height);
      expect(Math.abs(edge.startDx)).toBeLessThan(0.05);
      expect(Math.abs(edge.endDx)).toBeLessThan(0.05);
    }
    const next = geometry[index + 1];
    if (next?.index !== row.index + 1) continue;
    const leaving = row.edges
      .filter((edge) => Math.abs(edge.end.y - row.height) < 0.01)
      .map((edge) => `${Math.round(edge.end.x)}:${edge.color}`);
    const entering = next.edges
      .filter((edge) => Math.abs(edge.start.y) < 0.01)
      .map((edge) => `${Math.round(edge.start.x)}:${edge.color}`);
    expect(
      [...new Set(leaving)].sort(),
      `continuous lanes between rows ${row.index} and ${next.index}`,
    ).toEqual([...new Set(entering)].sort());
  }
}

test("History graph keeps fork and merge edges joined and visible through selection", async ({
  page,
}) => {
  await openFixture(page);
  const parents = [[1], [2], [3], [7], [6, 5], [6], [7], [8], []];
  const graphPage = {
    ...demoGraphPage(),
    branches: [],
    commits: parents.map((links, index) => ({
      oid: String(index + 1).padStart(40, "0"),
      parents: links.map((parent) => String(parent + 1).padStart(40, "0")),
      subject: [
        "main tip",
        "main work",
        "main tests",
        "main setup",
        "merge feature",
        "feature work",
        "branch base",
        "shared base",
        "root",
      ][index],
      author: "Graph fixture",
      date: "2026-09-15T00:00:00Z",
      refs: "",
    })),
  };
  await page.evaluate((graphPage) => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) =>
      payload?.command === "commit_graph" ? graphPage : original(name, payload);
  }, graphPage);
  await page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("tab", { name: "History", exact: true })
    .click();
  const graph = page.getByRole("listbox", { name: "提交列表与分支关系" });
  const rows = graph.getByRole("option");
  await expect(rows).toHaveCount(parents.length);
  const paths = () =>
    graph
      .locator(".graph-lanes path")
      .evaluateAll((paths) => paths.map((path) => path.getAttribute("d")));
  const before = await paths();
  await rows.nth(7).click();
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: ".artifacts/graph-connections/selected-light.png",
    animations: "disabled",
  });
  // Test actual painting, not only whether a path remains in the DOM. An edge
  // overflowing its SVG used to be covered by the following row's background.
  const incomingBranch = rows.nth(6).locator(".graph-lanes path").last();
  const painted = () =>
    incomingBranch.evaluate((element) => {
      const path = element as SVGPathElement;
      const point = path.getPointAtLength(path.getTotalLength() * 0.85);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(
        path.getScreenCTM()!,
      );
      return document.elementFromPoint(screen.x, screen.y) === path;
    });
  expect(
    await painted(),
    "selected parent must not cover its incoming branch",
  ).toBe(true);
  expect(await paths()).toEqual(before);
  await expectJoinedGraphRows(rows);
  await rows.nth(7).hover();
  expect(await painted(), "hover must preserve the incoming branch").toBe(true);
  await graph.press("ArrowUp");
  await expect(rows.nth(6)).toHaveAttribute("aria-selected", "true");
  expect(await paths()).toEqual(before);
  await graph.press("ArrowDown");
  await expect(rows.nth(7)).toHaveAttribute("aria-selected", "true");
  expect(await painted()).toBe(true);
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "dark"),
  );
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: ".artifacts/graph-connections/selected-dark.png",
    animations: "disabled",
  });
  expect(await painted()).toBe(true);
});

test("History graph preserves connected lanes across virtual scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await openFixture(page);
  const graphPage = demoGraphPage();
  // Repeat a fork/merge history with distinct OIDs so the list must virtualize.
  const commits = Array.from({ length: 10 }, (_, segment) =>
    graphPage.commits.map((commit) => ({
      ...commit,
      oid: `${segment}${commit.oid.slice(1)}`,
      parents: commit.parents.map((oid) => `${segment}${oid.slice(1)}`),
      refs: "",
    })),
  ).flat();
  await page.evaluate(
    ({ graphPage, commits }) => {
      const w = window as any,
        original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) =>
        payload?.command === "commit_graph"
          ? { ...graphPage, commits, branches: [] }
          : original(name, payload);
    },
    { graphPage, commits },
  );
  await page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("tab", { name: "History", exact: true })
    .click();
  const graph = page.getByRole("listbox", { name: "提交列表与分支关系" });
  const rows = graph.getByRole("option");
  await rows.first().click();
  await expectJoinedGraphRows(rows);
  await graph.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await expect
    .poll(async () => Number(await rows.last().getAttribute("aria-posinset")))
    .toBeGreaterThan(150);
  expect(await rows.count()).toBeLessThan(60);
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  await expectJoinedGraphRows(rows);
  await graph.press("End");
  await expect(rows.last()).toHaveAttribute("aria-posinset", "300");
  await expect(rows.last()).toHaveAttribute("aria-selected", "true");
  await expectJoinedGraphRows(rows);
  await graph.press("Home");
  await expect(rows.first()).toHaveAttribute("aria-posinset", "1");
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  await expectJoinedGraphRows(rows);
});

test("History opens selected Commit diffs in closable tabs and preserves graph selection", async ({
  page,
}) => {
  await openFixture(page);
  const navigation = page.getByRole("navigation", { name: "Worktree" });
  await expect(
    navigation.getByRole("button", { name: "Compare", exact: true }),
  ).toHaveCount(0);
  await navigation
    .getByRole("tab", { name: "History", exact: true })
    .click();
  const graph = page.getByRole("listbox", { name: "提交列表与分支关系" });
  await graph.getByRole("option").first().click();
  await expect(page.locator(".diff-tab-item")).toHaveCount(0);
  await graph.getByRole("option").first().dblclick();
  const active = page.locator(".diff-tab-page:not([hidden])"),
    panel = active.getByRole("region", { name: "历史文件差异" });
  await expect(panel.locator(".diff-scroll")).toContainText("validateRequest");
  await expect(
    active.getByRole("combobox", { name: "Diff 比较父提交" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回 History", exact: true }).click();
  await graph
    .getByRole("option")
    .nth(2)
    .click({ modifiers: ["Meta"] });
  await expect(page.locator(".diff-tab-item")).toHaveCount(2);
  await expect(panel.locator(".diff-scroll")).toContainText("validateRequest");
  await panel.getByRole("button", { name: "并排视图", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: /Stage|预览丢弃/ }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "交换比较方向" }).click();
  await expect(panel.locator(".diff-scroll")).toContainText("validateRequest");
  const requests = await page.evaluate(() =>
    (window as any).fixture.actions.filter(
      (a: any) => a.command === "compare_refs",
    ),
  );
  expect(requests.at(-1).args.base).toBe(requests.at(-2).args.target);
  await page.screenshot({ path: ".artifacts/history-diff-tab-desktop.png" });
  await page.getByRole("button", { name: "返回 History", exact: true }).click();
  await expect(graph.getByRole("option", { selected: true })).toHaveCount(2);
  await expect(
    page.getByRole("region", { name: "Git 提交图" }).locator(".diff-scroll"),
  ).toHaveCount(0);
  await graph.getByRole("option").first().click();
  await chooseOption(page
    .getByRole("combobox", { name: "比较父提交", exact: true }),"1");
  await page
    .getByRole("button", { name: "在新 tab 中查看 Diff", exact: true })
    .click();
  await expect(page.locator(".diff-tab-item")).toHaveCount(2);
  await expect(
    active.getByRole("combobox", { name: "Diff 比较父提交" }),
  ).toHaveAttribute("data-value","1");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).fixture.actions
            .filter((a: any) => a.command === "compare_commit")
            .at(-1).args.parent,
      ),
    )
    .toBe(1);
  await page.locator(".diff-tab-item.active .diff-tab-close").click();
  await expect(
    navigation.getByRole("tab", { name: "History", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter((a: any) =>
        [
          "stage",
          "stage_files",
          "commit",
          "switch_branch",
          "mark_reviewed",
        ].includes(a.command),
      ),
    ),
  ).toEqual([]);
});

test("Diff tabs remain closable in a narrow window and return focus to History", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await openFixture(page);
  const history = page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("tab", { name: "History", exact: true });
  const graph = page.getByRole("listbox", { name: "提交列表与分支关系" });
  for (let index = 0; index < 6; index++) {
    await history.click();
    await graph.getByRole("option").nth(index).dblclick();
    const close = page.locator(".diff-tab-item.active .diff-tab-close");
    await expect(close).toBeInViewport({ ratio: 1 });
  }
  await expect(page.locator(".diff-tab-item")).toHaveCount(6);
  for (const width of [660, 1440, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(
      page.locator(".diff-tab-item.active .diff-tab-close"),
    ).toBeInViewport({ ratio: 1 });
  }
  await page.locator(".diff-tab-item.active .diff-tab-close").click();
  await expect(history).toHaveAttribute("aria-current", "page");
  await expect(history).toBeFocused();
  await expect(graph.getByRole("option").nth(5)).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("Desktop chrome reserves native controls and supports document tab shortcuts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "platform", { value: "MacIntel" }),
  );
  await openFixture(page);
  const toolbar = page.locator(".desktop-toolbar");
  const navigation = page.getByRole("navigation", { name: "Worktree" });
  const toolbarBox = (await toolbar.boundingBox())!;
  const tabsBox = (await navigation.boundingBox())!;
  expect(tabsBox.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height);
  expect(
    (await toolbar.locator(".brand").boundingBox())!.x,
  ).toBeGreaterThanOrEqual(88);
  expect(
    (await toolbar.locator(".window-drag-space").boundingBox())!.width,
  ).toBeGreaterThanOrEqual(36);
  await expect(toolbar.locator("button[data-tauri-drag-region]")).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "深色", exact: true }).click();
  await page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "设置", exact: true }),
  ).toBeHidden();
  await page.screenshot({
    path: ".artifacts/proof-desktop-changes-dark.png",
    animations: "disabled",
  });
  await page.keyboard.press("Meta+3");
  const history = navigation.getByRole("tab", {
    name: "History",
    exact: true,
  });
  await expect(history).toHaveAttribute("aria-current", "page");
  const graph = page.getByRole("listbox", { name: "提交列表与分支关系" });
  await expect(graph.getByRole("option").first()).toBeVisible();
  await page.screenshot({
    path: ".artifacts/proof-desktop-history-dark.png",
    animations: "disabled",
  });
  await graph.getByRole("option").first().dblclick();
  await page.keyboard.press("Meta+p");
  const diff = page.locator(".diff-tab-page:not([hidden])");
  await expect(
    diff.getByRole("textbox", { name: "搜索变化文件" }),
  ).toBeFocused();
  await page.evaluate(() =>
    (window as any).fixture.emitNativeEvent("proof:close-active-view"),
  );
  await expect(history).toBeFocused();
  await expect(history).toHaveAttribute("aria-current", "page");
  await graph.getByRole("option").first().dblclick();
  await page
    .locator(".diff-tab-item.active .diff-tab-button")
    .click({ button: "middle" });
  await expect(page.locator(".diff-tab-item")).toHaveCount(0);
  await history.press("ArrowLeft");
  await expect(
    navigation.getByRole("tab", { name: /^Commit/ }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    navigation.getByRole("tab", { name: /^Commit/ }),
  ).toHaveAttribute("aria-current", "page");
  await page
    .getByLabel("Commit message")
    .fill("Keep this draft while switching views");
  await page.keyboard.press("Meta+3");
  await expect(history).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Meta+2");
  await expect(page.getByLabel("Commit message")).toBeFocused();
  await expect(page.getByLabel("Commit message")).toHaveValue(
    "Keep this draft while switching views",
  );
  expect(await page.evaluate(() => (window as any).fixture.windowCloses)).toBe(
    0,
  );
  await page.evaluate(() =>
    (window as any).fixture.emitNativeEvent("proof:close-active-view"),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).fixture.windowCloses))
    .toBe(1);
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter((a: any) =>
        [
          "stage",
          "stage_files",
          "commit",
          "switch_branch",
          "mark_reviewed",
        ].includes(a.command),
      ),
    ),
  ).toEqual([]);
});

test("Non-macOS document shortcut closes only the active Diff", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "platform", { value: "Win32" }),
  );
  await openFixture(page);
  const history = page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("tab", { name: "History", exact: true });
  await history.click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  await page.keyboard.press("Control+w");
  await expect(page.locator(".diff-tab-item")).toHaveCount(0);
  await expect(history).toBeFocused();
  expect(await page.evaluate(() => (window as any).fixture.windowCloses)).toBe(
    0,
  );
});

test("Branch comparison opens a Diff tab and an older file response cannot replace its empty result", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const state = (window as any).fixture;
    state.delay = 1000;
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (
      name: string,
      payload: any,
    ) => {
      if (payload?.command === "compare_refs")
        return {
          baseOid: payload.args.base,
          targetOid: payload.args.target,
          files: [],
        };
      return original(name, payload);
    };
  });
  await page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("tab", { name: "History", exact: true })
    .click();
  const graph = page.getByRole("listbox", { name: "提交列表与分支关系" });
  await graph.getByRole("option").first().dblclick();
  const panel = page
    .locator(".diff-tab-page:not([hidden])")
    .getByRole("region", { name: "历史文件差异" });
  await expect(panel.locator(".diff-loading")).toContainText("载入 Diff");
  await page.getByRole("button", { name: "返回 History", exact: true }).click();
  await graph
    .getByRole("option")
    .nth(2)
    .click({ modifiers: ["Shift"] });
  await expect(panel.locator(".compare-empty")).toContainText("没有文件差异");
  await page.waitForTimeout(1100);
  await expect(panel.locator(".compare-empty")).toContainText("没有文件差异");
  await page.getByRole("button", { name: "返回 History", exact: true }).click();
  const branch = page
    .locator(".repository-refs .repo-ref")
    .filter({ hasText: "feature/" })
    .first();
  await branch.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "与当前 Branch 比较", exact: true })
    .click();
  await expect(panel.locator(".compare-capture")).toContainText("feature/");
  await expect(panel.locator(".compare-empty")).toContainText("没有文件差异");
});

for (const adapter of [{ agent: "codex", name: "Codex", config: "/fixture/config/hooks.json" }, { agent: "codewiz", name: "Codewiz", config: "/fixture/config/plugins/proof-observer.js" }]) {
test(`${adapter.name} Hook uses current workspace trust and requires a config preview before installing`, async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate((adapter) => {
    const w = window as any,
      state = w.fixture,
      original = w.__TAURI_INTERNALS__.invoke;
    state.changes.workspace.trusted = false;
    const hook = {
      policyRevision: 0,
      serviceAvailable: false,
      serviceError: null,
      installations: [] as any[],
    };
    let preview: any;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      const c = payload?.command,
        a = payload?.args ?? {};
      if (
        ![
          "observer_status",
          "observer_program_locations",
          "probe_observer",
          "data_workspaces",
          "preview_observer_install",
          "cancel_observer_config",
          "apply_observer_config",
          "configure_observer_workspace",
        ].includes(c)
      )
        return original(name, payload);
      state.actions.push({ command: c, args: structuredClone(a) });
      if (c === "data_workspaces")
        return [
          {
            workspace: { ...state.changes.workspace, trusted: true },
            recent: true,
          },
        ];
      if (c === "observer_program_locations")
        return [{ agent: adapter.agent, executablePath: `/fixture/${adapter.agent}`, name: adapter.name, installationAvailable: true, unavailableReason: null }];
      if (c === "observer_status") return structuredClone(hook);
      if (c === "probe_observer")
        return {
          agent: adapter.agent,
          version: "99.0.0-preview.2",
          status: "candidate_unverified",
          profile: { runtimeVerified: false, adapterVersion: "1" },
        };
      if (c === "preview_observer_install") {
        preview = {
          id: "hook-preview",
          action: "install",
          agent: adapter.agent,
          agentVersion: "99.0.0-preview.2",
          workspaceId: a.workspaceId,
          configPath: adapter.config,
          before: '{"userHook":true}',
          after: '{"userHook":true,"proofHook":true}',
          fields: a.fields,
          requiresHookTrust: adapter.agent === "codex",
        };
        return preview;
      }
      if (c === "cancel_observer_config") return null;
      if (c === "apply_observer_config") {
        hook.policyRevision++;
        hook.serviceAvailable = true;
        hook.installations = [
          {
            installationId: "fixture-hook",
            agent: adapter.agent,
            agentVersion: "99.0.0-preview.2",
            configPath: preview.configPath,
            state: "configured_pending",
            lastEventAt: null,
            issue: null,
            consents: [
              {
                ...preview.fields,
                installationId: "fixture-hook",
                workspaceId: a.workspaceId ?? preview.workspaceId,
                enabled: true,
              },
            ],
          },
        ];
        return {
          installationId: "fixture-hook",
          message: "Proof Hook 已安装。",
          warning: null,
          observingEnabled: true,
        };
      }
      if (c === "configure_observer_workspace") {
        hook.policyRevision++;
        hook.installations[0].consents[0].enabled = a.enabled;
        return null;
      }
    };
  }, adapter);
  await page.getByRole("button", { name: "Agent Hook", exact: true }).click();
  const card = page.getByRole("region", { name: `${adapter.name} Hook`, exact: true });
  await expect(
    card.getByRole("checkbox", { name: "Prompt", exact: true }),
  ).not.toBeChecked();
  await expect(
    card.getByRole("checkbox", { name: "关闭 Proof 后继续观察", exact: true }),
  ).not.toBeChecked();
  await card.getByRole("button", { name: "检测版本", exact: true }).click();
  await card.getByRole("checkbox", { name: "Prompt", exact: true }).check();
  await card.getByRole("button", { name: "预览安装…", exact: true }).click();
  await expect(card.locator(".hook-config-preview")).toContainText(
    adapter.config,
  );
  await card.getByRole("button", { name: "取消", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter(
        (a: any) => a.command === "apply_observer_config",
      ),
    ),
  ).toHaveLength(0);
  await card.getByRole("button", { name: "预览安装…", exact: true }).click();
  await card
    .getByRole("button", { name: "安装并开启观察", exact: true })
    .click();
  await expect(card).toContainText("等待 Agent 事件");
  await card.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(card).toContainText("已暂停");
});

}

test("Context: opening a file's activity requests that file, not the entire session", async ({ page }) => {
  await openContextFixture(page);
  await page.getByRole("button", { name: /查看文件活动/ }).first().click();
  await expect.poll(() => page.evaluate(() => (window as any).contextFixture.calls.find((c: any) => c.command === "context_session_events")?.args.path)).toBe("src/api/requests.ts");
});

test("Context: compact file activity shows edits, commands and failures without opening raw logs", async ({ page }) => {
  await openContextFixture(page);
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    w.contextFixture.links[0].session.eventCount = 1060;
    w.contextFixture.links[0].originalEvidence.pathEventCount = 65;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (payload?.command !== "context_session_events") return original(name, payload);
      w.contextFixture.calls.push({ command: payload.command, args: structuredClone(payload.args) });
      const make = (id: string, patch: any = {}) => ({ id, sessionId: "session-a", nativeSessionId: "native-session-a", kind: "PostToolUse", toolName: "Bash", toolRef: id, turnId: "file-turn", receivedAt: Date.now(), paths: ["src/api/requests.ts"], prompt: null, command: "cat src/api/requests.ts", output: null, reply: null, exitCode: 0, commandState: "command_succeeded", fieldStatus: {}, truncated: false, possiblyDuplicate: false, ...patch });
      const events = [
        ...Array.from({ length: 60 }, (_, index) => make(`read-${index}`)),
        ...Array.from({ length: 3 }, (_, index) => make(`edit-${index}`, { toolName: "apply_patch", command: null, output: index === 0 ? "Applied earlier patch" : null, exitCode: null, commandState: "not_applicable" })),
        make("check", { command: "npm run typecheck", output: "No type errors" }),
        make("failed", { command: "npm test", output: "Expected 401 but received 200", exitCode: 1, commandState: "command_failed" }),
      ];
      if (!payload.args.path) events.unshift(make("unrelated", { turnId: "other-turn", toolName: "Write", paths: ["other.ts"], command: null }));
      return { events, fileEventCount: 65, taskContext: [make("intent", { kind: "UserPromptSubmit", prompt: "Fix authentication expiry", toolName: null })], expiry: {}, next: null, cleared: false };
    };
  });
  await page.getByRole("button", { name: /查看文件活动/ }).click();
  await expect(page.getByText("Fix authentication expiry", { exact: true })).toBeVisible();
  await expect(page.getByText("修改文件 · requests.ts", { exact: true })).toBeVisible();
  await expect(page.getByText("No type errors", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Expected 401 but received 200", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".activity-row:visible")).toHaveCount(3);
  await expect(page.getByText("cat src/api/requests.ts", { exact: true }).first()).not.toBeVisible();
  await expect(page.getByText("读取、搜索与其他操作 · 60 条", { exact: true })).toBeVisible();
  await page.screenshot({ path: ".artifacts/hook-context/file-activity-light.png", animations: "disabled" });
  const edits = page.locator(".activity-row").filter({ hasText: "修改文件 · requests.ts" }).first();
  await edits.locator(".activity-detail > summary").click();
  await edits.locator(".activity-repeats details").last().locator("summary").click();
  await expect(edits.getByText("Applied earlier patch", { exact: true })).toBeVisible();
  await edits.locator(".activity-detail > summary").click();
  await page.getByRole("button", { name: "完整会话", exact: true }).click();
  await expect(page.getByText("修改文件 · other.ts", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "当前文件", exact: true }).click();
  await expect(page.getByText("修改文件 · other.ts", { exact: true })).toHaveCount(0);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.screenshot({ path: ".artifacts/hook-context/file-activity-dark.png", animations: "disabled" });
});

test("Context: manual links, notes, unlink and undo preserve original session evidence", async ({
  page,
}) => {
  await openContextFixture(page);
  expect(
    await page.evaluate(() =>
      (window as any).contextFixture.calls.some(
        (c: any) => c.command === "context_session_events",
      ),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "关联会话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理会话关联" });
  await dialog
    .locator(".association-candidate")
    .filter({ hasText: "native-session-b" })
    .click();
  await dialog
    .getByLabel("本地备注", { exact: true })
    .fill("This task also explains the request change");
  await dialog.getByRole("button", { name: "关联此会话", exact: true }).click();
  await expect(
    dialog.getByRole("status", { name: "关联保存状态" }),
  ).toContainText("关联已保存");
  await page.screenshot({ path: ".artifacts/context-association-desktop.png" });
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.locator(".context-linked-session")).toHaveCount(2);
  const manual = page
    .locator(".context-linked-session")
    .filter({ hasText: "native-session-b" });
  await expect(manual).toContainText("用户指定");
  await expect(manual).toContainText("This task also explains");
  await manual.getByRole("button", { name: /查看文件活动/ }).click();
  await manual.locator(".observer-events summary").click();
  await expect(manual).toContainText("Prompt");
  await expect(manual).toContainText("未开启记录");
  await expect(manual).toContainText("Agent 最终回复 · 原文");
  await expect(manual).not.toContainText("命令成功");
  await manual.getByRole("button", { name: "编辑关联" }).click();
  await dialog.getByRole("button", { name: "解除关联", exact: true }).click();
  await expect(
    dialog.getByRole("status", { name: "关联保存状态" }),
  ).toContainText("关联已保存");
  await dialog
    .getByLabel("本地备注", { exact: true })
    .fill("Unlinked, preserve this reason");
  await dialog.getByRole("button", { name: "保存备注", exact: true }).click();
  await expect(
    dialog.getByRole("status", { name: "关联保存状态" }),
  ).toContainText("关联已保存");
  expect(
    await page.evaluate(() => (window as any).contextFixture.links[1].active),
  ).toBe(false);
  await dialog.getByRole("button", { name: "修改记录", exact: true }).click();
  await expect(dialog.locator(".association-history article")).toHaveCount(3);
  await dialog.getByRole("button", { name: "撤销此修改", exact: true }).click();
  await expect(
    dialog.getByRole("status", { name: "关联保存状态" }),
  ).toContainText("已撤销");
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.locator(".context-linked-session")).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        (window as any).contextFixture.history[0].originalEvidence
          .pathEventCount,
    ),
  ).toBe(0);
});

test("Context: background updates cannot overwrite a note draft or its expected revision", async ({
  page,
}) => {
  await openContextFixture(page);
  await page.getByRole("button", { name: "编辑关联", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理会话关联" });
  await dialog.getByLabel("本地备注", { exact: true }).fill("My unsaved note");
  await page.keyboard.press("Meta+3");
  await page.evaluate(() =>
    (window as any).fixture.emitNativeEvent("proof:close-active-view"),
  );
  await expect(
    page
      .locator(".workspace-tabs .view-tab")
      .filter({hasText:/^本地变更/}),
  ).toHaveAttribute("aria-current", "page");
  await expect(dialog.getByLabel("本地备注", { exact: true })).toBeFocused();
  expect(await page.evaluate(() => (window as any).fixture.windowCloses)).toBe(
    0,
  );
  await page.evaluate(() =>
    Object.assign((window as any).contextFixture.links[0], {
      userOverride: { enabled: true, note: "Peer's saved note" },
      revision: "peer-version",
    }),
  );
  await expect(page.locator(".context-local-note")).toContainText(
    "Peer's saved note",
    { timeout: 7000 },
  );
  await expect(dialog.getByLabel("本地备注", { exact: true })).toHaveValue(
    "My unsaved note",
  );
  await dialog.getByRole("button", { name: "关联此会话", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({hasText:/\S/})).toContainText("关联已更新");
  await expect(dialog.getByLabel("本地备注", { exact: true })).toHaveValue(
    "My unsaved note",
  );
  await dialog
    .getByRole("button", { name: "读取最新关联", exact: true })
    .click();
  await expect(
    dialog.getByRole("status", { name: "关联保存状态" }),
  ).toContainText("已读取最新关联");
  await dialog.getByRole("button", { name: "保存备注", exact: true }).click();
  await expect(
    dialog.getByRole("status", { name: "关联保存状态" }),
  ).toContainText("关联已保存");
  expect(
    await page.evaluate(
      () => (window as any).contextFixture.links[0].userOverride.note,
    ),
  ).toBe("My unsaved note");
});

test("Context: failed saves remain visible after closing and notes survive selecting another session", async ({
  page,
}) => {
  await openContextFixture(page);
  await page.getByRole("button", { name: "编辑关联", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理会话关联" });
  await dialog.getByLabel("本地备注", { exact: true }).fill("Draft A");
  await dialog
    .locator(".association-candidate")
    .filter({ hasText: "native-session-b" })
    .click();
  await dialog.getByLabel("本地备注", { exact: true }).fill("Draft B");
  await dialog
    .locator(".association-candidate")
    .filter({ hasText: "native-session-a" })
    .click();
  await expect(dialog.getByLabel("本地备注", { exact: true })).toHaveValue(
    "Draft A",
  );
  await page.evaluate(() => {
    (window as any).contextFixture.pending = true;
  });
  await dialog.getByRole("button", { name: "关联此会话", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).contextFixture.reject),
    )
    .toBe("function");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).contextFixture.reject({
      code: "SQLITE_FULL",
      message: "备注未保存：磁盘空间不足",
      detail: "fixture disk full",
    }),
  );
  await expect(page.getByRole("alert").filter({hasText:/\S/})).toContainText(
    "备注未保存：磁盘空间不足",
  );
});

test("Context: manager is scoped to the selected file and stays usable in a narrow window", async ({
  page,
}) => {
  await openContextFixture(page);
  await page.setViewportSize({ width: 640, height: 720 });
  const show = page.getByRole("button", { name: "显示上下文", exact: true });
  await expect(show).toBeVisible();
  await show.click();
  await page.getByRole("button", { name: "关联会话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理会话关联" });
  await dialog.getByLabel("搜索当前 Worktree 的会话").fill("native-session-b");
  await expect(dialog.locator(".association-candidate")).toHaveCount(1);
  await dialog.locator(".association-candidate").click();
  await dialog
    .getByLabel("本地备注", { exact: true })
    .fill("Narrow panel note");
  await dialog.getByRole("button", { name: "关联此会话", exact: true }).click();
  await expect(
    dialog.getByRole("status", { name: "关联保存状态" }),
  ).toContainText("关联已保存");
  expect(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({ path: ".artifacts/context-association-narrow.png" });
  const saved = await page.evaluate(
    () =>
      (window as any).contextFixture.calls.find(
        (c: any) => c.command === "update_context_association",
      ).args,
  );
  expect(saved.path).toBe("src/api/requests.ts");
  expect(saved.workspaceId).toBe("workflow-test");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "关联会话", exact: true })).toBeFocused();
});

test("Context: cached event pages survive new activity and expire output without a count change", async ({
  page,
}) => {
  await openContextFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    const expiry = Date.now() + 6000;
    w.contextFixture.links[0].session.eventCount = 21;
    w.contextFixture.eventReads = 0;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (payload?.command !== "context_session_events")
        return original(name, payload);
      w.contextFixture.eventReads++;
      const old = !!payload.args.before,
        id = old ? "old-page-event" : "first-page-event";
      return {
        events: [
          {
            id,
            sessionId: payload.args.sessionId,
            kind: "PostToolUse",
            toolName: "Bash",
            toolRef: null,
            turnId: null,
            receivedAt: Date.now(),
            paths: [],
            prompt: null,
            command: old ? "command-from-older-page" : "first-page-command",
            output: old ? "CACHED_OUTPUT_TO_EXPIRE" : null,
            reply: null,
            exitCode: 0,
            commandState: "command_succeeded",
            fieldStatus: {},
            truncated: false,
            possiblyDuplicate: false,
          },
        ],
        expiry: {
          [id]: { contentExpiresAt: expiry, expiresAt: expiry + 100000 },
        },
        next: old ? null : { receivedAt: Date.now(), id },
        cleared: false,
      };
    };
  });
  await page.getByRole("button", { name: /查看文件活动/ }).click();
  const events = page.getByLabel("会话原始记录");
  await events.getByRole("button", { name: "加载更早的记录" }).click();
  await events.locator(".activity-routine > summary").click();
  await events.locator(".activity-row").filter({ hasText: "command-from-older-page" }).locator(".activity-detail > summary").click();
  await expect(events).toContainText("CACHED_OUTPUT_TO_EXPIRE");
  const readsBeforeActivity = await page.evaluate(
    () => (window as any).contextFixture.eventReads,
  );
  await page.evaluate(() => {
    (window as any).contextFixture.links[0].session.eventCount = 22;
  });
  await expect(
    events.getByRole("button", { name: "读取最新记录" }),
  ).toBeVisible({ timeout: 7000 });
  await expect(events).toContainText("command-from-older-page");
  expect(
    await page.evaluate(() => (window as any).contextFixture.eventReads),
  ).toBe(readsBeforeActivity);
  await expect(events).not.toContainText("CACHED_OUTPUT_TO_EXPIRE", {
    timeout: 7000,
  });
  await expect(events).toContainText("工具输出 · 记录已清理");
  await expect(events).toContainText("command-from-older-page");
  await expect(events.locator(".activity-row").filter({ hasText: "command-from-older-page" }).locator(".activity-detail")).toHaveAttribute("open", "");
  expect(
    await page.evaluate(() => (window as any).contextFixture.eventReads),
  ).toBe(readsBeforeActivity);
});

test("Diagnostics confirms optional categories, previews exact bytes and supports cancellation", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.diagnostics = {
      requests: [],
      previews: new Map(),
      exports: [],
      saveResult: null,
      next: 0,
    };
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (name !== "proof_command" || !payload.command.endsWith("diagnostic"))
        return original(name, payload);
      const s = w.diagnostics,
        a = payload.args;
      s.requests.push({ command: payload.command, args: structuredClone(a) });
      if (payload.command === "prepare_diagnostic") {
        const content =
          JSON.stringify(
            {
              product: "Proof",
              included: a.options,
              additional: a.options.includePaths
                ? { path: "/fixture/repo" }
                : {},
              queue: { status: "stopped" },
            },
            null,
            2,
          ) + "\n";
        const preview = {
          id: String(++s.next),
          fileName: "Proof-diagnostics.json",
          bytes: new TextEncoder().encode(content).length,
          sha256: "fixture-digest",
          capturedAt: Date.now(),
          expiresAt: Date.now() + 300000,
          options: a.options,
          content,
        };
        s.previews.set(preview.id, preview);
        return preview;
      }
      if (payload.command === "cancel_diagnostic") {
        s.previews.delete(a.previewId);
        return null;
      }
      if (payload.command === "validate_diagnostic") {
        if (!s.previews.has(a.previewId))
          throw {
            code: "DIAGNOSTIC_EXPIRED",
            message: "诊断预览已失效",
            detail: "fixture",
          };
        return null;
      }
      if (payload.command === "export_diagnostic") {
        if (!s.previews.has(a.previewId))
          throw {
            code: "DIAGNOSTIC_EXPIRED",
            message: "诊断预览已失效",
            detail: "fixture",
          };
        s.exports.push(a);
        if (s.saveResult) {
          s.exportedPreview = s.previews.get(a.previewId);
          s.previews.delete(a.previewId);
          await new Promise((resolve) => setTimeout(resolve, 2600));
        }
        return s.saveResult;
      }
    };
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("tablist", { name: "设置分类" })
    .getByRole("tab", { name: "诊断", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "诊断导出" });
  for (const checkbox of await panel.getByRole("checkbox").all())
    await expect(checkbox).not.toBeChecked();
  await panel.getByRole("button", { name: "生成预览", exact: true }).click();
  await expect(panel.getByLabel("诊断内容预览")).not.toContainText(
    "/fixture/repo",
  );
  await panel.getByRole("button", { name: "保存到本地…", exact: true }).click();
  await expect(panel.getByLabel("诊断内容预览")).toBeVisible(); // Save dialog cancelled.
  await panel.getByRole("button", { name: "取消预览", exact: true }).click();
  await expect(panel.getByLabel("诊断内容预览")).toHaveCount(0);
  await panel.getByRole("checkbox", { name: /本地路径/ }).click();
  await expect(
    panel.getByRole("button", { name: "生成预览", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("checkbox", { name: /本地路径/ }),
  ).not.toBeChecked();
  await panel
    .getByRole("button", { name: "确认包含本地路径", exact: true })
    .click();
  await expect(panel.getByRole("checkbox", { name: /本地路径/ })).toBeChecked();
  await expect(
    panel.getByRole("checkbox", { name: /事件缺口时间线/ }),
  ).not.toBeChecked();
  await panel.getByRole("button", { name: "生成预览", exact: true }).click();
  const text = await panel.getByLabel("诊断内容预览").textContent();
  await expect(panel.getByLabel("诊断内容预览")).toContainText("/fixture/repo");
  await page.evaluate(() => {
    const s = (window as any).diagnostics;
    const last = [...s.previews.values()].at(-1) as any;
    s.saveResult = {
      path: "/fixture/Proof-diagnostics.json",
      bytes: last.bytes,
      sha256: last.sha256,
    };
  });
  await panel.getByRole("button", { name: "保存到本地…", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("诊断已保存");
  const saved = await page.evaluate(() => {
    const s = (window as any).diagnostics,
      a = s.exports.at(-1);
    return { args: a, preview: s.exportedPreview };
  });
  expect(saved.args.sha256).toBe(saved.preview.sha256);
  expect(saved.args).not.toHaveProperty("path");
  expect(saved.args).not.toHaveProperty("content");
  expect(saved.preview.content).toBe(text);
});

test("Diagnostics removes invalid previews after another window clears records", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (payload?.command === "prepare_diagnostic")
        return {
          id: "stale",
          fileName: "diagnostic.json",
          bytes: 12,
          sha256: "digest",
          capturedAt: Date.now(),
          expiresAt: Date.now() + 300000,
          options: { includePaths: false, includeTimeline: false },
          content: "OLD_DIAGNOSTIC",
        };
      if (payload?.command === "validate_diagnostic")
        throw {
          code: "DIAGNOSTIC_EXPIRED",
          message: "本地记录已清理",
          detail: "fixture",
        };
      if (payload?.command === "cancel_diagnostic") return null;
      return original(name, payload);
    };
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("tablist", { name: "设置分类" })
    .getByRole("tab", { name: "诊断", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "诊断导出" });
  await panel.getByRole("button", { name: "生成预览", exact: true }).click();
  await expect(panel.getByLabel("诊断内容预览")).toContainText(
    "OLD_DIAGNOSTIC",
  );
  await expect(panel.getByRole("status")).toContainText("预览已失效");
  await expect(panel.getByText("OLD_DIAGNOSTIC", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    panel.getByRole("button", { name: "保存到本地…", exact: true }),
  ).toHaveCount(0);
});

test("Application diagnostics remains available when startup cannot open local records", async ({
  page,
}) => {
  await openFixture(page);
  await page.addInitScript(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (name === "proof_command")
        throw {
          code: "CORE_STARTUP_FAILED",
          message: "无法打开本地数据",
          detail: "fixture read-only storage",
        };
      if (name === "application_diagnostic") {
        if (payload.command === "prepare")
          return {
            applicationOnly: true,
            id: "application",
            fileName: "Proof-application.json",
            content:
              '{"product":"Proof","scope":"application_only","localRecordsRead":false}',
            bytes: 77,
            sha256: "fixture",
            capturedAt: Date.now(),
            expiresAt: Date.now() + 300000,
            options: { includePaths: false, includeTimeline: false },
          };
        if (payload.command === "export")
          return {
            path: "/fixture/application.json",
            bytes: 77,
            sha256: "fixture",
          };
        return null;
      }
      return original(name, payload);
    };
  });
  await page.reload();
  await page.getByRole("button", { name: "打开诊断", exact: true }).click();
  const panel = page.getByRole("region", { name: "诊断导出" });
  await panel
    .getByRole("button", { name: "仅导出应用信息", exact: true })
    .click();
  await expect(panel.getByLabel("诊断内容预览")).toContainText(
    '"localRecordsRead":false',
  );
  await expect(
    panel.getByRole("checkbox", { name: /本地路径/ }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "保存到本地…", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("诊断已保存");
});

test("AI grouping is explicit, editable and cannot overwrite manual groups", async ({
  page,
}) => {
  await openFixture(page, false, true);
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter(
        (a: any) => a.command === "run_ai_task",
      ),
    ),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "AI 分组", exact: true }).click();
  await expect(
    page.locator(".change-group .group-toggle").first(),
  ).toContainText("Authentication");
  await page
    .getByRole("button", { name: "重命名 Authentication", exact: true })
    .click();
  const groupTitle = "邮箱签发 JWT 取消认证门槛并同步测试和迁移文档";
  await page.getByRole("textbox", { name: "分组名称" }).fill(groupTitle);
  await page.getByRole("textbox", { name: "分组名称" }).press("Enter");
  await expect(page.locator(".group-toggle").first()).toContainText(groupTitle);
  const file = page.locator('.group-file-select[title="src/api/response.ts"]');
  // DOM visibility alone misses filenames squeezed to zero width by a long select.
  const filename = file.locator(":scope > span:nth-child(2)");
  await expect
    .poll(async () => (await filename.boundingBox())?.width ?? 0)
    .toBeGreaterThan(100);
  await expect(file.locator(".group-file-name")).toHaveText("response.ts");
  await expect(file.locator(".group-file-directory")).toHaveText("src/api");
  await file.click();
  await expect(page.locator(".diff-file-header")).toContainText("response.ts");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText(
    "createResponse",
  );
  await page.mouse.move(900, 60);
  await page.screenshot({
    path: ".artifacts/group-file-labels/local-light.png",
    animations: "disabled",
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.screenshot({
    path: ".artifacts/group-file-labels/local-dark.png",
    animations: "disabled",
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  const move = page.locator('.change-group-file [role="combobox"]').first();
  expect((await move.boundingBox())!.width).toBeLessThanOrEqual(28);
  await move.focus();
  await move.press("Enter");
  const groupOption = page.locator(".proof-select-popup").getByRole("option", {
    name: groupTitle,
    exact: true,
  });
  await expect(groupOption).toBeVisible();
  const optionText = groupOption.locator('[data-slot="select-item-text"]');
  expect(
    await optionText.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: ".artifacts/group-file-labels/group-menu.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(move).toBeFocused();
  await chooseOption(move, "new");
  await expect(page.locator(".group-toggle")).toHaveCount(2);
  await page.getByRole("button", { name: "AI 分组", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "应用分组", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".group-toggle").first()).toContainText(groupTitle);
  await page.getByRole("button", { name: "取消全部分组", exact: true }).click();
  await expect(page.locator(".group-toggle")).toHaveCount(0);
  const writes = await page.evaluate(() =>
    (window as any).fixture.actions.filter((a: any) =>
      ["stage", "commit", "mark_reviewed"].includes(a.command),
    ),
  );
  expect(writes).toHaveLength(0);
});
test("AI Review returns structured findings, jumps to Diff and expires after file changes", async ({
  page,
}) => {
  await openFixture(page, true, true);
  await page.getByRole("button", { name: "显示上下文", exact: true }).click();
  await page.getByRole("button", { name: "AI Review", exact: true }).click();
  await chooseOption(page
    .getByRole("combobox", { name: "AI Agent" }),"claude_code");
  await page
    .getByRole("button", { name: "Review 当前变更", exact: true })
    .click();
  await expect(page.locator(".ai-finding")).toContainText(
    "Missing boundary validation",
  );
  await page
    .getByRole("button", { name: "Missing boundary validation", exact: true })
    .click();
  await expect(page.locator(".is-finding-target")).toHaveCount(2);
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter(
        (a: any) => a.command === "mark_reviewed",
      ),
    ),
  ).toHaveLength(0);
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.changes.token = "new-ai-source";
    f.emitNativeEvent("workspace-invalidated", f.changes.workspace.id);
  });
  await expect(page.locator(".ai-stale")).toContainText("已过期");
  await expect(page.locator(".ai-inline-review")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Missing boundary validation",
      exact: true,
    }),
  ).toBeDisabled();
  const calls = await page.evaluate(() =>
    (window as any).fixture.actions.filter(
      (a: any) => a.command === "run_ai_task",
    ),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].args.request.provider).toBe("claude_code");
  await page.screenshot({ path: ".artifacts/ai-core/local-review.png" });
});

test("historical AI Review stays in its frozen Diff tab and never reviews local files", async ({
  page,
}) => {
  await openFixture(page, false, true);
  await page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  const tab = page.locator(".diff-tab-page").last();
  await tab.getByRole("button", { name: "AI Review", exact: true }).click();
  await tab
    .getByRole("button", { name: "Review 全部变更", exact: true })
    .click();
  await expect(tab.locator(".ai-finding")).toContainText(
    "Missing boundary validation",
  );
  await tab
    .getByRole("button", { name: "Missing boundary validation", exact: true })
    .click();
  await expect(tab.locator(".is-finding-target")).toHaveCount(2);
  const calls = await page.evaluate(() =>
    (window as any).fixture.actions.filter(
      (a: any) => a.command === "run_ai_task",
    ),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].args.request.scope.kind).toBe("comparison");
  expect(calls[0].args.request.scope.path).toBeNull();
  expect(calls[0].args.request.scope.base).toBeTruthy();
  expect(calls[0].args.request.scope.target).toBeTruthy();
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter((a: any) =>
        [
          "mark_reviewed",
          "mark_comparison_reviewed",
          "stage",
          "commit",
        ].includes(a.command),
      ),
    ),
  ).toHaveLength(0);
  const layout = await tab.evaluate((element) => {
    const center = element
      .querySelector(".center-panel")!
      .getBoundingClientRect();
    const inspector = element
      .querySelector(".comparison-ai")!
      .getBoundingClientRect();
    return {
      centerWidth: center.width,
      inspectorWidth: inspector.width,
      centerRight: center.right,
      inspectorLeft: inspector.left,
      centerTop: center.top,
      inspectorTop: inspector.top,
    };
  });
  expect(layout.centerWidth).toBeGreaterThan(layout.inspectorWidth * 2);
  expect(Math.abs(layout.centerRight + 4 - layout.inspectorLeft)).toBeLessThan(2); // The resize handle occupies 4 px.
  expect(Math.abs(layout.centerTop - layout.inspectorTop)).toBeLessThan(2);
  await page.screenshot({ path: ".artifacts/ai-core/history-review.png" });
});
test("missing AI providers leave manual groups, Diff and Commit usable", async ({
  page,
}) => {
  await openFixture(page);
  await expect(
    page.getByRole("button", { name: "AI 分组", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "变更分组", exact: true }).click();
  await chooseOption(page.locator('.change-group-file [role="combobox"]').first(),"new");
  await expect(page.locator(".group-toggle").first()).toContainText("新变更");
  await openCommit(page);
  await expect(
    page.getByRole("textbox", { name: "Commit message" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter(
        (a: any) => a.command === "run_ai_task",
      ),
    ),
  ).toHaveLength(0);
});

test("Agent settings expose default provider, CLI paths, models and a no-inference login check", async ({
  page,
}) => {
  await openFixture(page, false, true);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "AI Agent", exact: true }).click();
  await chooseOption(page
    .getByLabel("默认 Agent", { exact: true }),"claude_code");
  await page
    .getByRole("textbox", { name: "Codex CLI 路径", exact: true })
    .fill("/custom/Codex Agent/codex");
  await page
    .getByRole("textbox", { name: "Codex 模型", exact: true })
    .fill("gpt-6-astra");
  await page
    .getByRole("textbox", { name: "Claude Code 模型", exact: true })
    .fill("sonnet");
  const claude = page
    .locator(".agent-setting-card")
    .filter({ has: page.getByText("Claude Code", { exact: true }) });
  await claude.getByRole("button", { name: "检测 CLI", exact: true }).click();
  await expect(claude.getByRole("status")).toContainText("没有可用登录");
  await expect(claude.getByRole("status")).toContainText("claude auth login");
  await page
    .getByRole("button", { name: "保存 Agent 设置", exact: true })
    .click();
  await expect(
    page.locator(".agent-settings-footer").getByRole("status"),
  ).toContainText("已保存");
  const actions = await page.evaluate(() => (window as any).fixture.actions);
  expect(actions.filter((a: any) => a.command === "run_ai_task")).toHaveLength(
    0,
  );
  const save = actions.find((a: any) => a.command === "set_agent_settings");
  expect(save.args.update.codex.executablePath).toBe(
    "/custom/Codex Agent/codex",
  );
  expect(save.args.update.codex.model).toBe("gpt-6-astra");
  await page.getByRole("tab", { name: "外观与阅读", exact: true }).click();
  await page.getByRole("tab", { name: "AI Agent", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Codex CLI 路径", exact: true }),
  ).toHaveValue("/custom/Codex Agent/codex");
  await expect(page.getByLabel("默认 Agent", { exact: true })).toHaveAttribute("data-value","claude_code");
  await expect(
    page.getByRole("heading", { name: "AI Agent", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: ".artifacts/ai-settings/settings.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "显示上下文", exact: true }).click();
  await page.getByRole("button", { name: "AI Review", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "AI Agent", exact: true }),
  ).toHaveAttribute("data-value","claude_code");
});

test("Codewiz is hidden until detected and its settings drive Grouping and Review", async ({ page }) => {
  await openFixture(page, false, true);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "AI Agent", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Codewiz CLI 路径", exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).fixture.codewizEnabled = true; (window as any).fixture.agentAuthenticated = true; });
  await page.getByRole("button", { name: "重新读取 Agent 设置", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Codewiz CLI 路径", exact: true })).toBeVisible();
  await chooseOption(page.getByLabel("默认 Agent", { exact: true }), "codewiz");
  await page.getByRole("textbox", { name: "Codewiz 模型", exact: true }).fill("company/model");
  const card = page.locator(".agent-setting-card").filter({ has: page.getByText("Codewiz", { exact: true }) });
  await card.getByRole("button", { name: "检测 CLI", exact: true }).click();
  await expect(card.getByRole("status")).toContainText("未调用模型");
  await page.getByRole("button", { name: "保存 Agent 设置", exact: true }).click();
  await expect(page.locator(".agent-settings-footer").getByRole("status")).toContainText("已保存");
  expect(await page.evaluate(() => (window as any).fixture.actions.filter((a: any) => a.command === "run_ai_task"))).toHaveLength(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "AI 分组", exact: true }).click();
  await expect(page.locator(".group-toggle")).not.toHaveCount(0);
  await page.getByRole("button", { name: "显示上下文", exact: true }).click();
  await page.getByRole("button", { name: "AI Review", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "AI Agent", exact: true })).toHaveAttribute("data-value", "codewiz");
  await page.getByRole("button", { name: "Review 当前变更", exact: true }).click();
  await expect(page.locator(".ai-finding")).toContainText("Missing boundary validation");
  const actions = await page.evaluate(() => (window as any).fixture.actions);
  expect(actions.filter((a: any) => a.command === "run_ai_task").map((a: any) => a.args.request.provider)).toEqual(["codewiz", "codewiz"]);
  expect(actions.filter((a: any) => ["stage", "commit", "mark_reviewed"].includes(a.command))).toHaveLength(0);
  await page.screenshot({ path: ".artifacts/codewiz/codewiz-review.png" });
});

test("software update downloads survive closing settings and install only on an explicit click", async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as any, invoke = w.__TAURI_INTERNALS__.invoke;
    w.fixture.updateCalls = [];
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (name === "check_app_update") { w.fixture.updateCalls.push(name); return { id: "u1", version: "0.1.2", currentVersion: "0.1.1", notes: "Improved Diff reading" }; }
      if (name === "download_app_update") {
        w.fixture.updateCalls.push(name);
        payload.onProgress.onmessage({ downloaded: 50, total: 100 });
        return new Promise<void>((resolve) => { w.fixture.finishUpdateDownload = resolve; });
      }
      if (name === "install_app_update") { w.fixture.updateCalls.push(name); throw { code: "UPDATE_WORK_RUNNING", message: "请等待 Git 操作或 AI 分析完成后再安装更新。", detail: "Busy" }; }
      return invoke(name, payload);
    };
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "软件更新", exact: true }).click();
  expect(await page.evaluate(() => (window as any).fixture.updateCalls)).toEqual([]);
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByText("可用版本：0.1.2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下载更新", exact: true }).click();
  await expect(page.getByText("50%", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "软件更新", exact: true }).click();
  await expect(page.getByText("50%", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).fixture.finishUpdateDownload());
  await expect(page.getByRole("button", { name: "安装并重启", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).fixture.updateCalls)).toEqual(["check_app_update", "download_app_update"]);
  await page.getByRole("button", { name: "安装并重启", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("请等待 Git 操作或 AI 分析完成");
  await expect(page.getByRole("button", { name: "安装并重启", exact: true })).toBeEnabled();
  await page.screenshot({ path: ".artifacts/codewiz/software-update.png" });
});
test("AI failure details link directly to Agent settings and preserve the error category", async ({
  page,
}) => {
  await openFixture(page, false, true);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (payload?.command === "run_ai_task")
        throw {
          code: "AI_STARTUP_PERMISSION",
          message: "CLI 启动所需的文件或系统能力受限，请查看失败详情。",
          detail:
            "Provider: Codex\nPhase: analysis\nExit code: 1\nOperation not permitted",
        };
      return original(name, payload);
    };
  });
  await page.getByRole("button", { name: "显示上下文", exact: true }).click();
  await page.getByRole("button", { name: "AI Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Review 当前变更", exact: true })
    .click();
  await page
    .getByText("失败详情 · AI_STARTUP_PERMISSION", { exact: true })
    .click();
  await expect(page.locator(".ai-error pre")).toContainText(
    "Operation not permitted",
  );
  await page
    .getByRole("button", { name: "打开 Agent 设置", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Codex CLI 路径", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Claude Code CLI 路径", exact: true }),
  ).toBeVisible();
});

test("Grouping errors expose failure details in the file pane", async ({
  page,
}) => {
  await openFixture(page, false, true);
  await page.evaluate(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (payload?.command === "run_ai_task")
        throw {
          code: "AI_STARTUP_PERMISSION",
          message: "CLI 启动失败，请查看失败详情。",
          detail: "Provider: Codex\nPhase: analysis\nCannot initialize runtime",
        };
      return original(name, payload);
    };
  });
  await page.getByRole("button", { name: "AI 分组", exact: true }).click();
  const pane = page.locator(".change-groups");
  await pane
    .getByText("失败详情 · AI_STARTUP_PERMISSION", { exact: true })
    .click();
  await expect(pane.locator(".ai-error pre")).toContainText(
    "Cannot initialize runtime",
  );
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter(
        (a: any) => a.command === "mark_reviewed",
      ),
    ),
  ).toHaveLength(0);
});

test("historical Diff exposes grouping, collapsible panes and a separate window", async ({
  page,
}) => {
  await openFixture(page, false, true);
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  const tab = page.locator(".diff-tab-page:not([hidden])");
  await expect(
    tab.getByRole("button", { name: "AI 分组", exact: true }),
  ).toBeVisible();
  await expect(
    tab.getByRole("button", { name: "收起文件栏", exact: true }),
  ).toBeVisible();
  await expect(
    tab.getByRole("button", { name: "在独立窗口打开 Diff", exact: true }),
  ).toBeEnabled();
});

test("historical groups stay scoped while panes collapse and window requests freeze the pair", async ({
  page,
}) => {
  await openFixture(page, false, true);
  await page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  const tab = page.locator(".diff-tab-page:not([hidden])");
  await tab.getByRole("button", { name: "AI 分组", exact: true }).click();
  await expect(tab.locator(".group-toggle").first()).toContainText(
    "Authentication",
  );
  const groupTitle = "邮箱签发 JWT 取消认证门槛并同步测试和迁移文档";
  await tab
    .getByRole("button", { name: "重命名 Authentication", exact: true })
    .click();
  await tab.getByRole("textbox", { name: "分组名称" }).fill(groupTitle);
  await tab.getByRole("textbox", { name: "分组名称" }).press("Enter");
  const file = tab.locator('.group-file-select[title="src/api/response.ts"]');
  await expect
    .poll(async () => (await file.locator(".group-file-name").boundingBox())?.width ?? 0)
    .toBeGreaterThan(100);
  await file.click();
  await expect(tab.locator(".diff-file-header")).toContainText("response.ts");
  const actions = await page.evaluate(() => (window as any).fixture.actions);
  const grouping = actions.find((a: any) => a.command === "run_ai_task");
  expect(grouping.args.request.scope.kind).toBe("comparison");
  expect(grouping.args.request.scope.path).toBeNull();
  expect(
    actions.filter((a: any) => a.command === "set_change_groups"),
  ).toHaveLength(0);
  await tab.getByRole("button", { name: "收起文件栏", exact: true }).click();
  await expect(tab.locator(".compare-files")).toBeHidden();
  await tab.getByRole("button", { name: "AI Review", exact: true }).click();
  await expect(tab.locator(".comparison-ai")).toBeVisible();
  await tab.getByRole("button", { name: "收起上下文", exact: true }).click();
  await expect(tab.locator(".comparison-ai")).toHaveCount(0);
  await tab.getByRole("button", { name: "显示文件栏", exact: true }).click();
  await expect(tab.locator(".group-toggle").first()).toContainText(groupTitle);
  await tab
    .getByRole("button", { name: "在独立窗口打开 Diff", exact: true })
    .click();
  const opened = await page.evaluate(
    () => (window as any).fixture.windowSelection,
  );
  expect(opened.kind).toBe("comparison");
  expect(opened.base).toBe(grouping.args.request.scope.base);
  expect(opened.target).toBe(grouping.args.request.scope.target);
  await tab.getByRole("button", { name: "AI Review", exact: true }).click();
  await page.screenshot({ path: ".artifacts/diff-workspace/history.png" });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.screenshot({ path: ".artifacts/diff-workspace/history-dark.png" });
});

test("detached Diff uses the shared workspace without repository navigation or automatic AI", async ({
  page,
}) => {
  await openFixture(page, false, true);
  await page.goto("/?diffWindow=1");
  await expect(page.locator(".diff-window-app")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Worktree" })).toHaveCount(
    0,
  );
  const tab = page.locator(".diff-tab-page:not([hidden])");
  await expect(
    tab.getByRole("button", { name: "AI 分组", exact: true }),
  ).toBeVisible();
  await expect(tab.locator(".diff-scroll")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+2");
  await expect(tab).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Commit message" }),
  ).toBeHidden();
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter(
        (a: any) => a.command === "run_ai_task",
      ),
    ),
  ).toHaveLength(0);
  await expect(tab.locator(".monaco-editor .view-lines")).toContainText("validateRequest");
  await expect.poll(()=>tab.locator(".monaco-editor .view-lines [class*=mtk]").evaluateAll(nodes=>new Set(nodes.map(node=>getComputedStyle(node).color)).size)).toBeGreaterThanOrEqual(4);
  await page.screenshot({ path: ".artifacts/diff-workspace/window.png" });
});

test("Local changes opens the selected file and side in a Diff window", async ({
  page,
}) => {
  await openFixture(page, false, true);
  await page
    .getByRole("button", { name: "在独立窗口打开 Diff", exact: true })
    .click();
  const selection = await page.evaluate(
    () => (window as any).fixture.windowSelection,
  );
  expect(selection).toMatchObject({
    kind: "local",
    path: "src/api/requests.ts",
    side: "unstaged",
  });
  expect(selection.workspaceId).toBeTruthy();
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter((a: any) =>
        ["stage", "commit", "mark_reviewed", "run_ai_task"].includes(a.command),
      ),
    ),
  ).toHaveLength(0);
});

test("Diff file loading preserves workbench geometry", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFixture(page);
  await page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("tab", { name: "History", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  const tab = page.locator(".diff-tab-page:not([hidden])");
  await expect(tab.locator(".diff-file-header")).toBeVisible();
  const before = await tab.locator(".center-panel").boundingBox();
  await page.evaluate(() => {
    (window as any).fixture.delay = 1800;
  });
  await tab
    .locator(".tree-file")
    .filter({ hasText: "response.ts" })
    .first()
    .click();
  await expect(
    tab.getByRole("status").filter({ hasText: "载入 Diff" }),
  ).toBeVisible();
  const during = await tab.locator(".center-panel").boundingBox();
  expect(during).toEqual(before);
  await expect(tab.locator(".diff-file-header")).toContainText("response.ts");
  expect(await tab.locator(".center-panel").boundingBox()).toEqual(before);
});

async function openScrollingReview(page: Page) {
  await openFixture(page, true, true);
  await page.evaluate(() => {
    const f = (window as any).fixture;
    const path = "scroll-review.ts";
    f.changes.files.push({ ...f.changes.files[0], path, side: "unstaged" });
    const diff = structuredClone(f.diffs[f.changes.files[0].path]);
    Object.assign(diff, {
      path,
      id: "scroll-review",
      token: "scroll-review",
      side: "unstaged",
      additions: 240,
      deletions: 0,
    });
    diff.hunks = [
      {
        ...diff.hunks[0],
        id: "scroll-review-hunk",
        header: "@@ -0,0 +1,240 @@",
        lines: Array.from({ length: 240 }, (_, index) => ({
          kind: "add",
          oldLine: null,
          newLine: index + 1,
          content: `const reviewScroll${index} = ${index};`,
        })),
      },
    ];
    f.diffs[path] = diff;
    f.changes.token = "scroll-review-changes";
    f.emitNativeEvent("workspace-invalidated", f.changes.workspace.id);
  });
  await page
    .locator(".tree-file")
    .filter({ hasText: "scroll-review.ts" })
    .click();
  await expect(page.locator(".diff-file-header")).toContainText(
    "scroll-review.ts",
  );
  await page.getByRole("button", { name: "显示上下文", exact: true }).click();
  await page.getByRole("button", { name: "AI Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Review 当前变更", exact: true })
    .click();
  await expect(page.locator(".ai-finding")).toContainText(
    "Missing boundary validation",
  );
  return page.locator(".center-panel").first();
}

for (const side of ["unified", "new"] as const) {
  test(`Review comments survive scrolling out of view and back in ${side} mode`, async ({
    page,
  }) => {
    const center = await openScrollingReview(page);
    if (side === "new")
      await center
        .getByRole("button", { name: "并排视图", exact: true })
        .click();
    const bubble = center.locator(".ai-inline-review");
    await expect(bubble).toBeVisible();
    await bubble.getByRole("button", { name: "采纳", exact: true }).click();
    await expect(bubble.locator(".finding-decision")).toHaveText("已采纳");
    await setEditorScroll(center, { scrollTop: 2200 }, side);
    await expect(bubble).toHaveCount(0);
    await setEditorScroll(center, { scrollTop: 0 }, side);
    await expect(
      bubble,
      "Review comment must be mounted again when its code returns to the viewport",
    ).toBeVisible();
    await expect(bubble.locator(".finding-decision")).toHaveText("已采纳");
    await expect(
      bubble.getByRole("button", { name: "不采纳", exact: true }),
    ).toBeEnabled();
  });
}

test("Review exports selected findings as copyable instructions and a Markdown file", async ({
  page,
}) => {
  await openScrollingReview(page);
  const panel = page.locator(".ai-review-panel");
  await panel
    .locator(".ai-finding")
    .getByRole("button", { name: "采纳", exact: true })
    .click();
  await expect(panel.locator(".finding-decision")).toHaveText("已采纳");
  await page.evaluate(() => {
    const w = window as any,
      f = w.fixture;
    const report = Object.values(f.aiReports)[0] as any;
    const finding = report.review.findings[0];
    report.review.findings.push(
      {
        ...finding,
        title: "Add cleanup test",
        description: "Cover cleanup failure",
        suggestion: "Assert cleanup on an error path",
        line: 120,
        endLine: 121,
      },
      {
        ...finding,
        title: "Keep existing response",
        description: "Dismissed feedback",
        suggestion: "Do not include this by default",
        line: 230,
        endLine: 231,
      },
    );
    report.decisions.push("pending", "dismissed");
    report.revision++;
    window.dispatchEvent(
      new CustomEvent("proof:ai-review-updated", {
        detail: {
          workspaceId: report.scope.workspaceId,
          scope: "local",
          reportId: report.id,
          revision: report.revision,
        },
      }),
    );
    w.reviewExport = {
      copied: "",
      saves: [],
      mode: "cancel",
      copyFails: false,
    };
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text: string) => {
        if (w.reviewExport.copyFails) throw new Error("Clipboard unavailable");
        w.reviewExport.copied = text;
      },
    });
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (payload?.command === "save_review_instructions") {
        w.reviewExport.saves.push(payload.args);
        if (w.reviewExport.mode === "cancel") return null;
        if (w.reviewExport.mode === "fail")
          throw {
            code: "REVIEW_EXPORT_FAILED",
            message: "修改说明未能保存，请检查目标位置和权限。",
            detail: "fixture write failure",
          };
        return { path: "/exports/proof-review.md" };
      }
      return original(name, payload);
    };
  });
  await expect(panel.locator(".ai-finding")).toHaveCount(3);
  await panel
    .getByRole("button", { name: "导出给 Agent", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "导出修改建议",
    exact: true,
  });
  const preview = dialog.getByRole("textbox", { name: "给 Agent 的修改说明" });
  await expect(
    dialog.getByRole("checkbox", {
      name: "Missing boundary validation",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Add cleanup test", exact: true }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole("checkbox", {
      name: "Keep existing response",
      exact: true,
    }),
  ).not.toBeChecked();
  await expect(preview).toHaveValue(/Missing boundary validation/);
  expect(await preview.inputValue()).not.toMatch(
    /Add cleanup test|Keep existing response/,
  );
  await dialog
    .getByRole("checkbox", { name: "Add cleanup test", exact: true })
    .check();
  await expect(preview).toHaveValue(/L120–L121/);
  const content = await preview.inputValue();
  await dialog
    .getByRole("button", { name: "复制修改说明", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("修改说明已复制");
  expect(await page.evaluate(() => (window as any).reviewExport.copied)).toBe(
    content,
  );
  await dialog
    .getByRole("button", { name: "保存 Markdown…", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "保存 Markdown…", exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByRole("status")).toBeEmpty();
  await page.evaluate(() => {
    (window as any).reviewExport.mode = "fail";
  });
  await dialog
    .getByRole("button", { name: "保存 Markdown…", exact: true })
    .click();
  await expect(dialog.locator(".modal-error")).toContainText(
    "修改说明未能保存",
  );
  await expect(preview).toHaveValue(content);
  await page.evaluate(() => {
    (window as any).reviewExport.mode = "success";
  });
  await dialog
    .getByRole("button", { name: "保存 Markdown…", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "/exports/proof-review.md",
  );
  expect(
    await page.evaluate(
      () => (window as any).reviewExport.saves.at(-1).markdown,
    ),
  ).toBe(content);
  expect(
    await page.evaluate(() =>
      Object.hasOwn((window as any).reviewExport.saves.at(-1), "path"),
    ),
  ).toBe(false);
  await page.screenshot({
    path: ".artifacts/review-export/export-light.png",
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "清空选择", exact: true }).click();
  await expect(preview).toHaveValue("");
  await expect(
    dialog.getByRole("button", { name: "复制修改说明", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "保存 Markdown…", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "选择已采纳", exact: true }).click();
  await page.evaluate(() => {
    (window as any).reviewExport.copyFails = true;
  });
  await dialog
    .getByRole("button", { name: "复制修改说明", exact: true })
    .click();
  await expect(dialog.locator(".modal-error")).toContainText("手动复制");
  await expect(preview).toHaveValue(/Missing boundary validation/);
  await preview.focus();
  await preview.press("Meta+a");
  expect(
    await preview.evaluate(
      (node) =>
        (node as HTMLTextAreaElement).selectionEnd -
        (node as HTMLTextAreaElement).selectionStart,
    ),
  ).toBe((await preview.inputValue()).length);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "导出给 Agent", exact: true }),
  ).toBeFocused();
  const state = await page.evaluate(() => {
    const f = (window as any).fixture;
    return {
      decisions: (Object.values(f.aiReports)[0] as any).decisions,
      calls: f.actions
        .filter((a: any) =>
          ["run_ai_task", "stage", "commit", "mark_reviewed"].includes(
            a.command,
          ),
        )
        .map((a: any) => a.command),
    };
  });
  expect(state.decisions).toEqual(["accepted", "pending", "dismissed"]);
  expect(state.calls).toEqual(["run_ai_task"]);
});

test("Historical Review exports frozen refs and current language in a narrow window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await openFixture(page, true, true);
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await page
    .getByRole("listbox", { name: "提交列表与分支关系" })
    .getByRole("option")
    .first()
    .dblclick();
  const tab = page.locator(".diff-tab-page:not([hidden])");
  await expect(tab.locator(".diff-file-header")).toBeVisible();
  await tab.getByRole("button", { name: "AI Review", exact: true }).click();
  await tab
    .getByRole("button", { name: "Review 当前变更", exact: true })
    .click();
  const panel = tab.locator(".ai-review-panel");
  await expect(panel.locator(".ai-finding")).toBeVisible();
  await panel
    .getByRole("button", { name: "导出给 Agent", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "导出修改建议", exact: true });
  await expect(
    dialog.getByRole("button", { name: "复制修改说明", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "全选", exact: true }).click();
  const scope = await page.evaluate(
    () => (Object.values((window as any).fixture.aiReports)[0] as any).scope,
  );
  const preview = dialog.getByRole("textbox");
  expect(await preview.inputValue()).toContain(scope.base);
  expect(await preview.inputValue()).toContain(scope.target);
  await page.evaluate(async () => {
    const { setLanguage } = await import(/* @vite-ignore */ "/src/i18n.ts");
    setLanguage("en");
    document.documentElement.setAttribute("data-theme", "dark");
  });
  dialog = page.getByRole("dialog", {
    name: "Export review fixes",
    exact: true,
  });
  await expect(dialog.getByRole("textbox")).toHaveValue(
    /Verify and address each selected Review finding/,
  );
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(720);
  await expect(
    dialog.getByRole("button", { name: "Copy instructions", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: ".artifacts/review-export/export-dark-en.png",
    animations: "disabled",
  });
});

for (const historical of [false, true]) {
  test(`Review comments and decisions restore after reload in ${historical ? "historical Diff" : "Local changes"}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openFixture(page, true, true);
    async function openReview() {
      if (historical) {
        await page
          .getByRole("navigation", { name: "Worktree" })
          .getByRole("tab", { name: "History", exact: true })
          .click();
        await page
          .getByRole("listbox", { name: "提交列表与分支关系" })
          .getByRole("option")
          .first()
          .dblclick();
        const tab = page.locator(".diff-tab-page:not([hidden])");
        await expect(tab.locator(".diff-file-header")).toBeVisible();
        await tab
          .getByRole("button", { name: "AI Review", exact: true })
          .click();
        return tab;
      }
      await page
        .getByRole("button", { name: "显示上下文", exact: true })
        .click();
      await page
        .getByRole("button", { name: "AI Review", exact: true })
        .click();
      return page.locator(".changes-page");
    }
    // Local changes container is mounted even while other tabs are open.
    let region = await openReview();
    if (!historical) region = page.locator(".app");
    await region
      .getByRole("button", { name: "Review 当前变更", exact: true })
      .click();
    await expect(region.locator(".ai-finding")).toContainText(
      "Missing boundary validation",
    );
    await region
      .getByRole("button", { name: "Missing boundary validation", exact: true })
      .click();
    await expect(region.locator(".monaco-editor .is-finding-target")).toHaveCount(2);
    const bubble = region.locator(".ai-inline-review").first();
    await expect(bubble).toBeVisible();
    await expect(bubble.locator("summary")).toContainText("修改后 3–4");
    await bubble.getByRole("button", { name: "采纳", exact: true }).click();
    await expect(region.locator(".ai-finding .finding-decision")).toHaveText(
      "已采纳",
    );
    await bubble.locator("summary").click();
    await expect(bubble.locator(".inline-review-body")).toBeHidden();
    await page.reload();
    await page
      .getByRole("button", {
        name: "demo-service /demo/demo-service",
        exact: true,
      })
      .click();
    await expect(page.locator(".diff-file-header")).toBeVisible();
    region = await openReview();
    if (!historical) region = page.locator(".app");
    await expect(region.locator(".ai-finding .finding-decision")).toHaveText(
      "已采纳",
    );
    expect(
      await page.evaluate(() =>
        (window as any).fixture.actions.filter(
          (a: any) => a.command === "run_ai_task",
        ),
      ),
    ).toHaveLength(0);
    await region
      .locator(".ai-finding")
      .getByRole("button", { name: "不采纳", exact: true })
      .click();
    await expect(
      region.locator(".ai-inline-review .finding-decision"),
    ).toHaveText("不采纳");
    await region
      .getByRole("button", { name: "Review 当前变更", exact: true })
      .click();
    await region.getByRole("combobox", {name:"Review 记录"}).click();
    await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await chooseOption(region
      .getByRole("combobox", { name: "Review 记录" }),{ index: 1 });
    await expect(region.locator(".ai-finding .finding-decision")).toHaveText(
      "不采纳",
    );
    await region
      .locator(".ai-finding")
      .getByRole("button", { name: "撤销", exact: true })
      .click();
    await expect(
      region.locator(".ai-inline-review .finding-decision"),
    ).toHaveText("待处理");
    expect(
      await page.evaluate(() =>
        (window as any).fixture.actions.filter((a: any) =>
          [
            "stage",
            "commit",
            "mark_reviewed",
            "mark_comparison_reviewed",
          ].includes(a.command),
        ),
      ),
    ).toHaveLength(0);
    if (historical) {
      await region
        .getByRole("button", { name: "并排视图", exact: true })
        .click();
      await region
        .getByRole("button", {
          name: "Missing boundary validation",
          exact: true,
        })
        .click();
      await expect(
        region.locator('.proof-code-editor[data-code-side="new"] .is-finding-target'),
      ).toHaveCount(2);
      await expect(
        region.locator('.proof-code-editor[data-code-side="old"] .is-finding-target'),
      ).toHaveCount(0);
      await expect(
        region.locator(".proof-code-editor[data-code-side='new'] .ai-inline-review"),
      ).toBeVisible();
    }
    const reviewBounds=await region.locator(".proof-code-editor:has(.ai-inline-review)").evaluate(node=>{
      const editor=node.getBoundingClientRect(),bubble=node.querySelector(".ai-inline-review")!.getBoundingClientRect();
      const buttons=[...node.querySelectorAll(".ai-inline-review button")].map(button=>button.getBoundingClientRect().right);
      return {editorRight:editor.right,bubbleRight:bubble.right,buttons,variables:getComputedStyle(node).getPropertyValue("--editor-width")};
    });
    expect(reviewBounds.bubbleRight,JSON.stringify(reviewBounds)).toBeLessThanOrEqual(reviewBounds.editorRight);
    expect(Math.max(...reviewBounds.buttons)).toBeLessThanOrEqual(reviewBounds.editorRight);
    await page.screenshot({
      path: `.artifacts/review-comments/${historical ? "history" : "local"}.png`,
    });
  });
}

test("Local file loading stays inside the center and can be cancelled", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFixture(page, true);
  const center = page.locator(".center-panel").first();
  const before = await center.boundingBox();
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.delay = 1800;
    const path = "review-loading.ts";
    f.changes.files.push({ ...f.changes.files[0], path });
    f.diffs[path] = {
      ...structuredClone(f.diffs[f.changes.files[0].path]),
      path,
      id: "loading-new-file",
      token: "loading-new-token",
    };
    f.changes.token = "loading-version";
    f.emitNativeEvent("workspace-invalidated", f.changes.workspace.id);
  });
  await page
    .locator(".tree-file")
    .filter({ hasText: "review-loading.ts" })
    .click();
  await expect(center.locator(".diff-loading")).toContainText("载入 Diff");
  expect(await center.boundingBox()).toEqual(before);
  const notice = (await center.locator(".diff-loading").boundingBox())!;
  expect(notice.x).toBeGreaterThanOrEqual(before!.x);
  expect(notice.x + notice.width).toBeLessThanOrEqual(
    before!.x + before!.width,
  );
  await center.getByRole("button", { name: "取消读取", exact: true }).click();
  await expect(center.locator(".diff-loading")).toHaveCount(0);
  expect(await center.boundingBox()).toEqual(before);
});

test("Review decisions reconcile peer updates arriving during a save", async ({
  page,
}) => {
  await openFixture(page, false, true);
  await page.getByRole("button", { name: "显示上下文", exact: true }).click();
  await page.getByRole("button", { name: "AI Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Review 当前变更", exact: true })
    .click();
  await expect(page.locator(".ai-finding")).toBeVisible();
  await page.evaluate(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (
      name: string,
      payload: any = {},
    ) => {
      const value = await original(name, payload);
      if (payload.command === "set_ai_finding_decision")
        await new Promise<void>((resolve) => {
          (window as any).fixture.decisionRelease = resolve;
        });
      return value;
    };
  });
  await page
    .locator(".ai-finding")
    .getByRole("button", { name: "采纳", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => !!(window as any).fixture.decisionRelease))
    .toBe(true);
  await page.evaluate(() => {
    const f = (window as any).fixture;
    const report = Object.values(f.aiReports)[0] as any;
    report.decisions[0] = "dismissed";
    report.revision++;
    window.dispatchEvent(
      new CustomEvent("proof:ai-review-updated", {
        detail: {
          workspaceId: report.scope.workspaceId,
          scope: "local",
          reportId: report.id,
          revision: report.revision,
        },
      }),
    );
    f.decisionRelease();
  });
  await expect(page.locator(".ai-finding .finding-decision")).toHaveText(
    "不采纳",
  );
  await expect(page.locator(".ai-inline-review .finding-decision")).toHaveText(
    "不采纳",
  );
  await page.getByRole("button", { name: "并排视图", exact: true }).click();
  await page.evaluate(() => {
    const f = (window as any).fixture;
    const report = Object.values(f.aiReports)[0] as any;
    Object.assign(report.review.findings[0], {
      line: 5,
      endLine: 6,
      lineSide: "old",
    });
    report.revision++;
    window.dispatchEvent(
      new CustomEvent("proof:ai-review-updated", {
        detail: {
          workspaceId: report.scope.workspaceId,
          scope: "local",
          reportId: report.id,
          revision: report.revision,
        },
      }),
    );
  });
  await expect(page.locator(".ai-finding .ai-location")).toContainText(
    "修改前 5–6",
  );
  await page
    .getByRole("button", { name: "Missing boundary validation", exact: true })
    .click();
  await expect(
    page.locator('.proof-code-editor[data-code-side="old"] .is-finding-target'),
  ).toHaveCount(2);
  await expect(
    page.locator('.proof-code-editor[data-code-side="new"] .is-finding-target'),
  ).toHaveCount(0);
  await expect(page.locator(".proof-code-editor[data-code-side='old'] .ai-inline-review")).toBeVisible();
});

test("i18n switches immediately, retains drafts and persists after reopening", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFixture(page, false, true);
  await openCommit(page);
  const draft = "不要翻译这个 Commit message / keep this draft";
  await page
    .getByRole("textbox", { name: "Commit message", exact: true })
    .fill(draft);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await chooseOption(page.locator("#ui-language"),"en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("heading", { name: "Appearance and reading", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Agent observation", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Commit message", exact: true }),
  ).toHaveValue(draft);
  await page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("tab", { name: /^Local changes/ })
    .click();
  await expect(
    page.getByRole("button", { name: "AI Group Changes", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Full file", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".diff-file-header")).toContainText("requests.ts");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("validateRequest");
  const before=await page.locator(".monaco-editor .view-lines").textContent();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page
    .getByRole("button", {
      name: "demo-service /demo/demo-service",
      exact: true,
    })
    .click();
  await expect(page.locator(".diff-file-header")).toContainText("requests.ts");
  await expect(page.locator(".monaco-editor .view-lines")).toHaveText(before!);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await chooseOption(page.locator("#ui-language"),"zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "AI 分组", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).fixture.actions.filter((a: any) =>
        [
          "run_ai_task",
          "stage",
          "stage_files",
          "commit",
          "mark_reviewed",
        ].includes(a.command),
      ),
    ),
  ).toHaveLength(0);
  await page.screenshot({ path: ".artifacts/i18n/zh-local.png" });
});

test("i18n translates backend errors and keeps a failed language save unchanged", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFixture(page, false, true);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await chooseOption(page.locator("#ui-language"),"en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.evaluate(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (
      name: string,
      payload: any = {},
    ) => {
      if (payload.command === "set_ui_language")
        throw {
          code: "STORAGE_ERROR",
          message: "本地记录未能保存，请检查存储空间和权限。",
          detail: "fixture storage failure",
        };
      return original(name, payload);
    };
  });
  await chooseOption(page.locator("#ui-language"),"zh-CN");
  await expect(page.getByRole("alert").filter({hasText:/\S/})).toContainText(
    "Could not save the language setting",
  );
  await expect(page.getByRole("alert").filter({hasText:/\S/})).toContainText(
    "Local records could not be saved",
  );
  await expect(page.locator("#ui-language")).toHaveAttribute("data-value","en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.screenshot({ path: ".artifacts/i18n/en-settings.png" });
});

test("i18n reconciles peer language changes during saving without replacing the selected Diff", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFixture(page, false, true);
  await page
    .locator(".tree-file")
    .filter({ hasText: "response.ts" })
    .first()
    .click();
  await expect(page.locator(".diff-file-header")).toContainText("response.ts");
  const source = await page.locator(".diff-scroll code").allTextContents();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.evaluate(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (
      name: string,
      payload: any = {},
    ) => {
      if (payload.command === "ui_language")
        (window as any).fixture.languageReads =
          ((window as any).fixture.languageReads ?? 0) + 1;
      const result = await original(name, payload);
      if (payload.command === "set_ui_language")
        await new Promise<void>((resolve) => {
          (window as any).fixture.languageRelease = resolve;
        });
      return result;
    };
  });
  await chooseOption(page.locator("#ui-language"),"en");
  await expect
    .poll(() => page.evaluate(() => !!(window as any).fixture.languageRelease))
    .toBe(true);
  await page.evaluate(() => {
    sessionStorage.setItem("proof-test-language", "zh-CN");
    (window as any).fixture.emitNativeEvent("proof:language-updated", {
      origin: "peer",
      detail: {},
    });
    (window as any).fixture.languageRelease();
  });
  await expect(page.locator("#ui-language")).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.evaluate(() => {
    sessionStorage.setItem("proof-test-language", "en");
    (window as any).fixture.emitNativeEvent("proof:language-updated", {
      origin: "peer",
      detail: {},
    });
  });
  await expect(
    page.getByRole("heading", { name: "Appearance and reading", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: ".artifacts/i18n/en-settings-ready.png" });
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.locator(".diff-file-header")).toContainText("response.ts");
  expect(await page.locator(".diff-scroll code").allTextContents()).toEqual(
    source,
  );
  const reads = await page.evaluate(
    () => (window as any).fixture.languageReads,
  );
  await page.evaluate(async () => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "proof:draft:v0:e0:workflow-test",
        newValue: "user draft",
      }),
    );
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  expect(await page.evaluate(() => (window as any).fixture.languageReads)).toBe(
    reads,
  );
  await page.screenshot({ path: ".artifacts/i18n/en-local.png" });
});

test("migrated panels save user resizing, cancel Escape and keep narrow fitting temporary",async({page})=>{
  await openFixture(page,true);
  const files=page.getByRole("tabpanel",{name:/^本地变更/}).locator(".files-panel"),handle=page.getByRole("separator",{name:"变化文件",exact:true});
  const start=(await files.boundingBox())!.width;
  const drag=async(dx:number,cancel=false)=>{await handle.focus();const b=(await handle.boundingBox())!;await page.mouse.move(b.x+b.width/2,b.y+120);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+120,{steps:10});if(cancel)await page.keyboard.press("Escape");await page.mouse.up();};
  await drag(64);
  await expect.poll(async()=>Math.round((await files.boundingBox())!.width)).toBe(Math.round(start+64));
  const writes=()=>page.evaluate(()=>(window as any).fixture.actions.filter((a:any)=>a.command==="set_repository_layout"));
  await expect.poll(async()=>(await writes()).length).toBe(1);
  await handle.press("ArrowLeft");
  await expect.poll(async()=>(await writes()).length).toBe(2);
  const before=(await files.boundingBox())!.width;
  await drag(80,true);
  await expect.poll(async()=>Math.round((await files.boundingBox())!.width)).toBe(Math.round(before));
  expect((await writes()).length).toBe(2);
  await page.setViewportSize({width:850,height:760});
  await expect(page.locator(".center-panel")).toBeVisible();
  expect((await writes()).length).toBe(2);
  await page.getByRole("button",{name:"显示上下文",exact:true}).click();
  await page.getByRole("button",{name:"AI Review",exact:true}).click();
  await expect(page.getByRole("button",{name:"Review 全部变更",exact:true})).toBeVisible();
});

test("dragging files changes logical groups without Git writes",async({page})=>{
  await openFixture(page,true,true);
  await page.getByRole("button",{name:"AI 分组",exact:true}).click();
  const first=page.locator('.change-group-file [role="combobox"]').first();
  await chooseOption(first,"new");
  await expect(page.locator('[data-drop-group="1"]')).toBeVisible();
  const source=page.locator('[data-drop-group="0"] .group-drag-handle').first();
  const path=(await source.getAttribute("aria-label"))!.replace(/^拖动 /,"").replace(/ 到其他分组$/,"");
  const from=(await source.boundingBox())!,to=(await page.locator('[data-drop-group="1"] header').boundingBox())!;
  await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:15});await page.mouse.up();
  await expect.poll(()=>page.evaluate(path=>(window as any).fixture.aiGroups.groups[1].files.includes(path),path)).toBe(true);
  const actions=await page.evaluate(()=>(window as any).fixture.actions);
  expect(actions.filter((a:any)=>["stage","stage_files","commit","mark_reviewed"].includes(a.command))).toHaveLength(0);
  expect(actions.filter((a:any)=>a.command==="run_ai_task")).toHaveLength(1);
});

test("Diff tabs separate click activation from drag and keyboard ordering",async({page})=>{
  await openFixture(page,true);
  const history=page.getByRole("tab",{name:"History",exact:true}),tabs=page.locator(".diff-tab-button");
  await history.click();await page.getByRole("listbox",{name:"提交列表与分支关系"}).getByRole("option").nth(0).dblclick();
  await history.click();await page.getByRole("listbox",{name:"提交列表与分支关系"}).getByRole("option").nth(1).dblclick();
  const before=await tabs.allTextContents();expect(before).toHaveLength(2);
  const from=(await tabs.last().boundingBox())!,to=(await tabs.first().boundingBox())!;
  await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:12});await page.mouse.up();
  await expect.poll(()=>tabs.allTextContents()).toEqual([before[1],before[0]]);
  await history.click();await tabs.first().click();await expect(tabs.first()).toHaveAttribute("aria-selected","true");
  await tabs.first().press("Meta+Shift+ArrowRight");await expect.poll(()=>tabs.allTextContents()).toEqual(before);
});


test("Agent activity stays scoped, shows quiet elapsed time and cancels both task types", async ({ page }) => {
  await page.clock.install();
  await openFixture(page, false, true);
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("validateRequest");
  await page.evaluate(() => { (window as any).fixture.aiHold = true; });
  await page.getByRole("button", { name: "AI 分组", exact: true }).click();
  const progress = page.getByRole("region", { name: "Agent 活动", exact: true });
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("正在收集变更");
  await expect.poll(() => page.evaluate(() => (window as any).fixture.aiTicket)).not.toBe("");
  const groupingTicket = await page.evaluate(() => (window as any).fixture.aiTicket);
  await page.evaluate(() => {
    const fixture = (window as any).fixture;
    fixture.emitNativeEvent("proof://ai-progress", { ticket: "another-window", event: { phase: "reading", path: "private-other-task.ts" } });
  });
  await expect(progress).not.toContainText("private-other-task.ts");
  await page.evaluate(() => {
    const fixture = (window as any).fixture;
    fixture.emitNativeEvent("proof://ai-progress", { ticket: fixture.aiTicket, event: { phase: "searching", path: "src/api/requests.ts" } });
  });
  await expect(progress).toContainText("正在搜索代码");
  await expect(progress).toContainText("src/api/requests.ts");
  await page.clock.fastForward(16_000);
  await expect(progress).toContainText("等待 Agent 新活动，任务仍在运行。");
  await expect(progress.getByLabel("运行时长")).toHaveText("0:16");
  await progress.getByText("查看活动", { exact: true }).click();
  await expect(progress.getByRole("list", { name: "活动记录" })).toContainText("src/api/requests.ts");
  await page.screenshot({ path: ".artifacts/agent-activity/grouping.png", animations: "disabled" });
  await progress.getByRole("button", { name: "取消", exact: true }).click();
  await expect(progress).toBeHidden();
  await expect(page.locator(".ai-error")).toContainText("AI 分析已取消");
  await page.getByRole("button", { name: "显示上下文", exact: true }).click();
  await page.getByRole("button", { name: "AI Review", exact: true }).click();
  await page.getByRole("button", { name: "Review 全部变更", exact: true }).click();
  await expect(progress).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.aiTicket)).not.toBe(groupingTicket);
  await page.evaluate((ticket) => {
    const fixture = (window as any).fixture;
    fixture.emitNativeEvent("proof://ai-progress", { ticket, event: { phase: "reading", path: "late-old-task.ts" } });
    fixture.emitNativeEvent("proof://ai-progress", { ticket: fixture.aiTicket, event: { phase: "reading", path: "src/lib/validation.ts" } });
  }, groupingTicket);
  await expect(progress).toContainText("src/lib/validation.ts");
  await expect(progress).not.toContainText("late-old-task.ts");
  await page.screenshot({ path: ".artifacts/agent-activity/review.png", animations: "disabled" });
  await progress.getByRole("button", { name: "取消", exact: true }).click();
  await expect(progress).toBeHidden();
});


test("blocked Agent analysis is an error in Grouping and Review, never an empty success report", async ({ page }) => {
  await openFixture(page, false, true);
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, payload: any) => {
      if (payload?.command === "run_ai_task") throw {
        code: "AI_ANALYSIS_BLOCKED",
        message: "Agent 未能完成分析，请查看失败详情后重试。",
        detail: "Unable to read manifest.json: code-mode host is disabled",
      };
      return original(name, payload);
    };
  });
  await page.getByRole("button", { name: "AI 分组", exact: true }).click();
  await expect(page.locator(".change-groups .ai-error")).toContainText("Agent 未能完成分析");
  await expect(page.locator(".group-toggle")).toHaveCount(0);
  await page.getByRole("button", { name: "显示上下文", exact: true }).click();
  await page.getByRole("button", { name: "AI Review", exact: true }).click();
  await page.getByRole("button", { name: "Review 全部变更", exact: true }).click();
  const panel = page.locator(".ai-review-panel");
  await expect(panel.locator(".ai-error")).toContainText("Agent 未能完成分析");
  await panel.getByText("失败详情 · AI_ANALYSIS_BLOCKED", { exact: true }).click();
  await expect(panel.locator(".ai-error pre")).toContainText("code-mode host is disabled");
  await expect(panel.locator(".ai-report-meta")).toHaveCount(0);
  await expect(panel.getByText("此次分析未提出 Findings，仍需人工 Review。", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("combobox", { name: "Review 记录", exact: true })).toHaveCount(0);
});
