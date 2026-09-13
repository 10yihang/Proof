import { test, expect, type Page } from "@playwright/test";
import { demoChanges, demoDiff } from "../../src/demo";
import { demoGraphPage } from "../../src/graph-demo";
import { defaultPreferences } from "../../src/types";

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
    ({ changes, diffs, preferences }) => {
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
    { changes, diffs, preferences: defaultPreferences },
  );
  await page.goto("/");
  await page.locator(".recent-projects button").first().click();
  await expect(page.locator(".diff-file-header")).toContainText("requests.ts");
}

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
  ).toContainText("history-only.txt");
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
