import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

// 嵌入式终端 UI 测试：真实 proof-core（NDJSON fixture 驱动）+ 页面内 stub 的
// terminal_* 命令。PTY 本身由 src-tauri/src/terminal.rs 的 Rust 单元测试覆盖，
// 这里验证 xterm 懒加载、Channel 数据写入、按键回传与退出提示的接线。
async function fixture(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), "proof-terminal-ui-"));
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
  writeFileSync(join(repo, "code.txt"), "initial\n");
  git("add", ".");
  git("commit", "-m", "Initial change");
  const child = spawn(
    resolve(process.env.PROOF_UI_CORE_BINARY!),
    [join(directory, "data")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending: { resolve: (v: any) => void; reject: (e: any) => void }[] = [];
  let closed = false;
  child.stdin.on("error", (error) => {
    for (const p of pending.splice(0)) p.reject(error);
  });
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
  const invoke = (command: string, args: Record<string, unknown> = {}) => {
    if (closed) return Promise.reject(new Error("Fixture closed"));
    const value = queue
      .catch(() => {})
      .then(
        () =>
          new Promise<any>((resolvePromise, reject) => {
            if (closed) {
              reject(new Error("Fixture closed"));
              return;
            }
            pending.push({ resolve: resolvePromise, reject });
            child.stdin.write(JSON.stringify({ command, args }) + "\n");
          }),
      );
    queue = value;
    return value;
  };
  const workspace = await invoke("open_workspace", { path: repo });
  await invoke("set_trust", { workspaceId: workspace.id, trusted: true });
  await page.exposeFunction("terminalFixtureInvoke", invoke);
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: any) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let identifier = 0;
    const terminals = {
      spawns: [] as any[],
      writes: [] as any[],
      resizes: [] as any[],
      closes: [] as string[],
      channels: new Map<string, any>(),
      next: 0,
    };
    Object.assign(window, {
      terminals,
      emitTerminalExit: (id: string) => {
        for (const entry of listeners.values())
          if (entry.event === "terminal-exit")
            callbacks.get(entry.handler)?.({
              event: "terminal-exit",
              payload: { id },
            });
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (_: string, id: number) => listeners.delete(id),
      },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: (callback: (event: any) => void) => {
          const id = ++identifier;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: (name: string, payload: any = {}) => {
          if (name === "terminal_spawn") {
            const id = `fixture-pty-${++terminals.next}`;
            terminals.spawns.push({
              id,
              cwd: payload.cwd,
              cols: payload.cols,
              rows: payload.rows,
            });
            terminals.channels.set(id, payload.onData);
            return Promise.resolve(id);
          }
          if (name === "terminal_write") {
            terminals.writes.push({ id: payload.id, data: payload.data });
            return Promise.resolve(undefined);
          }
          if (name === "terminal_resize") {
            terminals.resizes.push({
              id: payload.id,
              cols: payload.cols,
              rows: payload.rows,
            });
            return Promise.resolve(undefined);
          }
          if (name === "terminal_close") {
            terminals.closes.push(payload.id);
            return Promise.resolve(undefined);
          }
          if (name === "prepare_read_request")
            return Promise.resolve(crypto.randomUUID());
          if (name === "cancel_read_request") return Promise.resolve(true);
          if (name === "plugin:event|listen") {
            const id = ++identifier;
            listeners.set(id, payload);
            return Promise.resolve(id);
          }
          if (name.startsWith("plugin:event|")) return Promise.resolve(1);
          if (name === "watch_workspace") return Promise.resolve(false);
          return (window as any).terminalFixtureInvoke(
            payload.command,
            payload.args,
          );
        },
      },
    });
  });
  const open = async () => {
    await page.goto("/");
    await page.locator(".recent-projects button").first().click();
    await page
      .getByRole("tab", { name: /^本地变更/ })
      .first()
      .click();
  };
  return {
    repo,
    invoke,
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

test("Terminal drawer renders output and forwards keystrokes", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.open();
    await page.getByRole("button", { name: "打开终端", exact: true }).click();
    const drawer = page.locator("#terminal-drawer");
    await expect(drawer).toBeVisible();
    // xterm 按需加载完成并打开后会渲染 .xterm-rows。
    await expect(drawer.locator(".xterm-rows")).toBeVisible();
    const spawn = await page.evaluate(
      () => (window as any).terminals.spawns[0],
    );
    expect(spawn.cwd).toBe(realpathSync(f.repo));
    expect(spawn.cols).toBeGreaterThan(0);
    expect(spawn.rows).toBeGreaterThan(0);
    // Channel 下发二进制输出 → xterm 渲染。
    await page.evaluate((id) => {
      const channel = (window as any).terminals.channels.get(id);
      channel.onmessage(new TextEncoder().encode("proof-terminal-ok").buffer);
    }, spawn.id);
    await expect(drawer.locator(".xterm-rows")).toContainText(
      "proof-terminal-ok",
    );
    // 按键 → terminal_write 字节回传。
    await drawer.locator(".xterm").click();
    await page.keyboard.type("ab");
    await expect
      .poll(async () =>
        page.evaluate(() =>
          (window as any).terminals.writes.flatMap((w: any) => w.data),
        ),
      )
      .toEqual(expect.arrayContaining([97, 98]));
    // Ctrl+` 收起抽屉，会话保留（不触发 close）。
    await page.keyboard.press("Control+`");
    await expect(drawer).toBeHidden();
    const closes = await page.evaluate(() => (window as any).terminals.closes);
    expect(closes).toEqual([]);
  } finally {
    f.close();
  }
});

test("Terminal opens from the header on any workspace tab", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.open();
    await page.getByRole("tab", { name: "History", exact: true }).click();
    await page.getByRole("button", { name: "打开终端", exact: true }).click();
    const drawer = page.locator("#terminal-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".xterm-rows")).toBeVisible();
    // 终端在所有标签页可用，不再强制切回 Changes。
    await expect(
      page.getByRole("tab", { name: "History", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    // 在 History 页收起终端后，Changes 页再打开仍是同一会话。
    // （终端聚焦时 Escape 留给终端程序本身；先把焦点移回页面再 Esc。）
    await page.locator(".workspace-statusbar").click();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await page
      .getByRole("tab", { name: /^本地变更/ })
      .first()
      .click();
    await page.keyboard.press("Control+`");
    await expect(drawer).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => (window as any).terminals.spawns.length),
      )
      .toBe(1);
  } finally {
    f.close();
  }
});

test("Terminal shows exited state when the shell exits", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.open();
    await page.getByRole("button", { name: "打开终端", exact: true }).click();
    const drawer = page.locator("#terminal-drawer");
    await expect(drawer.locator(".xterm-rows")).toBeVisible();
    const spawn = await page.evaluate(
      () => (window as any).terminals.spawns[0],
    );
    await page.evaluate((id) => (window as any).emitTerminalExit(id), spawn.id);
    await expect(drawer.getByText("进程已退出", { exact: true })).toBeVisible();
    await expect(drawer.locator(".xterm-rows")).toContainText("终端进程已退出");
    // 重新启动会 spawn 新会话；已退出的旧会话由后端 reader EOF 自动回收。
    await drawer.getByRole("button", { name: "重新启动" }).click();
    await expect
      .poll(async () =>
        page.evaluate(() => (window as any).terminals.spawns.length),
      )
      .toBe(2);
  } finally {
    f.close();
  }
});
