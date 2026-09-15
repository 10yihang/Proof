import { afterEach, describe, expect, it } from "vitest";
import zh from "./i18n/zh-CN.json";
import en from "./i18n/en.json";
import {
  getLanguage,
  setLanguage,
  t,
  translate,
  uiMessage,
  riskLabel,
} from "./i18n";
afterEach(() => setLanguage("zh-CN"));
describe("application i18n", () => {
  it("has complete catalogs with matching interpolation parameters", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    const params = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(en[key].trim(), key).not.toBe("");
      expect(params(en[key]), key).toEqual(params(zh[key]));
    }
  });
  it("switches copy while retaining technical terms and literal user values", () => {
    expect(getLanguage()).toBe("zh-CN");
    expect(t("Review Current Change")).toBe("Review 当前变更");
    for (const term of [
      "History",
      "Commit",
      "Git",
      "Review",
      "Worktree",
      "Diff",
    ] as const) {
      if (term === "Git") continue;
      expect(t(term)).toBe(term);
    }
    setLanguage("en");
    expect(t("Review Current Change")).toBe("Review Current Change");
    const name = "设置 <script> {v1} & 中文.ts";
    expect(t("Rename {v0}", { v0: name })).toBe(`Rename ${name}`);
    expect(riskLabel("high")).toBe("High risk");
    expect(translate("Local changes · {v0} files", "en", { v0: 1 })).toBe(
      "Local changes · 1 file",
    );
    expect(translate("Local changes · {v0} files", "en", { v0: 2 })).toBe(
      "Local changes · 2 files",
    );
  });
  it("translates known backend feedback and preserves diagnostic or source text", () => {
    setLanguage("en");
    expect(
      uiMessage("CLI 启动所需的文件或系统能力受限，请查看失败详情。"),
    ).toMatch(/^Files or system capabilities/);
    expect(uiMessage("已切换到 feature/中文")).toBe("Switched to feature/中文");
    expect(uiMessage("const 提交 = '保留原文';")).toBe(
      "const 提交 = '保留原文';",
    );
    setLanguage("zh-CN");
    expect(uiMessage("Switched to feature/中文")).toBe("已切换到 feature/中文");
  });
});
