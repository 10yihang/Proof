import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowClockwise,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarDots,
  CaretRight,
  Checks,
  CheckCircle,
  Code,
  GitBranch,
  GitCommit,
  GitDiff,
  Stack,
  Users,
  Warning,
  type Icon,
} from "@phosphor-icons/react";
import { useRequest } from "../api";
import { getLanguage, t } from "../i18n";
import {
  contributors,
  dayKey,
  demoRepositoryOverview,
  historyCounts,
  languageBreakdown,
  overviewDayStarts,
  overviewRanges,
  rangeBuckets,
  shiftDay,
  type LineChange,
  type CommitDay,
  type OverviewRange,
  type RepositoryOverview,
} from "../overview-data";
import { relativeTime } from "../relative-time";
import type { ReviewCoverage } from "../review-coverage";
import type { ChangedFile, Changes, CommitEntry } from "../types";
import type { HistoryComparison } from "./HistoryDiff";
import { Button } from "./ui/controls";
import "../styles/overview.css";

const num = (value: number) => value.toLocaleString(getLanguage());

export default function WorkspaceOverview({
  active,
  changes,
  demo,
  historyRevision,
  busy,
  coverage,
  nextReview,
  onOpenFile,
  onOpenChanges,
  onOpenHistory,
  onOpenDiff,
}: {
  active: boolean;
  changes: Changes;
  demo: boolean;
  historyRevision: number;
  busy: boolean;
  coverage: ReviewCoverage;
  nextReview?: ChangedFile;
  onOpenFile: (file: ChangedFile) => void;
  onOpenChanges: () => void;
  onOpenHistory: () => void;
  onOpenDiff: (comparison: HistoryComparison) => void;
}) {
  const request = useRequest();
  const { head, branch, files, workspace } = changes;
  const today = +shiftDay(new Date(), 0);
  const now = new Date(today);
  const dayStarts = useMemo(() => overviewDayStarts(new Date(today)), [today]);
  const [range, setRange] = useState<OverviewRange>(30);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    value: RepositoryOverview | null;
  }>();
  const read = useRef<{
    key: string;
    promise: Promise<RepositoryOverview | null>;
  } | null>(null);
  const key = JSON.stringify([
    workspace.id,
    head,
    branch,
    today,
    historyRevision,
    revision,
  ]);
  const stillCurrent = result?.key === key;
  const pending = !demo && !stillCurrent;
  const failed = !demo && stillCurrent && !result?.value;
  const sample = useMemo(
    () => (demo ? demoRepositoryOverview(new Date(today)) : null),
    [demo, today],
  );
  const data = demo ? sample : stillCurrent ? result.value : null;

  useEffect(() => {
    if (!active || demo || stillCurrent) return;
    if (read.current?.key !== key) {
      read.current = {
        key,
        promise: request<RepositoryOverview>("repository_overview", {
          workspaceId: workspace.id,
          dayStarts,
        })
          .then((value) =>
            value.head === head && value.branch === branch ? value : null,
          )
          .catch(() => null),
      };
    }
    let cancelled = false;
    void read.current.promise.then((value) => {
      if (!cancelled) setResult({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    branch,
    dayStarts,
    demo,
    head,
    key,
    request,
    stillCurrent,
    workspace.id,
  ]);

  const conflict = files.find((file) => file.conflicted);
  const target = conflict ?? nextReview;
  const ReviewIcon = conflict ? Warning : target ? Checks : CheckCircle;
  const changeCount = new Set(files.map((file) => file.path)).size;

  function unavailable(message: string) {
    return (
      <p className="ov-empty">
        {pending ? (
          <span className="ov-skeleton" aria-hidden="true" />
        ) : failed ? (
          t("统计暂不可用")
        ) : (
          message
        )}
      </p>
    );
  }

  return (
    <div className="overview-layout">
      <header className="ov-top">
        <div className="ov-title">
          <h1>{t("总览")}</h1>
          <span className="ov-scope" title={t("本地分支和已抓取的远程分支")}>
            <GitBranch size={13} aria-hidden="true" />
            {t("所有分支")}
          </span>
        </div>
        <div className="ov-top-tools">
          <div
            className="ov-period"
            role="group"
            aria-label={t("统计范围")}
            style={
              {
                "--period-index": overviewRanges.indexOf(range),
              } as CSSProperties
            }
          >
            {overviewRanges.map((days) => (
              <button
                type="button"
                key={days}
                aria-pressed={range === days}
                onClick={() => setRange(days)}
              >
                {t("{days} 天", { days })}
              </button>
            ))}
          </div>
          <Button
            className="icon-button ov-refresh"
            aria-label={t("刷新统计")}
            title={t("刷新统计")}
            disabled={pending || demo}
            onClick={() => setRevision((value) => value + 1)}
          >
            <ArrowClockwise size={16} aria-hidden="true" />
          </Button>
        </div>
      </header>
      <section
        className="ov-review"
        aria-label={t("审查进度")}
        data-conflict={!!conflict || undefined}
      >
        <span className="ov-review-icon">
          <ReviewIcon size={19} aria-hidden="true" />
        </span>
        <div className="ov-review-label">
          <strong>
            {t(
              conflict
                ? "有冲突待处理"
                : target
                  ? "待审查"
                  : files.length
                    ? "审查进度"
                    : "当前没有代码变化",
            )}
          </strong>
          {target && <code title={target.path}>{target.path}</code>}
        </div>
        <div className="ov-review-state">
          {coverage.total > 0 && (
            <div className="ov-review-line">
              <span title={t("已审查的变更块")}>
                {coverage.reviewed}/{coverage.total} {t("已审查")}
              </span>
              <div
                className="ov-meter"
                role="progressbar"
                aria-label={t("已审查的变更块")}
                aria-valuemin={0}
                aria-valuemax={coverage.total}
                aria-valuenow={coverage.reviewed}
              >
                <span
                  style={{
                    transform: `scaleX(${coverage.reviewed / coverage.total})`,
                  }}
                />
              </div>
            </div>
          )}
          {coverage.unreadFiles > 0 && (
            <small>
              {t("{count} 项变更尚未读取", { count: coverage.unreadFiles })}
            </small>
          )}
        </div>
        {!!target && (
          <Button
            className="button primary compact ov-review-action"
            disabled={busy}
            onClick={() => onOpenFile(target)}
          >
            {t(conflict ? "查看冲突" : "继续审查")}
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
        )}
      </section>

      <div className="ov-grid" aria-busy={pending}>
        {pending && (
          <span className="sr-only" role="status">
            {t("正在读取仓库统计…")}
          </span>
        )}
        {failed && (
          <div className="ov-error" role="status">
            <Warning size={16} aria-hidden="true" />
            {t("无法读取仓库统计。")}
            <Button
              className="ov-link"
              onClick={() => setRevision((value) => value + 1)}
            >
              {t("重试")}
            </Button>
          </div>
        )}
        <Card name="ov-contributors" icon={Users} title={t("贡献者")}>
          {data ? (
            <Contributors data={data} now={now} range={range} />
          ) : (
            unavailable(t("这段时间没有提交"))
          )}
        </Card>
        <Card
          name="ov-languages"
          icon={Code}
          title={t("语言分布")}
          aside={
            branch
              ? `${t("当前分支")} · ${t("按已提交文件")}`
              : t("按已提交文件")
          }
        >
          {data ? (
            <Languages extensions={data.extensions} />
          ) : (
            unavailable(t("暂无已提交文件"))
          )}
        </Card>
        <Card
          name="ov-heatmap"
          icon={CalendarDots}
          title={t("提交热力图")}
          aside={t("最近一年")}
        >
          {data ? (
            <Heatmap activity={data.activity} now={now} />
          ) : (
            unavailable(t("暂无提交活动"))
          )}
        </Card>
        <Card
          name="ov-branches"
          icon={GitBranch}
          title={t("分支与协作")}
          action={<Jump onClick={onOpenHistory}>{t("查看分支")}</Jump>}
        >
          {data ? (
            <Branches value={data.branches} />
          ) : (
            unavailable(t("暂无分支信息"))
          )}
        </Card>
        <Card
          name="ov-worktree"
          icon={Stack}
          title={t("工作区")}
          action={<Jump onClick={onOpenChanges}>{t("查看变更")}</Jump>}
        >
          <Worktree files={files} total={changeCount} />
        </Card>
        <Card
          name="ov-churn"
          icon={GitDiff}
          title={t("代码增删")}
          aside={t("非合并提交")}
        >
          {data ? (
            <Churn lines={data.lines} range={range} now={now} />
          ) : (
            unavailable(t("暂无代码增删"))
          )}
        </Card>
        <Card
          name="ov-recent"
          icon={GitCommit}
          title={t("最近提交")}
          action={<Jump onClick={onOpenHistory}>{t("查看历史")}</Jump>}
        >
          {data ? (
            <Recent commits={data.recent} onOpenDiff={onOpenDiff} />
          ) : (
            unavailable(t("仓库还没有提交"))
          )}
        </Card>
      </div>
    </div>
  );
}

function Card({
  name,
  icon: Icon,
  title,
  aside,
  action,
  children,
}: {
  name: string;
  icon: Icon;
  title: string;
  aside?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`ov-card ${name}`}>
      <header className="ov-card-head">
        <h2>
          <span className="ov-glyph">
            <Icon size={15} aria-hidden="true" />
          </span>
          {title}
        </h2>
        {aside && <small>{aside}</small>}
        {action}
      </header>
      {children}
    </section>
  );
}

function Jump({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button className="ov-link" onClick={onClick}>
      {children}
      <CaretRight size={12} aria-hidden="true" />
    </Button>
  );
}

function Contributors({
  data,
  now,
  range,
}: {
  data: RepositoryOverview;
  now: Date;
  range: OverviewRange;
}) {
  const stat = contributors(data, now, range);
  const date = new Intl.DateTimeFormat(getLanguage(), {
    month: "short",
    day: "numeric",
  });
  const max = Math.max(1, ...stat.buckets.map((bucket) => bucket.count));
  const leading = stat.leaders.map(
    ([name, count]) => [name || t("未知作者"), count] as const,
  );
  return (
    <div className="ov-contribution-body">
      <div className="ov-trend">
        <div className="ov-stat-line">
          <strong>{num(stat.commits)}</strong> {t("提交次数")}
          <span className="ov-stat-divider" />
          <b>{num(stat.active)}</b> {t("活跃贡献者")}
        </div>
        <div className="ov-trend-chart" role="img" aria-label={t("提交趋势")}>
          <span className="ov-y-axis" aria-hidden="true">
            <span>{max}</span>
            <span>0</span>
          </span>
          <div className="ov-trend-bars" key={range}>
            {stat.buckets.map(({ from, to, count }) => (
              <span
                className="ov-bar-slot"
                key={dayKey(from)}
                title={t("{date}，{count} 条提交", {
                  date:
                    +from === +to
                      ? date.format(from)
                      : date.formatRange(from, to),
                  count,
                })}
              >
                <i
                  style={{ height: count ? `${(count / max) * 100}%` : "2px" }}
                  data-empty={!count || undefined}
                />
              </span>
            ))}
          </div>
        </div>
        <div className="ov-chart-caption">
          <span>{date.format(stat.buckets[0].from)}</span>
          <span>{date.format(now)}</span>
        </div>
      </div>
      <div className="ov-ranking">
        <h3>{t("最活跃")}</h3>
        {leading.length ? (
          <ol>
            {leading.map(([author, count], index) => (
              <li key={author}>
                <span
                  className="ov-author"
                  data-tone={index}
                  aria-hidden="true"
                >
                  {Array.from(author.trim())[0]?.toUpperCase()}
                </span>
                <span className="ov-author-name" title={author}>
                  {author}
                </span>
                <span className="ov-rank-track" aria-hidden="true">
                  <i style={{ width: `${(count / leading[0][1]) * 100}%` }} />
                </span>
                <strong>{num(count)}</strong>
              </li>
            ))}
          </ol>
        ) : (
          <p className="ov-empty">{t("这段时间没有提交")}</p>
        )}
      </div>
    </div>
  );
}

function Languages({ extensions }: { extensions: Record<string, number> }) {
  const rows = languageBreakdown(extensions);
  const total = rows.reduce((sum, row) => sum + row[1], 0);
  if (!total) return <p className="ov-empty">{t("暂无已提交文件")}</p>;
  let offset = 0;
  const segments = rows.map(([, count], index) => {
    const start = offset;
    offset += (count * 100) / total;
    return `var(--ov-language-${index}) ${start}% ${offset}%`;
  });
  return (
    <div className="ov-language-body">
      <div
        className="ov-donut"
        style={{ background: `conic-gradient(${segments.join(",")})` }}
      >
        <div className="ov-donut-center">
          <strong>{num(total)}</strong>
          <span>{t("文件")}</span>
        </div>
      </div>
      <ul className="ov-language-list">
        {rows.map(([name, count], index) => (
          <li key={name} title={`${name} · ${num(count)}`}>
            <i
              style={{ background: `var(--ov-language-${index})` }}
              aria-hidden="true"
            />
            <span>{name}</span>
            <strong>
              {((count * 100) / total).toLocaleString(getLanguage(), {
                maximumFractionDigits: 1,
              })}
              %
            </strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Heatmap({ activity, now }: { activity: CommitDay[]; now: Date }) {
  const dates = historyCounts(activity);
  const last = shiftDay(now, 0);
  const start = shiftDay(last, -364 - ((last.getDay() + 6) % 7));
  const label = new Intl.DateTimeFormat(getLanguage(), {
    month: "short",
    day: "numeric",
  });
  const month = new Intl.DateTimeFormat(getLanguage(), { month: "short" });
  const cells = Array.from({ length: 371 }, (_, index) => {
    const date = shiftDay(start, index);
    return { date, future: date > last, count: dates.get(dayKey(date)) ?? 0 };
  });
  const year = shiftDay(last, -364);
  const valid = cells.filter(({ date }) => date >= year && date <= last);
  const volume = valid.reduce((sum, day) => sum + day.count, 0);
  const active = valid.filter((day) => day.count > 0).length;
  const peak = Math.max(1, ...valid.map((day) => day.count));
  const getLevel = (count: number) =>
    count ? Math.max(1, Math.ceil((count / peak) * 4)) : 0;
  return (
    <div className="ov-heat-body">
      <div className="ov-heat">
        <div className="ov-months" aria-hidden="true">
          {cells
            .filter((_, idx) => idx % 7 === 0)
            .map(
              ({ date }, index, weeks) =>
                (index === 0
                  ? date.getMonth() === weeks[2].date.getMonth()
                  : date.getMonth() !== weeks[index - 1].date.getMonth()) && (
                  <span key={dayKey(date)} style={{ gridColumn: index + 1 }}>
                    {month.format(date)}
                  </span>
                ),
            )}
        </div>
        <ol className="ov-heat-cells" aria-label={t("每日提交记录")}>
          {cells.map(({ date, count, future }) => {
            const inRange = date >= year && !future;
            const caption = inRange
              ? t("{date}，{count} 条提交", { date: label.format(date), count })
              : undefined;
            return (
              <li
                key={dayKey(date)}
                data-level={getLevel(count)}
                data-blank={!inRange || undefined}
                title={caption}
                aria-hidden={!inRange || undefined}
              >
                {caption && <span className="sr-only">{caption}</span>}
              </li>
            );
          })}
        </ol>
      </div>
      <div className="ov-heat-foot">
        <span>
          <b>{num(volume)}</b> {t("提交次数")}{" "}
          <span className="ov-dot-divider">·</span> <b>{num(active)}</b>{" "}
          {t("活跃天数")}
        </span>
        <span className="ov-heat-key" aria-hidden="true">
          {t("少")}
          {[0, 1, 2, 3, 4].map((level) => (
            <i key={level} data-level={level} />
          ))}
          {t("多")}
        </span>
      </div>
    </div>
  );
}

function Branches({ value }: { value: RepositoryOverview["branches"] }) {
  return (
    <div className="ov-branch-body">
      <div className="ov-upstream">
        <code title={value.upstream ?? undefined}>
          {value.upstream ?? t("未设置上游")}
        </code>
        {value.distance ? (
          <div className="ov-distance">
            <span aria-label={t("领先 {count}", { count: value.distance[0] })}>
              <ArrowUp size={12} aria-hidden="true" />
              {num(value.distance[0])}
            </span>
            <span aria-label={t("落后 {count}", { count: value.distance[1] })}>
              <ArrowDown size={12} aria-hidden="true" />
              {num(value.distance[1])}
            </span>
          </div>
        ) : (
          value.upstream && <small>{t("同步状态未知")}</small>
        )}
      </div>
      <dl className="ov-ref-counts">
        <div>
          <dt>{t("本地分支")}</dt>
          <dd>{num(value.local)}</dd>
        </div>
        <div>
          <dt>{t("远程分支")}</dt>
          <dd>{num(value.remote)}</dd>
        </div>
        <div>
          <dt>Worktree</dt>
          <dd>{num(value.worktrees)}</dd>
        </div>
      </dl>
      <div className="ov-health">
        {value.merged !== null && (
          <span>
            <i />
            {t("{count} 个已合入 HEAD", { count: num(value.merged) })}
          </span>
        )}
        <span data-warning={value.stale > 0 || undefined}>
          <i />
          {t("{count} 个 90 天未更新", { count: num(value.stale) })}
        </span>
      </div>
    </div>
  );
}

function Worktree({ files, total }: { files: ChangedFile[]; total: number }) {
  const counts = { staged: 0, unstaged: 0, untracked: 0 };
  const conflictedPaths = new Set<string>();
  for (const file of files) {
    if (file.conflicted) conflictedPaths.add(file.path);
    else if (file.status === "?") counts.untracked++;
    else counts[file.side]++;
  }
  const states = [
    { label: t("已暂存"), count: counts.staged, tone: "staged" },
    { label: t("未暂存修改"), count: counts.unstaged, tone: "unstaged" },
    { label: t("未跟踪"), count: counts.untracked, tone: "untracked" },
    { label: t("冲突"), count: conflictedPaths.size, tone: "conflict" },
  ];
  const width = Math.max(1, ...states.map((state) => state.count));
  return (
    <div className="ov-worktree-body">
      <div className="ov-file-total">
        <strong>{num(total)}</strong>
        <span>{t("Changed files")}</span>
      </div>
      <dl className="ov-file-counts">
        {states.map(({ label, count, tone }) => (
          <div key={tone} data-tone={tone}>
            <dt>
              <i />
              {label}
            </dt>
            <dd>
              <span className="ov-count-track" aria-hidden="true">
                <i style={{ width: `${(count / width) * 100}%` }} />
              </span>
              <b>{num(count)}</b>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Churn({
  lines,
  range,
  now,
}: {
  lines: LineChange[] | null;
  range: OverviewRange;
  now: Date;
}) {
  if (!lines) return <p className="ov-empty">{t("代码增删暂不可用")}</p>;
  const counts = new Map<string, number[]>();
  for (const { timestamp, added, removed } of lines) {
    const key = dayKey(new Date(timestamp * 1000));
    const aggregate = counts.get(key) ?? [0, 0];
    aggregate[0] += added;
    aggregate[1] += removed;
    counts.set(key, aggregate);
  }
  const data = rangeBuckets(now, range).map(({ from, to }) => {
    let added = 0,
      removed = 0;
    for (let day = from; day <= to; day = shiftDay(day, 1)) {
      const count = counts.get(dayKey(day));
      added += count?.[0] ?? 0;
      removed += count?.[1] ?? 0;
    }
    return { from, to, added, removed };
  });
  const date = new Intl.DateTimeFormat(getLanguage(), {
    month: "short",
    day: "numeric",
  });
  const max = Math.max(
    1,
    ...data.flatMap(({ added, removed }) => [added, removed]),
  );
  const added = data.reduce((sum, value) => sum + value.added, 0);
  const removed = data.reduce((sum, value) => sum + value.removed, 0);
  return (
    <div className="ov-churn-body">
      <div className="ov-line-totals">
        <strong className="ov-add">+{num(added)}</strong>
        <strong className="ov-del">−{num(removed)}</strong>
        <small>{t("行")}</small>
      </div>
      <div
        className="ov-churn-chart"
        role="img"
        aria-label={t("代码增删趋势")}
        key={range}
      >
        {data.map((bar) => (
          <span
            className="ov-churn-slot"
            key={dayKey(bar.from)}
            title={`${date.formatRange(bar.from, bar.to)} · +${num(bar.added)} / −${num(bar.removed)}`}
          >
            <i
              className="ov-add-bar"
              style={{ height: `${(bar.added / max) * 50}%` }}
            />
            <i
              className="ov-del-bar"
              style={{ height: `${(bar.removed / max) * 50}%` }}
            />
          </span>
        ))}
      </div>
      <p className="ov-churn-note">{t("最近 {days} 天", { days: range })}</p>
    </div>
  );
}

function Recent({
  commits,
  onOpenDiff,
}: {
  commits: CommitEntry[];
  onOpenDiff: (comparison: HistoryComparison) => void;
}) {
  if (!commits.length) return <p className="ov-empty">{t("仓库还没有提交")}</p>;
  return (
    <ul className="ov-recent-list">
      {commits.map((commit) => (
        <li key={commit.oid}>
          <Button
            className="ov-commit"
            title={commit.subject}
            onClick={() =>
              onOpenDiff({
                target: commit.oid,
                targetLabel: commit.subject,
                parents: commit.parents,
                unavailable:
                  commit.boundary === "shallow"
                    ? t("父版本尚未获取。")
                    : undefined,
              })
            }
          >
            <span className="ov-commit-marker" aria-hidden="true" />
            <span className="ov-commit-copy">
              <strong>{commit.subject || commit.oid.slice(0, 8)}</strong>
              <small>
                {commit.author}
                <span> · </span>
                {relativeTime(commit.date)}
              </small>
            </span>
            <CaretRight size={12} aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
