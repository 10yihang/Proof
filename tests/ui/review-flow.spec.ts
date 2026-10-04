import { expect, test, type Locator, type Page } from "@playwright/test";
import { chooseOption } from "./controls";

const currentDiff = (page: Page) =>
  page.getByRole("region", { name: /^(代码差异|Code Diff)$/, exact: true });
const navigation = (page: Page) =>
  page.getByRole("navigation", { name: "Worktree", exact: true });
async function openCommit(page: Page) {
  await navigation(page)
    .getByRole("tab", { name: /^Commit/ })
    .click();
  await expect(page.locator(".commit-workspace")).toBeVisible();
}
async function containedInViewport(control: Locator) {
  const geometry = await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: innerWidth,
      height: innerHeight,
      scroll: element.scrollWidth,
      client: element.clientWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height + 1);
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
}

test("reviewing one of five files keeps the remaining coverage unknown and Next only navigates", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const diff = currentDiff(page);
  const coverage = page.locator("#files-panel .review-coverage-summary");
  await expect(coverage).toContainText("已加载 1/5 个文件版本");
  await expect(coverage).toContainText("还有 4 个文件版本未加载");
  await expect(diff.locator(".diff-scroll")).toContainText("validateRequest");
  await page.screenshot({
    path: ".artifacts/ui-performance/changes-1440-zh-CN.png",
  });
  await diff.getByRole("button", { name: "标记整个文件", exact: true }).click();
  const confirmation = page.getByRole("dialog", {
    name: "标记整个文件已审查",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "确认已审查全部内容", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(coverage).toContainText("已加载 1/5 个文件版本");
  await expect(coverage).toContainText("已加载内容 2/2 个 Hunk 已审查");
  await expect(coverage).toContainText("还有 4 个文件版本未加载");
  await diff
    .locator(".diff-footer")
    .getByRole("button", { name: "下一未审查文件", exact: true })
    .click();
  await expect(diff.locator(".diff-file-header")).toContainText(
    "src/api/response.ts",
  );
  await expect(diff.locator(".hunk-review").first()).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(diff.locator(".diff-footer")).toContainText(/0\/\d+\s*已审查/);
  await expect(coverage).toContainText("已加载 2/5 个文件版本");
  await expect(coverage).toContainText("还有 3 个文件版本未加载");
  await expect(
    navigation(page).getByRole("tab", { name: /^Commit/ }),
  ).toHaveText(/Commit\s*1/);
  await expect(diff.locator(".comparison")).toHaveText(/Index\s*→\s*Worktree/);
  await expect(
    diff.getByRole("button", { name: "Stage 文件", exact: true }),
  ).toBeDisabled();
});

test("Commit starts with staged README and candidate reading remains outside its staged scope", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const diff = currentDiff(page);
  await expect(diff.locator(".diff-file-header")).toContainText(
    "src/api/requests.ts",
  );
  await openCommit(page);
  const commit = page.locator(".commit-workspace");
  await expect(commit.locator(".commit-scope-summary")).toContainText(
    "已暂存提交范围：1 个文件",
  );
  await expect(commit.locator(".composer-scope")).toHaveText(
    "本次仅提交 1 个已暂存文件。",
  );
  await expect(diff.locator(".diff-file-header")).toContainText("README.md");
  await expect(diff.locator(".comparison")).toHaveText(/HEAD\s*→\s*Index/);
  await expect(
    commit.getByRole("button", { name: "Staged", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: ".artifacts/ui-performance/commit-1440-zh-CN.png",
  });

  await commit.getByRole("button", { name: "Unstaged", exact: true }).click();
  await commit
    .getByRole("button", { name: "requests.ts M", exact: true })
    .click();
  const notice = page.locator(".commit-version-notice");
  await expect(notice).toHaveAttribute("role", "status");
  await expect(notice).toContainText(
    "当前查看未暂存版本，不在本次 Staged 提交范围内。",
  );
  await expect(diff.locator(".comparison")).toHaveText(/Index\s*→\s*Worktree/);
  await expect(commit.locator(".composer-scope")).toHaveText(
    "本次仅提交 1 个已暂存文件。",
  );
  const search = commit.getByRole("textbox", {
    name: "搜索变化文件",
    exact: true,
  });
  await search.fill("requests");
  await notice
    .getByRole("button", { name: "查看已暂存变更", exact: true })
    .click();
  await expect(notice).toBeHidden();
  await expect(search).toHaveValue("");
  await expect(diff.locator(".diff-file-header")).toContainText("README.md");
  await expect(diff.locator(".comparison")).toHaveText(/HEAD\s*→\s*Index/);
  await expect(
    commit.getByRole("button", { name: "Staged", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    commit.getByRole("button", { name: "README.md M", exact: true }),
  ).toBeVisible();
});

for (const language of ["zh-CN", "en"] as const) {
  test(`minimum desktop window keeps review and Commit scope readable in ${language}`, async ({
    page,
  }) => {
    // Playwright gives every test an isolated browser context; demo preferences do not leak.
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.goto("/?demo=1");
    if (language === "en") {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "设置", exact: true });
      await expect(settings).toBeVisible();
      await chooseOption(
        settings.getByRole("combobox", { name: "界面语言", exact: true }),
        "en",
      );
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("dialog", { name: "Settings", exact: true }),
      ).toBeHidden();
    }
    const coverage = page.locator("#files-panel .review-coverage-summary");
    await expect(coverage).toContainText(
      language === "en" ? "1/5 file versions loaded" : "已加载 1/5 个文件版本",
    );
    await expect(coverage).toContainText(
      language === "en"
        ? "4 file versions not loaded"
        : "还有 4 个文件版本未加载",
    );
    await containedInViewport(coverage);
    await page.screenshot({
      path: `.artifacts/ui-performance/changes-1024-${language}.png`,
    });
    await openCommit(page);
    const commit = page.locator(".commit-workspace");
    const summary = commit.locator(".commit-scope-summary");
    await expect(summary).toContainText(
      language === "en"
        ? "Staged commit scope: 1 file"
        : "已暂存提交范围：1 个文件",
    );
    await expect(commit.locator(".composer-scope")).toHaveText(
      language === "en"
        ? "Staged files in this commit: 1."
        : "本次仅提交 1 个已暂存文件。",
    );
    await expect(currentDiff(page).locator(".diff-file-header")).toContainText(
      "README.md",
    );
    await containedInViewport(summary);
    const message = commit.getByRole("textbox", {
      name: "Commit message",
      exact: true,
    });
    await expect(message).toBeVisible();
    await message.fill(
      "Review the staged README changes\nPreserve the unstaged request validation work for a separate commit.",
    );
    await expect(message).toHaveValue(
      /Preserve the unstaged request validation work/,
    );
    await message.focus();
    await expect(message).toBeFocused();
    await containedInViewport(message);
    const submit = commit.getByRole("button", { name: /^Commit\s*1$/ });
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();
    await containedInViewport(submit);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.artifacts/ui-performance/commit-1024-${language}.png`,
    });
  });
}
