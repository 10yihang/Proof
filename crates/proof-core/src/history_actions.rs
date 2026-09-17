//! History mutations share one validated, short-lived preview. The renderer never
//! supplies executable arguments, and a preview cannot be replayed after a write.
use crate::{
    fingerprint,
    git::{self, Git},
    now, process, Changes, Error, Proof, Result, Workspace,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, time::Duration};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HistoryActionKind {
    Switch,
    CreateBranch,
    RenameBranch,
    DeleteBranch,
    CreateTag,
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Reset,
    CheckoutCommit,
    Fetch,
    Pull,
    Push,
    Stash,
    StashApply,
    StashPop,
    StashDrop,
    Continue,
    Abort,
    StageResolution,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryActionRequest {
    pub kind: HistoryActionKind,
    pub target: Option<String>,
    pub name: Option<String>,
    pub remote: Option<String>,
    pub mode: Option<String>,
    pub mainline: Option<usize>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryActionPreview {
    pub id: String,
    pub request: HistoryActionRequest,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub target_oid: Option<String>,
    pub remote_branch: Option<String>,
    pub expected_remote_oid: Option<String>,
    pub dirty_files: usize,
    pub affected_commits: usize,
    pub operation: Option<String>,
    pub arguments: Vec<String>,
    pub destructive: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryActionResult {
    pub ok: bool,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub operation: Option<String>,
    pub conflicts: Vec<String>,
    pub detail: String,
    pub warning: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRepositoryState {
    pub remotes: Vec<String>,
    pub upstream: Option<String>,
    pub upstream_remote: Option<String>,
    pub upstream_branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub operation: Option<String>,
    pub conflicts: Vec<String>,
}
pub(crate) struct PreparedAction {
    workspace_id: String,
    preview: HistoryActionPreview,
    guard: String,
    created_at: u64,
}
fn invalid(detail: impl ToString) -> Error {
    Error::new(
        "HISTORY_ACTION_INVALID",
        "无法执行所选 Git 操作，请检查目标和选项。",
        detail,
    )
}
fn required(value: &Option<String>) -> Result<&str> {
    value
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("Missing target"))
}
fn text(git: &Git, workspace: &Workspace, args: &[&str]) -> Result<String> {
    let args: Vec<_> = std::iter::once("--no-replace-objects")
        .chain(args.iter().copied())
        .collect();
    Ok(git::text(git.query(workspace, &args)?)?
        .trim_end_matches('\n')
        .to_owned())
}
fn valid_name(git: &Git, workspace: &Workspace, name: &str, namespace: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 1024
        || name.starts_with('-')
        || name == "HEAD"
        || name.chars().any(char::is_control)
    {
        return Err(invalid("Invalid ref name"));
    }
    git.query(
        workspace,
        &["check-ref-format", &format!("refs/{namespace}/{name}")],
    )?;
    Ok(())
}
fn commit(git: &Git, workspace: &Workspace, target: &str) -> Result<String> {
    let oid = [40, 64].contains(&target.len()) && target.bytes().all(|b| b.is_ascii_hexdigit());
    if !oid {
        if !(target.starts_with("refs/heads/")
            || target.starts_with("refs/remotes/")
            || target.starts_with("refs/tags/"))
        {
            return Err(invalid("Expected a full branch ref or commit OID"));
        }
        git.query(workspace, &["check-ref-format", target])?;
        // Remote HEAD is symbolic, not a branch to switch, rename or delete.
        if target.starts_with("refs/remotes/") && target.ends_with("/HEAD") {
            return Err(invalid("Choose a remote branch, not remote HEAD"));
        }
    }
    let value = text(
        git,
        workspace,
        &[
            "--no-replace-objects",
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{target}^{{commit}}"),
        ],
    )?;
    if ![40, 64].contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("Invalid commit OID"));
    }
    Ok(value)
}
fn config(git: &Git, workspace: &Workspace, key: &str) -> Result<Option<String>> {
    let mut command = git.command(workspace)?;
    command.args(["config", "--get", key]);
    let output = process::run(command, None, Duration::from_secs(20))?;
    if output.code == 1 {
        return Ok(None);
    }
    Ok(Some(
        git::text(process::checked(output)?)?
            .trim_end_matches('\n')
            .into(),
    ))
}
fn operation_guard(git: &Git, workspace: &Workspace, changes: &Changes) -> Result<String> {
    let refs = git.query(
        workspace,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(symref)",
        ],
    )?;
    // Hash config, never return it: remote URLs may contain credentials.
    let config = git.query(workspace, &["config", "--null", "--list"])?;
    let mut state = Vec::new();
    for marker in [
        "MERGE_HEAD",
        "MERGE_MSG",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "ORIG_HEAD",
        "rebase-merge/git-rebase-todo",
        "rebase-merge/done",
        "rebase-merge/head-name",
        "rebase-merge/onto",
        "rebase-merge/orig-head",
        "rebase-apply/next",
        "rebase-apply/last",
        "rebase-apply/orig-head",
        "sequencer/todo",
        "sequencer/head",
    ] {
        match fs::read(Path::new(&workspace.git_dir).join(marker)) {
            Ok(bytes) => {
                state.extend_from_slice(marker.as_bytes());
                state.extend_from_slice(&bytes);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(fingerprint(&[
        changes.token.as_bytes(),
        &refs,
        &config,
        &state,
        &git.query(workspace, &["stash", "list", "--format=%H%x00%gd%x00%gs"])?,
        git.executable.as_bytes(),
    ]))
}
impl Proof {
    pub fn history_repository_state(&self, workspace_id: &str) -> Result<HistoryRepositoryState> {
        self.history_branch_state(workspace_id, None)
    }
    pub fn history_branch_state(
        &self,
        workspace_id: &str,
        selected_branch: Option<&str>,
    ) -> Result<HistoryRepositoryState> {
        let workspace = self.store.workspace(workspace_id)?;
        let git = self.git()?;
        let changes = git.changes(&workspace)?;
        if let Some(name) = selected_branch {
            valid_name(&git, &workspace, name, "heads")?;
            commit(&git, &workspace, &format!("refs/heads/{name}"))?;
        }
        let remotes = text(&git, &workspace, &["remote"])?
            .lines()
            .map(str::to_owned)
            .collect();
        let (mut remote, mut branch, mut upstream) = (None, None, None);
        let (mut ahead, mut behind) = (0, 0);
        if let Some(name) = selected_branch.or(changes.branch.as_deref()) {
            remote = config(&git, &workspace, &format!("branch.{name}.remote"))?;
            branch = config(&git, &workspace, &format!("branch.{name}.merge"))?
                .and_then(|value| value.strip_prefix("refs/heads/").map(str::to_owned));
            let row = text(
                &git,
                &workspace,
                &[
                    "for-each-ref",
                    "--format=%(upstream)",
                    &format!("refs/heads/{name}"),
                ],
            )?;
            if !row.is_empty() {
                upstream = Some(row.clone());
                // An upstream can be configured but not fetched yet.
                if let Ok(counts) = text(
                    &git,
                    &workspace,
                    &[
                        "rev-list",
                        "--left-right",
                        "--count",
                        &format!("refs/heads/{name}...{row}"),
                        "--",
                    ],
                ) {
                    let values: Vec<_> = counts.split_whitespace().collect();
                    ahead = values.first().and_then(|v| v.parse().ok()).unwrap_or(0);
                    behind = values.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
                }
            }
        }
        Ok(HistoryRepositoryState {
            remotes,
            upstream,
            upstream_remote: remote,
            upstream_branch: branch,
            ahead,
            behind,
            operation: changes.operation,
            conflicts: changes
                .files
                .into_iter()
                .filter(|f| f.conflicted)
                .map(|f| f.path)
                .collect(),
        })
    }
    pub fn history_commit_message(&self, workspace_id: &str, oid: &str) -> Result<String> {
        let workspace = self.store.workspace(workspace_id)?;
        let git = self.git()?;
        let oid = commit(&git, &workspace, oid)?;
        text(
            &git,
            &workspace,
            &[
                "--no-replace-objects",
                "show",
                "-s",
                "--format=%B",
                &oid,
                "--",
            ],
        )
    }
    pub fn prepare_history_action(
        &mut self,
        workspace_id: &str,
        request: HistoryActionRequest,
        expected_token: &str,
    ) -> Result<HistoryActionPreview> {
        use HistoryActionKind::*;
        let workspace = self.store.workspace(workspace_id)?;
        if !workspace.trusted {
            return Err(Error::new(
                "TRUST_REQUIRED",
                "请先确认信任此仓库，再执行 Git 写操作。",
                "History actions require trust",
            ));
        }
        let git = self.git()?;
        let changes = git.changes(&workspace)?;
        if changes.token != expected_token {
            return Err(Error::stale());
        }
        let recovery = matches!(request.kind, Continue | Abort | StageResolution);
        if recovery {
            if !matches!(
                changes.operation.as_deref(),
                Some("Merge" | "Rebase" | "Cherry-pick" | "Revert")
            ) {
                return Err(invalid("No supported operation to continue or abort"));
            }
        } else {
            self.require_write(&workspace)?;
        }
        if matches!(request.kind, Merge | Rebase | CherryPick | Revert | Pull)
            && !changes.files.is_empty()
        {
            return Err(Error::new(
                "HISTORY_CLEAN_REQUIRED",
                "请先 Commit 或 Stash 本地修改，再执行此操作。",
                "A clean index and Worktree are required; Proof does not autostash",
            ));
        }
        let guard = operation_guard(&git, &workspace, &changes)?;
        let mut args: Vec<String> = Vec::new();
        let mut target_oid = None;
        let mut remote_branch = None;
        let mut expected_remote_oid = None;
        let mut affected_commits = 0;
        let destructive = matches!(request.kind, Rebase | Reset | Abort | StashDrop)
            || request.kind == Pull && request.mode.as_deref() == Some("rebase")
            || request.kind == Push && request.mode.as_deref() == Some("force-with-lease");
        let needs_target = matches!(
            request.kind,
            Switch
                | CreateBranch
                | RenameBranch
                | DeleteBranch
                | CreateTag
                | Merge
                | Rebase
                | CherryPick
                | Revert
                | Reset
                | CheckoutCommit
        );
        if needs_target {
            target_oid = Some(commit(&git, &workspace, required(&request.target)?)?);
        }
        let oid = target_oid.as_deref().unwrap_or("");
        let current_branch = || {
            changes
                .branch
                .as_deref()
                .ok_or_else(|| invalid("This action requires a checked-out branch"))
        };
        let local_branch = || {
            required(&request.target)?
                .strip_prefix("refs/heads/")
                .ok_or_else(|| invalid("Choose a local branch"))
        };
        let words = |values: &[&str]| values.iter().map(|v| (*v).to_owned()).collect::<Vec<_>>();
        match request.kind {
            Switch => {
                let target = required(&request.target)?;
                if let Some(name) = target.strip_prefix("refs/heads/") {
                    if changes.branch.as_deref() == Some(name) {
                        return Err(invalid("Branch is already checked out"));
                    }
                    args = words(&["switch", "--no-guess", "--", name]);
                } else if target.starts_with("refs/remotes/") {
                    let name = required(&request.name)?;
                    valid_name(&git, &workspace, name, "heads")?;
                    args = words(&["switch", "--track", "--create", name, "--", target]);
                } else {
                    return Err(invalid("Choose a local or remote branch"));
                }
            }
            CreateBranch | CreateTag => {
                let name = required(&request.name)?;
                let namespace = if request.kind == CreateTag {
                    "tags"
                } else {
                    "heads"
                };
                valid_name(&git, &workspace, name, namespace)?;
                args = if request.kind == CreateTag {
                    words(&["-c", "tag.gpgSign=false", "tag", "--", name, oid])
                } else {
                    words(&["branch", "--no-track", "--", name, oid])
                };
            }
            RenameBranch => {
                let from = local_branch()?;
                let name = required(&request.name)?;
                valid_name(&git, &workspace, name, "heads")?;
                args = words(&["branch", "--move", "--", from, name]);
            }
            DeleteBranch => {
                let name = local_branch()?;
                if changes.branch.as_deref() == Some(name) {
                    return Err(invalid("Cannot delete the current branch"));
                }
                // -d only: never silently force-delete unmerged history.
                args = words(&["branch", "--delete", "--", name]);
            }
            Merge | Rebase => {
                current_branch()?;
                affected_commits = text(
                    &git,
                    &workspace,
                    &[
                        "rev-list",
                        "--count",
                        &if request.kind == Rebase {
                            format!("{oid}..HEAD")
                        } else {
                            format!("HEAD..{oid}")
                        },
                        "--",
                    ],
                )?
                .parse()
                .unwrap_or(0);
                args = if request.kind == Merge {
                    let target = required(&request.target)?;
                    let label = target
                        .strip_prefix("refs/heads/")
                        .or_else(|| target.strip_prefix("refs/remotes/"))
                        .unwrap_or(target);
                    let message = format!("Merge branch '{label}' into '{}'", current_branch()?);
                    words(&[
                        "merge",
                        "--no-edit",
                        "--no-autostash",
                        "--ff",
                        "--commit",
                        "--message",
                        &message,
                        oid,
                    ])
                } else {
                    words(&[
                        "-c",
                        "rebase.updateRefs=false",
                        "rebase",
                        "--no-autostash",
                        "--no-autosquash",
                        "--no-fork-point",
                        oid,
                    ])
                };
            }
            CherryPick | Revert => {
                current_branch()?;
                let parents = text(&git, &workspace, &["show", "-s", "--format=%P", oid, "--"])?;
                let count = parents.split_whitespace().count();
                args.push(
                    if request.kind == CherryPick {
                        "cherry-pick"
                    } else {
                        "revert"
                    }
                    .into(),
                );
                args.push("--no-edit".into());
                if count > 1 {
                    let parent = request
                        .mainline
                        .filter(|p| *p >= 1 && *p <= count)
                        .ok_or_else(|| {
                            invalid("Choose the mainline parent for this merge commit")
                        })?;
                    args.extend(["--mainline".into(), parent.to_string()]);
                } else if request.mainline.is_some() {
                    return Err(invalid("Mainline is only valid for merge commits"));
                }
                args.push(oid.into());
                affected_commits = 1;
            }
            Reset => {
                current_branch()?;
                let mode = request.mode.as_deref().unwrap_or("mixed");
                if !["soft", "mixed", "hard"].contains(&mode) {
                    return Err(invalid("Invalid reset mode"));
                }
                args = words(&["reset", &format!("--{mode}"), oid, "--"]);
                affected_commits = text(
                    &git,
                    &workspace,
                    &["rev-list", "--count", &format!("{oid}..HEAD"), "--"],
                )?
                .parse()
                .unwrap_or(0);
            }
            CheckoutCommit => args = words(&["switch", "--detach", oid]),
            Fetch | Pull | Push => {
                let remote = required(&request.remote)?;
                valid_name(&git, &workspace, remote, "remotes")?;
                let state = self.history_repository_state(workspace_id)?;
                if !state.remotes.iter().any(|name| name == remote) {
                    return Err(invalid("Select a configured remote"));
                }
                if request.kind == Fetch {
                    args = words(&[
                        "fetch",
                        "--no-tags",
                        "--no-recurse-submodules",
                        "--",
                        remote,
                        &format!("+refs/heads/*:refs/remotes/{remote}/*"),
                    ]);
                } else {
                    let local = if request.kind == Push {
                        match request.target.as_deref() {
                            Some(target) if target.starts_with("refs/heads/") => {
                                let branch = target.strip_prefix("refs/heads/").unwrap();
                                valid_name(&git, &workspace, branch, "heads")?;
                                branch
                            }
                            None => current_branch()?,
                            Some(target) if Some(target) == changes.head.as_deref() => {
                                current_branch()?
                            }
                            _ => return Err(invalid("Push requires a local source branch")),
                        }
                    } else {
                        current_branch()?
                    };
                    if request.kind == Push {
                        target_oid =
                            Some(commit(&git, &workspace, &format!("refs/heads/{local}"))?);
                    }
                    let branch = request
                        .name
                        .as_deref()
                        .filter(|v| !v.is_empty())
                        .unwrap_or(local);
                    valid_name(&git, &workspace, branch, "heads")?;
                    remote_branch = Some(branch.into());
                    if request.kind == Pull {
                        args = words(&[
                            "-c",
                            "rebase.updateRefs=false",
                            "pull",
                            "--no-autostash",
                            "--no-recurse-submodules",
                            "--no-edit",
                        ]);
                        match request.mode.as_deref().unwrap_or("ff-only") {
                            "ff-only" => args.extend(words(&["--no-rebase", "--ff-only"])),
                            "merge" => args.extend(words(&["--no-rebase", "--ff"])),
                            "rebase" => args.extend(words(&["--rebase=true", "--ff"])),
                            _ => return Err(invalid("Invalid pull strategy")),
                        }
                        args.extend(words(&["--", remote, &format!("refs/heads/{branch}")]));
                    } else {
                        // Multiple push URLs would send one click to multiple servers.
                        let push_url = text(
                            &git,
                            &workspace,
                            &["remote", "get-url", "--push", "--all", remote],
                        )?;
                        if push_url.lines().count() != 1 {
                            return Err(invalid("Select a remote with exactly one push URL"));
                        }
                        args = words(&[
                            "-c",
                            &format!("remote.{remote}.mirror=false"),
                            "push",
                            "--porcelain",
                            "--no-follow-tags",
                            "--recurse-submodules=no",
                            "--set-upstream",
                        ]);
                        match request.mode.as_deref().unwrap_or("normal") {
                            "normal" => {}
                            "force-with-lease" => {
                                // Read the actual push destination (which may differ from
                                // the fetch URL), then freeze an explicit lease. Background
                                // fetches must never silently move the confirmed baseline.
                                let remote_ref = format!("refs/heads/{branch}");
                                let advertised = text(
                                    &git,
                                    &workspace,
                                    &["ls-remote", "--refs", "--", &push_url, &remote_ref],
                                )?;
                                for row in advertised.lines() {
                                    let (oid, name) = row.split_once('\t').ok_or_else(|| {
                                        invalid("Invalid remote ref advertisement")
                                    })?;
                                    if name != remote_ref
                                        || expected_remote_oid.is_some()
                                        || ![40, 64].contains(&oid.len())
                                        || !oid.bytes().all(|byte| byte.is_ascii_hexdigit())
                                        || oid.bytes().all(|byte| byte == b'0')
                                    {
                                        return Err(invalid("Invalid remote ref advertisement"));
                                    }
                                    expected_remote_oid = Some(oid.to_owned());
                                }
                                // An empty expectation permits creation only while the
                                // remote branch remains absent.
                                args.push(format!(
                                    "--force-with-lease={remote_ref}:{}",
                                    expected_remote_oid.as_deref().unwrap_or("")
                                ));
                            }
                            _ => return Err(invalid("Invalid push mode")),
                        }
                        args.extend(words(&[
                            "--",
                            remote,
                            &format!("refs/heads/{local}:refs/heads/{branch}"),
                        ]));
                    }
                }
            }
            Stash => {
                if changes.head.is_none() {
                    return Err(invalid("Stash requires an initial commit"));
                }
                let include_untracked = match request.mode.as_deref().unwrap_or("tracked") {
                    "tracked" => false,
                    "include-untracked" => true,
                    _ => return Err(invalid("Invalid stash scope")),
                };
                if !changes
                    .files
                    .iter()
                    .any(|file| include_untracked || file.status != "?")
                {
                    return Err(Error::new(
                        "STASH_EMPTY",
                        "没有可保存到 Stash 的修改。",
                        "No matching changes",
                    ));
                }
                let message = request
                    .name
                    .as_deref()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or("Work in progress");
                if message.len() > 2048 || message.chars().any(char::is_control) {
                    return Err(invalid("Invalid stash message"));
                }
                args = words(&["stash", "push", "--message", message]);
                if include_untracked {
                    args.push("--include-untracked".into());
                }
            }
            StashApply | StashPop | StashDrop => {
                let entry = crate::stash::entries(&git, &workspace)?
                    .into_iter()
                    .find(|entry| Some(entry.selector.as_str()) == request.target.as_deref())
                    .ok_or_else(|| {
                        Error::new(
                            "STASH_MISSING",
                            "此 Stash 已更新或移除，请刷新后重试。",
                            "Stash selector is no longer available",
                        )
                    })?;
                target_oid = Some(entry.oid.clone());
                let verb = match request.kind {
                    StashApply => "apply",
                    StashPop => "pop",
                    _ => "drop",
                };
                args = words(&["stash", verb]);
                if request.kind != StashDrop {
                    match request.mode.as_deref().unwrap_or("worktree") {
                        "worktree" => {}
                        "index" => args.push("--index".into()),
                        _ => return Err(invalid("Invalid stash restore mode")),
                    }
                }
                args.push(if request.kind == StashApply {
                    entry.oid
                } else {
                    entry.selector
                });
            }
            Continue | Abort => {
                if request.kind == Continue && changes.files.iter().any(|f| f.conflicted) {
                    return Err(Error::new(
                        "HISTORY_CONFLICTS",
                        "请先解决冲突并 Stage，再继续。",
                        "Unmerged paths remain",
                    ));
                }
                let command = match changes.operation.as_deref() {
                    Some("Rebase") => "rebase",
                    Some("Merge") => "merge",
                    Some("Cherry-pick") => "cherry-pick",
                    Some("Revert") => "revert",
                    _ => return Err(invalid("Unsupported operation")),
                };
                args = words(&[
                    command,
                    if request.kind == Continue {
                        "--continue"
                    } else {
                        "--abort"
                    },
                ]);
            }
            StageResolution => {
                let path = required(&request.target)?;
                if !changes.files.iter().any(|f| f.conflicted && f.path == path) {
                    return Err(invalid("This path is no longer conflicted"));
                }
                git::checked_path(&workspace, path)?;
                args = words(&["add", "--", path]);
            }
        }
        // Preparing never writes; check that all of the reads describe one state.
        if operation_guard(&git, &workspace, &git.changes(&workspace)?)? != guard {
            return Err(Error::stale());
        }
        let preview = HistoryActionPreview {
            id: uuid::Uuid::new_v4().to_string(),
            request,
            head: changes.head,
            branch: changes.branch,
            target_oid,
            remote_branch,
            expected_remote_oid,
            dirty_files: changes.files.len(),
            affected_commits,
            operation: changes.operation,
            arguments: args,
            destructive,
        };
        self.history_actions
            .retain(|p| now().saturating_sub(p.created_at) < 600_000);
        while self.history_actions.len() >= 32 {
            self.history_actions.pop_front();
        }
        self.history_actions.push_back(PreparedAction {
            workspace_id: workspace_id.into(),
            preview: preview.clone(),
            guard,
            created_at: now(),
        });
        Ok(preview)
    }
    pub fn execute_history_action(
        &mut self,
        workspace_id: &str,
        preview_id: &str,
    ) -> Result<HistoryActionResult> {
        let index = self
            .history_actions
            .iter()
            .position(|p| p.workspace_id == workspace_id && p.preview.id == preview_id)
            .ok_or_else(Error::stale)?;
        let prepared = self
            .history_actions
            .remove(index)
            .ok_or_else(Error::stale)?;
        let workspace = self.store.workspace(workspace_id)?;
        if !workspace.trusted {
            return Err(Error::new(
                "TRUST_REQUIRED",
                "请先确认信任此仓库，再执行 Git 写操作。",
                "Trust was revoked",
            ));
        }
        let git = self.git()?;
        if now().saturating_sub(prepared.created_at) >= 600_000
            || operation_guard(&git, &workspace, &git.changes(&workspace)?)? != prepared.guard
        {
            return Err(Error::stale());
        }
        let mut command = git.command(&workspace)?;
        // Keep configured hooks/signing, but never wait for a terminal editor or
        // credential prompt. Only this owned Git process is timed out.
        if matches!(
            prepared.preview.request.kind,
            HistoryActionKind::Stash
                | HistoryActionKind::StashApply
                | HistoryActionKind::StashPop
                | HistoryActionKind::StashDrop
        ) {
            // Stash receives no user pathspecs. Git's internal clean uses :/;
            // inheriting literal-pathspecs silently leaves untracked files.
            command.arg("--no-literal-pathspecs");
        }
        command
            .arg("--no-replace-objects")
            .args(&prepared.preview.arguments)
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "true")
            .env("GIT_MERGE_AUTOEDIT", "no");
        if matches!(
            prepared.preview.request.kind,
            HistoryActionKind::Fetch | HistoryActionKind::Pull
        ) {
            self.history_fetches
                .entry(workspace.repository_id.clone())
                .or_default()
                .note_manual_fetch();
        }
        let output = process::run(command, None, Duration::from_secs(180));
        self.clear_reading_cache();
        let after = git.changes(&workspace)?;
        let (ok, detail) = match output {
            Ok(output) => (
                output.code == 0,
                format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                ),
            ),
            // A timeout may already have changed Git state. Report the observed
            // state and never retry or roll back automatically.
            Err(error) => (false, format!("{}\n{}", error.message, error.detail)),
        };
        let mut result = HistoryActionResult {
            ok,
            head: after.head,
            branch: after.branch,
            operation: after.operation,
            conflicts: after
                .files
                .into_iter()
                .filter(|f| f.conflicted)
                .map(|f| f.path)
                .collect(),
            detail,
            warning: None,
        };
        if result.ok {
            use HistoryActionKind::*;
            let p = &prepared.preview;
            let r = &p.request;
            let verified = match r.kind {
                Switch => {
                    result.branch.as_deref()
                        == r.target
                            .as_deref()
                            .and_then(|target| target.strip_prefix("refs/heads/"))
                            .or(r.name.as_deref())
                        && result.head == p.target_oid
                }
                CheckoutCommit => result.branch.is_none() && result.head == p.target_oid,
                Reset => result.branch == p.branch && result.head == p.target_oid,
                Fetch | StageResolution | Stash | StashApply | StashPop | StashDrop => {
                    result.branch == p.branch && result.head == p.head
                }
                Push => {
                    let source = r
                        .target
                        .as_deref()
                        .filter(|name| name.starts_with("refs/heads/"))
                        .map(str::to_owned)
                        .or_else(|| p.branch.as_ref().map(|name| format!("refs/heads/{name}")));
                    result.branch == p.branch
                        && result.head == p.head
                        && source.is_some_and(|source| {
                            commit(&git, &workspace, &source).ok() == p.target_oid
                        })
                }
                CreateBranch | CreateTag | RenameBranch => {
                    let namespace = if r.kind == CreateTag { "tags" } else { "heads" };
                    let new_ref = format!("refs/{namespace}/{}", r.name.as_deref().unwrap_or(""));
                    let expected_branch = if r.kind == RenameBranch
                        && p.branch.as_deref()
                            == r.target
                                .as_deref()
                                .and_then(|value| value.strip_prefix("refs/heads/"))
                    {
                        &r.name
                    } else {
                        &p.branch
                    };
                    commit(&git, &workspace, &new_ref).ok() == p.target_oid
                        && &result.branch == expected_branch
                        && result.head == p.head
                }
                DeleteBranch => {
                    commit(&git, &workspace, r.target.as_deref().unwrap_or("")).is_err()
                        && result.branch == p.branch
                        && result.head == p.head
                }
                Merge | Rebase | CherryPick | Revert | Pull => result.branch == p.branch,
                Continue | Abort => true,
            };
            if !verified {
                result.ok = false;
                result.warning =
                    Some("Git 执行后的状态与预期不符，请检查实际 Branch 和 HEAD。".into());
            }
        }
        // Store only the outcome, not Git output that can contain credential URLs.
        let record = serde_json::json!({"kind":prepared.preview.request.kind,"ok":result.ok,"head":result.head,"branch":result.branch,"operation":result.operation});
        if let Err(error) =
            self.store
                .record_operation(workspace_id, "history", &record.to_string())
        {
            result.warning = Some(error.message);
        }
        Ok(result)
    }
}
