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

// 「文件」页 e2e：真实 proof-core（NDJSON fixture），list/read/save 命令由
// core 直接提供，无需页面内 stub。
async function fixture(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), "proof-files-ui-"));
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
  mkdirSync(join(repo, "src/api"), { recursive: true });
  writeFileSync(join(repo, "src/api/client.ts"), "export const v = 1;\n");
  writeFileSync(join(repo, "code.txt"), "first\n");
  git("add", ".");
  git("commit", "-m", "Initial");
  writeFileSync(join(repo, "code.txt"), "second\n");
  git("add", ".");
  git("commit", "-m", "Second");
  const child = spawn(
    resolve(process.env.PROOF_UI_CORE_BINARY!),
    [join(directory, "data")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending: { resolve: (v: any) => void; reject: (e: any) => void }[] = [];
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
  const invoke = (command: string, args: Record<string, unknown> = {}) =>
    new Promise<any>((resolvePromise, reject) => {
      pending.push({ resolve: resolvePromise, reject });
      child.stdin.write(JSON.stringify({ command, args }) + "\n");
    });
  const workspace = await invoke("open_workspace", { path: repo });
  await invoke("set_trust", { workspaceId: workspace.id, trusted: true });
  await page.exposeFunction("filesFixtureInvoke", invoke);
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
      invoke: (name: string, payload: any = {}) => {
        if (name === "plugin:event|listen") return Promise.resolve(1);
        if (name.startsWith("plugin:event|")) return Promise.resolve(1);
        if (name === "prepare_read_request")
          return Promise.resolve(crypto.randomUUID());
        if (name === "cancel_read_request") return Promise.resolve(true);
        if (name === "watch_workspace") return Promise.resolve(false);
        return (window as any).filesFixtureInvoke(payload.command, payload.args);
      },
    };
  });
  return {
    repo,
    open: async () => {
      await page.goto("/");
      await page.locator(".recent-projects button").first().click();
    },
    close: () => {
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

test("Files tab browses, edits, saves and reloads repository files", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.open();
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    // 文件树默认折叠：根文件与压缩链文件夹可见，链内文件不可见。
    const sidebar = page.locator(".editor-sidebar");
    await expect(
      sidebar.getByRole("button", { name: /code\.txt/ }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: /src\/api/ }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: /client\.ts/ }),
    ).toHaveCount(0);
    // 展开折叠链后可见；搜索过滤。
    await sidebar.getByRole("button", { name: /src\/api/ }).click();
    await expect(
      sidebar.getByRole("button", { name: /client\.ts/ }),
    ).toBeVisible();
    await sidebar.getByPlaceholder("筛选文件…").fill("client");
    await expect(
      sidebar.getByRole("button", { name: /client\.ts/ }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: /code\.txt/ }),
    ).toHaveCount(0);
    await sidebar.getByPlaceholder("筛选文件…").fill("");

    // 打开并编辑：Monaco 挂载，输入后出现脏标记。
    await sidebar.getByRole("button", { name: /code\.txt/ }).click();
    const editor = page.locator(".editor-main .monaco-editor");
    await expect(editor).toBeVisible();
    await expect(editor).toContainText("second");
    await expect(page.locator(".editor-dirty-dot")).toHaveCount(0);
    // 点击文本行定位光标到该行，End 移到行尾后追加。
    await editor.getByText("second").click();
    await page.keyboard.press("End");
    await page.keyboard.type("edited");
    await expect(page.locator(".editor-dirty-dot").first()).toBeVisible();

    // ⌘S 保存 → 磁盘更新 + 本地变更计数出现。
    await page.keyboard.press("Meta+s");
    await expect
      .poll(() => readFileSync(join(f.repo, "code.txt"), "utf8"))
      .toBe("secondedited\n");
    await expect(page.locator(".editor-dirty-dot")).toHaveCount(0);
    await expect(
      page.getByRole("tab", { name: /本地变更/ }).locator(".tab-count"),
    ).toHaveText("1");
  } finally {
    f.close();
  }
});

test("Files tab views historical versions read-only and returns", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.open();
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    await page
      .locator(".editor-sidebar")
      .getByRole("button", { name: /code\.txt/ })
      .click();
    const editor = page.locator(".editor-main .monaco-editor");
    await expect(editor).toContainText("second");
    // 打开历史栏，点第一个提交 → 只读 + 提示条 + 旧内容。
    await page.getByRole("button", { name: "文件历史", exact: true }).click();
    const history = page.locator(".editor-history");
    await expect(history.getByText("Initial", { exact: true })).toBeVisible();
    await history.getByText("Initial", { exact: true }).click();
    await expect(
      page.getByText(/正在查看历史版本/),
    ).toBeVisible();
    await expect(editor).toContainText("first");
    await expect(editor).not.toContainText("second");
    await expect(
      page.getByRole("button", { name: "保存", exact: true }),
    ).toHaveCount(0);
    // 返回当前版本。
    await page
      .getByRole("button", { name: "返回当前版本", exact: true })
      .click();
    await expect(editor).toContainText("second");
    await expect(page.getByText(/正在查看历史版本/)).toHaveCount(0);
  } finally {
    f.close();
  }
});

test("Files tab find widget works inside Monaco", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.open();
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    await page
      .locator(".editor-sidebar")
      .getByRole("button", { name: /code\.txt/ })
      .click();
    const editor = page.locator(".editor-main .monaco-editor");
    await expect(editor).toBeVisible();
    await editor.click();
    // ⌘F 打开查找组件，能命中并关闭。
    await page.keyboard.press("Meta+f");
    const find = page.locator(".editor-main .find-widget");
    await expect(find).toBeVisible();
    await find.getByPlaceholder("Find", { exact: true }).fill("second");
    // 替换输入框也在（⌘F 组件含查找+替换）。
    await expect(find.getByPlaceholder("Replace")).toBeAttached();
    await expect(find).toContainText("1 of 1");
    await page.keyboard.press("Escape");
    // Monaco 以 aria-hidden 标记关闭态（保留 DOM 复用，不做可见性断言）。
    await expect(find).toHaveAttribute("aria-hidden", "true");
  } finally {
    f.close();
  }
});

test("Files tab refuses binary files with a notice", async ({ page }) => {
  const f = await fixture(page);
  try {
    writeFileSync(join(f.repo, "image.png"), Buffer.from([0, 1, 2, 3, 255]));
    await f.open();
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    const sidebar = page.locator(".editor-sidebar");
    await sidebar.getByRole("button", { name: /image\.png/ }).click();
    await expect(
      page.getByText("二进制文件不提供文本查看与编辑。"),
    ).toBeVisible();
    await expect(page.locator(".editor-main .monaco-editor")).toHaveCount(0);
  } finally {
    f.close();
  }
});

test("Files tab creates, renames, deletes files and shows a status bar", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.open();
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    const sidebar = page.locator(".editor-sidebar");

    // 新建：侧边栏加号 → 输入路径 → 落盘并自动打开。
    await sidebar.getByRole("button", { name: "新建文件", exact: true }).click();
    await page
      .getByPlaceholder("新文件路径，如 docs/note.md")
      .fill("notes/todo.txt");
    await page.keyboard.press("Enter");
    await expect(
      sidebar.getByRole("button", { name: /todo\.txt/ }),
    ).toBeVisible();
    expect(readFileSync(join(f.repo, "notes/todo.txt"), "utf8")).toBe("");
    await expect(page.locator(".editor-main .monaco-editor")).toBeVisible();

    // 状态栏：行列、语言、行尾、大小齐全。
    const statusbar = page.locator(".editor-statusbar");
    await expect(statusbar).toContainText("行 1，列 1");
    await expect(statusbar).toContainText("TXT");
    await expect(statusbar).toContainText("LF");
    await expect(statusbar).toContainText("0 B");

    // 重命名：悬浮行 → 铅笔按钮 → 行内输入新名。
    const row = sidebar.locator(".editor-tree-row", {
      has: page.getByRole("button", { name: /todo\.txt/ }),
    });
    await row.hover();
    await row
      .getByRole("button", { name: "重命名", exact: true })
      .click();
    await page.locator(".editor-rename-input").fill("done.txt");
    await page.keyboard.press("Enter");
    await expect(
      sidebar.getByRole("button", { name: /done\.txt/ }),
    ).toBeVisible();
    expect(readFileSync(join(f.repo, "notes/done.txt"), "utf8")).toBe("");

    // 删除：确认弹窗 → 文件消失，恢复点出现。
    const deleteRow = sidebar.locator(".editor-tree-row", {
      has: page.getByRole("button", { name: /done\.txt/ }),
    });
    await deleteRow.hover();
    await deleteRow
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await page
      .getByRole("button", { name: "删除", exact: true })
      .last()
      .click();
    await expect(
      sidebar.getByRole("button", { name: /done\.txt/ }),
    ).toHaveCount(0);
    expect(() => readFileSync(join(f.repo, "notes/done.txt"))).toThrow();
  } finally {
    f.close();
  }
});
