/**
 * 「文件」页的仓库文件树：把全部文件路径铺成扁平行，单子文件夹链压缩成一行
 * （与本地变更文件树同一规则，见 file-tree.ts），供 EditorView 左栏渲染。
 */
export interface RepoTreeRow {
  key: string;
  depth: number;
  parent: string | null;
  kind: "folder" | "file";
  /** folder：可能压缩过的链（如 src/main/java）；file：文件名。 */
  label: string;
  /** 完整仓库相对路径。 */
  path: string;
  expanded: boolean;
}

export function repoTreeRows(
  paths: string[],
  search: string,
  expanded: Set<string>,
): RepoTreeRow[] {
  const query = search.trim().toLocaleLowerCase();
  const visible = query
    ? paths.filter((path) => path.toLocaleLowerCase().includes(query))
    : paths;
  const rows: RepoTreeRow[] = [];
  function walk(
    children: string[],
    prefix: string,
    depth: number,
    parent: string | null,
  ) {
    const folders = new Map<string, string[]>(),
      direct: string[] = [];
    for (const path of children) {
      const rest = path.slice(prefix.length),
        slash = rest.indexOf("/");
      if (slash < 0) direct.push(path);
      else {
        const name = rest.slice(0, slash);
        folders.set(name, [...(folders.get(name) ?? []), path]);
      }
    }
    for (const [name, files] of [...folders].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      // 压缩单子文件夹链：唯一子项仍是文件夹时合并显示。
      let path = prefix + name,
        label = name;
      for (;;) {
        const subfolders = new Set<string>();
        let hasDirectFile = false;
        for (const child of files) {
          const rest = child.slice(path.length + 1),
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
      // 默认折叠，仅当用户展开过或正在搜索时展开。
      const key = `folder:${path}`,
        isExpanded = !!query || expanded.has(key);
      rows.push({
        kind: "folder",
        key,
        label,
        path,
        depth,
        parent,
        expanded: isExpanded,
      });
      if (isExpanded) walk(files, path + "/", depth + 1, key);
    }
    for (const path of direct.sort((a, b) => a.localeCompare(b)))
      rows.push({
        kind: "file",
        key: `file:${path}`,
        label: path.slice(prefix.length),
        path,
        depth,
        parent,
        expanded: true,
      });
  }
  walk(visible, "", 0, null);
  return rows;
}
