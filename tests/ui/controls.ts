import { expect, type Locator, type Page } from "@playwright/test";

/** Secondary Diff controls live in a portal, outside their tab's DOM subtree. */
export async function openReadingTools(surface: Page | Locator) {
  const page = "page" in surface ? surface.page() : surface;
  const popup = page.getByRole("dialog", {
    name: /^(Diff 阅读选项|Diff reading options)$/,
  });
  const trigger = surface.getByRole("button", {
    name: /^(阅读工具|Reading tools)$/,
  });
  // A closed popup remains visible during its exit transition. Never return
  // that departing surface as the target for the next action or assertion.
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await expect(popup).toBeHidden();
    await trigger.click();
  }
  await expect(popup).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(popup).toHaveAttribute("data-open", "");
  return popup;
}

export async function closeReadingTools(surface: Page | Locator) {
  const page = "page" in surface ? surface.page() : surface;
  const popup = page.getByRole("dialog", {
    name: /^(Diff 阅读选项|Diff reading options)$/,
  });
  const trigger = surface.getByRole("button", {
    name: /^(阅读工具|Reading tools)$/,
  });
  if ((await trigger.getAttribute("aria-expanded")) === "true") {
    await trigger.click();
  }
  await expect(popup).toBeHidden();
}

/** Exercise the rendered listbox, including keyboard/focus and option events. */
export async function chooseOption(
  control: Locator,
  value: string | { index: number },
) {
  await control.click();
  const popup = control
    .page()
    .locator(".proof-select-popup")
    .getByRole("listbox");
  await expect(popup).toBeVisible();
  const popupId = await popup.getAttribute("id");
  const anchored = popupId
    ? control.page().locator(`[id=${JSON.stringify(popupId)}]`)
    : popup;
  const option =
    typeof value === "string"
      ? popup
          .getByRole("option")
          .and(popup.locator(`[data-value=${JSON.stringify(value)}]`))
      : popup.getByRole("option").nth(value.index);
  await option.click();
  await expect(anchored).toBeHidden();
}
