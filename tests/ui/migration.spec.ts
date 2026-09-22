import { test, expect } from "@playwright/test";

test("migrated workbench primitives keep navigation, theme and focus coherent",async({page})=>{
  test.setTimeout(60000);
  const errors:string[]=[];page.on("console",message=>{if(message.type()==="error")console.error(message.text());});page.on("requestfailed",request=>console.error(request.url(),request.failure()));page.on("pageerror",error=>errors.push(error.message));
  await page.goto("/?demo=1");
  await expect(page.locator(".diff-panel")).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("validateRequest",{timeout:30000});
  await page.getByRole("tab",{name:"History",exact:true}).click();
  await expect(page.locator(".graph-row").first()).toBeVisible();
  await expect(page.locator(".workspace-page:not([hidden])")).toHaveCount(1);
  await page.screenshot({path:".artifacts/ui-migration/history-light.png"});
  await page.getByRole("button",{name:"设置",exact:true}).click();
  const modal=page.getByRole("dialog",{name:"设置",exact:true});
  await expect(modal.getByRole("tab",{name:"外观与阅读",exact:true})).toHaveAttribute("aria-selected","true");
  await page.screenshot({path:".artifacts/ui-migration/settings-light.png"});
  await modal.getByRole("button",{name:"深色",exact:true}).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme","dark");
  const themeReadability = await modal
    .locator(".settings-content h3")
    .first()
    .evaluate((heading) => {
      const theme = getComputedStyle(document.documentElement);
      const parse = (value: string) =>
        value.startsWith("#")
          ? value
              .slice(1)
              .match(/.{2}/g)!
              .map((channel) => parseInt(channel, 16))
          : value
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number);
      const foreground = parse(getComputedStyle(heading).color);
      const luminance = (color: number[]) =>
        color
          .map((channel) => {
            const value = channel / 255;
            return value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4;
          })
          .reduce(
            (sum, channel, index) =>
              sum + channel * [0.2126, 0.7152, 0.0722][index],
            0,
          );
      const background = parse(theme.getPropertyValue("--bg").trim());
      const levels = [luminance(foreground), luminance(background)].sort(
        (a, b) => b - a,
      );
      return {
        foreground,
        textToken: parse(theme.getPropertyValue("--text").trim()),
        contrast: (levels[0] + 0.05) / (levels[1] + 0.05),
      };
    });
  expect(themeReadability.foreground).toEqual(themeReadability.textToken);
  expect(themeReadability.contrast).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({path:".artifacts/ui-migration/settings-dark.png"});
  await page.keyboard.press("Escape");await expect(modal).not.toBeVisible();
  await expect(page.getByRole("button",{name:"设置",exact:true})).toBeFocused();
  await page.getByRole("tab",{name:/本地变更/}).click();
  await expect(page.locator(".diff-panel")).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("validateRequest",{timeout:30000});
  await page.screenshot({path:".artifacts/ui-migration/changes-dark.png"});
  expect(errors).toEqual([]);
});

test("Monaco stays read only, copies code without patch metadata and uses keyboard commands",async({page,context})=>{
  await context.grantPermissions(["clipboard-read","clipboard-write"]);
  await page.emulateMedia({reducedMotion:"reduce"});
  const requests:string[]=[];page.on("request",request=>requests.push(request.url()));
  await page.goto("/?demo=1");
  const editor=page.locator('.proof-code-editor[data-code-side="unified"]');
  await expect(editor.locator(".view-lines")).toContainText("validateRequest",{timeout:30000});
  const source=()=>page.evaluate(async()=>{const {monaco}=await import("/src/monaco-runtime.ts");return monaco.editor.getModels().map((model:any)=>model.getValue());});
  const before=await source();
  await editor.locator("textarea").focus();await page.keyboard.type("DO_NOT_EDIT");
  expect(await source()).toEqual(before);
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem",{name:"全选已加载代码",exact:true}).click();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem",{name:"复制选中代码",exact:true}).click();
  const copied=await page.evaluate(()=>navigator.clipboard.readText());
  expect(copied).toContain("validateRequest");expect(copied).not.toContain("@@");expect(copied).not.toContain("Stage Hunk");
  await editor.locator("textarea").focus();await page.keyboard.press("Meta+f");
  await expect(page.getByRole("textbox",{name:"搜索当前 Diff",exact:true})).toBeFocused();
  await page.getByRole("textbox",{name:"搜索当前 Diff",exact:true}).fill("ValidationError");
  await expect(editor.locator(".proof-search-match").first()).toBeVisible();
  await page.getByRole("button",{name:"关闭文件内容搜索",exact:true}).click();
  await page.getByRole("button",{name:"打开命令面板",exact:true}).click();
  await page.getByRole("combobox",{name:"搜索命令",exact:true}).fill("设置");
  await page.keyboard.press("ArrowDown");await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog",{name:"设置",exact:true})).toBeVisible();
  expect(requests.filter(url=>/^https?:/.test(url)&&!url.startsWith("http://127.0.0.1:1420/"))).toEqual([]);
});
