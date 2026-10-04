import { test, expect, type Locator } from "@playwright/test";

async function presentation(surface: Locator) {
  return surface.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      scale: style.scale,
      transition: style.transitionDuration,
      animations: element.getAnimations().length,
      centerX: box.x + box.width / 2,
      centerY: box.y + box.height / 2,
      viewportX: innerWidth / 2,
      viewportY: innerHeight / 2,
      background: style.backgroundColor,
      blur: style.backdropFilter,
    };
  });
}

test("press feedback starts before activation and cancelling a press keeps the workspace open", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await expect(page.locator(".diff-panel")).toBeVisible();
  const settings = page.getByRole("button", { name: "设置", exact: true });
  const box = (await settings.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect
    .poll(async () => Number((await presentation(settings)).scale))
    .toBeLessThan(1);
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toBeHidden();
  await page.mouse.move(box.x - 60, box.y + box.height + 60);
  await page.mouse.up();
  await expect(dialog).toBeHidden();

  await settings.click();
  await expect(dialog).toBeVisible();
  await expect.poll(async () => (await presentation(dialog)).scale).toBe("1");
  const position = await presentation(dialog);
  expect(position.centerX).toBeCloseTo(position.viewportX, 0);
  expect(position.centerY).toBeCloseTo(position.viewportY, 0);
  await page.screenshot({ path: ".artifacts/ui-polish/settings-light.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(settings).toBeFocused();
  await settings.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: ".artifacts/ui-polish/settings-dark.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("tab", { name: /^本地变更/ }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText(
    "validateRequest",
  );
  await page.mouse.move(800, 20);
  await page.screenshot({ path: ".artifacts/ui-polish/changes-dark.png" });
});

test("keyboard navigation and the command palette respond without transitions", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await expect(page.locator(".diff-panel")).toBeVisible();
  await page.keyboard.press("Meta+3");
  const history = page.getByRole("tab", { name: "History", exact: true });
  await expect(history).toHaveAttribute("aria-current", "page");
  // A shared-layout indicator must already be at the new tab on the next frame.
  const indicator = await history.locator(".workspace-tab-indicator").evaluate(
    (element) =>
      new Promise<{ x: number; width: number; parentX: number }>((resolve) => {
        requestAnimationFrame(() => {
          const box = element.getBoundingClientRect();
          const parent = element.parentElement!.getBoundingClientRect();
          resolve({ x: box.x, width: box.width, parentX: parent.x });
        });
      }),
  );
  expect(indicator.x).toBeCloseTo(indicator.parentX, 0);
  expect(indicator.width).toBeGreaterThan(0);

  const settings = page.getByRole("button", { name: "设置", exact: true });
  await settings.press("Enter");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toBeVisible();
  const position = await presentation(dialog);
  expect(position.transition).toBe("0s");
  expect(position.animations).toBe(0);
  expect(position.centerX).toBeCloseTo(position.viewportX, 0);
  expect(position.centerY).toBeCloseTo(position.viewportY, 0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(settings).toBeFocused();

  await page.getByRole("button", { name: "打开命令面板", exact: true }).click();
  const commands = page.getByRole("dialog", { name: "命令面板", exact: true });
  await expect(commands).toBeVisible();
  const commandMotion = await presentation(commands);
  expect(commandMotion.transition).toBe("0s");
  expect(commandMotion.animations).toBe(0);
  await expect(
    page.getByRole("combobox", { name: "搜索命令", exact: true }),
  ).toBeFocused();
});

test("reduced motion and increased contrast keep both themes centered and opaque in a narrow window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce", contrast: "more" });
  await page.goto("/?demo=1");
  await expect(page.locator(".diff-panel")).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toBeVisible();
  for (const theme of ["深色", "浅色"]) {
    await dialog.getByRole("button", { name: theme, exact: true }).click();
    const position = await presentation(dialog);
    expect(position.scale).toBe("1");
    expect(position.blur).toBe("none");
    expect(position.background).toMatch(/^rgb\(/);
    expect(position.centerX).toBeCloseTo(position.viewportX, 0);
    expect(position.centerY).toBeCloseTo(position.viewportY, 0);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1024);
    expect(box.y + box.height).toBeLessThanOrEqual(720);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator(".diff-panel")).toBeVisible();
});

test("code font size has a stable accessible name and keyboard adjustment", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const slider = dialog.getByRole("slider", { name: "代码字号", exact: true });
  await expect(slider).toBeVisible();
  const before = Number(await slider.inputValue());
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue(String(before + 1));
  await expect(dialog.locator("#font-size-label")).toContainText(
    String(before + 1),
  );
  await expect(slider).toHaveAccessibleName("代码字号");
});

test("reduced motion preserves pointer opacity feedback and immediate keyboard dialogs", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?demo=1");
  const settings = page.getByRole("button", { name: "设置", exact: true });
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toBeVisible();
  const pointer = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      property: style.transitionProperty,
      duration: style.transitionDuration,
      scale: style.scale,
    };
  });
  expect(pointer.property).toBe("opacity");
  expect(pointer.duration).toBe("0.12s");
  expect(pointer.scale).toBe("1");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await settings.press("Enter");
  await expect(dialog).toBeVisible();
  expect((await presentation(dialog)).transition).toBe("0s");
  await dialog
    .getByRole("button", { name: "深色", exact: true })
    .press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    dialog.getByRole("button", { name: "深色", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
