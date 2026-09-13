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
    console.log(
      JSON.stringify({
        fixture: repo,
        selectedCommit,
        finalHead: git("rev-parse", "HEAD"),
        status: "clean",
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
