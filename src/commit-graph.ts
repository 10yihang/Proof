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
  before: GraphLane[];
  after: GraphLane[];
}
export const GRAPH_ROW_HEIGHT = 40;
export const GRAPH_LANE_WIDTH = 18;

/** Layout only: every outgoing edge retains the real parent object ID. */
export function layoutCommitGraph(commits: readonly CommitEntry[]) {
  let lanes: GraphLane[] = [];
  let nextColor = 0;
  let columns = 1;
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const before = lanes.map((lane) => ({ ...lane }));
    let column = lanes.findIndex((lane) => lane.oid === commit.oid);
    const incoming = column >= 0;
    if (!incoming) {
      column = lanes.length;
      lanes.push({ oid: commit.oid, color: nextColor++ });
    }
    const color = lanes[column].color;
    const after = lanes.filter((_, index) => index !== column);
    commit.parents.forEach((parent, index) => {
      if (after.some((lane) => lane.oid === parent)) return;
      after.splice(Math.min(column + index, after.length), 0, {
        oid: parent,
        color: index === 0 ? color : nextColor++,
      });
    });
    const through = before.flatMap((lane, from) => {
      if (lane.oid === commit.oid) return [];
      const to = after.findIndex((candidate) => candidate.oid === lane.oid);
      return [{ from, to, color: lane.color }];
    });
    const parents = commit.parents.map((parent) => {
      const to = after.findIndex((lane) => lane.oid === parent);
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
      before,
      after,
    });
    lanes = after.map((lane) => ({ ...lane }));
  }
  return { rows, columns, remaining: lanes };
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
