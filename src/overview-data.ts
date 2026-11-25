import { demoGraphPage } from "./graph-demo";
import { t } from "./i18n";
import type { CommitEntry } from "./types";

export const overviewRanges = [7, 30, 90] as const;
export type OverviewRange = (typeof overviewRanges)[number];

export interface CommitDay {
  timestamp: number;
  count: number;
}

interface ContributorRanking {
  range: OverviewRange;
  active: number;
  leaders: [string, number][];
}

export interface LineChange {
  timestamp: number;
  added: number;
  removed: number;
}

export interface RepositoryOverview {
  head: string | null;
  branch: string | null;
  recent: CommitEntry[];
  activity: CommitDay[];
  contributors: ContributorRanking[];
  extensions: Record<string, number>;
  lines: LineChange[] | null;
  branches: {
    local: number;
    remote: number;
    worktrees: number;
    stale: number;
    merged: number | null;
    upstream: string | null;
    distance: [ahead: number, behind: number] | null;
  };
}

export function shiftDay(date: Date, offset: number) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + offset,
    12,
  );
}

export function dayKey(date: Date) {
  return date.toDateString();
}

export function overviewDayStarts(now: Date) {
  return Array.from(
    { length: 366 },
    (_, index) => shiftDay(now, index - 364).setHours(0, 0, 0, 0) / 1000,
  );
}

export function historyCounts(activity: CommitDay[]) {
  return new Map(
    activity.map(({ timestamp, count }) => [
      dayKey(new Date(timestamp * 1000)),
      count,
    ]),
  );
}

export function rangeBuckets(now: Date, range: OverviewRange) {
  const daysPerBucket = range === 90 ? 5 : 1;
  return Array.from(
    { length: Math.ceil(range / daysPerBucket) },
    (_, index) => {
      const from = shiftDay(now, 1 - range + index * daysPerBucket);
      const to = shiftDay(from, daysPerBucket - 1);
      return { from, to };
    },
  );
}

type CountedPeriod = { from: Date; to: Date; count: number };

export function contributors(
  overview: RepositoryOverview,
  now: Date,
  range: OverviewRange,
) {
  const dates = historyCounts(overview.activity);
  const buckets: CountedPeriod[] = rangeBuckets(now, range).map(
    ({ from, to }) => {
      let count = 0;
      for (let date = from; date <= to; date = shiftDay(date, 1))
        count += dates.get(dayKey(date)) ?? 0;
      return { from, to, count };
    },
  );
  const ranking = overview.contributors.find((item) => item.range === range);
  return {
    commits: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    active: ranking?.active ?? 0,
    leaders: ranking?.leaders ?? [],
    buckets,
  };
}

const languageLabels: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  rs: "Rust",
  go: "Go",
  java: "Java",
  py: "Python",
  swift: "Swift",
  kt: "Kotlin",
  kts: "Kotlin",
  c: "C",
  h: "C",
  cs: "C#",
  cc: "C++",
  cpp: "C++",
  hpp: "C++",
  rb: "Ruby",
  php: "PHP",
  vue: "Vue",
  svelte: "Svelte",
  sql: "SQL",
  lua: "Lua",
  md: "Markdown",
  markdown: "Markdown",
  css: "CSS",
  scss: "CSS",
  less: "CSS",
  html: "HTML",
  htm: "HTML",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  sh: "Shell",
  zsh: "Shell",
  bash: "Shell",
};

export function languageBreakdown(extensions: Record<string, number>) {
  const counts = new Map<string, number>();
  let other = 0;
  for (const [extension, count] of Object.entries(extensions)) {
    const language = Object.hasOwn(languageLabels, extension)
      ? languageLabels[extension]
      : undefined;
    if (language) counts.set(language, (counts.get(language) ?? 0) + count);
    else other += count;
  }
  const ranked = [...counts].sort(
    ([a, left], [b, right]) => right - left || a.localeCompare(b),
  );
  other += ranked.slice(4).reduce((total, [, count]) => total + count, 0);
  const first = ranked.slice(0, 4);
  if (other) first.push([t("其他文件类型"), other]);
  return first;
}

const demoAuthors = [
  "林舟",
  "Alex Chen",
  "许宁",
  "Maya Patel",
  "陈微",
  "Taylor",
];

export function demoRepositoryOverview(now = new Date()): RepositoryOverview {
  const graph = demoGraphPage("current");
  const recentDays = [3, 2, 6, 1, 0, 4, 2, 5, 0, 4, 1].flatMap((count, day) =>
    Array<number>(count).fill(day),
  );
  const recent = graph.commits.map((commit, index) => ({
    ...commit,
    date: shiftDay(now, -(recentDays[index] ?? index)).toISOString(),
  }));
  const older = Array.from({ length: 365 }, (_, day) => {
    if (day <= 10) return [];
    const date = shiftDay(now, -day);
    const hash = Math.imul(day + 19, 0x85ebca6b);
    const roll = ((hash ^ (hash >>> 13)) >>> 0) % 100;
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const threshold =
      (day < 120 ? 82 : day < 235 ? 52 : 29) - (weekend ? 23 : 0);
    const count =
      roll < threshold ? 1 + ((roll + day) % (day < 150 ? 7 : 4)) : 0;
    return Array.from({ length: count }, (_, index) => ({
      author: demoAuthors[(day * 2 + index) % demoAuthors.length],
      date: date.toISOString(),
    }));
  }).flat();
  const commits = [...recent, ...older];
  const days = overviewDayStarts(now);
  const counts = new Map<string, number>();
  for (const commit of commits) {
    const key = dayKey(new Date(commit.date));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const activity = days.slice(0, -1).map((timestamp) => ({
    timestamp,
    count: counts.get(dayKey(new Date(timestamp * 1000))) ?? 0,
  }));
  const contributors = overviewRanges.map((range) => {
    const authors = new Map<string, number>();
    const since = days[365 - range] * 1000;
    for (const { author, date } of commits) {
      if (Date.parse(date) >= since)
        authors.set(author, (authors.get(author) ?? 0) + 1);
    }
    const leaders = [...authors]
      .sort(([a, left], [b, right]) => right - left || a.localeCompare(b))
      .slice(0, 4);
    return { range, active: authors.size, leaders };
  });
  const lines = Array.from({ length: 48 }, (_, index) => ({
    timestamp: +shiftDay(now, -Math.floor((index * 28) / 48)) / 1000,
    added: 8 + ((index * 47 + (index % 5) ** 3 * 5) % 127),
    removed: (index * 17 + (index % 3) * 13) % 61,
  }));
  return {
    head: graph.head,
    branch: "main",
    recent: recent.slice(0, 4),
    activity,
    contributors,
    extensions: { ts: 38, tsx: 24, rs: 24, css: 16, md: 11, json: 5, "": 3 },
    lines,
    branches: {
      local: 7,
      remote: 12,
      worktrees: 2,
      stale: 2,
      merged: 3,
      upstream: "origin/main",
      distance: [2, 1],
    },
  };
}
