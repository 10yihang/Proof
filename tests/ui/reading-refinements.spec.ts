import { expect, test } from "@playwright/test";
import { openReadingTools } from "./controls";

test("reading tools disclose secondary actions and keep search and human review reachable", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const diff = page.getByRole("region", { name: "代码差异", exact: true });
  await expect(diff).toBeVisible();
  const toolbar = diff.locator(".diff-toolbar");
  await expect(toolbar).toContainText("Index");
  await expect(toolbar).toContainText("Worktree");
  await expect(
    toolbar.getByRole("button", { name: "统一视图", exact: true }),
  ).toBeVisible();
  await expect(
    toolbar.getByRole("button", { name: "并排视图", exact: true }),
  ).toBeVisible();
  await expect(
    toolbar.getByRole("button", { name: "搜索文件内容", exact: true }),
  ).toBeVisible();
  await expect(
    toolbar.getByRole("button", { name: "在外部编辑器打开", exact: true }),
  ).toHaveCount(0);

  const tools = toolbar.getByRole("button", { name: "阅读工具", exact: true });
  await tools.press("Enter");
  const options = page.getByRole("dialog", {
    name: "Diff 阅读选项",
    exact: true,
  });
  await expect(
    options.getByRole("button", { name: "在外部编辑器打开", exact: true }),
  ).toBeVisible();
  await expect(
    options.getByRole("button", { name: "文件历史与 Blame", exact: true }),
  ).toBeVisible();
  await options.getByRole("button", { name: "全文", exact: true }).click();
  await expect(options).toBeHidden();
  await openReadingTools(diff);
  await expect(
    options.getByRole("button", { name: "全文", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await options
    .getByRole("button", { name: "查看原始 patch", exact: true })
    .click();
  await expect(options).toBeHidden();
  await expect(diff.locator(".raw-patch pre")).toContainText(
    "@@ -1,9 +1,11 @@",
  );
  await expect(diff.locator(".raw-patch pre")).toContainText(
    "+import { validateRequest, ValidationError }",
  );
  await tools.click();
  await options
    .getByRole("button", { name: "查看原始 patch", exact: true })
    .click();
  await expect(diff.locator(".raw-patch")).toHaveCount(0);
  await expect(diff.locator(".hunk-review-label").first()).toHaveText(
    "标记已 Review",
  );
  await diff.locator(".diff-scroll").press("Meta+f");
  await expect(
    diff.getByRole("textbox", { name: "搜索当前 Diff", exact: true }),
  ).toBeFocused();
});

test("cancelling a delayed Settings module restores the initiating focus", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/src/components/Settings.tsx*", async (route) => {
    requested = true;
    await held;
    await route.continue();
  });
  try {
    await page.goto("/?demo=1");
    const settings = page.locator("#settings-toggle");
    await settings.press("Enter");
    await expect.poll(() => requested).toBe(true);
    const pending = page.locator(".workspace-pending-dialog");
    await expect(pending).toHaveAttribute("role", "status");
    await expect(pending).toContainText("正在载入设置…");
    await pending.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByText("正在载入设置…", { exact: true })).toBeHidden();
    await expect(settings).toBeFocused();
    release();
    await expect(
      page.getByRole("dialog", { name: "设置", exact: true }),
    ).toBeHidden();
    await settings.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "设置", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
  } finally {
    release();
    await page.unroute("**/src/components/Settings.tsx*");
  }
});

test("the current snapshot and verification summary precede collapsed demo activity", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const context = page.getByRole("complementary", {
    name: "上下文与证据",
    exact: true,
  });
  const snapshot = context.locator(".snapshot-info");
  await expect(snapshot).toContainText("src/api/requests.ts");
  await expect(snapshot).toContainText("Index → Worktree");
  const verification = context.locator(".context-section").filter({
    has: page.getByRole("heading", { name: "验证记录", exact: true }),
  });
  await expect(verification).toContainText("未确认它对应当前代码");
  const activity = context.locator(".context-activity-disclosure");
  await expect(activity).not.toHaveAttribute("open", "");
  await expect(activity.locator(".context-timeline")).toBeHidden();
  expect(
    await snapshot.evaluate(
      (el) =>
        el.compareDocumentPosition(
          el.parentElement!.querySelector(".context-activity-disclosure")!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBeTruthy();
  expect(
    await verification.evaluate(
      (el) =>
        el.compareDocumentPosition(
          el.parentElement!.querySelector(".context-activity-disclosure")!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBeTruthy();
  await activity.locator("summary").click();
  await expect(activity.locator(".context-timeline")).toBeVisible();
  await expect(activity).toContainText("npm test");
});

test("reading actions fit the minimum desktop window and completed review offers the next file", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto("/?demo=1");
  const diff = page.getByRole("region", { name: "代码差异", exact: true });
  await expect(diff).toBeVisible();
  await expect(diff.locator(".hunk-review-label").first()).toBeVisible();
  await expect(
    diff.getByRole("button", { name: "阅读工具", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await diff.getByRole("button", { name: "标记整个文件", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: /标记.*文件/ });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "确认已审查全部内容", exact: true })
    .click();
  await expect(
    diff
      .locator(".diff-footer")
      .getByRole("button", { name: "下一未审查文件", exact: true }),
  ).toBeVisible();
  await expect(
    diff.getByRole("button", { name: "撤销文件标记", exact: true }),
  ).toBeVisible();
});
