import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chooseOption, closeReadingTools, openReadingTools } from "./controls";
import { editorState, setEditorScroll, visibleSourcePosition } from "./editor";
import type { Workspace } from "../../src/types";

test.use({ viewport: { width: 1024, height: 720 } });
test.beforeEach(() => {
  test.skip(
    !process.env.PROOF_UI_CORE_BINARY,
    "Build ui-fixture-driver and set PROOF_UI_CORE_BINARY for actual Git integration.",
  );
  test.setTimeout(60000);
});

/** Two identical repository names, real Git/SQLite, and isolated fixture data. */
async function projectsFixture(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), "proof-project-tabs-ui-"));
  const repos = [join(directory, "one/repo"), join(directory, "two/repo")];
  const preserved = repos.map((repo, index) => {
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Proof UI Test");
    git("config", "user.email", "ui@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", join(repo, ".git/hooks"));
    const marker = index === 0 ? "project-one" : "project-two";
    const source =
      Array.from(
        { length: 160 },
        (_, line) => `export const value${line + 1} = "${marker}-${line + 1}";`,
      ).join("\n") + "\n";
    writeFileSync(join(repo, "client.ts"), source);
    git("add", ".");
    git("commit", "-m", "Initial");
    writeFileSync(
      join(repo, "client.ts"),
      source.replace(`${marker}-10`, `${marker}-changed-10`),
    );
    return {
      git,
      head: git("rev-parse", "HEAD"),
      index: readFileSync(join(repo, ".git/index")),
      source: readFileSync(join(repo, "client.ts")),
    };
  });
  const child = spawn(
    resolve(process.env.PROOF_UI_CORE_BINARY!),
    [join(directory, "data")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const pending: {
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }[] = [];
  let queue = Promise.resolve<unknown>(null);
  let stopped = false;
  const rejectPending = (error: Error) => {
    for (const task of pending.splice(0)) task.reject(error);
  };
  child.stdin.on("error", rejectPending);
  child.on("error", (error) => {
    stopped = true;
    rejectPending(error);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line);
    const task = pending.shift();
    if (response.error) task?.reject(response.error);
    else task?.resolve(response.value);
  });
  child.on("exit", (code) => {
    stopped = true;
    rejectPending(new Error(`Project fixture exited ${code}`));
  });
  const invoke = (command: string, args: Record<string, unknown> = {}) => {
    if (stopped) return Promise.reject(new Error("Project fixture is closed"));
    calls.push({ command, args });
    const result = queue
      .catch(() => {})
      .then(() => {
        if (stopped) throw new Error("Project fixture is closed");
        return new Promise<any>((resolve, reject) => {
          pending.push({ resolve, reject });
          child.stdin.write(JSON.stringify({ command, args }) + "\n");
        });
      });
    queue = result;
    return result;
  };
  const close = async () => {
    // Unmount every renderer before stopping Core; welcome also reads data.
    if (!page.isClosed()) await page.close().catch(() => {});
    stopped = true;
    await queue.catch(() => {});
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      });
    }
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const workspaces: Workspace[] = [];
    for (const repo of repos) {
      const workspace = await invoke("open_workspace", { path: repo });
      await invoke("set_trust", { workspaceId: workspace.id, trusted: true });
      await invoke("set_repository_layout", {
        workspaceId: workspace.id,
        layout: {
          ...(await invoke("repository_layout", { workspaceId: workspace.id })),
          contextOpen: false,
        },
      });
      workspaces.push(workspace);
    }
    await invoke("set_preferences", {
      preferences: {
        ...(await invoke("preferences")),
        theme: "dark",
        language: "zh-CN",
      },
    });
    await page.exposeFunction("projectFixtureInvoke", invoke);
    await page.exposeFunction(
      "projectFixtureWatch",
      (args: Record<string, unknown>) => {
        calls.push({ command: "watch_workspace", args });
        return false;
      },
    );
    await page.addInitScript(() => {
      (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: () => {},
      };
      (window as any).__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: (name: string, payload: any = {}) => {
          if (name.startsWith("plugin:event|")) return Promise.resolve(1);
          if (name === "prepare_read_request")
            return Promise.resolve(crypto.randomUUID());
          if (name === "cancel_read_request") return Promise.resolve(true);
          if (name === "watch_workspace")
            return (window as any).projectFixtureWatch(payload);
          return (window as any).projectFixtureInvoke(
            payload.command,
            payload.args,
          );
        },
      };
    });
    const panel = (index: number) =>
      page.locator(
        `.project-session[data-project-id="${workspaces[index].id}"]`,
      );
    const strip = () => page.locator(".project-tab-strip:visible");
    const tab = (index: number) =>
      strip()
        .getByRole("tab")
        .and(
          strip().locator(
            `[aria-controls="project-panel-${workspaces[index].id}"]`,
          ),
        );
    const closeTab = (index: number) =>
      strip().locator(
        `.project-tab-item:has([aria-controls="project-panel-${workspaces[index].id}"]) .project-tab-close`,
      );
    const openSecond = async () => {
      await page.getByRole("button", { name: "打开项目", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "打开仓库",
        exact: true,
      });
      await dialog.getByLabel("本地目录", { exact: true }).fill(repos[1]);
      await dialog
        .getByRole("button", { name: "打开仓库", exact: true })
        .click();
      await expect(panel(1)).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(panel(1).locator(".diff-scroll")).toContainText(
        "project-two-changed-10",
      );
    };
    return {
      repos,
      workspaces,
      calls,
      panel,
      strip,
      tab,
      closeTab,
      openSecond,
      open: async () => {
        await page.goto("/");
        await page
          .locator(".recent-projects button")
          .filter({ hasText: repos[0] })
          .click();
        await expect(panel(0).locator(".diff-scroll")).toContainText(
          "project-one-changed-10",
        );
      },
      assertGitPreserved: () => {
        for (let index = 0; index < repos.length; index++) {
          expect(preserved[index].git("rev-parse", "HEAD")).toBe(
            preserved[index].head,
          );
          expect(readFileSync(join(repos[index], ".git/index"))).toEqual(
            preserved[index].index,
          );
          expect(readFileSync(join(repos[index], "client.ts"))).toEqual(
            preserved[index].source,
          );
        }
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test("same-name projects keep their own view, Commit draft and source position", async ({
  page,
}) => {
  const f = await projectsFixture(page);
  try {
    await f.open();
    const one = f.panel(0);
    const changesDiff = one.locator(".changes-page .diff-panel");
    await (
      await openReadingTools(one)
    )
      .getByRole("button", { name: "全文", exact: true })
      .click();
    await closeReadingTools(one);
    await setEditorScroll(changesDiff, { scrollTop: 1800 });
    const readingPosition = await visibleSourcePosition(changesDiff);
    expect(readingPosition).not.toBeNull();
    const navigation = one.getByRole("navigation", { name: "Worktree" });
    await navigation.getByRole("tab", { name: /^Commit/ }).click();
    await one
      .getByLabel("Commit message", { exact: true })
      .fill("Project one draft");

    await f.openSecond();
    const two = f.panel(1);
    await two
      .getByRole("navigation", { name: "Worktree" })
      .getByRole("tab", { name: /^Commit/ })
      .click();
    await two
      .getByLabel("Commit message", { exact: true })
      .fill("Project two draft");
    await two
      .getByRole("navigation", { name: "Worktree" })
      .getByRole("tab", { name: "History", exact: true })
      .click();
    await expect(f.strip().getByRole("tab")).toHaveCount(2);
    for (let index = 0; index < 2; index++) {
      await expect(f.tab(index)).toHaveText("repo");
      await expect(f.tab(index)).toHaveAttribute(
        "title",
        f.workspaces[index].path,
      );
    }
    const ids = await page
      .locator("[id]")
      .evaluateAll((elements) => elements.map((element) => element.id));
    expect(ids.filter((id) => id.startsWith("project-tab-"))).toHaveLength(
      new Set(ids.filter((id) => id.startsWith("project-tab-"))).size,
    );

    await f.tab(0).click();
    await expect(one).toBeVisible();
    await expect(
      navigation.getByRole("tab", { name: /^Commit/ }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(one.getByLabel("Commit message", { exact: true })).toHaveValue(
      "Project one draft",
    );
    await navigation.getByRole("tab", { name: /本地变更/ }).click();
    await expect
      .poll(() => visibleSourcePosition(changesDiff))
      .toEqual(readingPosition);
    await f.tab(1).click();
    await expect(
      two
        .getByRole("navigation", { name: "Worktree" })
        .getByRole("tab", { name: "History", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await two
      .getByRole("navigation", { name: "Worktree" })
      .getByRole("tab", { name: /^Commit/ })
      .click();
    await expect(two.getByLabel("Commit message", { exact: true })).toHaveValue(
      "Project two draft",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    f.assertGitPreserved();
    await two
      .getByRole("navigation", { name: "Worktree" })
      .getByRole("tab", { name: /本地变更/ })
      .click();
    const currentDiff = two.locator(".changes-page .diff-panel");
    await expect.poll(() => visibleSourcePosition(currentDiff)).not.toBeNull();
    await (
      await openReadingTools(two)
    )
      .getByRole("button", { name: "全文", exact: true })
      .click();
    await closeReadingTools(two);
    const readers = [changesDiff, currentDiff];
    const warmNodes = [];
    const warmIdentities = [];
    const identity = (index: number) =>
      readers[index].evaluate(async (node) => {
        const { monaco } = await import(
          /* @vite-ignore */ "/src/monaco-runtime.ts"
        );
        const editor = monaco.editor
          .getEditors()
          .find((editor: any) => node.contains(editor.getDomNode()));
        const model = editor?.getModel();
        return editor && model
          ? {
              editor: editor.getId(),
              model: model.uri.toString(),
              lines: model.getLineCount(),
            }
          : null;
      });
    for (const index of [0, 1]) {
      await f.tab(index).click();
      await expect
        .poll(async () => (await editorState(readers[index]))?.modelLines ?? 0)
        .toBeGreaterThanOrEqual(160);
      const node = await readers[index]
        .locator(".monaco-editor")
        .elementHandle();
      expect(node).not.toBeNull();
      warmNodes.push(node!);
      const currentIdentity = await identity(index);
      expect(currentIdentity).not.toBeNull();
      warmIdentities.push(currentIdentity);
    }
    const contextReads = f.calls.filter(
      (call) => call.command === "diff_context",
    ).length;
    for (const index of [0, 1, 0, 1]) {
      await f.tab(index).click();
      await expect(f.panel(index)).toBeVisible();
      await expect
        .poll(() =>
          readers[index]
            .locator(".monaco-editor")
            .evaluate((node, previous) => node === previous, warmNodes[index]),
        )
        .toBe(true);
      await expect.poll(() => identity(index)).toEqual(warmIdentities[index]);
      if (index === 0)
        await expect
          .poll(() => visibleSourcePosition(changesDiff))
          .toEqual(readingPosition);
    }
    expect(
      f.calls.filter((call) => call.command === "diff_context").length,
    ).toBe(contextReads);
    f.assertGitPreserved();
    await expect
      .poll(async () => {
        const tab = two.locator(
          '.workspace-sidebar .view-tab[aria-selected="true"]',
        );
        const button = await tab.boundingBox();
        const indicator = await tab
          .locator(".workspace-tab-indicator")
          .boundingBox();
        return button && indicator
          ? Math.abs(button.y - indicator.y)
          : Infinity;
      })
      .toBeLessThan(1);
    await expect(
      two.locator(".workspace-sidebar .view-tab > svg").first(),
    ).toBeVisible();
    await page.mouse.move(950, 690);
    await page.screenshot({
      path: ".artifacts/project-navigation/two-projects-1024-zh-dark.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => visibleSourcePosition(currentDiff)).not.toBeNull();
    await page.screenshot({
      path: ".artifacts/project-navigation/two-projects-1440-zh-dark.png",
      animations: "disabled",
    });
    await two.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: /^(设置|Settings)$/ });
    await settings.getByRole("button", { name: "浅色", exact: true }).click();
    await chooseOption(
      settings.getByRole("combobox", { name: "界面语言", exact: true }),
      "en",
    );
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect.poll(() => visibleSourcePosition(currentDiff)).not.toBeNull();
    await page.mouse.move(1350, 850);
    const label = two.locator(".workspace-sidebar .view-tab-label").first();
    await expect(label).toHaveText("Changes");
    expect(
      await label.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: ".artifacts/project-navigation/two-projects-1440-en-light.png",
      animations: "disabled",
    });
  } finally {
    await f.close();
  }
});

test("returning to a warm project refreshes disk changes made while hidden", async ({
  page,
}) => {
  const f = await projectsFixture(page);
  const path = join(f.repos[0], "client.ts");
  const original = readFileSync(path, "utf8");
  try {
    await f.open();
    const one = f.panel(0);
    const diff = one.locator(".changes-page .diff-panel");
    await (
      await openReadingTools(one)
    )
      .getByRole("button", { name: "全文", exact: true })
      .click();
    await closeReadingTools(one);
    await expect(diff).toContainText("project-one-changed-10");
    await f.openSecond();
    await expect(one).toBeHidden();
    await expect(one).toHaveAttribute("inert", "");
    writeFileSync(
      path,
      original.replace("project-one-changed-10", "project-one-hidden-edit-10"),
    );
    const before = f.calls.length;
    await f.tab(0).click();
    await expect(one).toBeVisible();
    await expect(diff).toContainText("project-one-hidden-edit-10");
    await expect(diff).not.toContainText('"project-one-changed-10"');
    expect(
      f.calls
        .slice(before)
        .some(
          (call) =>
            call.command === "read_file_diff" &&
            call.args.workspaceId === f.workspaces[0].id,
        ),
    ).toBe(true);
    expect(
      f.calls.filter((call) =>
        ["stage", "stage_files", "commit", "switch_branch"].includes(
          call.command,
        ),
      ),
    ).toEqual([]);
    writeFileSync(path, original);
    f.assertGitPreserved();
  } finally {
    writeFileSync(path, original);
    await f.close();
  }
});

test("project keyboard switching focuses the visible tab, pauses hidden polling and closes to welcome", async ({
  page,
}) => {
  const f = await projectsFixture(page);
  try {
    await f.open();
    await f.openSecond();
    await f.tab(1).focus();
    await page.keyboard.press("Control+Tab");
    await expect(f.panel(0)).toBeVisible();
    await expect(f.tab(0)).toBeFocused();
    await page.keyboard.press("Control+Shift+Tab");
    await expect(f.panel(1)).toBeVisible();
    await expect(f.tab(1)).toBeFocused();
    await f.tab(1).press("Home");
    await expect(f.panel(0)).toBeVisible();
    await expect(f.tab(0)).toBeFocused();
    await f.tab(0).press("ArrowRight");
    await expect(f.panel(1)).toBeVisible();
    await expect(f.tab(1)).toBeFocused();

    f.calls.length = 0;
    const reads = (index: number) =>
      f.calls.filter(
        (call) =>
          call.command === "changes" &&
          call.args.workspaceId === f.workspaces[index].id,
      ).length;
    await expect
      .poll(() => reads(1), { timeout: 6000 })
      .toBeGreaterThanOrEqual(2);
    expect(reads(0)).toBe(0);
    await expect(f.panel(0)).toHaveAttribute("inert", "");

    await f.closeTab(1).click();
    await expect(f.strip().getByRole("tab")).toHaveCount(1);
    await expect(f.panel(1)).toHaveCount(0);
    await expect(f.panel(0)).toBeVisible();
    await expect(f.tab(0)).toBeFocused();
    await f.tab(0).click({ button: "middle" });
    await expect(
      page.getByRole("heading", { name: "打开仓库，开始工作" }),
    ).toBeVisible();
    await expect(
      page.locator(".project-tab-strip:visible [role=tab]"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "打开项目", exact: true }),
    ).toBeFocused();
    f.assertGitPreserved();
  } finally {
    await f.close();
  }
});

test("closing an unsaved Files editor asks before discarding its buffer", async ({
  page,
}) => {
  const f = await projectsFixture(page);
  try {
    await f.open();
    await f.openSecond();
    await f.tab(0).click();
    const one = f.panel(0);
    await one
      .getByRole("navigation", { name: "Worktree" })
      .getByRole("tab", { name: "文件", exact: true })
      .click();
    await one
      .locator(".editor-sidebar")
      .getByRole("button", { name: /client\.ts/ })
      .click();
    const editor = one.locator(".editor-main .monaco-editor");
    await expect(editor).toBeVisible();
    await editor.locator(".view-line").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" // unsaved project buffer");
    await expect(one.locator(".editor-dirty-dot").first()).toBeVisible();
    await f.closeTab(0).click();
    const dialog = page.getByRole("dialog", { name: "关闭项目", exact: true });
    await expect(dialog).toContainText("未保存的文件更改");
    await expect(f.panel(0)).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(editor).toContainText("unsaved project buffer");
    await f.tab(1).click();
    await f.tab(0).click();
    await expect(editor).toContainText("unsaved project buffer");
    await f.closeTab(0).click();
    await dialog
      .getByRole("button", { name: "丢弃并关闭", exact: true })
      .click();
    await expect(f.panel(0)).toHaveCount(0);
    await expect(f.panel(1)).toBeVisible();
    f.assertGitPreserved();
  } finally {
    await f.close();
  }
});

test("project switching closes the previous project's Branch popup", async ({
  page,
}) => {
  const f = await projectsFixture(page);
  try {
    await f.open();
    await f.openSecond();
    await f.panel(1).locator(".project-header .branch-picker").click();
    const popup = page.locator(".proof-branch-popup:visible");
    await expect(
      popup.getByRole("listbox", { name: "分支", exact: true }),
    ).toBeVisible();
    await expect(
      popup.locator(".branch-option").filter({ hasText: "main" }),
    ).toBeVisible();
    expect(
      f.calls.some(
        (call) =>
          call.command === "branches" &&
          call.args.workspaceId === f.workspaces[1].id,
      ),
    ).toBe(true);
    await page.keyboard.press("Control+Tab");
    await expect(f.panel(0)).toBeVisible();
    await expect(f.panel(1)).toBeHidden();
    await expect(page.locator(".proof-branch-popup:visible")).toHaveCount(0);
    await expect(
      f.panel(0).locator(".project-header .branch-picker"),
    ).toHaveText("main");
    await expect(f.tab(0)).toBeFocused();
    expect(f.calls.filter((call) => call.command === "switch_branch")).toEqual(
      [],
    );
    f.assertGitPreserved();
  } finally {
    await f.close();
  }
});
