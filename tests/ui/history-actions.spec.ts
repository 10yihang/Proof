import { chooseOption } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

async function fixture(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), "proof-history-ui-"));
  const repo = join(directory, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Proof UI");
  git("config", "user.email", "ui@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(repo, ".git/hooks"));
  writeFileSync(join(repo, "code.txt"), "initial\n");
  git("add", ".");
  git("commit", "-m", "Initial change\n\nDetails for clipboard");
  git("branch", "feature/ui");
  const remote = join(directory, "remote.git");
  mkdirSync(remote);
  execFileSync("git", ["-C", remote, "init", "--bare", "-b", "main"]);
  git("remote", "add", "origin", remote);
  git("push", "-u", "origin", "main");
  const child = spawn(
    resolve(process.env.PROOF_UI_CORE_BINARY!),
    [join(directory, "data")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending: { resolve: (v: any) => void; reject: (e: any) => void }[] = [];
  let closed = false;
  child.stdin.on("error", (error) => { for (const p of pending.splice(0)) p.reject(error); });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const r = JSON.parse(line),
      p = pending.shift();
    if (r.error) p?.reject(r.error);
    else p?.resolve(r.value);
  });
  child.on("exit", (code) => {
    for (const p of pending.splice(0))
      p.reject(new Error(`Fixture exited ${code}`));
  });
  let queue = Promise.resolve<unknown>(null);
  const calls: string[] = [];
  const invoke = (command: string, args: Record<string, unknown> = {}) => {
    if (closed) return Promise.reject(new Error("Fixture closed"));
    calls.push(command);
    const value = queue
      .catch(() => {})
      .then(
        () =>
          new Promise<any>((resolve, reject) => {
            if (closed) { reject(new Error("Fixture closed")); return; }
            pending.push({ resolve, reject });
            child.stdin.write(JSON.stringify({ command, args }) + "\n");
          }),
      );
    queue = value;
    return value;
  };
  const workspace = await invoke("open_workspace", { path: repo });
  await invoke("set_trust", { workspaceId: workspace.id, trusted: true });
  await page.exposeFunction("historyFixtureInvoke", invoke);
  await page.addInitScript(() =>
    Object.assign(window, {
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: (name: string, payload: any) =>
          name === "prepare_read_request"
            ? Promise.resolve(crypto.randomUUID())
            : name === "cancel_read_request"
              ? Promise.resolve(true)
              : name.startsWith("plugin:event|")
                ? Promise.resolve(1)
                : name === "watch_workspace"
                  ? Promise.resolve(false)
                  : (window as any).historyFixtureInvoke(
                      payload.command,
                      payload.args,
                    ),
      },
    }),
  );
  const open = async (history = true) => {
    await page.goto("/");
    await page.locator(".recent-projects button").first().click();
    if (history) {
      await page.getByRole("tab", { name: "History", exact: true }).click();
      await expect(page.locator(".graph-row").first()).toBeVisible();
    }
  };
  return {
    repo,
    remote,
    git,
    calls,
    invoke,
    workspace,
    open,
    close: () => {
      closed = true;
      child.kill();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test.beforeEach(() =>
  test.skip(
    !process.env.PROOF_UI_CORE_BINARY,
    "Build ui-fixture-driver for native Git tests.",
  ),
);

test("Git basics: Local changes exposes sync controls, branch copy and Push for a different branch", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const f = await fixture(page);
  try {
    await f.invoke("set_ui_language", { language: "en" });
    f.git("switch", "feature/ui");
    writeFileSync(join(f.repo, "feature.txt"), "feature content\n");
    f.git("add", "feature.txt"); f.git("commit", "-m", "Feature to publish");
    const feature = f.git("rev-parse", "HEAD");
    f.git("switch", "main");
    await f.open(false);
    const toolbar = page.getByLabel("Git actions", { exact: true });
    for (const name of ["Fetch", "Pull", "Push", "Stash"]) await expect(toolbar.getByRole("button", { name, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Current Branch actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Copy Branch name", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("main");
    await page.getByRole("combobox", { name: "Switch Branch, current main", exact: true }).click();
    await page.getByRole("button", { name: "Branch actions for feature/ui", exact: true }).click();
    await page.getByRole("menuitem", { name: "Push", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Push", exact: true });
    await expect(dialog.getByLabel("Remote Branch", { exact: true })).toHaveValue("feature/ui");
    await dialog.getByLabel("Remote Branch", { exact: true }).fill("review/ui");
    await expect(dialog.locator(".history-action-direction")).toContainText("feature/ui");
    await dialog.getByRole("button", { name: "Run Push", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(f.git("branch", "--show-current")).toBe("main");
    expect(execFileSync("git", ["-C", f.remote, "rev-parse", "refs/heads/review/ui"], { encoding: "utf8" }).trim()).toBe(feature);
    await page.setViewportSize({ width: 760, height: 820 });
    for (const name of ["Fetch", "Pull", "Push", "Stash"]) await expect(toolbar.getByRole("button", { name, exact: true })).toBeInViewport();
  } finally { f.close(); }
});

test("Git basics: file menus copy paths and batch Discard is confirmed, cancellable and recoverable", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const f = await fixture(page);
  try {
    await f.invoke("set_ui_language", { language: "en" });
    writeFileSync(join(f.repo, "code.txt"), "keep my local edit\n");
    writeFileSync(join(f.repo, "new.txt"), "keep my new file\n");
    await f.open(false);
    await page.getByRole("button", { name: "File actions for code.txt", exact: true }).click();
    await page.getByRole("menuitem", { name: "Copy relative path", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("code.txt");
    await page.getByRole("checkbox", { name: "Select code.txt (unstaged)", exact: true }).check();
    await page.getByRole("checkbox", { name: "Select new.txt (unstaged)", exact: true }).check();
    const discard = page.getByRole("button", { name: "Discard…", exact: true });
    await discard.click();
    const dialog = page.getByRole("dialog", { name: "Confirm discarding unstaged changes", exact: true });
    await expect(dialog.locator(".discard-scope")).toContainText("2 files");
    expect(readFileSync(join(f.repo, "code.txt"), "utf8")).toBe("keep my local edit\n");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await f.invoke("recovery_points", { workspaceId: f.workspace.id })).length).toBe(0);
    await discard.click();
    await dialog.getByRole("button", { name: "Discard selected changes", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(readFileSync(join(f.repo, "code.txt"), "utf8")).toBe("initial\n");
    expect(existsSync(join(f.repo, "new.txt"))).toBe(false);
    expect(f.git("diff", "--cached", "--name-only")).toBe("");
    await page.getByRole("button", { name: "Recover discarded changes…", exact: true }).click();
    const recovery = page.getByRole("dialog", { name: "Discard recovery points", exact: true });
    await recovery.locator("article").filter({ hasText: "new.txt" }).getByRole("button", { name: "Undo discard", exact: true }).click();
    await recovery.getByRole("button", { name: "Confirm restore", exact: true }).click();
    await expect.poll(() => existsSync(join(f.repo, "new.txt"))).toBe(true);
    expect(readFileSync(join(f.repo, "new.txt"), "utf8")).toBe("keep my new file\n");
  } finally { f.close(); }
});

test("Git basics: Stash saves untracked files, Apply keeps the entry and Drop needs confirmation", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.invoke("set_ui_language", { language: "en" });
    writeFileSync(join(f.repo, "code.txt"), "saved local work\n");
    writeFileSync(join(f.repo, "new.txt"), "saved new file\n");
    await f.open(false);
    await page.getByRole("button", { name: "Stash", exact: true }).click();
    const manager = page.getByRole("dialog", { name: "Stashes", exact: true });
    await manager.getByRole("button", { name: "Stash changes…", exact: true }).click();
    const save = page.getByRole("dialog", { name: "Stash changes…", exact: true });
    await save.getByLabel("Stash message (optional)", { exact: true }).fill("Switching tasks");
    await save.getByRole("checkbox", { name: "Include untracked files", exact: true }).check();
    await save.getByRole("button", { name: "Run Stash", exact: true }).click();
    await expect(save).toHaveCount(0);
    expect(existsSync(join(f.repo, "new.txt"))).toBe(false);
    expect(f.git("status", "--porcelain")).toBe("");
    await page.getByRole("button", { name: "Stash", exact: true }).click();
    await expect(manager).toContainText("Switching tasks");
    await manager.getByRole("button", { name: "Apply", exact: true }).click();
    const apply = page.getByRole("dialog", { name: "Apply Stash…", exact: true });
    await apply.getByRole("button", { name: "Run Apply Stash", exact: true }).click();
    await expect(apply).toHaveCount(0);
    expect(readFileSync(join(f.repo, "code.txt"), "utf8")).toBe("saved local work\n");
    expect(readFileSync(join(f.repo, "new.txt"), "utf8")).toBe("saved new file\n");
    await page.getByRole("button", { name: "Stash", exact: true }).click();
    await manager.getByRole("button", { name: "Drop…", exact: true }).click();
    const drop = page.getByRole("dialog", { name: "Drop Stash…", exact: true });
    await expect(drop.getByRole("button", { name: "Run Drop Stash", exact: true })).toBeDisabled();
    await drop.getByRole("checkbox").check();
    await drop.getByRole("button", { name: "Run Drop Stash", exact: true }).click();
    await expect(drop).toHaveCount(0);
    expect((await f.invoke("stashes", { workspaceId: f.workspace.id })).length).toBe(0);
    expect(readFileSync(join(f.repo, "code.txt"), "utf8")).toBe("saved local work\n");
  } finally { f.close(); }
});

test("Git basics: toolbar and file actions remain readable in light, dark and narrow layouts", async ({ page }) => {
  const f = await fixture(page);
  const shots = resolve(".artifacts/git-basics-0.1.2");
  mkdirSync(shots, { recursive: true });
  try {
    await f.invoke("set_ui_language", { language: "en" });
    mkdirSync(join(f.repo, "src"));
    writeFileSync(join(f.repo, "src/auth.ts"), "export interface Session {\n  token: string;\n  expiresAt: number;\n}\n\nexport function isValid(session: Session) {\n  return session.expiresAt > Date.now();\n}\n");
    writeFileSync(join(f.repo, "code.txt"), "local modification\n");
    for (const theme of ["light", "dark"]) {
      const preferences = await f.invoke("preferences");
      await f.invoke("set_preferences", { preferences: { ...preferences, theme } });
      await f.open(false);
      await page.getByRole("button", { name: "auth.ts U", exact: true }).click();
      await expect(page.locator(".diff-scroll")).toContainText("expiresAt");
      await expect(page.locator(".error-banner")).toHaveCount(0);
      await page.getByRole("button", { name: "File actions for src/auth.ts", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "Discard file changes…", exact: true })).toBeVisible();
      await page.screenshot({ path: join(shots, `git-actions-${theme}.png`) });
      await page.keyboard.press("Escape");
    }
    await page.setViewportSize({ width: 760, height: 820 });
    await expect(page.getByLabel("Git actions", { exact: true }).getByRole("button", { name: "Push", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(shots, "git-actions-narrow.png") });
  } finally { f.close(); }
});
test("entering History fetches remote refs quietly and does not fetch again within a minute", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.invoke("set_ui_language", { language: "en" });
    const head = f.git("rev-parse", "HEAD");
    const remoteGit = (...args: string[]) => execFileSync("git", ["-C", f.remote,
      "-c", "user.name=Proof UI", "-c", "user.email=ui@example.invalid", ...args], { encoding: "utf8" }).trim();
    const tree = remoteGit("rev-parse", "HEAD^{tree}");
    const first = remoteGit("commit-tree", tree, "-p", head, "-m", "Auto fetched remote change");
    remoteGit("update-ref", "refs/heads/main", first);
    await f.open();
    await expect(page.locator(".graph-row").filter({ hasText: "Auto fetched remote change" })).toBeVisible();
    expect(f.git("rev-parse", "refs/remotes/origin/main")).toBe(first);
    expect(f.git("rev-parse", "HEAD")).toBe(head);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
    await page.locator(".graph-row").filter({ hasText: "Initial change" }).click();
    const second = remoteGit("commit-tree", tree, "-p", first, "-m", "Later remote change");
    remoteGit("update-ref", "refs/heads/main", second);
    await page.getByRole("tab", { name: /Local changes/ }).click();
    await page.getByRole("tab", { name: "History", exact: true }).click();
    await expect.poll(() => f.calls.filter((name) => name === "history_auto_fetch").length).toBeGreaterThanOrEqual(2);
    await expect(page.locator(".graph-row.is-active")).toContainText("Initial change");
    expect(f.git("rev-parse", "refs/remotes/origin/main")).toBe(first);
    await expect(page.locator(".graph-row").filter({ hasText: "Later remote change" })).toHaveCount(0);
    f.git("branch", "created-in-terminal");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("button", { name: "created-in-terminal", exact: true })).toBeVisible();
    expect(f.git("rev-parse", "refs/remotes/origin/main")).toBe(first);
  } finally { f.close(); }
});

test("History creates Branch and Tag in English without premature validation errors", async ({
  page,
}) => {
  test.setTimeout(60000);
  const f = await fixture(page);
  try {
    await f.invoke("set_ui_language", { language: "en" });
    await f.open();
    await page
      .getByRole("button", { name: "Create Branch…", exact: true })
      .click();
    const modal = page.getByRole("dialog", {
      name: "Create Branch…",
      exact: true,
    });
    await expect(modal.locator(".history-action-preview")).toHaveText("");
    await expect(modal.getByRole("alert").filter({hasText:/\S/})).toHaveCount(0);
    await expect(
      modal.getByRole("button", { name: "Run Branch", exact: true }),
    ).toBeDisabled();
    await modal
      .getByLabel("Branch name", { exact: true })
      .fill("feature/created");
    await modal
      .getByRole("button", { name: "Run Branch", exact: true })
      .click();
    await expect(modal).not.toBeVisible();
    expect(f.git("branch", "--show-current")).toBe("main");
    await expect(
      page
        .locator(".repository-refs .repo-ref")
        .filter({ hasText: "feature/created" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Selected Commit actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Create Tag…", exact: true })
      .click();
    const tag = page.getByRole("dialog", { name: "Create Tag…", exact: true });
    await tag.getByLabel("Tag name", { exact: true }).fill("v0.2-ui");
    await tag.getByRole("button", { name: "Run Tag", exact: true }).click();
    await expect(tag).not.toBeVisible();
    expect(f.git("rev-parse", "refs/tags/v0.2-ui")).toBe(
      f.git("rev-parse", "HEAD"),
    );
    await expect(
      page.locator(".graph-ref").filter({ hasText: "tag: v0.2-ui" }),
    ).toBeVisible();
  } finally {
    f.close();
  }
});
test("History menus support keyboard, clipboard, real Branch switching and rename", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const f = await fixture(page);
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await f.open();
    expect(f.calls.filter((c) => c === "execute_history_action")).toHaveLength(
      0,
    );
    const openBranch = () =>
      page
        .locator(".repository-refs")
        .getByRole("button", { name: "feature/ui 的 Branch 操作", exact: true })
        .click();
    await openBranch();
    const menu = page.getByRole("menu", { name: "Branch 操作", exact: true });
    await expect(
      menu.getByRole("menuitem", { name: "Switch Branch", exact: true }),
    ).toBeFocused();
    for (const label of [
      "Merge 到当前 Branch…",
      "将当前 Branch Rebase 到这里…",
      "删除 Branch…",
      "复制 Branch 名称",
    ])
      await expect(
        menu.getByRole("menuitem", { name: label, exact: true }),
      ).toBeVisible();
    await menu
      .getByRole("menuitem", { name: "复制 Branch 名称", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("feature/ui");
    await openBranch();
    await page.keyboard.press("Enter");
    let modal = page.getByRole("dialog", {
      name: "Switch Branch",
      exact: true,
    });
    await expect(
      modal.getByRole("button", { name: "执行 Switch", exact: true }),
    ).toBeEnabled();
    await modal
      .getByRole("button", { name: "执行 Switch", exact: true })
      .click();
    await expect(modal).not.toBeVisible();
    expect(f.git("branch", "--show-current")).toBe("feature/ui");
    await expect(page.locator(".branch-picker")).toContainText(
      "feature/ui",
    );
    await openBranch();
    await menu
      .getByRole("menuitem", { name: "重命名 Branch…", exact: true })
      .click();
    modal = page.getByRole("dialog", { name: "重命名 Branch…", exact: true });
    await modal
      .getByRole("textbox", { name: "Branch 名称", exact: true })
      .fill("feature/renamed");
    await modal
      .getByRole("button", { name: "执行 Rename", exact: true })
      .click();
    await expect(modal).not.toBeVisible();
    await expect(
      page
        .locator(".repository-refs .repo-ref")
        .filter({ hasText: "feature/renamed" }),
    ).toBeVisible();
    expect(f.git("branch", "--show-current")).toBe("feature/renamed");
    await page
      .getByRole("button", { name: "所选 Commit 的操作", exact: true })
      .click();
    const commits = page.getByRole("menu", {
      name: "Commit 操作",
      exact: true,
    });
    await commits
      .getByRole("menuitem", { name: "复制 Commit message", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("Initial change\n\nDetails for clipboard");
    await page
      .getByRole("button", { name: "所选 Commit 的操作", exact: true })
      .click();
    await page.keyboard.press("End");
    await page.keyboard.press("Escape");
    await expect(commits).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "所选 Commit 的操作", exact: true }),
    ).toBeFocused();
    await page.screenshot({ path: ".artifacts/history-actions/history.png" });
  } finally {
    f.close();
  }
});
test("History Pull previews explicit direction and Push updates only the selected remote Branch", async ({
  page,
}) => {
  test.setTimeout(60000);
  const f = await fixture(page);
  try {
    // A remote Branch created from a temporary secondary Worktree is fetched into History.
    f.git("switch", "feature/ui");
    writeFileSync(join(f.repo, "remote.txt"), "from remote\n");
    f.git("add", ".");
    f.git("commit", "-m", "Remote update");
    f.git("push", "origin", "feature/ui:main");
    f.git("switch", "main");
    await f.open();
    await page.getByRole("button", { name: "Pull", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Pull", exact: true });
    await expect(modal.locator(".history-action-direction")).toHaveText(
      "origin/main→main",
    );
    await expect(modal.getByLabel("Pull 方式")).toHaveAttribute("data-value","ff-only");
    await modal.getByRole("button", { name: "执行 Pull", exact: true }).click();
    await expect(modal).not.toBeVisible();
    expect(readFileSync(join(f.repo, "remote.txt"), "utf8")).toBe(
      "from remote\n",
    );
    await expect(
      page.locator(".graph-row").filter({ hasText: "Remote update" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Push", exact: true }).click();
    const push = page.getByRole("dialog", { name: "Push", exact: true });
    await push.getByLabel("远程 Branch", { exact: true }).fill("published");
    await push.getByRole("button", { name: "执行 Push", exact: true }).click();
    await expect(push).not.toBeVisible();
    expect(f.git("ls-remote", "origin", "refs/heads/published")).toContain(
      f.git("rev-parse", "HEAD"),
    );
    await expect(
      page
        .locator(".repository-refs .repo-ref")
        .filter({ hasText: "origin/published" }),
    ).toBeVisible();
  } finally {
    f.close();
  }
});
test("History shows conflicts with Stage resolution and Continue, and Reset requires acknowledgment", async ({
  page,
}) => {
  test.setTimeout(60000);
  const f = await fixture(page);
  try {
    f.git("switch", "feature/ui");
    writeFileSync(join(f.repo, "code.txt"), "feature\n");
    f.git("add", ".");
    f.git("commit", "-m", "Feature edit");
    f.git("switch", "main");
    writeFileSync(join(f.repo, "code.txt"), "main\n");
    f.git("add", ".");
    f.git("commit", "-m", "Main edit");
    await f.open();
    await page
      .locator(".repository-refs")
      .getByRole("button", { name: "feature/ui 的 Branch 操作", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Merge 到当前 Branch…", exact: true })
      .click();
    const modal = page.getByRole("dialog", {
      name: "Merge 到当前 Branch…",
      exact: true,
    });
    await expect(modal.locator(".history-action-direction")).toHaveText(
      "feature/ui→main",
    );
    await modal
      .getByRole("button", { name: "执行 Merge", exact: true })
      .click();
    await expect(modal).not.toBeVisible();
    const banner = page.locator(".history-operation-banner");
    await expect(banner).toContainText("Merge 进行中");
    await expect(
      banner.getByRole("button", { name: "继续操作", exact: true }),
    ).toBeDisabled();
    await banner.getByRole("button", { name: "code.txt", exact: true }).click();
    await expect(
      page.locator(".workspace-page:not([hidden]) .diff-panel"),
    ).toContainText("code.txt");
    await page.getByRole("tab", { name: "History", exact: true }).click();
    await expect(banner).toBeVisible();
    writeFileSync(join(f.repo, "code.txt"), "resolved in editor\n");
    // Wait for the normal Worktree poll so the dialog previews the newest content.
    await expect
      .poll(async () => {
        const changes = await f.invoke("changes", {
          workspaceId: f.workspace.id,
        });
        return changes.files.length;
      })
      .toBeGreaterThan(0);
    await banner
      .getByRole("button", { name: "Stage 冲突解决结果", exact: true })
      .click();
    const stage = page.getByRole("dialog", {
      name: "Stage 冲突解决结果",
      exact: true,
    });
    await stage
      .getByRole("button", { name: "执行 Stage", exact: true })
      .click();
    await expect(stage).not.toBeVisible();
    await expect(
      banner.getByRole("button", { name: "继续操作", exact: true }),
    ).toBeEnabled();
    await banner.getByRole("button", { name: "继续操作", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "执行 Continue", exact: true })
      .click();
    await expect(banner).not.toBeVisible();
    expect(f.git("show", "-s", "--format=%P").split(" ")).toHaveLength(2);
    await page
      .getByRole("button", { name: "所选 Commit 的操作", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Reset 当前 Branch 到这里…", exact: true })
      .click();
    const reset = page.getByRole("dialog");
    await chooseOption(reset.getByLabel("Reset 方式"),"hard");
    const execute = reset.getByRole("button", {
      name: "执行 Reset",
      exact: true,
    });
    await expect(execute).toBeDisabled();
    await reset
      .getByRole("checkbox", {
        name: "我确认丢弃受影响的本地修改。",
        exact: true,
      })
      .check();
    await expect(execute).toBeEnabled();
    await reset.getByRole("button", { name: "取消", exact: true }).click();
    await page.setViewportSize({ width: 1024, height: 640 });
    await page
      .getByRole("button", { name: "所选 Commit 的操作", exact: true })
      .click();
    const rect = await page.getByRole("menu").boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(640);
    await page.screenshot({
      path: ".artifacts/history-actions/commit-menu.png",
    });
  } finally {
    f.close();
  }
});
