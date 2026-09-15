import { describe, expect, it } from "vitest";
import { createWindowUI, reorderComparisonTabs } from "./window-ui";
import type { ComparisonTab } from "./components/WorkspaceTabs";

describe("window UI lifetime", () => {
  it("does not leak tabs or dialogs across windows and reset lifetimes", () => {
    const first = createWindowUI(),
      second = createWindowUI("settings");
    first.setState({ tab: "commit", focused: true });
    expect(second.getState()).toMatchObject({
      tab: "changes",
      dialog: "settings",
      focused: false,
    });
    expect(createWindowUI().getState()).toMatchObject({
      tab: "changes",
      dialog: null,
      focused: false,
      diffTabs: [],
    });
  });
  it("reorders only existing comparisons inside the same workspace", () => {
    const tabs = ["a", "b", "c"].map((id, index) => ({
      id: `diff:${id}`,
      workspaceId: index === 2 ? "other" : "workspace",
      selection: { target: id, kind: "commit" },
    })) as ComparisonTab[];
    const reordered = reorderComparisonTabs(tabs, "diff:b", "diff:a");
    expect(reordered.map((tab) => tab.id)).toEqual([
      "diff:b",
      "diff:a",
      "diff:c",
    ]);
    expect(tabs.map((tab) => tab.id)).toEqual(["diff:a", "diff:b", "diff:c"]);
    expect(reorderComparisonTabs(tabs, "diff:a", "diff:c")).toBe(tabs);
    expect(reorderComparisonTabs(tabs, "diff:a", "diff:missing")).toBe(tabs);
  });
});
