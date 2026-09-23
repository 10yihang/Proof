import { test, expect, type Locator, type Page } from "@playwright/test";
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

type Workspace = { id: string; name: string; path: string };
type Axis = "width" | "height";

async function fixture(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), "proof-card-resize-"));
  const createRepo = (name: string) => {
    const path = join(directory, name);
    mkdirSync(path);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", path, ...args], {
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Proof UI");
    git("config", "user.email", "ui@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(path, "code.txt"), "initial\n");
    git("add", "code.txt");
    git("commit", "-m", "Initial");
    writeFileSync(join(path, "code.txt"), "committed\n");
    git("add", "code.txt");
    git("commit", "-m", "Second");
    writeFileSync(join(path, "code.txt"), "local modification\n");
    return { path, git };
  };
  const repo = createRepo("primary");
  const child = spawn(
    resolve(process.env.PROOF_UI_CORE_BINARY!),
    [join(directory, "data")],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const pending: {
    resolve: (value: any) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const calls: { command: string; args: Record<string, any> }[] = [];
  let closed = false;
  let queue = Promise.resolve<unknown>(null);
  const rejectPending = (error: unknown) => {
    for (const entry of pending.splice(0)) entry.reject(error);
  };
  child.stdin.on("error", rejectPending);
  child.on("exit", (code) =>
    rejectPending(new Error(`Fixture exited ${code}`)),
  );
  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line),
      request = pending.shift();
    if (response.error) request?.reject(response.error);
    else request?.resolve(response.value);
  });
  const invoke = (
    command: string,
    args: Record<string, any> = {},
  ): Promise<any> => {
    if (closed) return Promise.reject(new Error("Fixture closed"));
    calls.push({ command, args: structuredClone(args) });
    const result = queue
      .catch(() => {})
      .then(
        () =>
          new Promise((resolve, reject) => {
            pending.push({ resolve, reject });
            child.stdin.write(JSON.stringify({ command, args }) + "\n");
          }),
      );
    queue = result;
    return result;
  };
  const register = async (path: string): Promise<Workspace> => {
    const workspace = await invoke("open_workspace", { path });
    await invoke("set_trust", { workspaceId: workspace.id, trusted: true });
    return workspace;
  };
  const workspace = await register(repo.path);
  await invoke("set_ui_language", { language: "en" });
  await page.exposeFunction("cardResizeInvoke", invoke);
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
        if (name === "watch_workspace") return Promise.resolve(false);
        return (window as any).cardResizeInvoke(payload.command, payload.args);
      },
    };
  });
  return {
    repo,
    workspace,
    invoke,
    calls,
    layout: (target = workspace) =>
      invoke("repository_layout", { workspaceId: target.id }),
    writes: () =>
      calls.filter((call) => call.command === "set_repository_layout"),
    other: async () => register(createRepo("secondary").path),
    open: async (view: "History" | "Files" | "Commit", target = workspace) => {
      await page.goto("/");
      await page
        .locator(".recent-projects button")
        .filter({
          has: page.getByText(target.name, { exact: true }),
        })
        .click();
      await page
        .getByRole("tab", {
          name: view === "Commit" ? /^Commit/ : view,
          exact: view !== "Commit",
        })
        .click();
    },
    close: () => {
      closed = true;
      child.kill();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function handle(page: Page, field: string) {
  return page.locator(`[data-field="${field}"]`).getByRole("separator").first();
}
async function size(panel: Locator, axis: Axis) {
  return Math.round((await panel.boundingBox())![axis]);
}
async function drag(page: Page, separator: Locator, axis: Axis, delta: number) {
  await expect(separator).toBeVisible();
  await separator.click({ trial: true });
  const box = (await separator.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    x + (axis === "width" ? delta : 0),
    y + (axis === "height" ? delta : 0),
    { steps: 8 },
  );
  await page.mouse.up();
}
async function savedSize(
  f: Awaited<ReturnType<typeof fixture>>,
  field: string,
  panel: Locator,
  axis: Axis,
) {
  await expect
    .poll(async () =>
      Math.abs((await f.layout())[field] - (await size(panel, axis))),
    )
    .toBeLessThanOrEqual(3);
  return (await f.layout())[field] as number;
}

async function captureGeometry(page: Page, name: string) {
  const directory = resolve(".artifacts/card-resize");
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`) });
  const geometry = await page
    .locator(
      ".card-split, .card-split-pane, .card-split-content, .card-split-separator, .editor-main, .history-inspector, .commit-details",
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const bounds = node.getBoundingClientRect(),
          style = getComputedStyle(node);
        return {
          field: node.getAttribute("data-field"),
          class: node.className,
          rect: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          },
          direction: style.flexDirection,
          flex: style.flex,
          overflow: style.overflow,
        };
      }),
    );
  writeFileSync(
    join(directory, `${name}.json`),
    JSON.stringify(geometry, null, 2),
  );
}

test.beforeEach(async ({ page }) => {
  test.skip(
    !process.env.PROOF_UI_CORE_BINARY,
    "Build ui-fixture-driver for native Git tests.",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus && !page.isClosed()) {
    const name = info.title.split(" ")[0].toLowerCase();
    await captureGeometry(page, `${name}-failure`);
  }
});

test("History cards resize on both axes and restore saved intent after reload and temporary fitting", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.open("History");
    const sidebar = page.locator(".repository-nav");
    const horizontal = handle(page, "historySidebarWidth");
    await expect(horizontal).toBeVisible({ timeout: 5000 });
    const beforeWidth = await size(sidebar, "width"),
      beforeHeight = await size(sidebar, "height");
    await drag(page, horizontal, "width", 130);
    await expect
      .poll(() => size(sidebar, "width"))
      .toBeGreaterThan(beforeWidth + 30);
    expect(
      Math.abs((await size(sidebar, "height")) - beforeHeight),
    ).toBeLessThanOrEqual(2);
    let savedWidth = await savedSize(
      f,
      "historySidebarWidth",
      sidebar,
      "width",
    );
    const writesBeforeCancel = f.writes().length;
    const handleBox = (await horizontal.boundingBox())!;
    const handleX = handleBox.x + handleBox.width / 2;
    const handleY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(handleX, handleY);
    await page.mouse.down();
    await page.mouse.move(handleX - 40, handleY, { steps: 6 });
    await expect
      .poll(() => size(sidebar, "width"))
      .toBeLessThan(savedWidth - 15);
    await page.keyboard.press("Escape");
    await page.mouse.move(handleX - 90, handleY, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => Math.abs((await size(sidebar, "width")) - savedWidth))
      .toBeLessThanOrEqual(3);
    expect(f.writes()).toHaveLength(writesBeforeCancel);
    await drag(page, horizontal, "width", 24);
    await expect
      .poll(() => size(sidebar, "width"))
      .toBeGreaterThan(savedWidth + 10);
    savedWidth = await savedSize(f, "historySidebarWidth", sidebar, "width");
    const details = page.locator(".history-inspector");
    const beforeDetails = await size(details, "height");
    await drag(page, handle(page, "historyDetailsHeight"), "height", -44);
    await captureGeometry(page, "history-resized");
    await expect
      .poll(() => size(details, "height"))
      .toBeGreaterThan(beforeDetails + 20);
    const savedHeight = await savedSize(
      f,
      "historyDetailsHeight",
      details,
      "height",
    );

    await horizontal.focus();
    const writes = f.writes().length;
    await page.keyboard.down("ArrowRight");
    await expect.poll(() => size(sidebar, "width")).toBeGreaterThan(savedWidth);
    expect(f.writes()).toHaveLength(writes);
    await page.keyboard.press("Escape");
    await page.keyboard.up("ArrowRight");
    await expect
      .poll(async () => Math.abs((await size(sidebar, "width")) - savedWidth))
      .toBeLessThanOrEqual(3);
    expect(f.writes()).toHaveLength(writes);
    await page.keyboard.down("ArrowLeft");
    expect(f.writes()).toHaveLength(writes);
    await page.keyboard.up("ArrowLeft");
    await expect.poll(() => f.writes().length).toBe(writes + 1);
    let finalWidth = await savedSize(
      f,
      "historySidebarWidth",
      sidebar,
      "width",
    );

    await horizontal.focus();
    const writesBeforeBlur = f.writes().length;
    await page.keyboard.down("ArrowLeft");
    await expect.poll(() => size(sidebar, "width")).toBeLessThan(finalWidth);
    expect(f.writes()).toHaveLength(writesBeforeBlur);
    await page.getByRole("tab", { name: "History", exact: true }).focus();
    await page.keyboard.up("ArrowLeft");
    await expect.poll(() => f.writes().length).toBe(writesBeforeBlur + 1);
    finalWidth = await savedSize(f, "historySidebarWidth", sidebar, "width");

    await f.open("History");
    await expect
      .poll(async () => Math.abs((await size(sidebar, "width")) - finalWidth))
      .toBeLessThanOrEqual(3);
    await expect
      .poll(async () => Math.abs((await size(details, "height")) - savedHeight))
      .toBeLessThanOrEqual(3);
    const writesBeforeFit = f.writes().length;
    await page.setViewportSize({ width: 560, height: 720 });
    await expect
      .poll(() => size(sidebar, "width"))
      .toBeLessThan(finalWidth - 10);
    expect((await f.layout()).historySidebarWidth).toBe(finalWidth);
    expect(f.writes()).toHaveLength(writesBeforeFit);
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect
      .poll(async () => Math.abs((await size(sidebar, "width")) - finalWidth))
      .toBeLessThanOrEqual(3);
  } finally {
    f.close();
  }
});

test("Files cards resize independently and preserve unsaved editor text while history opens and closes", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.open("Files");
    const sidebar = page.locator(".editor-sidebar");
    const before = await size(sidebar, "width");
    await drag(page, handle(page, "filesSidebarWidth"), "width", 64);
    await expect
      .poll(() => size(sidebar, "width"))
      .toBeGreaterThan(before + 30);
    await savedSize(f, "filesSidebarWidth", sidebar, "width");
    await sidebar.getByRole("button", { name: /code\.txt/ }).click();
    const editor = page.locator(".editor-main .monaco-editor");
    await expect(editor).toContainText("local modification");
    await captureGeometry(page, "files-before-edit");
    await editor.locator(".view-line").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" unsaved card resize");
    await expect(page.locator(".editor-dirty-dot").first()).toBeVisible();
    await page
      .getByRole("button", { name: "File history", exact: true })
      .click();
    const history = page.locator(".editor-history");
    await expect(history).toBeVisible();
    const previousHistory = await size(history, "width");
    await drag(page, handle(page, "filesHistoryWidth"), "width", -48);
    await expect
      .poll(() => size(history, "width"))
      .toBeGreaterThan(previousHistory + 20);
    const savedHistory = await savedSize(
      f,
      "filesHistoryWidth",
      history,
      "width",
    );
    await page
      .getByRole("button", { name: "Close file history", exact: true })
      .click();
    await expect(history).toBeHidden();
    await expect(editor).toContainText("unsaved card resize");
    await page
      .getByRole("button", { name: "File history", exact: true })
      .click();
    await expect
      .poll(async () => Math.abs((await size(history, "width")) - savedHistory))
      .toBeLessThanOrEqual(3);
    await expect(editor).toContainText("unsaved card resize");
    expect(readFileSync(join(f.repo.path, "code.txt"), "utf8")).toBe(
      "local modification\n",
    );
  } finally {
    f.close();
  }
});

test("Commit keeps files and composer beside the live Diff while both split directions resize", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.open("Commit");
    const workspace = page.locator(".commit-workspace");
    const composer = page.locator(".commit-details");
    const message = page.getByLabel("Commit message", { exact: true });
    await message.fill("Keep this commit draft");
    await page
      .locator(".commit-stage-files .tree-file")
      .filter({ hasText: "code.txt" })
      .click();
    await expect(page.locator(".diff-scroll")).toContainText(
      "local modification",
    );
    await page.evaluate(() => {
      (window as any).resizeDiff = document.querySelector(
        ".center-panel .diff-panel",
      );
    });
    const before = await size(workspace, "width");
    await drag(
      page,
      page.getByRole("separator", { name: "Changed files", exact: true }),
      "width",
      54,
    );
    await expect
      .poll(() => size(workspace, "width"))
      .toBeGreaterThan(before + 25);
    const beforeHeight = await size(composer, "height");
    await drag(page, handle(page, "commitDetailsHeight"), "height", -48);
    await captureGeometry(page, "commit-resized");
    await expect
      .poll(() => size(composer, "height"))
      .toBeGreaterThan(beforeHeight + 20);
    await savedSize(f, "commitDetailsHeight", composer, "height");
    await expect(message).toHaveValue("Keep this commit draft");
    await expect(message).toBeInViewport();
    const filesBox = (await page.locator(".commit-stage-files").boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    const sidebarBox = (await workspace.boundingBox())!;
    const diffBox = (await page
      .locator(".center-panel .diff-panel")
      .boundingBox())!;
    expect(filesBox.y + filesBox.height).toBeLessThanOrEqual(composerBox.y + 1);
    expect(sidebarBox.x + sidebarBox.width).toBeLessThanOrEqual(diffBox.x + 1);
    expect(diffBox.width).toBeGreaterThan(sidebarBox.width);
    expect(
      await page.evaluate(
        () =>
          (window as any).resizeDiff ===
          document.querySelector(".center-panel .diff-panel"),
      ),
    ).toBe(true);
    await page.getByRole("tab", { name: "History", exact: true }).click();
    await page.getByRole("tab", { name: /^Commit/ }).click();
    await expect(message).toHaveValue("Keep this commit draft");
  } finally {
    f.close();
  }
});

test("Card dimensions stay separate between views and repositories", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.open("History");
    const initial = await f.layout();
    await drag(page, handle(page, "historySidebarWidth"), "width", 72);
    const saved = await savedSize(
      f,
      "historySidebarWidth",
      page.locator(".repository-nav"),
      "width",
    );
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    const files = await f.layout();
    expect(files.filesSidebarWidth).toBe(initial.filesSidebarWidth);
    const other = await f.other();
    await f.open("History", other);
    expect((await f.layout(other)).historySidebarWidth).toBe(
      initial.historySidebarWidth,
    );
    await drag(page, handle(page, "historySidebarWidth"), "width", -28);
    await expect
      .poll(async () => (await f.layout(other)).historySidebarWidth)
      .not.toBe(initial.historySidebarWidth);
    expect((await f.layout()).historySidebarWidth).toBe(saved);
    await f.open("History");
    await expect
      .poll(async () =>
        Math.abs(
          (await size(page.locator(".repository-nav"), "width")) - saved,
        ),
      )
      .toBeLessThanOrEqual(3);
  } finally {
    f.close();
  }
});
