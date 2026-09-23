import type { CommitEntry } from "./types";

export interface GraphLane {
  oid: string;
  color: number;
}
export interface GraphLine {
  from: number;
  to: number;
  color: number;
  parent?: string;
  incoming?: boolean;
}
export interface GraphRow {
  oid: string;
  column: number;
  color: number;
  incoming: boolean;
  through: GraphLine[];
  parents: GraphLine[];
}
export interface CommitGraphLayout {
  rows: GraphRow[];
  columns: number;
  remaining: GraphLane[];
  nextColor: number;
}
export const GRAPH_ROW_HEIGHT = 32;
export const GRAPH_ROW_CENTER = GRAPH_ROW_HEIGHT / 2;
export const GRAPH_LANE_WIDTH = 18;

/** Layout only: every outgoing edge retains the real parent object ID. */
export function layoutCommitGraph(
  commits: readonly CommitEntry[],
): CommitGraphLayout {
  return appendCommitGraph(
    { rows: [], columns: 1, remaining: [], nextColor: 0 },
    commits,
  );
}

/** Continue only within the same immutable Git snapshot and commit order. */
export function appendCommitGraph(
  previous: CommitGraphLayout,
  commits: readonly CommitEntry[],
): CommitGraphLayout {
  if (!commits.length) return previous;
  let lanes = previous.remaining;
  let nextColor = previous.nextColor;
  let columns = previous.columns;
  const rows = [...previous.rows];
  for (const commit of commits) {
    const before = lanes;
    let column = before.findIndex((lane) => lane.oid === commit.oid);
    const incoming = column >= 0;
    if (!incoming) column = before.length;
    const color = incoming ? before[column].color : nextColor++;
    const after = before.filter((_, index) => index !== column);
    const pending = new Set(after.map((lane) => lane.oid));
    commit.parents.forEach((parent, index) => {
      if (pending.has(parent)) return;
      pending.add(parent);
      after.splice(Math.min(column + index, after.length), 0, {
        oid: parent,
        color: index === 0 ? color : nextColor++,
      });
    });
    const positions = new Map(after.map((lane, index) => [lane.oid, index]));
    const through = before.flatMap((lane, from) => {
      if (lane.oid === commit.oid) return [];
      const to = positions.get(lane.oid)!;
      return [{ from, to, color: lane.color }];
    });
    const parents = commit.parents.map((parent) => {
      const to = positions.get(parent)!;
      return { from: column, to, color: after[to].color, parent };
    });
    columns = Math.max(columns, before.length, column + 1, after.length);
    rows.push({
      oid: commit.oid,
      column,
      color,
      incoming,
      through,
      parents,
    });
    lanes = after;
  }
  return { rows, columns, remaining: lanes, nextColor };
}

export function graphX(column: number) {
  return 20 + column * GRAPH_LANE_WIDTH;
}
export function graphPath(
  from: number,
  to: number,
  start = 0,
  end = GRAPH_ROW_HEIGHT,
) {
  const x1 = graphX(from),
    x2 = graphX(to);
  if (from === to) return `M ${x1} ${start} V ${end}`;
  const midpoint = (start + end) / 2;
  return `M ${x1} ${start} C ${x1} ${midpoint}, ${x2} ${midpoint}, ${x2} ${end}`;
}
