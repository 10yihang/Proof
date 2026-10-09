import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { demoGraphPage } from "../../src/graph-demo";
import { demoChanges } from "../../src/demo";
import { editorState, setEditorScroll, visibleSourcePosition } from "./editor";
import { closeReadingTools, openReadingTools } from "./controls";

test.use({ colorScheme: "dark" });

const artifacts = ".artifacts/navigation-density";

async function openHistoryDiff(page: Page, language: "zh-CN" | "en") {
  await page.addInitScript(
    (language) => localStorage.setItem("proof:ui-language", language),
    language,
  );
  await page.goto("/?demo=1");
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  const navigation = page.locator(".workspace-sidebar:visible");
  const views = navigation.getByRole("tab");
  await expect(views).toHaveCount(4);
  // All four views remain keyboard reachable when narrow layouts show icons.
  await views.first().focus();
  for (let index = 0; index < 4; index++) {
    await expect(views.nth(index)).toBeEnabled();
    await expect(views.nth(index)).toBeFocused();
    await views.nth(index).press("ArrowDown");
  }
  await navigation.getByRole("tab", { name: "History", exact: true }).click();
  await page
    .locator(".graph-scroll:visible")
    .getByRole("option")
    .first()
    .dblclick();
  const panel = page.locator(".diff-tab-page:not([hidden])");
  const scroll = panel.locator(".diff-scroll");
  await expect.poll(() => editorState(scroll)).not.toBeNull();
  return { panel, scroll, navigation };
}

for (const width of [1440, 1024]) {
  for (const language of ["zh-CN", "en"] as const) {
    test(`historical Diff keeps chrome compact at ${width} in ${language}`, async ({
      page,
    }) => {
      const height = width === 1440 ? 900 : 720;
      await page.setViewportSize({ width, height });
      const { panel, scroll, navigation } = await openHistoryDiff(
        page,
        language,
      );
      const chinese = language === "zh-CN";
      const scopeName = chinese ? "比较范围" : "Comparison range";
      const toolsName = chinese ? "阅读工具" : "Reading tools";
      const backName = chinese ? "返回 History" : "Back to History";
      const commit = demoGraphPage().commits[0];
      const title = panel
        .locator(
          '.file-title[title="src/api/requests.ts"], .file-title [title="src/api/requests.ts"]',
        )
        .first();
      await expect(title).toBeVisible();
      await title.hover();
      await expect(title).toHaveAttribute("title", "src/api/requests.ts");
      await expect(
        panel.getByRole("button", { name: toolsName, exact: true }),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "AI Review", exact: true }),
      ).toBeVisible();
      await expect(
        panel.locator(".comparison-tools").getByRole("button", {
          name: chinese ? "隐藏文件栏" : "Hide file pane",
          exact: true,
        }),
      ).toBeVisible();
      const history = navigation.getByRole("tab", {
        name: "History",
        exact: true,
      });
      const files = navigation.getByRole("tab", {
        name: chinese ? "文件" : "Files",
        exact: true,
      });
      const diffTabs = navigation.locator(".diff-tab-item");
      await expect(diffTabs).toHaveCount(1);
      const order = await navigation
        .locator(".view-tab, .diff-tab-item")
        .evaluateAll((nodes) =>
          nodes.map((node) =>
            node.classList.contains("diff-tab-item")
              ? "Diff"
              : node.textContent?.trim(),
          ),
        );
      expect(order.slice(2)).toEqual([
        "History",
        "Diff",
        chinese ? "文件" : "Files",
      ]);
      await expect(
        page.locator(".project-header:visible .desktop-toolbar"),
      ).toHaveCount(1);
      await expect(
        page.locator(".workspace-content > .desktop-toolbar"),
      ).toHaveCount(0);
      const header = page.locator(".project-header:visible");
      await expect(header.locator(".history-git-toolbar")).toHaveCount(0);
      for (const action of ["Fetch", "Pull", "Push"])
        await expect(
          header.getByRole("button", { name: action, exact: true }),
        ).toHaveCount(0);
      const identity = header.locator(".project-identity");
      await expect(identity.locator("strong")).toHaveText(
        demoChanges.workspace.name,
      );
      const center = await identity.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const header = element.closest(".project-header")!;
        const headerBox = header.getBoundingClientRect();
        const style = getComputedStyle(header);
        return {
          identity: box.x + box.width / 2,
          header:
            headerBox.x +
            (headerBox.width +
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight)) /
              2,
        };
      });
      expect(Math.abs(center.identity - center.header)).toBeLessThan(1);

      const projectBar = (await page
        .locator(".project-header:visible")
        .boundingBox())!;
      const toolbar = (await page
        .locator(".desktop-toolbar:visible")
        .boundingBox())!;
      const reader = (await scroll.boundingBox())!;
      const demoNotice = await page
        .locator(".demo-notice:visible")
        .boundingBox();
      const sourceTop = reader.y - (demoNotice?.height ?? 0);
      expect(projectBar.height).toBe(48);
      expect(toolbar.height).toBeLessThanOrEqual(48);
      expect(toolbar.y).toBeGreaterThanOrEqual(projectBar.y);
      expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(
        projectBar.y + projectBar.height,
      );
      const dragRegion = page
        .locator(".project-header:visible .project-drag-space")
        .first();
      await expect(dragRegion).toHaveAttribute(
        "data-tauri-drag-region",
        "true",
      );
      expect((await dragRegion.boundingBox())!.width).toBeGreaterThanOrEqual(
        32,
      );
      const branch = page.locator(".project-header:visible .branch-picker");
      await expect(branch).toBeVisible();
      await expect(branch).toHaveAttribute(
        "aria-label",
        chinese ? "切换 Branch，当前 main" : "Switch Branch, current main",
      );
      const branchBox = (await branch.boundingBox())!;
      const projects = page
        .locator(".project-tabs-row:visible")
        .getByRole("tablist", {
          name: chinese ? "项目" : "Projects",
          exact: true,
        });
      await expect(projects).toBeVisible();
      const projectsBox = (await projects.boundingBox())!;
      expect(branchBox.y).toBeGreaterThanOrEqual(projectBar.y);
      expect(branchBox.y + branchBox.height).toBeLessThanOrEqual(
        projectBar.y + projectBar.height,
      );
      const projectTabsRow = (await page
        .locator(".project-tabs-row:visible")
        .boundingBox())!;
      expect(projectTabsRow.height).toBe(32);
      expect(projectTabsRow.y).toBe(projectBar.y + projectBar.height);
      expect(projectTabsRow.width).toBe(width);
      expect(projectsBox.y).toBeGreaterThanOrEqual(projectTabsRow.y);
      expect(projectsBox.y + projectsBox.height).toBeLessThanOrEqual(
        projectTabsRow.y + projectTabsRow.height,
      );
      expect((await navigation.boundingBox())!.y).toBeGreaterThanOrEqual(
        projectTabsRow.y + projectTabsRow.height,
      );
      expect((await navigation.boundingBox())!.width).toBeGreaterThanOrEqual(
        144,
      );
      expect(sourceTop).toBeLessThanOrEqual(124);
      expect(reader.height).toBeGreaterThanOrEqual(height * 0.55);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width + 1);

      await mkdir(artifacts, { recursive: true });
      await page.screenshot({
        path: `${artifacts}/dense-history-${width}-${language}.png`,
        animations: "disabled",
      });
      await writeFile(
        `${artifacts}/dense-history-${width}-${language}.json`,
        JSON.stringify(
          {
            width,
            language,
            projectBar,
            projectTabsRow,
            toolbar,
            reader,
            sourceTop,
          },
          null,
          2,
        ),
      );

      const scope = panel.getByRole("button", { name: scopeName, exact: true });
      await scope.click();
      const popup = page.getByRole("dialog", { name: scopeName, exact: true });
      await expect(popup).toBeVisible();
      await expect(popup).toContainText(commit.parents[0]);
      await expect(popup).toContainText(commit.oid);
      await expect(popup).toContainText(commit.subject);
      await expect(
        popup.getByRole("combobox", {
          name: chinese ? "Diff 比较父提交" : "Parent Commit for Diff",
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
      await expect(scope).toBeFocused();

      // At the supported minimum height the short fixture can scroll; at 900px
      // the denser layout may already show its entire expanded source.
      await page.setViewportSize({ width, height: 720 });
      await expect
        .poll(async () => (await scroll.boundingBox())?.height ?? Infinity)
        .toBeLessThan(720);
      const initialLines = (await editorState(scroll))!.modelLines;
      const tools = await openReadingTools(panel);
      await tools
        .getByRole("button", {
          name: chinese ? "全文" : "Full file",
          exact: true,
        })
        .click();
      await expect
        .poll(async () => (await editorState(scroll))?.modelLines ?? 0)
        .toBeGreaterThan(initialLines);
      await closeReadingTools(panel);
      await setEditorScroll(scroll, { scrollTop: 180 });
      await expect
        .poll(async () => (await editorState(scroll))?.top ?? 0)
        .toBeGreaterThan(50);
      const position = await visibleSourcePosition(scroll);
      await scope.click();
      await popup.getByRole("button", { name: backName, exact: true }).click();
      await expect(panel).toBeHidden();
      await expect(popup).toBeHidden();
      await expect(
        navigation.getByRole("tab", { name: "History", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await page
        .locator(".workspace-sidebar:visible .diff-tab-button")
        .last()
        .click();
      await expect.poll(() => visibleSourcePosition(scroll)).toEqual(position);
      await expect(title).toHaveAttribute("title", "src/api/requests.ts");
      await navigation.locator(".diff-tab-item.active .diff-tab-close").click();
      await expect(diffTabs).toHaveCount(0);
      await expect(history).toBeFocused();
      await expect(history).toHaveAttribute("aria-current", "page");
      await history.press("ArrowDown");
      await expect(files).toBeFocused();
    });
  }
}

test("sidebar keeps view and Diff labels readable at intermediate widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1150, height: 720 });
  const { navigation, panel } = await openHistoryDiff(page, "zh-CN");
  expect((await navigation.boundingBox())!.width).toBeGreaterThanOrEqual(144);
  expect((await navigation.boundingBox())!.width).toBeLessThanOrEqual(180);
  await expect(
    panel.getByRole("button", { name: "阅读工具", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 720 });
  expect((await navigation.boundingBox())!.width).toBeGreaterThanOrEqual(144);
  expect((await navigation.boundingBox())!.width).toBeLessThanOrEqual(180);
  await expect(
    panel.getByRole("button", { name: "比较范围", exact: true }),
  ).toBeVisible();
});

for (const language of ["zh-CN", "en"] as const) {
  test(`sidebar collapse keeps Diff and view navigation available in ${language}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { panel, scroll, navigation } = await openHistoryDiff(page, language);
    const chinese = language === "zh-CN";
    const collapseName = chinese ? "收起侧边栏" : "Collapse sidebar";
    const expandName = chinese ? "展开侧边栏" : "Expand sidebar";
    const history = navigation.getByRole("tab", {
      name: "History",
      exact: true,
    });
    const files = navigation.getByRole("tab", {
      name: chinese ? "文件" : "Files",
      exact: true,
    });
    const activeDiff = navigation.locator(".diff-tab-button").first();
    await page
      .getByRole("button", {
        name: chinese ? "设置" : "Settings",
        exact: true,
      })
      .click();
    const settings = page.getByRole("dialog", {
      name: chinese ? "设置" : "Settings",
      exact: true,
    });
    await settings
      .getByRole("button", {
        name: chinese ? "深色" : "Dark",
        exact: true,
      })
      .click();
    await settings
      .getByRole("button", {
        name: chinese ? "关闭" : "Close",
        exact: true,
      })
      .click();
    await expect(settings).toBeHidden();
    if (chinese) {
      await mkdir(".artifacts/chrome-followup", { recursive: true });
      await page.screenshot({
        path: ".artifacts/chrome-followup/sidebar-expanded-1440-dark.png",
        animations: "disabled",
      });
    }
    const before = await visibleSourcePosition(scroll);
    const diffName = await activeDiff.getAttribute("aria-label");
    const initialReader = (await scroll.boundingBox())!;
    await navigation
      .getByRole("button", { name: collapseName, exact: true })
      .click();
    await expect(navigation).toHaveAttribute("data-sidebar-state", "collapsed");
    await expect(
      navigation.getByRole("button", { name: expandName, exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    expect((await navigation.boundingBox())!.width).toBe(48);
    const collapsedIcons = await navigation
      .locator(".view-tab > svg")
      .evaluateAll((icons) =>
        icons.map((icon) => {
          const rect = icon.getBoundingClientRect();
          const button = icon.parentElement!;
          const buttonRect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          const style = getComputedStyle(icon);
          return {
            name: button.getAttribute("aria-label"),
            width: rect.width,
            height: rect.height,
            display: style.display,
            visibility: style.visibility,
            insideButton:
              rect.x >= buttonRect.x &&
              rect.x + rect.width <= buttonRect.right &&
              rect.y >= buttonRect.y &&
              rect.y + rect.height <= buttonRect.bottom,
            hit: hit === icon || icon.contains(hit),
          };
        }),
      );
    expect(collapsedIcons).toHaveLength(4);
    for (const icon of collapsedIcons) {
      expect(icon).toMatchObject({
        width: 16,
        height: 16,
        display: "block",
        visibility: "visible",
        insideButton: true,
        hit: true,
      });
    }
    await expect(panel).toBeVisible();
    await expect(activeDiff).toHaveAttribute("aria-label", diffName!);
    await expect(activeDiff).toHaveAttribute("aria-current", "page");
    await expect.poll(() => visibleSourcePosition(scroll)).toEqual(before);
    expect((await scroll.boundingBox())!.width).toBeGreaterThan(
      initialReader.width,
    );
    if (chinese)
      await page.screenshot({
        path: ".artifacts/chrome-followup/sidebar-collapsed-1440-dark.png",
        animations: "disabled",
      });
    await history.focus();
    await history.press("ArrowDown");
    await expect(activeDiff).toBeFocused();
    await activeDiff.press("ArrowDown");
    await expect(files).toBeFocused();
    await files.press("Enter");
    await expect(files).toHaveAttribute("aria-current", "page");
    await activeDiff.click();
    await expect(panel).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 720 });
    await expect(navigation).toHaveAttribute("data-sidebar-state", "collapsed");
    if (chinese) {
      await page.screenshot({
        path: ".artifacts/chrome-followup/sidebar-collapsed-1024-dark.png",
        animations: "disabled",
      });
      await navigation
        .getByRole("button", { name: expandName, exact: true })
        .click();
      await expect(navigation).toHaveAttribute(
        "data-sidebar-state",
        "expanded",
      );
      await page.screenshot({
        path: ".artifacts/chrome-followup/sidebar-expanded-1024-dark.png",
        animations: "disabled",
      });
      await navigation
        .getByRole("button", { name: collapseName, exact: true })
        .click();
    }
    await page.reload();
    const reloaded = page.locator(".workspace-sidebar:visible");
    await expect(reloaded).toHaveAttribute("data-sidebar-state", "collapsed");
    expect((await reloaded.boundingBox())!.width).toBe(48);
    await reloaded
      .getByRole("button", { name: expandName, exact: true })
      .click();
    await expect(reloaded).toHaveAttribute("data-sidebar-state", "expanded");
    expect((await reloaded.boundingBox())!.width).toBe(136);
    await page.reload();
    await expect(reloaded).toHaveAttribute("data-sidebar-state", "expanded");
    expect((await reloaded.boundingBox())!.width).toBe(136);
    await expect(
      reloaded.getByRole("button", { name: collapseName, exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("proof.workspace-sidebar"),
      ),
    ).toBe("expanded");
  });
}
