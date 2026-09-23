import { describe, expect, it } from "vitest";
import { appendCommitGraph, layoutCommitGraph } from "./commit-graph";
import type { CommitEntry } from "./types";

const commit = (oid: string, ...parents: string[]): CommitEntry => ({
  oid,
  parents,
  subject: oid,
  date: "2026-09-12",
  author: "Fixture",
  refs: "",
});
function checkConnections(commits: CommitEntry[]) {
  const graph = layoutCommitGraph(commits);
  let lanes: string[] = [];
  graph.rows.forEach((row, index) => {
    expect(row.parents.map((edge) => edge.parent)).toEqual(
      commits[index].parents,
    );
    if (row.incoming) expect(lanes[row.column]).toBe(commits[index].oid);
    else expect(lanes).not.toContain(commits[index].oid);
    // Reconstruct identities from the rendered edges. This checks topology
    // independently of the layout's internal before/after lane bookkeeping.
    const next: string[] = [];
    row.through.forEach((edge) => {
      expect(edge.from).toBeGreaterThanOrEqual(0);
      expect(edge.to).toBeGreaterThanOrEqual(0);
      expect(lanes[edge.from]).toBeDefined();
      expect(lanes[edge.from]).not.toBe(commits[index].oid);
      next[edge.to] = lanes[edge.from];
    });
    row.parents.forEach((edge) => {
      expect(edge.from).toBe(row.column);
      expect(edge.to).toBeGreaterThanOrEqual(0);
      if (next[edge.to]) expect(next[edge.to]).toBe(edge.parent);
      next[edge.to] = edge.parent!;
    });
    expect(row.through).toHaveLength(lanes.length - Number(row.incoming));
    expect(new Set(next).size).toBe(next.length);
    expect(next.every((oid) => !!oid)).toBe(true);
    lanes = next;
  });
  expect(lanes).toEqual(graph.remaining.map((lane) => lane.oid));
  return graph;
}
describe("commit topology", () => {
  it("retains only renderable edges and the final lane cursor", () => {
    const graph = layoutCommitGraph([
      commit("merge", "a", "b"),
      commit("a", "root"),
      commit("b", "root"),
    ]);
    for (const row of graph.rows) {
      expect(row).not.toHaveProperty("before");
      expect(row).not.toHaveProperty("after");
    }
  });
  it("appends a page without rebuilding or mutating previous rows", () => {
    const first = [commit("merge", "a", "b"), commit("other")];
    const second = [commit("a", "root"), commit("b", "root"), commit("root")];
    const graph = layoutCommitGraph(first);
    const saved = structuredClone(graph);
    const appended = appendCommitGraph(graph, second);
    expect(appended).toEqual(layoutCommitGraph([...first, ...second]));
    expect(graph).toEqual(saved);
    expect(appended.rows[0]).toBe(graph.rows[0]);
    expect(appended.rows[1]).toBe(graph.rows[1]);
    expect(appendCommitGraph(appended, [])).toBe(appended);
  });
  it("preserves fork, merge and boundary identities across arbitrary page splits", () => {
    for (let seed = 1; seed <= 8; seed++) {
      let random = seed;
      const next = () => {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        return random;
      };
      const commits = Array.from({ length: 400 }, (_, index) => {
        const parents = new Set<string>();
        const count = next() % 4;
        for (let parent = 0; parent < count; parent++)
          parents.add(String(index + 1 + (next() % 30)));
        return commit(String(index), ...parents);
      });
      const expected = checkConnections(commits);
      let paged = layoutCommitGraph([]);
      for (let offset = 0; offset < commits.length; offset += 97)
        paged = appendCommitGraph(paged, commits.slice(offset, offset + 97));
      expect(paged).toEqual(expected);
    }
  });
  it("connects a fork and merge to their actual parents", () => {
    const graph = checkConnections([
      commit("merge", "main", "feature"),
      commit("feature", "base"),
      commit("main", "base"),
      commit("base"),
    ]);
    expect(graph.rows[0].parents).toHaveLength(2);
    expect(graph.columns).toBeGreaterThan(1);
    expect(graph.remaining).toEqual([]);
  });
  it("supports octopus merges and disconnected roots without inventing edges", () => {
    const graph = checkConnections([
      commit("merge", "a", "b", "c"),
      commit("other"),
      commit("a", "root"),
      commit("b", "root"),
      commit("c", "root"),
      commit("root"),
    ]);
    expect(graph.rows[1].incoming).toBe(false);
    expect(graph.rows[1].parents).toEqual([]);
    expect(graph.remaining).toEqual([]);
  });
  it("keeps existing lanes stable when the next page arrives", () => {
    const first = [commit("merge", "a", "b"), commit("a", "root")];
    const before = layoutCommitGraph(first);
    const after = checkConnections([
      ...first,
      commit("b", "root"),
      commit("root"),
    ]);
    expect(after.rows.slice(0, first.length)).toEqual(before.rows);
    expect(before.remaining.map((lane) => lane.oid).sort()).toEqual([
      "b",
      "root",
    ]);
  });
  it("leaves a missing parent as a boundary instead of connecting a nearby commit", () => {
    const graph = checkConnections([
      commit("a", "unavailable"),
      commit("unrelated"),
    ]);
    expect(graph.remaining[0].oid).toBe("unavailable");
    expect(graph.rows[1].incoming).toBe(false);
  });
});
