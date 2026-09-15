import { expect, type Locator } from "@playwright/test";

/** Exercise the rendered listbox, including keyboard/focus and option events. */
export async function chooseOption(control:Locator,value:string|{index:number}) {
  await control.click();
  const popup=control.page().locator(".proof-select-popup").getByRole("listbox");
  await expect(popup).toBeVisible();
  const popupId=await popup.getAttribute("id");
  const anchored=popupId?control.page().locator(`[id=${JSON.stringify(popupId)}]`):popup;
  const option=typeof value==="string"?popup.getByRole("option").and(popup.locator(`[data-value=${JSON.stringify(value)}]`)):popup.getByRole("option").nth(value.index);
  await option.click();
  await expect(anchored).toBeHidden();
}
