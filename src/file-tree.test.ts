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
    // unstaged 侧 src 下有 api、lib 两个子文件夹 → 不压缩；staged 侧只有
    // src/api 一条链 → 压缩为单行 "src/api"，两侧结构独立。
    expect(
      rows.filter((row) => row.kind === "folder" && row.label === "src"),
    ).toHaveLength(1);
    expect(
      rows.filter((row) => row.kind === "folder" && row.label === "src/api"),
    ).toHaveLength(1);
    const a = rows.find((row) => row.key === "unstaged:src/api/a.ts")!;
    expect(a.depth).toBe(4);
    expect(a.parent).toBe("folder:unstaged:src/api");
  });
  it("collapses descendants and limits folder actions to the filtered visible files", () => {
    const files = [file("src/api/a.ts"), file("src/api/b.ts")];
    // src 下唯一子项是 api 文件夹 → 压缩为一行 "src/api"。
    const collapsed = new Set(["folder:unstaged:src/api"]);
    expect(
      treeRows(files, "all", "", "tree", collapsed).some(
        (row) => row.kind === "file",
      ),
    ).toBe(false);
    const rows = treeRows(files, "all", "a.ts", "tree", collapsed);
    const folder = rows.find((row) => row.key === "folder:unstaged:src/api");
    expect(folder && folder.kind !== "file" && folder.label).toBe("src/api");
    expect(
      folder && folder.kind !== "file" && folder.files.map((file) => file.path),
    ).toEqual(["src/api/a.ts"]);
    expect(rows.filter((row) => row.kind === "file")).toHaveLength(1);
  });
  it("compacts single-child folder chains like Java package directories", () => {
    const rows = treeRows(
      [
        file("src/main/java/com/xhs/App.java"),
        file("src/main/java/com/xhs/Util.java"),
      ],
      "all",
      "",
      "tree",
      new Set(),
    );
    const folders = rows.filter((row) => row.kind === "folder");
    expect(folders).toHaveLength(1);
    expect(
      folders[0].kind === "folder" && {
        label: folders[0].label,
        depth: folders[0].depth,
        key: folders[0].key,
      },
    ).toEqual({
      label: "src/main/java/com/xhs",
      depth: 2,
      key: "folder:unstaged:src/main/java/com/xhs",
    });
    const app = rows.find(
      (row) => row.key === "unstaged:src/main/java/com/xhs/App.java",
    )!;
    expect(app.depth).toBe(3);
    expect(app.parent).toBe("folder:unstaged:src/main/java/com/xhs");
  });
  it("stops compacting at direct files or multiple subfolders", () => {
    const rows = treeRows(
      [
        file("a/b/c/d.ts"),
        file("a/b/e.ts"),
        file("a/f.ts"),
        file("a/b/c/g/h.ts"),
      ],
      "all",
      "",
      "tree",
      new Set(),
    );
    const labels = rows
      .filter((row) => row.kind === "folder")
      .map((row) => (row.kind === "folder" ? row.label : ""));
    // a 含直接文件 f.ts → 不压缩；b 同时含 c 与直接文件 e.ts → 不压缩；
    // c 只含 d.ts、g/ → 有 g 子文件夹和直接文件 → 不压缩；g 单子链压缩到 g。
    expect(labels).toEqual(["a", "b", "c", "g"]);
  });
});
