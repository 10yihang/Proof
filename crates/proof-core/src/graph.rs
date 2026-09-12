use crate::{fingerprint, git, guarded_file::BoundFile, model::*, now, Error, Proof, Result};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::Path,
};

const PAGE: usize = 100;
const FORMAT: &str = "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D";

pub(crate) struct GraphSnapshot {
    id: String,
    workspace_id: String,
    scope: String,
    tips: Vec<CommitEntry>,
    labels: BTreeMap<String, Vec<String>>,
    branches: Vec<BranchEntry>,
    head: Option<String>,
    captured_at: u64,
    shallow: bool,
    source_shape: String,
    boundaries: HashSet<String>,
}

impl Proof {
    /// The root object IDs and ref labels are captured once. Later pages walk
    /// the same commits even if an external process moves or removes a branch.
    pub fn commit_graph(
        &mut self,
        workspace_id: &str,
        snapshot_id: Option<&str>,
        offset: usize,
        scope: &str,
    ) -> Result<CommitGraphPage> {
        let object_scope =
            [40, 64].contains(&scope.len()) && scope.bytes().all(|b| b.is_ascii_hexdigit());
        let ref_scope = scope.starts_with("refs/heads/") || scope.starts_with("refs/remotes/");
        if (!object_scope && !ref_scope && !["all", "current"].contains(&scope)) || offset > 100_000
        {
            return Err(Error::new(
                "GRAPH_RANGE",
                "请选择有效的历史范围。",
                "Invalid graph range",
            ));
        }
        let workspace = self.store.workspace(workspace_id)?;
        let git = self.git()?;
        let id = if let Some(id) = snapshot_id {
            id.to_owned()
        } else {
            if offset != 0 {
                return Err(Error::new(
                    "GRAPH_SNAPSHOT",
                    "请重新加载提交图。",
                    "First page must start at zero",
                ));
            }
            let before = git.query(
                &workspace,
                &["for-each-ref", "--format=%(refname)%00%(objectname)"],
            )?;
            let shape = graph_shape(&git, &workspace)?;
            if shape.rewritten {
                return Err(Error::new(
                    "GRAPH_REWRITTEN_HISTORY",
                    "此仓库启用了 Git replace 或 grafts，请在外部 Git 核对替换后的历史。",
                    "Rewritten ancestry is not supported by the graph",
                ));
            }
            let head = git.head(&workspace)?;
            let branch = git.branch(&workspace)?;
            let selected_ref = if ref_scope {
                Some(
                    git::text(
                        git.query(&workspace, &["show-ref", "--verify", "--hash", scope])
                            .map_err(|_| {
                                Error::new(
                                    "GRAPH_REF_MISSING",
                                    "所选分支不可读取，请重新选择历史范围。",
                                    "Selected reference unavailable",
                                )
                            })?,
                    )?
                    .trim()
                    .to_owned(),
                )
            } else {
                None
            };
            let mut args = vec![
                "log",
                "--no-show-signature",
                "--no-walk=unsorted",
                "-z",
                FORMAT,
            ];
            if scope == "all" {
                args.extend(["--branches", "--remotes", "--tags"]);
            }
            if object_scope {
                args.push(scope);
            } else if let Some(oid) = &selected_ref {
                args.push(oid);
            } else if let Some(head) = &head {
                args.push(head);
            }
            args.push("--");
            let tips = if !object_scope
                && !ref_scope
                && (scope == "current" || before.is_empty())
                && head.is_none()
            {
                Vec::new()
            } else {
                parse_commits(&git.query(&workspace, &args)?)?
            };
            if tips.len() > 1024 {
                return Err(Error::new(
                    "GRAPH_TIPS_LIMIT",
                    "引用过多，请先查看当前分支。",
                    "More than 1024 graph tips",
                ));
            }
            let branches = git.branches(&workspace)?;
            let labels = if before.is_empty() && head.is_none() {
                BTreeMap::new()
            } else {
                graph_labels(
                    &git::text(git.query(&workspace, &["show-ref", "--head", "--dereference"])?)?,
                    branch.as_deref(),
                )?
            };
            let shallow =
                git::text(git.query(&workspace, &["rev-parse", "--is-shallow-repository"])?)?
                    .trim()
                    == "true";
            if before
                != git.query(
                    &workspace,
                    &["for-each-ref", "--format=%(refname)%00%(objectname)"],
                )?
                || head != git.head(&workspace)?
                || branch != git.branch(&workspace)?
            {
                return Err(Error::new(
                    "GRAPH_CHANGED",
                    "读取期间引用发生变化，请刷新提交图。",
                    "References changed during capture",
                ));
            }
            let id = uuid::Uuid::new_v4().to_string();
            if self.graphs.len() == 4 {
                self.graphs.pop_front();
            }
            self.graphs.push_back(GraphSnapshot {
                id: id.clone(),
                workspace_id: workspace_id.into(),
                scope: scope.into(),
                tips,
                labels,
                branches,
                head,
                captured_at: now(),
                shallow,
                source_shape: shape.fingerprint,
                boundaries: shape.boundaries,
            });
            id
        };
        let snapshot = self
            .graphs
            .iter()
            .find(|s| s.id == id && s.workspace_id == workspace_id && s.scope == scope)
            .ok_or_else(|| {
                Error::new(
                    "GRAPH_SNAPSHOT",
                    "此历史快照已释放，请刷新提交图。",
                    "Graph snapshot unavailable",
                )
            })?;
        let skip = format!("--skip={offset}");
        if graph_shape(&git, &workspace)?.fingerprint != snapshot.source_shape {
            return Err(shape_changed());
        }
        let count = format!("--max-count={}", PAGE + 1);
        let mut args = vec![
            "log",
            "--no-show-signature",
            "--topo-order",
            "-z",
            &skip,
            &count,
            FORMAT,
        ];
        args.extend(snapshot.tips.iter().map(|tip| tip.oid.as_str()));
        args.push("--");
        let mut commits = if snapshot.tips.is_empty() {
            Vec::new()
        } else {
            parse_commits(&git.query(&workspace, &args)?)?
        };
        let has_more = commits.len() > PAGE;
        commits.truncate(PAGE);
        if graph_shape(&git, &workspace)?.fingerprint != snapshot.source_shape {
            return Err(shape_changed());
        }
        for commit in &mut commits {
            commit.boundary = snapshot
                .boundaries
                .contains(&commit.oid)
                .then(|| "shallow".into());
            commit.refs = snapshot
                .labels
                .get(&commit.oid)
                .map(|labels| labels.join(", "))
                .unwrap_or_default();
        }
        Ok(CommitGraphPage {
            snapshot_id: id,
            workspace_id: workspace_id.into(),
            scope: scope.into(),
            commits,
            branches: snapshot.branches.clone(),
            head: snapshot.head.clone(),
            offset,
            has_more,
            captured_at: snapshot.captured_at,
            shallow: snapshot.shallow,
        })
    }

    pub fn graph_commit_diff(
        &self,
        workspace_id: &str,
        snapshot_id: &str,
        oid: &str,
        parent: usize,
    ) -> Result<String> {
        let snapshot = self
            .graphs
            .iter()
            .find(|snapshot| snapshot.id == snapshot_id && snapshot.workspace_id == workspace_id)
            .ok_or_else(|| {
                Error::new(
                    "GRAPH_SNAPSHOT",
                    "此历史快照已释放，请刷新提交图。",
                    "Graph snapshot unavailable",
                )
            })?;
        let workspace = self.store.workspace(workspace_id)?;
        let git = self.git()?;
        if graph_shape(&git, &workspace)?.fingerprint != snapshot.source_shape {
            return Err(shape_changed());
        }
        if snapshot.boundaries.contains(oid) {
            return Err(Error::new(
                "GRAPH_SHALLOW_BOUNDARY",
                "此提交处于浅克隆边界，无法确认父版本，不能按根提交与空树比较。",
                "Parent history is unavailable at the shallow boundary",
            ));
        }
        let patch = self.commit_diff(workspace_id, oid, parent)?;
        if graph_shape(&git, &workspace)?.fingerprint != snapshot.source_shape {
            return Err(shape_changed());
        }
        Ok(patch)
    }
}

fn graph_labels(text: &str, branch: Option<&str>) -> Result<BTreeMap<String, Vec<String>>> {
    let mut labels = BTreeMap::<String, Vec<String>>::new();
    for (index, line) in text.lines().enumerate() {
        if index >= 16384 {
            return Err(Error::new(
                "GRAPH_REFERENCE_LIMIT",
                "引用过多，无法完整捕获历史标签。",
                "Reference label limit exceeded",
            ));
        }
        let (oid, name) = line.split_once(' ').ok_or_else(|| {
            Error::new(
                "GRAPH_PARSE",
                "无法解析 Git 引用。",
                "Invalid reference record",
            )
        })?;
        let name = name.strip_suffix("^{}").unwrap_or(name);
        let label = if name == "HEAD" {
            branch
                .map(|name| format!("HEAD → {name}"))
                .unwrap_or_else(|| "HEAD".into())
        } else if let Some(name) = name.strip_prefix("refs/tags/") {
            format!("tag: {name}")
        } else if let Some(name) = name
            .strip_prefix("refs/heads/")
            .or_else(|| name.strip_prefix("refs/remotes/"))
        {
            if Some(name) == branch && line.ends_with(&format!("refs/heads/{name}")) {
                continue;
            }
            name.into()
        } else {
            continue;
        };
        let values = labels.entry(oid.into()).or_default();
        if !values.contains(&label) {
            values.push(label);
        }
    }
    Ok(labels)
}

struct GraphShape {
    fingerprint: String,
    boundaries: HashSet<String>,
    rewritten: bool,
}
fn graph_shape(git: &git::Git, workspace: &Workspace) -> Result<GraphShape> {
    let mut parts = vec![git.query(
        workspace,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)",
            "refs/replace",
        ],
    )?];
    for name in ["shallow", "info/grafts"] {
        match fs::symlink_metadata(Path::new(&workspace.common_dir).join(name)) {
            Ok(_) => parts.push(
                BoundFile::open(Path::new(&workspace.common_dir), name)?
                    .read()?
                    .map(|file| file.bytes)
                    .unwrap_or_default(),
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => parts.push(Vec::new()),
            Err(error) => return Err(error.into()),
        }
    }
    let boundaries = git::text(parts[1].clone())?
        .split_whitespace()
        .map(String::from)
        .collect();
    let rewritten = !parts[0].is_empty()
        || git::text(parts[2].clone())?
            .lines()
            .any(|line| !line.trim().is_empty() && !line.trim().starts_with('#'));
    Ok(GraphShape {
        fingerprint: fingerprint(&parts.iter().map(Vec::as_slice).collect::<Vec<_>>()),
        boundaries,
        rewritten,
    })
}
fn shape_changed() -> Error {
    Error::new(
        "GRAPH_CHANGED",
        "本地历史边界或替换关系已变化，请刷新提交图。",
        "Shallow, graft or replacement state changed",
    )
}

fn parse_commits(bytes: &[u8]) -> Result<Vec<CommitEntry>> {
    let fields: Vec<_> = bytes.split(|byte| *byte == 0).collect();
    let mut commits = Vec::new();
    for row in fields.chunks(6) {
        if row.len() == 1 && row[0].is_empty() {
            continue;
        }
        if row.len() != 6 {
            return Err(Error::new(
                "GRAPH_PARSE",
                "Git 返回的提交数据不完整。",
                "Invalid commit record",
            ));
        }
        let row = row
            .iter()
            .map(|v| git::text(v.to_vec()))
            .collect::<Result<Vec<_>>>()?;
        if ![40, 64].contains(&row[0].len()) || !row[0].bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(Error::new(
                "GRAPH_PARSE",
                "Git 返回了无效的提交 ID。",
                "Invalid object ID",
            ));
        }
        commits.push(CommitEntry {
            oid: row[0].clone(),
            parents: row[1].split_whitespace().map(String::from).collect(),
            author: row[2].clone(),
            date: row[3].clone(),
            subject: row[4].clone(),
            refs: row[5].clone(),
            boundary: None,
        });
    }
    Ok(commits)
}
