import { test, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

test("actual Git workflow: live save, branch, selected hunk Commit, Amend and Commit all", async ({
  page,
}) => {
  test.skip(
    !process.env.PROOF_UI_CORE_BINARY,
    "Build ui-fixture-driver and set PROOF_UI_CORE_BINARY for actual Git integration.",
  );
  test.setTimeout(60000);
  const directory = mkdtempSync(join(tmpdir(), "proof-workflow-ui-")),
    repo = join(directory, "repo");
  mkdirSync(repo);
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
  mkdirSync(join(repo, "src/api"), { recursive: true });
  const baseline =
    Array.from(
      { length: 100 },
      (_, i) => `export const value${i + 1} = "old-${i + 1}";`,
    ).join("\n") + "\n";
  writeFileSync(join(repo, "src/api/client.ts"), baseline);
  git("add", ".");
  git("commit", "-m", "Initial");
  git("branch", "feature/ui");
  const beforeHead = git("rev-parse", "HEAD");
  writeFileSync(
    join(repo, "src/api/client.ts"),
    baseline
      .replace("old-10", "first-change")
      .replace("old-80", "keep-unstaged"),
  );
  writeFileSync(join(repo, "extra.txt"), "Unselected file\n");
  const child = spawn(
    resolve(process.env.PROOF_UI_CORE_BINARY!),
    [join(directory, "data")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let queue = Promise.resolve<unknown>(null);
  const pending: {
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line),
      task = pending.shift();
    if (response.error) task?.reject(response.error);
    else task?.resolve(response.value);
  });
  child.on("exit", (code) => {
    for (const task of pending.splice(0))
      task.reject(new Error(`Core fixture exited ${code}`));
  });
  const invoke = (command: string, args: Record<string, unknown> = {}) => {
    const result = queue
      .catch(() => {})
      .then(
        () =>
          new Promise<any>((resolve, reject) => {
            pending.push({ resolve, reject });
            child.stdin.write(JSON.stringify({ command, args }) + "\n");
          }),
      );
    queue = result;
    return result;
  };
  try {
    const workspace = await invoke("open_workspace", { path: repo });
    await invoke("set_trust", { workspaceId: workspace.id, trusted: true });
    await page.exposeFunction("fixtureCoreInvoke", invoke);
    await page.addInitScript(() =>
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: (name: string, payload: any) =>
            name.startsWith("plugin:event|")
              ? Promise.resolve(1)
              : name === "watch_workspace"
                ? Promise.resolve(true)
                : (window as any).fixtureCoreInvoke(
                    payload.command,
                    payload.args,
                  ),
        },
      }),
    );
    await page.goto("/");
    await page.locator(".recent-projects button").first().click();
    await page.locator(".tree-file").filter({ hasText: "client.ts" }).click();
    await expect(page.locator(".diff-scroll")).toContainText("first-change");
    writeFileSync(
      join(repo, "src/api/client.ts"),
      readFileSync(join(repo, "src/api/client.ts"), "utf8").replace(
        "first-change",
        "live-save",
      ),
    );
    await expect(page.locator(".diff-scroll")).toContainText("live-save", {
      timeout: 7000,
    });
    await page.getByRole("button", { name: /切换 Branch/ }).click();
    await page.getByLabel("搜索 Branch").fill("feature/ui");
    await page
      .locator(".branch-option")
      .filter({ hasText: "feature/ui" })
      .click();
    await expect(page.locator(".branch-picker")).toContainText("feature/ui");
    expect(git("branch", "--show-current")).toBe("feature/ui");
    await page
      .getByRole("button", { name: "Stage hunk", exact: true })
      .first()
      .click();
    await page
      .getByRole("navigation", { name: "Worktree" })
      .getByRole("button", { name: /^Commit/ })
      .click();
    await expect(page.locator(".composer-hint")).toContainText("1 staged");
    expect(git("show", ":src/api/client.ts")).toContain("live-save");
    expect(git("show", ":src/api/client.ts")).not.toContain("keep-unstaged");
    await page.getByLabel("Commit message").fill("Selected hunk from UI");
    await page.locator(".composer-submit > button").first().click();
    await expect(page.getByLabel("Commit message")).toHaveValue("");
    const selectedCommit = git("rev-parse", "HEAD");
    expect(selectedCommit).not.toBe(beforeHead);
    expect(git("show", "HEAD:src/api/client.ts")).not.toContain(
      "keep-unstaged",
    );
    expect(git("status", "--porcelain")).toContain("extra.txt");
    await page.getByRole("checkbox", { name: /Amend/ }).click();
    await expect(page.getByLabel("Commit message")).toHaveValue(
      "Selected hunk from UI",
    );
    await page.getByLabel("Commit message").fill("Amended message from UI");
    await page.locator(".composer-submit > button").first().click();
    await expect(page.getByLabel("Commit message")).toHaveValue("");
    expect(git("rev-parse", "HEAD")).not.toBe(selectedCommit);
    expect(git("rev-parse", "HEAD^")).toBe(beforeHead);
    expect(git("show", "HEAD:src/api/client.ts")).not.toContain(
      "keep-unstaged",
    );
    await page.getByLabel("Commit message").fill("Commit remaining files");
    await expect(
      page.locator(".composer-submit > button").first(),
    ).toContainText("Stage all & Commit");
    await page.locator(".composer-submit > button").first().click();
    await expect(page.getByLabel("Commit message")).toHaveValue("");
    expect(git("status", "--porcelain")).toBe("");
    expect(git("show", "HEAD:extra.txt")).toBe("Unselected file");
    expect(git("show", "HEAD:src/api/client.ts")).toContain("keep-unstaged");
    await page
      .getByRole("navigation", { name: "Worktree" })
      .getByRole("button", { name: "History", exact: true })
      .click();
    const graph = page.getByRole("listbox", { name: "提交列表与分支关系" });
    await graph
      .getByRole("option")
      .filter({ hasText: beforeHead.slice(0, 8) })
      .click({ modifiers: ["Meta"] });
    const panel = page
      .locator(".diff-tab-page:not([hidden])")
      .getByRole("region", { name: "历史文件差异" });
    await panel.locator(".tree-file").filter({ hasText: "client.ts" }).click();
    await expect(panel.locator(".diff-scroll")).toContainText("keep-unstaged");
    await expect(panel.locator(".diff-scroll")).toContainText("live-save");
    await page
      .getByRole("navigation", { name: "Worktree" })
      .getByRole("button", { name: /^Commit/ })
      .click();
    const preservedHead = git("rev-parse", "HEAD"),
      preservedIndex = readFileSync(join(repo, ".git/index")),
      preservedConfig = readFileSync(join(repo, ".git/config")),
      preservedSource = readFileSync(join(repo, "src/api/client.ts"));
    await page.getByLabel("Commit message").fill("Private draft to remove");
    expect(
      await page.evaluate(
        (id) => localStorage.getItem(`proof:draft:v0:e0:${id}`),
        workspace.id,
      ),
    ).toBe("Private draft to remove");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .locator(".settings-nav")
      .getByRole("button", { name: "本地数据", exact: true })
      .click();
    await expect(page.locator(".data-usage-card")).toBeVisible();
    await page
      .getByRole("button", { name: "从最近项目移除", exact: true })
      .click();
    expect(await invoke("recent_workspaces")).toHaveLength(0);
    expect(await invoke("data_workspaces")).toHaveLength(1);
    await page
      .getByRole("button", { name: "查看此仓库的删除范围…", exact: true })
      .click();
    await expect(
      page.getByRole("group", { name: "确认删除 Proof 记录", exact: true }),
    ).toContainText(repo);
    await page
      .getByRole("button", { name: "删除 Proof 记录", exact: true })
      .click();
    await expect(page.locator(".data-usage-card")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          (id) => localStorage.getItem(`proof:draft:v0:e0:${id}`),
          workspace.id,
        ),
      )
      .toBeNull();
    const session = await invoke("data_session");
    expect(
      await invoke("data_workspaces", { _dataEpoch: session.epoch }),
    ).toHaveLength(0);
    expect(git("rev-parse", "HEAD")).toBe(preservedHead);
    expect(readFileSync(join(repo, ".git/index"))).toEqual(preservedIndex);
    expect(readFileSync(join(repo, ".git/config"))).toEqual(preservedConfig);
    expect(readFileSync(join(repo, "src/api/client.ts"))).toEqual(
      preservedSource,
    );
    await page.reload();
    await expect(page.locator(".recent-projects button")).toHaveCount(0);
    console.log(
      JSON.stringify({
        fixture: repo,
        selectedCommit,
        finalHead: git("rev-parse", "HEAD"),
        status: "clean",
        dataDeletion:
          "UI removed recent and repository records; source/index/HEAD/config preserved; renderer reload stayed empty",
        transport: "test NDJSON; actual core/Git, not Tauri IPC",
      }),
    );
  } finally {
    await page.close();
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  }
});
