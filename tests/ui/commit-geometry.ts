import { expect, type Locator, type Page } from "@playwright/test";

export async function containedInViewport(control: Locator) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  const viewport = control.page().viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(
    await control.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
}

/** Assert reading space and control geometry, beyond mere DOM visibility. */
export async function assertCommitGeometry(page: Page) {
  const commit = page.locator(".commit-workspace");
  const center = page.locator(".commit-page:not([hidden]) .center-panel");
  const diff = center.locator(".diff-panel");
  const files = commit.locator(".commit-stage-files");
  const details = commit.locator(".commit-details");
  await expect(
    page.locator(
      ".commit-scope-summary, .composer-scope, .commit-version-notice",
    ),
  ).toHaveCount(0);
  for (const control of [
    center,
    diff,
    files,
    details,
    commit.getByRole("textbox", { name: "Commit message", exact: true }),
    commit.locator(".composer-submit > button").first(),
  ]) {
    await containedInViewport(control);
  }
  const [centerBox, diffBox, filesBox, detailsBox] = await Promise.all([
    center.boundingBox(),
    diff.boundingBox(),
    files.boundingBox(),
    details.boundingBox(),
  ]);
  expect(centerBox!.width).toBeGreaterThan(page.viewportSize()!.width * 0.45);
  expect(diffBox!.width).toBeGreaterThan(centerBox!.width - 4);
  expect(Math.abs(diffBox!.x - centerBox!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(diffBox!.y - centerBox!.y)).toBeLessThanOrEqual(2);
  expect(
    Math.abs(diffBox!.y + diffBox!.height - centerBox!.y - centerBox!.height),
  ).toBeLessThanOrEqual(2);
  expect(filesBox!.x + filesBox!.width).toBeLessThanOrEqual(centerBox!.x);
  expect(filesBox!.y + filesBox!.height).toBeLessThanOrEqual(detailsBox!.y);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
