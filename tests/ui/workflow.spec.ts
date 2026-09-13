import { test, expect, type Page } from "@playwright/test";
import { demoChanges, demoDiff } from "../../src/demo";
import { demoGraphPage } from "../../src/graph-demo";
import { defaultPreferences } from "../../src/types";

async function openCommit(page: Page) {
  await page
    .getByRole("navigation", { name: "Worktree" })
    .getByRole("button", { name: /^Commit/ })
    .click();
}

async function openFixture(page: Page) {
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
    ({ changes, diffs, preferences, graph }) => {
      const state = {
        changes,
        diffs,
        calls: [] as string[],
        actions: [] as any[],
        delay: 0,
        failCommit: false,
        expireStage: false,
        reads: 0,
      };
      Object.assign(window, {
        fixture: state,
        __TAURI_INTERNALS__: {
          unregisterCallback: () => {},
          transformCallback: () => 1,
          invoke: async (_: string, { command, args }: any) => {
            if (_.startsWith("plugin:event|")) return 1;
            if (_ === "watch_workspace") return true;
            state.calls.push(command + (args.path ? ":" + args.path : ""));
            state.actions.push({ command, args: structuredClone(args) });
            if (command === "data_session")
              return { epoch: 0, wipeEpoch: 0, deletedWorkspaceIds: [] };
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
            if (command === "file_diff") {
              await new Promise((r) => setTimeout(r, state.delay));
              const diff = structuredClone(state.diffs[args.path]);
              diff.id += `:${++state.reads}`;
              diff.side = args.side;
              return diff;
            }
            if (command === "observer_file_context") return [];
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
            if (command === "compare_file") {
              await new Promise((r) => setTimeout(r, state.delay));
              return {
                ...structuredClone(state.diffs[args.path]),
                canStage: false,
                canStageHunks: false,
                canDiscard: false,
                canDiscardHunks: false,
              };
            }
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
    { changes, diffs, preferences: defaultPreferences, graph: demoGraphPage() },
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
    .getByRole("button", { name: /Changes/, exact: false })
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
        (s: string) => s === "file_diff:src/api/requests.ts",
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

test("branch dropdown switches in place and ignores IME confirmation", async ({
  page,
}) => {
  await openFixture(page);
  await openCommit(page);
  await page.getByLabel("Commit message").fill("Keep this draft");
  await page.getByRole("button", { name: /切换 Branch/ }).click();
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
  ).toContainText("Changes");
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
    .getByRole("button", { name: "Stage selected files", exact: true })
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
  await expect(page.getByRole("alert")).toContainText("Commit failed");
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
    .getByRole("button", { name: "Stage hunk", exact: true })
    .first()
    .click();
  await expect(page.getByRole("alert")).toContainText("Diff 已更新");
  await expect(
    page.getByRole("button", { name: "Stage hunk", exact: true }).first(),
  ).toBeEnabled();
  const calls = await page.evaluate(() =>
    (window as any).fixture.actions.filter(
      (action: any) => action.command === "file_diff",
    ),
  );
  expect(calls).toHaveLength(2);
  await page
    .getByRole("button", { name: "Stage hunk", exact: true })
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
  await page.getByRole("button", { name: /切换 Branch/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Switch branch" }),
  ).toBeVisible();
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
  await page.getByLabel("每处上下文行数").selectOption("10");
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
  await expect(page.getByRole("alert")).toHaveCount(0);
  const readsBefore = await page.evaluate(
    () =>
      (window as any).fixture.actions.filter(
        (action: any) =>
          action.command === "file_diff" &&
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
            action.command === "file_diff" &&
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
  await page
    .getByLabel("默认使用", { exact: true })
    .selectOption("application");
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
    page.getByRole("status").filter({ hasText: "已交给 Zed" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).fixture.editorLaunched),
  ).toBe(true);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "外部编辑器", exact: true })
    .click();
  await page.getByRole("button", { name: "此仓库", exact: true }).click();
  await expect(page.getByLabel("此仓库使用", { exact: true })).toHaveValue(
    "inherit",
  );
  await page.getByLabel("此仓库使用", { exact: true }).selectOption("disabled");
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
  await expect(page.getByRole("alert")).toContainText("编辑器设置未保存");
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
            (action: any) => action.command === "file_diff",
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
  await expect(page.getByRole("alert")).toContainText(
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
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "所选提交详情", exact: true }),
  ).toContainText(demoGraphPage().commits[0].subject);
  await page.getByRole("button", { name: "打开命令面板", exact: true }).click();
  const command = page
    .getByRole("dialog", { name: "命令面板", exact: true })
    .getByRole("button", { name: /在外部编辑器打开/ });
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
    .getByRole("button", { name: /在外部编辑器打开/ });
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
    .getByRole("button", { name: "本地数据", exact: true })
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
  await expect(page.getByLabel("查看范围", { exact: true })).toContainText(
    "Other project",
  );
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
  await page.getByLabel("查看范围", { exact: true }).selectOption("");
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
    .getByRole("button", { name: "外观与阅读", exact: true })
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
    .getByRole("button", { name: "本地数据", exact: true })
    .click();
  await page.getByLabel("查看范围", { exact: true }).selectOption("");
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
      if (command === "file_diff") value.workspaceId = args.workspaceId;
      return value;
    };
  });
  await page
    .getByLabel("查看范围", { exact: true })
    .selectOption("other-workspace");
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

test("History opens selected Commit diffs in closable tabs and preserves graph selection", async ({
  page,
}) => {
  await openFixture(page);
  const navigation = page.getByRole("navigation", { name: "Worktree" });
  await expect(
    navigation.getByRole("button", { name: "Compare", exact: true }),
  ).toHaveCount(0);
  await navigation
    .getByRole("button", { name: "History", exact: true })
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
  await panel.getByRole("button", { name: "Split", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: /Stage|标记|预览丢弃/ }),
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
  await page
    .getByRole("combobox", { name: "比较父提交", exact: true })
    .selectOption("1");
  await page
    .getByRole("button", { name: "在新 tab 中查看 Diff", exact: true })
    .click();
  await expect(page.locator(".diff-tab-item")).toHaveCount(2);
  await expect(
    active.getByRole("combobox", { name: "Diff 比较父提交" }),
  ).toHaveValue("1");
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
    navigation.getByRole("button", { name: "History", exact: true }),
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
    .getByRole("button", { name: "History", exact: true })
    .click();
  const graph = page.getByRole("listbox", { name: "提交列表与分支关系" });
  await graph.getByRole("option").first().dblclick();
  const panel = page
    .locator(".diff-tab-page:not([hidden])")
    .getByRole("region", { name: "历史文件差异" });
  await expect(panel.locator(".compare-empty")).toContainText("正在读取 Diff");
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

test("Hook uses current workspace trust and requires a config preview before installing", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
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
        return [{ agent: "codex", executablePath: "/fixture/codex" }];
      if (c === "observer_status") return structuredClone(hook);
      if (c === "probe_observer")
        return {
          agent: "codex",
          version: "0.153.4",
          status: "candidate_unverified",
          profile: null,
        };
      if (c === "preview_observer_install") {
        preview = {
          id: "hook-preview",
          action: "install",
          agent: "codex",
          agentVersion: "0.153.4",
          workspaceId: a.workspaceId,
          configPath: "/fixture/config/hooks.json",
          before: '{"userHook":true}',
          after: '{"userHook":true,"proofHook":true}',
          fields: a.fields,
          requiresHookTrust: true,
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
            agent: "codex",
            agentVersion: "0.153.4",
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
  });
  await page.getByRole("button", { name: "Agent Hook", exact: true }).click();
  const card = page.getByRole("region", { name: "Codex Hook", exact: true });
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
    "/fixture/config/hooks.json",
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
