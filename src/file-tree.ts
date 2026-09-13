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
        const path = prefix + name,
          key = `folder:${side}:${path}`,
          expanded = !!search || !collapsed.has(key);
        rows.push({
          kind: "folder",
          key,
          side,
          label: name,
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
