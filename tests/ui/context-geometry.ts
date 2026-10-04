import { expect, type Page } from "@playwright/test";

/** Call with a visible, real Context panel after setting its saved width. */
export async function assertContextGeometry(page: Page, width: number) {
  const panel = page.locator("#context-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".context-session-toolbar")).toBeVisible();
  await expect(panel.locator(".context-link-actions")).toBeVisible();
  await expect(panel.locator(".context-header .inspector-tabs")).toBeVisible();

  await expect
    .poll(
      () =>
        panel.evaluate((element, expectedWidth) => {
          const failures: string[] = [];
          const tolerance = 0.5;
          const panelBox = element.getBoundingClientRect();
          if (Math.abs(panelBox.width - expectedWidth) > 2) {
            failures.push(
              `panel width ${panelBox.width}; expected ${expectedWidth}`,
            );
          }

          function inspect(selector: string, container: Element = element) {
            const target = element.querySelector(selector);
            if (!target) {
              failures.push(`missing ${selector}`);
              return null;
            }
            const box = target.getBoundingClientRect();
            const parent = container.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0) {
              failures.push(`${selector} has no rendered area`);
            }
            if (
              box.left < parent.left - tolerance ||
              box.right > parent.right + tolerance ||
              box.top < parent.top - tolerance ||
              box.bottom > parent.bottom + tolerance
            ) {
              failures.push(`${selector} extends outside its container`);
            }
            if (target.scrollWidth > target.clientWidth + 1) {
              failures.push(`${selector} overflows horizontally`);
            }
            return { target, box };
          }

          function inspectText(target: Element, label: string) {
            const range = document.createRange();
            range.selectNodeContents(target);
            const text = range.getBoundingClientRect();
            const box = target.getBoundingClientRect();
            if (
              text.width <= 0 ||
              text.left < box.left - tolerance ||
              text.right > box.right + tolerance ||
              text.top < box.top - tolerance ||
              text.bottom > box.bottom + tolerance
            ) {
              failures.push(`${label} text is clipped or absent`);
            }
          }

          if (element.scrollWidth > element.clientWidth + 1) {
            failures.push("panel overflows horizontally");
          }
          inspect(".context-body");
          const toolbar = inspect(".context-session-toolbar");
          const title = inspect(
            ".context-session-toolbar .section-title",
            toolbar?.target,
          );
          const heading = inspect(".context-session-toolbar h3", title?.target);
          const actions = inspect(
            ".context-session-toolbar .context-link-actions",
            toolbar?.target,
          );
          if (heading) inspectText(heading.target, "session title");
          if (toolbar && title && actions) {
            if (actions.box.left - title.box.right < 8 - tolerance) {
              failures.push("session title/actions gap is below 8px");
            }
            const icons = Array.from(actions.target.querySelectorAll("button"));
            if (!icons.length) failures.push("session actions have no buttons");
            let previous: DOMRect | undefined;
            for (const icon of icons) {
              const box = icon.getBoundingClientRect();
              if (box.width < 28 - tolerance || box.height < 28 - tolerance) {
                failures.push("session action target is smaller than 28px");
              }
              if (
                box.left < actions.box.left - tolerance ||
                box.right > actions.box.right + tolerance ||
                box.top < actions.box.top - tolerance ||
                box.bottom > actions.box.bottom + tolerance
              ) {
                failures.push("session action extends outside actions row");
              }
              if (previous && box.left - previous.right < 4 - tolerance) {
                failures.push("session actions overlap or gap is below 4px");
              }
              previous = box;
            }
          }

          const header = inspect(".context-header");
          const tabs = inspect(
            ".context-header .inspector-tabs",
            header?.target,
          );
          const close = inspect(".context-header > button", header?.target);
          if (tabs && close && tabs.box.right > close.box.left + tolerance) {
            failures.push("Inspector tabs overlap the close button");
          }
          if (tabs) {
            for (const label of tabs.target.querySelectorAll(
              ".proof-segment-label",
            )) {
              inspectText(label, "Inspector tab");
              const box = label.getBoundingClientRect();
              const buttonBox = label
                .closest("button")
                ?.getBoundingClientRect();
              if (
                box.left < tabs.box.left - tolerance ||
                box.right > tabs.box.right + tolerance ||
                !buttonBox ||
                box.left < buttonBox.left - tolerance ||
                box.right > buttonBox.right + tolerance
              ) {
                failures.push("Inspector label extends outside its tab button");
              }
            }
          }
          return failures;
        }, width),
      { message: `Context geometry at ${width}px` },
    )
    .toEqual([]);
}
