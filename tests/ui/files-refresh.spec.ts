import { test, expect, type Page } from "@playwright/test";

async function openEditor(page: Page) {
  await page.goto("/tests/ui/fixtures/editor-refresh.html");
  await page.getByRole("button", { name: "code.txt", exact: true }).click();
  await expect(page.locator(".editor-main .monaco-editor")).toContainText(
    "original alpha",
  );
}
async function stats(page: Page) {
  return page.evaluate(() =>
    structuredClone((window as any).editorFixture.stats),
  );
}
async function hold(page: Page, ...commands: string[]) {
  await page.evaluate((commands) => {
    for (const command of commands)
      (window as any).editorFixture.holdNext(command);
  }, commands);
}
async function release(page: Page, ...commands: string[]) {
  await page.evaluate((commands) => {
    for (const command of commands)
      (window as any).editorFixture.release(command);
  }, commands);
}
async function invalidate(page: Page, count = 1) {
  await page.evaluate((count) => {
    for (let i = 0; i < count; i++) (window as any).editorFixture.invalidate();
  }, count);
}
async function value(page: Page) {
  return page.evaluate(() =>
    (window as any).editorFixture.models()[0]?.getValue(),
  );
}

test("Files coalesces hidden tab and hidden window invalidations", async ({
  page,
}) => {
  await openEditor(page);
  for (const mode of ["tab", "window"] as const) {
    await page.evaluate((mode) => {
      const f = (window as any).editorFixture;
      if (mode === "tab") f.activate(false);
      else f.visibility(true);
    }, mode);
    const before = await stats(page);
    await page.evaluate((mode) => {
      const f = (window as any).editorFixture;
      f.write("alpha", "code.txt", `updated ${mode}\n`);
      f.write("alpha", `new-${mode}.txt`, "created");
    }, mode);
    await invalidate(page, 100);
    await page.waitForTimeout(100);
    expect(await stats(page)).toEqual(before);
    await page.evaluate((mode) => {
      const f = (window as any).editorFixture;
      if (mode === "tab") f.activate(true);
      else f.visibility(false);
    }, mode);
    await expect.poll(() => value(page)).toBe(`updated ${mode}\n`);
    await expect(
      page.getByRole("button", { name: `new-${mode}.txt`, exact: true }),
    ).toBeVisible();
    const after = await stats(page);
    expect(after.list_files.calls - before.list_files.calls).toBe(1);
    expect(after.read_text_file.calls - before.read_text_file.calls).toBe(1);
  }
});

test("Files has one read per lane plus one trailing refresh under an event storm", async ({
  page,
}) => {
  await openEditor(page);
  const before = await stats(page);
  await hold(page, "list_files", "read_text_file");
  await invalidate(page);
  await expect
    .poll(async () => (await stats(page)).read_text_file.active)
    .toBe(1);
  await invalidate(page, 100);
  const during = await stats(page);
  expect(during.list_files.calls - before.list_files.calls).toBe(1);
  expect(during.read_text_file.calls - before.read_text_file.calls).toBe(1);
  await page.evaluate(() =>
    (window as any).editorFixture.write(
      "alpha",
      "code.txt",
      "latest content\n",
    ),
  );
  await release(page, "list_files", "read_text_file");
  await expect.poll(() => value(page)).toBe("latest content\n");
  const after = await stats(page);
  expect(after.list_files.calls - before.list_files.calls).toBe(2);
  expect(after.read_text_file.calls - before.read_text_file.calls).toBe(2);
  expect(after.list_files.maxActive).toBe(1);
  expect(after.read_text_file.maxActive).toBe(1);
});

test("Files preserves dirty text and undo when reactivation detects an external edit", async ({
  page,
}) => {
  await openEditor(page);
  await page.evaluate(() => {
    const model = (window as any).editorFixture.models()[0];
    model.pushStackElement();
    model.pushEditOperations(
      [],
      [
        {
          range: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 1,
          },
          text: "draft ",
        },
      ],
      () => null,
    );
    model.pushStackElement();
  });
  await expect(page.locator(".editor-status-dirty")).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).editorFixture;
    f.activate(false);
    f.write("alpha", "code.txt", "external edit\n");
  });
  await invalidate(page, 10);
  await page.evaluate(() => (window as any).editorFixture.activate(true));
  await expect(page.locator(".editor-banner.warning")).toBeVisible();
  expect(await value(page)).toBe("draft original alpha\n");
  await page.evaluate(() => (window as any).editorFixture.models()[0].undo());
  await expect.poll(() => value(page)).toBe("original alpha\n");
});

test("Files rejects a late document read after workspace switch", async ({
  page,
}) => {
  await openEditor(page);
  await hold(page, "read_text_file");
  await invalidate(page);
  await expect
    .poll(async () => (await stats(page)).read_text_file.active)
    .toBe(1);
  await page.evaluate(() => (window as any).editorFixture.workspace("beta"));
  await expect(
    page.getByRole("button", { name: "other.txt", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "code.txt", exact: true }).click();
  await expect.poll(() => value(page)).toBe("original beta\n");
  await release(page, "read_text_file");
  await expect
    .poll(async () => (await stats(page)).read_text_file.active)
    .toBe(0);
  expect(await value(page)).toBe("original beta\n");
});

test("Files resets saving on workspace switch and ignores the previous save response", async ({
  page,
}) => {
  await openEditor(page);
  await page.evaluate(() =>
    (window as any).editorFixture.models()[0].setValue("saved alpha\n"),
  );
  await hold(page, "save_text_file");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(async () => (await stats(page)).save_text_file.active)
    .toBe(1);
  await page.evaluate(() => (window as any).editorFixture.workspace("beta"));
  await expect(
    page.getByRole("button", { name: "other.txt", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "code.txt", exact: true }).click();
  await expect.poll(() => value(page)).toBe("original beta\n");
  await page.evaluate(() =>
    (window as any).editorFixture.models()[0].setValue("beta draft\n"),
  );
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeEnabled();
  await release(page, "save_text_file");
  await expect
    .poll(async () => (await stats(page)).save_text_file.active)
    .toBe(0);
  expect(await value(page)).toBe("beta draft\n");
  await expect(page.locator(".editor-status-dirty")).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).editorFixture.value("beta", "code.txt"),
      ),
    )
    .toBe("beta draft\n");
});

test("Files retries an in-flight read that fails after the tab becomes hidden", async ({
  page,
}) => {
  await openEditor(page);
  const before = await stats(page);
  await hold(page, "read_text_file");
  await page.evaluate(() =>
    (window as any).editorFixture.failNext("read_text_file"),
  );
  await invalidate(page);
  await expect
    .poll(async () => (await stats(page)).read_text_file.active)
    .toBe(1);
  await page.evaluate(() => (window as any).editorFixture.activate(false));
  await release(page, "read_text_file");
  await expect
    .poll(async () => (await stats(page)).read_text_file.active)
    .toBe(0);
  expect(
    (await stats(page)).read_text_file.calls - before.read_text_file.calls,
  ).toBe(1);
  await page.evaluate(() => {
    const f = (window as any).editorFixture;
    f.write("alpha", "code.txt", "recovered content\n");
    f.activate(true);
  });
  await expect.poll(() => value(page)).toBe("recovered content\n");
  expect(
    (await stats(page)).read_text_file.calls - before.read_text_file.calls,
  ).toBe(2);
});
