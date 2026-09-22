import { fileKey } from "./types";
import type { ChangedFile, Side } from "./types";

export type TreeRow = {
  key: string;
  depth: number;
  side: Side;
  parent: string | null;
} & (
  | {
      kind: "group" | "folder";
      label: string;
      files: ChangedFile[];
      expanded: boolean;
    }
  | { kind: "file"; file: ChangedFile }
);
export function treeRows(
  files: ChangedFile[],
  scope: Side | "all",
  search: string,
  mode: "tree" | "list",
  collapsed: Set<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const side of ["unstaged", "staged"] as const) {
    if (scope !== "all" && scope !== side) continue;
    const visible = files.filter(
      (file) =>
        file.side === side &&
        file.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    );
    const key = `group:${side}`;
    const expanded = !!search || !collapsed.has(key);
    rows.push({
      kind: "group",
      key,
      side,
      label: side === "staged" ? "Staged" : "Unstaged",
      files: visible,
      depth: 1,
      parent: null,
      expanded,
    });
    if (!expanded) continue;
    function walk(
      children: ChangedFile[],
      prefix: string,
      depth: number,
      parent: string,
    ) {
      const folders = new Map<string, ChangedFile[]>(),
        direct: ChangedFile[] = [];
      for (const file of children) {
        const rest = file.path.slice(prefix.length),
          slash = rest.indexOf("/");
        if (mode === "list" || slash < 0) direct.push(file);
        else {
          const name = rest.slice(0, slash);
          folders.set(name, [...(folders.get(name) ?? []), file]);
        }
      }
      for (const [name, files] of [...folders].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        // 压缩单子文件夹链（典型如 Java 的 src/main/java/com/...）：文件夹下
        // 唯一的直接子项仍是文件夹时合并成一行，直到出现直接文件或多个子文件夹。
        let path = prefix + name,
          label = name;
        for (;;) {
          const subfolders = new Set<string>();
          let hasDirectFile = false;
          for (const file of files) {
            const rest = file.path.slice(path.length + 1),
              slash = rest.indexOf("/");
            if (slash < 0) {
              hasDirectFile = true;
              break;
            }
            subfolders.add(rest.slice(0, slash));
            if (subfolders.size > 1) break;
          }
          if (hasDirectFile || subfolders.size !== 1) break;
          const child = subfolders.values().next().value!;
          label += `/${child}`;
          path += `/${child}`;
        }
        const key = `folder:${side}:${path}`,
          expanded = !!search || !collapsed.has(key);
        rows.push({
          kind: "folder",
          key,
          side,
          label,
          files,
          depth,
          parent,
          expanded,
        });
        if (expanded) walk(files, path + "/", depth + 1, key);
      }
      for (const file of direct.sort((a, b) => a.path.localeCompare(b.path)))
        rows.push({
          kind: "file",
          key: fileKey(file),
          side,
          depth,
          parent,
          file,
        });
    }
    walk(visible, "", 2, key);
  }
  return rows;
}
