import { describe, expect, it } from "vitest";
import { repoTreeRows } from "./repo-file-tree";

describe("repo file tree", () => {
  it("collapses folders by default; root files stay visible", () => {
    const rows = repoTreeRows(
      ["src/main/java/App.java", "README.md"],
      "",
      new Set(),
    );
    expect(rows.filter((row) => row.kind === "folder")).toHaveLength(1);
    expect(rows.some((row) => row.path.endsWith("App.java"))).toBe(false);
    expect(rows.some((row) => row.path === "README.md")).toBe(true);
  });

  it("compacts single-child folder chains and keeps direct files", () => {
    const rows = repoTreeRows(
      [
        "dayu/src/main/java/com/xhs/App.java",
        "dayu/src/main/java/com/xhs/Util.java",
        "README.md",
      ],
      "",
      new Set(["folder:dayu/src/main/java/com/xhs"]),
    );
    const folders = rows.filter((row) => row.kind === "folder");
    expect(folders.map((row) => row.label)).toEqual([
      "dayu/src/main/java/com/xhs",
    ]);
    const app = rows.find((row) => row.path.endsWith("App.java"))!;
    expect(app.depth).toBe(1);
    expect(app.parent).toBe("folder:dayu/src/main/java/com/xhs");
    const readme = rows.find((row) => row.path === "README.md")!;
    expect(readme.depth).toBe(0);
    expect(readme.label).toBe("README.md");
  });

  it("stops compacting at direct files or multiple subfolders", () => {
    const rows = repoTreeRows(
      ["a/b/c/d.ts", "a/b/e.ts", "a/f.ts"],
      "",
      new Set(["folder:a", "folder:a/b"]),
    );
    expect(
      rows.filter((row) => row.kind === "folder").map((row) => row.label),
    ).toEqual(["a", "b", "c"]);
  });

  it("expands by the compacted key and expands everything while searching", () => {
    const paths = ["src/main/java/App.java", "src/main/kotlin/Main.kt"];
    // src 下只有 main 一个子文件夹 → 先压成 src/main；main 下有 java/kotlin 两个 → 停。
    const closed = repoTreeRows(paths, "", new Set());
    expect(closed.some((row) => row.kind === "file")).toBe(false);
    expect(closed.find((row) => row.kind === "folder")?.label).toBe("src/main");
    const open = repoTreeRows(paths, "", new Set(["folder:src/main"]));
    // 展开 src/main 只露出 java/kotlin 两个子文件夹，文件仍折叠在内。
    expect(
      open.filter((row) => row.kind === "folder").map((row) => row.label),
    ).toEqual(["src/main", "java", "kotlin"]);
    const deep = repoTreeRows(
      paths,
      "",
      new Set(["folder:src/main", "folder:src/main/java"]),
    );
    expect(deep.some((row) => row.path.endsWith("App.java"))).toBe(true);
    const searching = repoTreeRows(paths, "main.kt", new Set());
    expect(searching.some((row) => row.path === "src/main/kotlin/Main.kt")).toBe(
      true,
    );
    // 搜索不命中的文件不出现，但保留其祖先链。
    expect(searching.some((row) => row.path.endsWith("App.java"))).toBe(false);
  });
});
