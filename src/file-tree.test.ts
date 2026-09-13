import { describe, it, expect } from "vitest";
import { treeRows } from "./file-tree";
import type { ChangedFile } from "./types";
const file = (
  path: string,
  side: "unstaged" | "staged" = "unstaged",
): ChangedFile => ({
  path,
  side,
  status: "M",
  oldPath: null,
  conflicted: false,
});
describe("changes tree", () => {
  it("represents nested directories once and keeps the two index sides separate", () => {
    const rows = treeRows(
      [
        file("src/api/a.ts"),
        file("src/api/b.ts"),
        file("src/lib/c.ts"),
        file("src/api/a.ts", "staged"),
      ],
      "all",
      "",
      "tree",
      new Set(),
    );
    expect(
      rows.filter((row) => row.kind === "folder" && row.label === "src"),
    ).toHaveLength(2);
    const a = rows.find((row) => row.key === "unstaged:src/api/a.ts")!;
    expect(a.depth).toBe(4);
    expect(a.parent).toBe("folder:unstaged:src/api");
  });
  it("collapses descendants and limits folder actions to the filtered visible files", () => {
    const files = [file("src/api/a.ts"), file("src/api/b.ts")];
    const collapsed = new Set(["folder:unstaged:src"]);
    expect(
      treeRows(files, "all", "", "tree", collapsed).some(
        (row) => row.kind === "file",
      ),
    ).toBe(false);
    const rows = treeRows(files, "all", "a.ts", "tree", collapsed);
    const folder = rows.find((row) => row.key === "folder:unstaged:src");
    expect(
      folder && folder.kind !== "file" && folder.files.map((file) => file.path),
    ).toEqual(["src/api/a.ts"]);
    expect(rows.filter((row) => row.kind === "file")).toHaveLength(1);
  });
});
