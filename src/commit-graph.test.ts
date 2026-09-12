import { describe, expect, it } from "vitest";
import { layoutCommitGraph } from "./commit-graph";
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
  graph.rows.forEach((row, index) => {
    expect(row.parents.map((edge) => edge.parent)).toEqual(
      commits[index].parents,
    );
    row.parents.forEach((edge) =>
      expect(row.after[edge.to].oid).toBe(edge.parent),
    );
    row.through.forEach((edge) =>
      expect(row.after[edge.to].oid).toBe(row.before[edge.from].oid),
    );
    if (index + 1 < graph.rows.length)
      expect(row.after).toEqual(graph.rows[index + 1].before);
  });
  return graph;
}
describe("commit topology", () => {
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
