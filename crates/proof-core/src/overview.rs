use crate::{git::Git, model::*, process, Error, Proof, Result};
use serde::Serialize;
use std::{collections::BTreeMap, path::Path, time::Duration};

const ACTIVITY_DAYS: usize = 365;
const RANGES: [usize; 3] = [7, 30, 90];
const STALE_SECONDS: u64 = 90 * 86_400;

pub struct RepositoryOverviewRead {
    git: Git,
    workspace: Workspace,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOverview {
    head: Option<String>,
    branch: Option<String>,
    recent: Vec<CommitEntry>,
    activity: Vec<CommitDay>,
    contributors: Vec<ContributorRanking>,
    extensions: BTreeMap<String, usize>,
    lines: Option<Vec<LineChange>>,
    branches: BranchOverview,
}

#[derive(Serialize)]
struct CommitDay {
    timestamp: u64,
    count: usize,
}

#[derive(Serialize)]
struct ContributorRanking {
    range: usize,
    active: usize,
    leaders: Vec<(String, usize)>,
}

#[derive(Serialize)]
struct LineChange {
    timestamp: u64,
    added: u64,
    removed: u64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchOverview {
    local: usize,
    remote: usize,
    worktrees: usize,
    stale: usize,
    merged: Option<usize>,
    upstream: Option<String>,
    distance: Option<[usize; 2]>,
}

impl Proof {
    pub fn prepare_repository_overview(
        &self,
        workspace_id: &str,
    ) -> Result<RepositoryOverviewRead> {
        Ok(RepositoryOverviewRead {
            git: self.git()?,
            workspace: self.store.workspace(workspace_id)?,
        })
    }
}

impl RepositoryOverviewRead {
    pub fn run(self, day_starts: &[u64]) -> Result<RepositoryOverview> {
        if day_starts.len() != ACTIVITY_DAYS + 1
            || day_starts.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(Error::new(
                "INVALID_REQUEST",
                "统计日期范围无效。",
                "Expected a year of increasing calendar day boundaries",
            ));
        }
        let head = self.git.head(&self.workspace)?;
        let branch = self.git.branch(&self.workspace)?;
        let (branches, branch_tips) = self.branches(head.as_deref())?;
        let recent = parse_history(&self.log(
            &branch_tips,
            &[
                "-z",
                "--max-count=4",
                "--format=%H%x00%P%x00%aN%x00%cI%x00%s",
            ],
        )?)?;
        let (activity, contributors) = collect_activity(
            &self.dated_log(&branch_tips, &["-z", "--format=%ct%x00%aN"], day_starts[0])?,
            day_starts,
        )?;
        let extensions = if let Some(oid) = head.as_deref() {
            extensions_in_tree(&self.query(&["ls-tree", "-rz", oid, "--"])?)
        } else {
            BTreeMap::new()
        };
        // A failed large diff read leaves the other statistics usable.
        let lines = self
            .dated_log(
                &branch_tips,
                &[
                    "--no-merges",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-renames",
                    "--shortstat",
                    "--format=%x00%ct",
                ],
                day_starts[ACTIVITY_DAYS - RANGES[2]],
            )
            .and_then(|data| parse_lines(&data, day_starts))
            .ok();
        if head != self.git.head(&self.workspace)? || branch != self.git.branch(&self.workspace)? {
            return Err(Error::stale());
        }
        Ok(RepositoryOverview {
            head,
            branch,
            recent,
            activity,
            contributors,
            extensions,
            lines,
            branches,
        })
    }

    fn query(&self, args: &[&str]) -> Result<Vec<u8>> {
        self.query_with_input(args, None)
    }

    fn query_with_input(&self, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>> {
        let mut command = self.git.command(&self.workspace)?;
        command.args(args).env("GIT_NO_LAZY_FETCH", "1");
        process::checked(process::run(command, input, Duration::from_secs(5))?)
    }

    fn log(&self, tips: &str, options: &[&str]) -> Result<Vec<u8>> {
        if tips.is_empty() {
            return Ok(Vec::new());
        }
        let mut args = vec![
            "log",
            "--stdin",
            "--no-show-signature",
            "--no-notes",
            "--no-decorate",
        ];
        args.extend_from_slice(options);
        args.push("--");
        self.query_with_input(&args, Some(tips.as_bytes()))
    }

    fn dated_log(&self, tips: &str, options: &[&str], cutoff: u64) -> Result<Vec<u8>> {
        let since = format!("--since-as-filter=@{cutoff}");
        let args: Vec<_> = options.iter().copied().chain([since.as_str()]).collect();
        let result = self.log(tips, &args);
        if !result.as_ref().is_err_and(|error| {
            error
                .detail
                .contains("unrecognized argument: --since-as-filter")
        }) {
            return result;
        }
        // Older Git can apply the date filter after traversing the commit graph.
        let commits = self.log(tips, &["--format=%H%x09%ct", "--no-patch"])?;
        let mut selected = String::new();
        for line in String::from_utf8_lossy(&commits).lines() {
            let (oid, time) = line.split_once('\t').ok_or_else(parse_error)?;
            if time.parse::<u64>().map_err(|_| parse_error())? >= cutoff {
                selected.push_str(oid);
                selected.push('\n');
            }
        }
        let args: Vec<_> = options
            .iter()
            .copied()
            .chain(["--no-walk=unsorted"])
            .collect();
        self.log(&selected, &args)
    }

    fn branches(&self, head: Option<&str>) -> Result<(BranchOverview, String)> {
        let refs = self.query(&[
            "for-each-ref",
            "--format=%(refname)%00%(HEAD)%00%(committerdate:unix)%00%(symref)%00%(upstream)%00%(objectname)",
            "refs/heads",
            "refs/remotes",
        ])?;
        let mut overview = BranchOverview {
            worktrees: self.git.worktrees(&self.workspace)?.len(),
            ..Default::default()
        };
        let cutoff = (crate::now() / 1000).saturating_sub(STALE_SECONDS);
        let mut current = String::new();
        let mut tips = String::new();
        for line in String::from_utf8_lossy(&refs).lines() {
            let fields: Vec<_> = line.split('\0').collect();
            let [reference, selected, time, symbolic, upstream, oid] = fields.as_slice() else {
                return Err(parse_error());
            };
            if !symbolic.is_empty() {
                continue;
            }
            tips.push_str(oid);
            tips.push('\n');
            if reference.starts_with("refs/remotes/") {
                overview.remote += 1;
                continue;
            }
            overview.local += 1;
            if *selected == "*" {
                current = (*reference).to_owned();
                if !upstream.is_empty() {
                    overview.upstream = Some(
                        upstream
                            .strip_prefix("refs/remotes/")
                            .or_else(|| upstream.strip_prefix("refs/heads/"))
                            .unwrap_or(upstream)
                            .to_owned(),
                    );
                    if let Some(head) = head {
                        let range = format!("{head}...{upstream}");
                        overview.distance = self
                            .query(&["rev-list", "--left-right", "--count", &range, "--"])
                            .ok()
                            .and_then(|raw| {
                                let text = String::from_utf8_lossy(&raw);
                                let (ahead, behind) = text.trim().split_once('\t')?;
                                Some([ahead.parse().ok()?, behind.parse().ok()?])
                            });
                    }
                }
            } else if time.parse::<u64>().is_ok_and(|time| time < cutoff) {
                overview.stale += 1;
            }
        }
        if let Some(head) = head {
            let filter = format!("--merged={head}");
            overview.merged = self
                .query(&["for-each-ref", &filter, "--format=%(refname)", "refs/heads"])
                .ok()
                .map(|refs| {
                    String::from_utf8_lossy(&refs)
                        .lines()
                        .filter(|name| *name != current)
                        .count()
                });
        }
        Ok((overview, tips))
    }
}

fn parse_error() -> Error {
    Error::new(
        "GIT_PARSE",
        "Git 返回的数据无法读取。",
        "Invalid repository overview record",
    )
}

fn parse_history(data: &[u8]) -> Result<Vec<CommitEntry>> {
    let text = String::from_utf8_lossy(data);
    let fields: Vec<_> = text.split_terminator('\0').collect();
    fields
        .chunks(5)
        .map(|row| {
            let [oid, parents, author, date, subject] = row else {
                return Err(parse_error());
            };
            Ok(CommitEntry {
                oid: (*oid).to_owned(),
                parents: parents.split_whitespace().map(String::from).collect(),
                author: (*author).to_owned(),
                date: (*date).to_owned(),
                subject: (*subject).to_owned(),
                refs: String::new(),
                boundary: None,
            })
        })
        .collect()
}

fn day_index(day_starts: &[u64], timestamp: u64) -> Option<usize> {
    day_starts
        .partition_point(|start| *start <= timestamp)
        .checked_sub(1)
        .filter(|index| *index < day_starts.len() - 1)
}

fn collect_activity(
    data: &[u8],
    day_starts: &[u64],
) -> Result<(Vec<CommitDay>, Vec<ContributorRanking>)> {
    let days = day_starts.len() - 1;
    let mut activity: Vec<_> = day_starts[..days]
        .iter()
        .map(|&timestamp| CommitDay {
            timestamp,
            count: 0,
        })
        .collect();
    let mut rankings: [BTreeMap<&str, usize>; RANGES.len()] =
        std::array::from_fn(|_| BTreeMap::new());
    let text = String::from_utf8_lossy(data);
    let mut records = text.split_terminator('\0');
    while let Some(stamp) = records.next() {
        let timestamp = stamp.parse::<u64>().map_err(|_| parse_error())?;
        let author = records.next().ok_or_else(parse_error)?;
        if let Some(index) = day_index(day_starts, timestamp) {
            activity[index].count += 1;
            for (counts, range) in rankings.iter_mut().zip(RANGES) {
                if index >= days - range {
                    *counts.entry(author).or_default() += 1;
                }
            }
        }
    }
    let contributors = rankings
        .into_iter()
        .zip(RANGES)
        .map(|(counts, range)| {
            let active = counts.len();
            let mut leaders: Vec<_> = counts.into_iter().collect();
            leaders.sort_unstable_by(|(a, left), (b, right)| right.cmp(left).then(a.cmp(b)));
            leaders.truncate(4);
            ContributorRanking {
                range,
                active,
                leaders: leaders
                    .into_iter()
                    .map(|(name, count)| (name.to_owned(), count))
                    .collect(),
            }
        })
        .collect();
    Ok((activity, contributors))
}

fn extensions_in_tree(data: &[u8]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for record in data.split(|&byte| byte == 0) {
        let text = String::from_utf8_lossy(record);
        let Some((metadata, path)) = text.split_once('\t') else {
            continue;
        };
        if !metadata.starts_with("100") {
            continue;
        }
        let extension = Path::new(path)
            .extension()
            .and_then(|part| part.to_str())
            .unwrap_or_default();
        *counts.entry(extension.to_ascii_lowercase()).or_default() += 1;
    }
    counts
}

fn parse_lines(data: &[u8], day_starts: &[u64]) -> Result<Vec<LineChange>> {
    let mut totals = BTreeMap::<u64, LineChange>::new();
    for record in String::from_utf8_lossy(data).split('\0').skip(1) {
        let mut rows = record.trim().lines();
        let timestamp = rows
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or_else(parse_error)?;
        let Some(index) = day_index(day_starts, timestamp) else {
            continue;
        };
        let change = totals.entry(day_starts[index]).or_insert(LineChange {
            timestamp: day_starts[index],
            added: 0,
            removed: 0,
        });
        for field in rows.flat_map(|row| row.trim().split(", ")) {
            if let Some((count, kind)) = field.trim().split_once(' ') {
                if kind.ends_with("(+)") {
                    change.added += count.parse::<u64>().map_err(|_| parse_error())?;
                } else if kind.ends_with("(-)") {
                    change.removed += count.parse::<u64>().map_err(|_| parse_error())?;
                }
            }
        }
    }
    Ok(totals.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fmt::Write, fs};

    #[test]
    fn reads_all_branch_activity_and_current_head_languages_from_git() {
        let fixture = tempfile::tempdir().unwrap();
        let repo = fixture.path().join("repository");
        fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            let result = process::git_command("git", &repo)
                .args([
                    "-c",
                    "user.name=Proof Test",
                    "-c",
                    "user.email=proof@example.test",
                ])
                .args([
                    "-c",
                    "commit.gpgSign=false",
                    "-c",
                    "core.hooksPath=/dev/null",
                ])
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .args(args)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        };
        git(&["init", "--quiet", "-b", "main"]);
        let mut proof = Proof::open(fixture.path().join("state")).unwrap();
        let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
        let today = crate::now() / 1000 / 86_400 * 86_400;
        let first = today - (ACTIVITY_DAYS as u64 - 1) * 86_400;
        let day_starts: Vec<_> = (0..=ACTIVITY_DAYS as u64)
            .map(|day| first + day * 86_400)
            .collect();
        let read = || {
            proof
                .prepare_repository_overview(&workspace.id)
                .unwrap()
                .run(&day_starts)
                .unwrap()
        };
        let empty = read();
        assert!(empty.head.is_none() && empty.recent.is_empty());
        assert_eq!(empty.branches.worktrees, 1);

        fs::write(repo.join("app.ts"), "first\n").unwrap();
        git(&["add", "app.ts"]);
        git(&["commit", "-qm", "Initial file"]);
        git(&["branch", "base"]);
        git(&["config", "branch.main.remote", "."]);
        git(&["config", "branch.main.merge", "refs/heads/base"]);

        fs::write(repo.join("app.ts"), "updated\n").unwrap();
        fs::write(repo.join("README.md"), "first\nsecond\n").unwrap();
        git(&["add", "app.ts", "README.md"]);
        git(&["commit", "-qm", "Update files"]);
        fs::write(repo.join("local.go"), "package preview").unwrap();

        git(&["switch", "-qc", "topic", "base"]);
        fs::write(repo.join("topic.rs"), "topic\n").unwrap();
        git(&["add", "topic.rs"]);
        git(&[
            "commit",
            "-qm",
            "Local topic",
            "--author=Topic <topic@example.test>",
        ]);
        git(&["update-ref", "refs/remotes/origin/topic", "topic"]);

        git(&["switch", "-qc", "remote-draft", "base"]);
        fs::write(repo.join("remote.go"), "first\nsecond\n").unwrap();
        git(&["add", "remote.go"]);
        git(&[
            "commit",
            "-qm",
            "Remote topic",
            "--author=Remote <remote@example.test>",
        ]);
        git(&[
            "update-ref",
            "refs/remotes/origin/remote-draft",
            "remote-draft",
        ]);
        git(&["switch", "-q", "main"]);
        git(&["branch", "-D", "remote-draft"]);

        let mut history = String::new();
        let older = today - 120 * 86_400;
        for index in 0..1347 {
            writeln!(history, "commit refs/remotes/origin/archive\ncommitter Archive <archive@example.test> {older} +0000\ndata 1\nx")
                .unwrap();
            if index == 0 {
                history.push_str("from refs/heads/base\n");
            }
            history.push('\n');
        }
        let mut importer = process::git_command("git", &repo);
        importer.args(["fast-import", "--quiet"]);
        process::checked(
            process::run(importer, Some(history.as_bytes()), Duration::from_secs(5)).unwrap(),
        )
        .unwrap();

        let overview = read();
        assert_eq!(overview.branch.as_deref(), Some("main"));
        assert!(overview
            .recent
            .iter()
            .any(|commit| commit.subject == "Local topic"));
        assert!(overview
            .recent
            .iter()
            .any(|commit| commit.subject == "Remote topic"));
        assert_eq!(
            overview.activity.iter().map(|day| day.count).sum::<usize>(),
            1351
        );
        let ranking = overview
            .contributors
            .iter()
            .find(|row| row.range == 30)
            .unwrap();
        assert_eq!(ranking.active, 3);
        assert!(ranking
            .leaders
            .iter()
            .any(|(name, count)| name == "Remote" && *count == 1));
        assert_eq!(
            overview.extensions,
            BTreeMap::from([("md".to_owned(), 1), ("ts".to_owned(), 1)])
        );
        let lines = overview.lines.unwrap();
        assert_eq!(lines.iter().map(|day| day.added).sum::<u64>(), 7);
        assert_eq!(lines.iter().map(|day| day.removed).sum::<u64>(), 1);
        assert_eq!(overview.branches.local, 3);
        assert_eq!(overview.branches.remote, 3);
        assert_eq!(overview.branches.merged, Some(1));
        assert_eq!(overview.branches.upstream.as_deref(), Some("base"));
        assert_eq!(overview.branches.distance, Some([1, 0]));
    }
}
