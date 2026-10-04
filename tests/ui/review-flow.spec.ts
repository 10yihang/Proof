import { expect, test, type Page } from "@playwright/test";
import { chooseOption } from "./controls";
import { assertCommitGeometry, containedInViewport } from "./commit-geometry";
import { editorState } from "./editor";

const currentDiff = (page: Page) =>
  page.getByRole("region", { name: /^(代码差异|Code Diff)$/, exact: true });
const navigation = (page: Page) =>
  page.getByRole("navigation", { name: "Worktree", exact: true });
async function waitForVisibleCode(page: Page) {
  await expect
    .poll(
      async () =>
        (await editorState(currentDiff(page).locator(".diff-scroll")))
          ?.modelLines ?? 0,
    )
    .toBeGreaterThan(0);
}
async function openCommit(page: Page) {
  await navigation(page)
    .getByRole("tab", { name: /^Commit/ })
    .click();
  await expect(page.locator(".commit-workspace")).toBeVisible();
}

test("reviewing one of five files keeps the remaining coverage unknown and Next only navigates", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const diff = currentDiff(page);
  const coverage = page.locator("#files-panel .file-selection-actions > span");
  await expect(page.locator("#files-panel .review-coverage")).toHaveCount(0);
  await expect(coverage).toHaveText(/5\s*个文件/);
  await expect(coverage).toHaveAttribute(
    "title",
    "已加载 1/5 个文件；已加载变更块 0/2 已审查；4 个文件未加载",
  );
  await expect(diff.locator(".diff-scroll")).toContainText("validateRequest");
  await waitForVisibleCode(page);
  await page.screenshot({
    path: ".artifacts/ui-compact-fix/changes-1440-zh-CN.png",
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
  await expect(coverage).toHaveAttribute(
    "title",
    "已加载 1/5 个文件；已加载变更块 2/2 已审查；4 个文件未加载",
  );
  const next = page
    .locator("#files-panel .file-selection-actions")
    .getByRole("button", { name: "下一未审查文件", exact: true });
  await expect(next).toHaveText("");
  await expect(next).toHaveAttribute("title", "下一未审查文件");
  await next.focus();
  await next.press("Enter");
  await expect(diff.locator(".diff-file-header")).toContainText(
    "src/api/response.ts",
  );
  await expect(diff.locator(".hunk-review").first()).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(diff.locator(".diff-footer")).toContainText(/0\/\d+\s*已审查/);
  await expect(coverage).toHaveAttribute(
    "title",
    "已加载 2/5 个文件；已加载变更块 2/3 已审查；3 个文件未加载",
  );
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
  await expect(diff.locator(".diff-file-header")).toContainText("README.md");
  await expect(diff.locator(".comparison")).toHaveText(/HEAD\s*→\s*Index/);
  await expect(
    commit.getByRole("button", { name: "Staged", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await assertCommitGeometry(page);
  await waitForVisibleCode(page);
  await page.screenshot({
    path: ".artifacts/ui-compact-fix/commit-mixed-1440-zh-CN.png",
  });

  await commit.getByRole("button", { name: "Unstaged", exact: true }).click();
  await commit
    .getByRole("button", { name: "requests.ts M", exact: true })
    .click();
  await expect(diff.locator(".comparison")).toHaveText(/Index\s*→\s*Worktree/);
  await expect(commit.locator(".composer-submit > button").first()).toHaveText(
    /Commit\s*1/,
  );
  await assertCommitGeometry(page);
  const search = commit.getByRole("textbox", {
    name: "搜索变化文件",
    exact: true,
  });
  await search.fill("requests");
  await commit.getByRole("button", { name: "Staged", exact: true }).click();
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

for (const width of [1440, 1024]) {
  for (const language of ["zh-CN", "en"] as const) {
    test(`compact mixed Commit keeps the full reading column at ${width} in ${language}`, async ({
      page,
    }) => {
      // Playwright gives every test an isolated browser context; demo preferences do not leak.
      await page.setViewportSize({ width, height: width === 1024 ? 720 : 960 });
      await page.goto("/?demo=1");
      if (language === "en") {
        await page.getByRole("button", { name: "设置", exact: true }).click();
        const settings = page.getByRole("dialog", {
          name: "设置",
          exact: true,
        });
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
      const coverage = page.locator(
        "#files-panel .file-selection-actions > span",
      );
      await expect(coverage).toHaveAttribute(
        "title",
        language === "en"
          ? "Files loaded 1/5; loaded hunks reviewed 0/2; 4 files not loaded"
          : "已加载 1/5 个文件；已加载变更块 0/2 已审查；4 个文件未加载",
      );
      await containedInViewport(coverage);
      await waitForVisibleCode(page);
      await page.screenshot({
        path: `.artifacts/ui-compact-fix/changes-${width}-${language}.png`,
      });
      await openCommit(page);
      const commit = page.locator(".commit-workspace");
      await expect(
        currentDiff(page).locator(".diff-file-header"),
      ).toContainText("README.md");
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
      await assertCommitGeometry(page);
      await commit
        .getByRole("button", { name: "Unstaged", exact: true })
        .click();
      await commit
        .getByRole("button", { name: "requests.ts M", exact: true })
        .click();
      await expect(currentDiff(page).locator(".comparison")).toHaveText(
        /Index\s*→\s*Worktree/,
      );
      await expect(submit).toHaveText(/Commit\s*1/);
      await assertCommitGeometry(page);
      await waitForVisibleCode(page);
      await page.screenshot({
        path: `.artifacts/ui-compact-fix/commit-mixed-candidate-${width}-${language}.png`,
      });
    });
  }
}
