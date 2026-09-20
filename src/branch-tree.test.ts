import { describe, expect, it } from "vitest";
import { buildBranchTree, countTreeBranches } from "./branch-tree";
import type { BranchEntry } from "./types";

function branch(name: string, remote = false): BranchEntry {
  return { name, current: false, oid: "00000000", remote };
}

describe("buildBranchTree", () => {
  it("nests branches into folders by delimiter", () => {
    const tree = buildBranchTree(
      [branch("codex/backup/migrate-fix"), branch("codex/backup/squash"), branch("codex/runtime")],
      "/",
    );
    expect(tree).toHaveLength(1);
    const codex = tree[0];
    expect(codex.name).toBe("codex");
    expect(codex.branch).toBeUndefined();
    const backup = codex.children.find((c) => c.name === "backup")!;
    expect(backup.children.map((c) => c.name)).toEqual(["migrate-fix", "squash"]);
    expect(backup.children[0].branch?.name).toBe("codex/backup/migrate-fix");
    const runtime = codex.children.find((c) => c.name === "runtime")!;
    expect(runtime.branch?.name).toBe("codex/runtime");
    expect(countTreeBranches(tree[0])).toBe(3);
  });

  it("keeps delimiter-free branches as root leaves", () => {
    const tree = buildBranchTree([branch("main"), branch("codex/x")], "/");
    const codex = tree.find((n) => n.name === "codex")!;
    const main = tree.find((n) => n.name === "main")!;
    expect(codex.children).toHaveLength(1);
    expect(main.branch?.name).toBe("main");
  });

  it("supports a branch that is both a leaf and a folder prefix", () => {
    // "release" and "release/hotfix": release holds a branch AND a child.
    const tree = buildBranchTree([branch("release"), branch("release/hotfix")], "/");
    expect(tree).toHaveLength(1);
    expect(tree[0].branch?.name).toBe("release");
    expect(tree[0].children[0].name).toBe("hotfix");
  });

  it("folds remote refs under their natural origin prefix", () => {
    const tree = buildBranchTree(
      [branch("origin/HEAD", true), branch("origin/feature/a", true)],
      "/",
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("origin");
    // Folders sort before leaves: feature/… before the HEAD leaf.
    expect(tree[0].children.map((c) => c.name)).toEqual(["feature", "HEAD"]);
    expect(tree[0].children[1].branch?.remote).toBe(true);
  });

  it("honors a custom delimiter", () => {
    const tree = buildBranchTree([branch("feat-login"), branch("feat-signup")], "-");
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("feat");
    expect(tree[0].children.map((c) => c.branch?.name)).toEqual([
      "feat-login",
      "feat-signup",
    ]);
  });

  it("leaves names untouched when the delimiter does not occur", () => {
    const tree = buildBranchTree([branch("codex/backup/x")], "-");
    expect(tree).toHaveLength(1);
    expect(tree[0].branch?.name).toBe("codex/backup/x");
  });

  it("drops empty segments from repeated delimiters", () => {
    const tree = buildBranchTree([branch("a//b"), branch("/c")], "/");
    const paths: string[] = [];
    const walk = (nodes: ReturnType<typeof buildBranchTree>) =>
      nodes.forEach((n) => {
        paths.push(n.path);
        walk(n.children);
      });
    walk(tree);
    expect(paths).toEqual(["a", "a/b", "c"]);
  });

  it("sorts folders before leaves, both alphabetically", () => {
    const tree = buildBranchTree(
      [branch("zebra"), branch("alpha/x"), branch("beta")],
      "/",
    );
    expect(tree.map((n) => n.name)).toEqual(["alpha", "beta", "zebra"]);
  });
});
