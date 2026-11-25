import { test, expect, type Locator, type Page } from "@playwright/test";

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

type PageMotionState = Window & {
  pageEntries: Animation[];
  selectionMoved: boolean;
};

async function observePageMotion(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as PageMotionState;
    state.pageEntries = [];
    state.selectionMoved = false;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const animation = animate.call(this, keyframes, options);
      if (this.classList.contains("workspace-page")) {
        state.pageEntries.push(animation);
      }
      return animation;
    };
    document.addEventListener("transitionrun", (event) => {
      if (
        event.propertyName === "transform" &&
        event.target instanceof Element &&
        event.target.classList.contains("workspace-tab-indicator")
      )
        state.selectionMoved = true;
    });
  });
}

function pageEntries(page: Page) {
  return page.evaluate(() =>
    (window as unknown as PageMotionState).pageEntries.map((entry) => ({
      state: entry.playState,
      duration: entry.effect?.getTiming().duration,
      transform:
        entry.effect instanceof KeyframeEffect
          ? entry.effect.getKeyframes()[0]?.transform
          : undefined,
    })),
  );
}

for (const width of [1440, 1024]) {
  test(`pointer page transitions are interruptible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/?demo=1");
    await expect(page.locator(".diff-panel")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Worktree" });
    await expect(nav.locator(".workspace-tab-indicator")).toBeVisible();
    if (width === 1024) {
      const settings = page.getByRole("button", { name: "设置", exact: true });
      await settings.click();
      await page.getByRole("button", { name: "深色", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.keyboard.press("Escape");
    }
    await observePageMotion(page);

    const commit = nav.getByRole("tab", { name: /^Commit/ });
    await commit.click();
    await expect(commit).toHaveAttribute("aria-current", "page");
    const commitPanel = page.locator(".commit-page:not([hidden])");
    await expect(commitPanel).toBeVisible();
    expect((await pageEntries(page))[0]).toMatchObject({
      duration: 300,
      transform: expect.stringMatching(/translateX\(clamp\(64px/),
    });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as PageMotionState).selectionMoved,
        ),
      )
      .toBe(true);

    await nav.getByRole("tab", { name: "History", exact: true }).click();
    await expect(
      page.locator(".history-page:not([hidden]) .repository-view"),
    ).toBeVisible();
    const entries = await pageEntries(page);
    expect(entries).toHaveLength(2);
    expect(entries[0].state).toBe("idle");
    expect(entries[1].state).not.toBe("idle");

    await page.keyboard.press("Meta+1");
    const changes = page.locator(".changes-page:not([hidden])");
    await expect(changes.locator(".diff-panel")).toBeVisible();
    const returning = await pageEntries(page);
    expect(returning.slice(0, 2).map((entry) => entry.state)).toEqual([
      "idle",
      "idle",
    ]);
    expect(returning[2].transform).toMatch(/translateX\(clamp\(-108px/);
    const content = page.locator(".workspace-content:visible");
    await expect(content).toHaveAttribute("data-page-sliding", "");
    const area = (await content.boundingBox())!;
    await page.mouse.move(area.x + area.width / 2, area.y + 40);
    await expect(content).not.toHaveAttribute("data-page-sliding", "");
    expect((await pageEntries(page))[2].state).toBe("idle");
    expect(await presentation(changes)).toMatchObject({ animations: 0 });
  });
}

test("the first History transition slides in the loaded page at normal speed", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  let releaseHistory!: () => void;
  const historyModule = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  await page.route("**/src/components/RepositoryView.tsx*", async (route) => {
    await historyModule;
    await route.continue();
  });
  try {
    await page.goto("/?demo=1");
    await expect(page.locator(".diff-panel")).toBeVisible();
    await page.getByRole("tab", { name: "History", exact: true }).click();
    const history = page.locator(".history-page:not([hidden])");
    await expect(history.locator(".workspace-pending")).toBeVisible();
    expect(
      await history.evaluate((panel) => panel.getAnimations().length),
    ).toBe(0);

    const frames = history.evaluate((panel) => {
      return new Promise<number[]>((resolve) => {
        const positions: number[] = [];
        const deadline = performance.now() + 2500;
        const sample = (now: number) => {
          if (panel.querySelector(".repository-view")) {
            const transform = getComputedStyle(panel).transform;
            positions.push(
              new DOMMatrix(transform === "none" ? undefined : transform).m41,
            );
          }
          if (
            now >= deadline ||
            (positions.length > 1 && positions.at(-1) === 0)
          ) {
            resolve(positions);
          } else {
            requestAnimationFrame(sample);
          }
        };
        requestAnimationFrame(sample);
      });
    });
    releaseHistory();
    const positions = await frames;
    expect(Math.max(...positions)).toBeGreaterThan(50);
    expect(
      positions.filter((position) => position > 16).length,
    ).toBeGreaterThan(2);
    expect(positions.at(-1)).toBe(0);
  } finally {
    releaseHistory();
  }
});

test("opening a comparison and closing its tab slide in opposite directions", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/?demo=1");
  await expect(page.locator(".diff-panel")).toBeVisible();
  await observePageMotion(page);
  await page.getByRole("tab", { name: "History", exact: true }).click();
  const graph = page.getByRole("listbox", { name: "提交列表与分支关系" });
  await graph.getByRole("option").first().dblclick();
  const close = page.getByRole("button", { name: /^关闭标签页/ });
  await expect(close).toBeVisible();
  await expect.poll(() => pageEntries(page)).toHaveLength(2);
  expect((await pageEntries(page))[1].transform).toMatch(
    /translateX\(clamp\(64px/,
  );

  await close.click();
  await expect(graph).toBeVisible();
  await expect.poll(() => pageEntries(page)).toHaveLength(3);
  expect((await pageEntries(page))[2].transform).toMatch(
    /translateX\(clamp\(-108px/,
  );
});

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

test("keyboard navigation aligns the sidebar and opens dialogs immediately", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await expect(page.locator(".diff-panel")).toBeVisible();
  await page.keyboard.press("Meta+3");
  const history = page.getByRole("tab", { name: "History", exact: true });
  await expect(history).toHaveAttribute("aria-current", "page");
  const indicator = await page
    .locator(".workspace-tab-indicator:visible")
    .evaluate(
      (element) =>
        new Promise<{
          x: number;
          y: number;
          width: number;
          tabX: number;
          tabY: number;
          transition: string;
        }>((resolve) => {
          requestAnimationFrame(() => {
            const box = element.getBoundingClientRect();
            const tab = element
              .parentElement!.querySelector('[aria-current="page"]')!
              .getBoundingClientRect();
            resolve({
              x: box.x,
              y: box.y,
              width: box.width,
              tabX: tab.x,
              tabY: tab.y,
              transition: getComputedStyle(element).transitionDuration,
            });
          });
        }),
    );
  expect(indicator.x).toBeCloseTo(indicator.tabX, 0);
  expect(indicator.y).toBeCloseTo(indicator.tabY, 0);
  expect(indicator.width).toBeGreaterThan(0);
  expect(indicator.transition).toBe("0s");

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
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(page.locator(".history-page:not([hidden])")).toBeVisible();
  expect(
    await presentation(page.locator(".history-page:not([hidden])")),
  ).toMatchObject({ animations: 0 });
  expect(
    await presentation(page.locator(".workspace-tab-indicator:visible")),
  ).toMatchObject({ transition: "0s", animations: 0 });
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
  await page.keyboard.press("Escape");
  await observePageMotion(page);
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(
    page.locator(".history-page:not([hidden]) .repository-view"),
  ).toBeVisible();
  expect(await pageEntries(page)).toHaveLength(0);
});
