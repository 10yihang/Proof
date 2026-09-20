import type { BranchEntry } from "./types";

/** One node in the collapsible branch tree shown in the History sidebar. */
export interface BranchTreeNode {
  /** Last path segment, e.g. "backup" for origin/codex/backup. */
  name: string;
  /** Full path from the tree root, used as the collapse-state key. */
  path: string;
  /** Set only on leaf nodes that map to a real branch. */
  branch?: BranchEntry;
  children: BranchTreeNode[];
}

type MutableNode = Omit<BranchTreeNode, "children"> & {
  children: Map<string, MutableNode>;
};

/**
 * Build a nested folder tree from flat branch names, splitting on `delimiter`.
 * Remote refs keep their remote prefix (origin/…), so they fold into the same
 * shape without a synthetic root. Folders sort before leaves, then by name.
 */
export function buildBranchTree(
  branches: BranchEntry[],
  delimiter: string,
): BranchTreeNode[] {
  const sep = delimiter || "/";
  const roots = new Map<string, MutableNode>();
  for (const branch of branches) {
    const parts = branch.name.split(sep).filter(Boolean);
    if (!parts.length) continue;
    let nodes = roots;
    let path = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      path = path ? `${path}${sep}${part}` : part;
      let node = nodes.get(part);
      if (!node) {
        node = { name: part, path, children: new Map() };
        nodes.set(part, node);
      }
      if (i === parts.length - 1) node.branch = branch;
      nodes = node.children;
    }
  }
  return finalize(roots);
}

function finalize(map: Map<string, MutableNode>): BranchTreeNode[] {
  return [...map.values()]
    .map((node) => ({
      name: node.name,
      path: node.path,
      branch: node.branch,
      children: finalize(node.children),
    }))
    .sort((a, b) => {
      if (!a.branch && b.branch) return -1;
      if (a.branch && !b.branch) return 1;
      return a.name.localeCompare(b.name);
    });
}

/** Count real branches under a node (folders are not counted). */
export function countTreeBranches(node: BranchTreeNode): number {
  if (node.branch) return 1;
  return node.children.reduce((sum, child) => sum + countTreeBranches(child), 0);
}
