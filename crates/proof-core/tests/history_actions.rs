use proof_core::{
    HistoryActionKind as Kind, HistoryActionPreview, HistoryActionRequest, HistoryActionResult,
    Proof, Workspace,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn git(path: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars().filter(|(key, _)| key.starts_with("GIT_")) {
        command.env_remove(key);
    }
    let output = command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_EDITOR", "true")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end_matches('\n')
        .into()
}
fn action(kind: Kind, target: Option<&str>) -> HistoryActionRequest {
    HistoryActionRequest {
        kind,
        target: target.map(str::to_owned),
        name: None,
        remote: None,
        mode: None,
        mainline: None,
    }
}
struct Fixture {
    temp: tempfile::TempDir,
    repo: PathBuf,
    proof: Proof,
    workspace: Workspace,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        Self::identity(&repo);
        fs::write(repo.join("code.txt"), "initial\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "Initial\n\nFull body"]);
        let mut proof = Proof::open(temp.path().join("data")).unwrap();
        let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
        proof.set_trust(&workspace.id, true).unwrap();
        Self {
            temp,
            repo,
            proof,
            workspace,
        }
    }
    fn identity(repo: &Path) {
        git(repo, &["config", "user.name", "Proof test"]);
        git(repo, &["config", "user.email", "test@example.invalid"]);
        git(repo, &["config", "commit.gpgsign", "false"]);
        git(
            repo,
            &[
                "config",
                "core.hooksPath",
                repo.join(".git/hooks").to_str().unwrap(),
            ],
        );
    }
    fn head(&self) -> String {
        git(&self.repo, &["rev-parse", "HEAD"])
    }
    fn commit(&self, path: &str, content: &str) -> String {
        fs::write(self.repo.join(path), content).unwrap();
        git(&self.repo, &["add", "--", path]);
        git(&self.repo, &["commit", "-m", content]);
        self.head()
    }
    fn prepare(
        &mut self,
        request: HistoryActionRequest,
    ) -> proof_core::Result<HistoryActionPreview> {
        let token = self.proof.changes(&self.workspace.id)?.token;
        self.proof
            .prepare_history_action(&self.workspace.id, request, &token)
    }
    fn run(&mut self, request: HistoryActionRequest) -> HistoryActionResult {
        let preview = self.prepare(request).unwrap();
        self.proof
            .execute_history_action(&self.workspace.id, &preview.id)
            .unwrap()
    }
    fn remote(&self) -> PathBuf {
        let remote = self.temp.path().join("remote.git");
        fs::create_dir(&remote).unwrap();
        git(&remote, &["init", "--bare", "-b", "main"]);
        git(
            &self.repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&self.repo, &["push", "-u", "origin", "main"]);
        let peer = self.temp.path().join("peer");
        git(
            self.temp.path(),
            &["clone", remote.to_str().unwrap(), peer.to_str().unwrap()],
        );
        Self::identity(&peer);
        peer
    }
    fn remote_action(&mut self, kind: Kind, mode: Option<&str>) -> HistoryActionResult {
        let mut request = action(kind, None);
        request.remote = Some("origin".into());
        request.name = Some("main".into());
        request.mode = mode.map(str::to_owned);
        self.run(request)
    }
}
#[test]
fn branches_tags_detached_checkout_and_full_message() {
    let mut f = Fixture::new();
    let initial = f.head();
    assert_eq!(
        f.proof
            .history_commit_message(&f.workspace.id, &initial)
            .unwrap(),
        "Initial\n\nFull body"
    );
    let mut create = action(Kind::CreateBranch, Some(&initial));
    create.name = Some("feature/中文".into());
    assert!(f.run(create).ok);
    assert_eq!(git(&f.repo, &["branch", "--show-current"]), "main");
    assert!(
        f.run(action(Kind::Switch, Some("refs/heads/feature/中文")))
            .ok
    );
    let mut rename = action(Kind::RenameBranch, Some("refs/heads/feature/中文"));
    rename.name = Some("feature/renamed".into());
    assert!(f.run(rename).ok);
    let mut tag = action(Kind::CreateTag, Some(&initial));
    tag.name = Some("v0.2".into());
    assert!(f.run(tag).ok);
    assert_eq!(git(&f.repo, &["rev-parse", "refs/tags/v0.2"]), initial);
    assert!(f
        .prepare(action(
            Kind::DeleteBranch,
            Some("refs/heads/feature/renamed")
        ))
        .is_err());
    assert!(f.run(action(Kind::CheckoutCommit, Some(&initial))).ok);
    assert!(git(&f.repo, &["branch", "--show-current"]).is_empty());
    assert!(f.run(action(Kind::Switch, Some("refs/heads/main"))).ok);
    assert!(
        f.run(action(
            Kind::DeleteBranch,
            Some("refs/heads/feature/renamed")
        ))
        .ok
    );
}
#[test]
fn preview_is_readonly_single_use_and_rejects_changed_refs_config_and_content() {
    let mut f = Fixture::new();
    git(&f.repo, &["branch", "feature"]);
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let head = f.head();
    let p = f
        .prepare(action(Kind::Switch, Some("refs/heads/feature")))
        .unwrap();
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert_eq!(f.head(), head);
    f.commit("other.txt", "other");
    assert_eq!(
        f.proof
            .execute_history_action(&f.workspace.id, &p.id)
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
    let p = f
        .prepare(action(Kind::Switch, Some("refs/heads/feature")))
        .unwrap();
    git(&f.repo, &["branch", "-f", "feature", "HEAD"]);
    assert_eq!(
        f.proof
            .execute_history_action(&f.workspace.id, &p.id)
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
    let p = f
        .prepare(action(Kind::Switch, Some("refs/heads/feature")))
        .unwrap();
    git(&f.repo, &["config", "branch.feature.remote", "changed"]);
    assert_eq!(
        f.proof
            .execute_history_action(&f.workspace.id, &p.id)
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
    let p = f
        .prepare(action(Kind::Switch, Some("refs/heads/feature")))
        .unwrap();
    fs::write(f.repo.join("untracked"), "new").unwrap();
    assert_eq!(
        f.proof
            .execute_history_action(&f.workspace.id, &p.id)
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
    let p = f
        .prepare(action(Kind::Switch, Some("refs/heads/feature")))
        .unwrap();
    assert!(
        f.proof
            .execute_history_action(&f.workspace.id, &p.id)
            .unwrap()
            .ok
    );
    assert!(f
        .proof
        .execute_history_action(&f.workspace.id, &p.id)
        .is_err());
}
#[test]
fn trust_validation_and_literal_targets_are_enforced_in_core() {
    let mut f = Fixture::new();
    let oid = f.head();
    for target in [
        "--help",
        "HEAD~1",
        "HEAD@{1}",
        "main",
        "refs/heads/main\nrefs/heads/evil",
    ] {
        assert!(f.prepare(action(Kind::Reset, Some(target))).is_err());
    }
    for name in ["--force", "HEAD", "../outside", "a:b", "bad name"] {
        let mut r = action(Kind::CreateBranch, Some(&oid));
        r.name = Some(name.into());
        assert!(f.prepare(r).is_err());
    }
    let p = f.prepare(action(Kind::CheckoutCommit, Some(&oid))).unwrap();
    f.proof.set_trust(&f.workspace.id, false).unwrap();
    assert_eq!(
        f.proof
            .execute_history_action(&f.workspace.id, &p.id)
            .unwrap_err()
            .code,
        "TRUST_REQUIRED"
    );
    assert_eq!(
        f.prepare(action(Kind::CheckoutCommit, Some(&oid)))
            .unwrap_err()
            .code,
        "TRUST_REQUIRED"
    );
}
#[test]
fn fetch_pull_push_and_remote_tracking_switch_use_only_selected_branch() {
    let mut f = Fixture::new();
    let peer = f.remote();
    let initial = f.head();
    fs::write(peer.join("remote.txt"), "remote").unwrap();
    git(&peer, &["add", "."]);
    git(&peer, &["commit", "-m", "remote change"]);
    git(&peer, &["branch", "topic"]);
    git(&peer, &["push", "origin", "main", "topic"]);
    assert!(f.remote_action(Kind::Fetch, None).ok);
    assert_eq!(f.head(), initial);
    let state = f.proof.history_repository_state(&f.workspace.id).unwrap();
    assert_eq!(state.behind, 1);
    assert_eq!(state.ahead, 0);
    assert!(f.remote_action(Kind::Pull, Some("ff-only")).ok);
    assert_eq!(
        fs::read_to_string(f.repo.join("remote.txt")).unwrap(),
        "remote"
    );
    f.commit("local.txt", "local");
    git(&f.repo, &["branch", "do-not-push"]);
    git(
        &f.repo,
        &[
            "config",
            "remote.origin.push",
            "refs/heads/do-not-push:refs/heads/unwanted",
        ],
    );
    git(&f.repo, &["config", "remote.origin.mirror", "true"]);
    assert!(f.remote_action(Kind::Push, None).ok);
    assert!(git(&peer, &["ls-remote", "--heads", "origin", "unwanted"]).is_empty());
    let mut switch = action(Kind::Switch, Some("refs/remotes/origin/topic"));
    switch.name = Some("topic".into());
    assert!(f.run(switch).ok);
    assert_eq!(
        git(&f.repo, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
        "origin/topic"
    );
}
#[test]
fn pull_strategies_stop_divergence_or_merge_or_rebase_as_selected() {
    for mode in ["ff-only", "merge", "rebase"] {
        let mut f = Fixture::new();
        let peer = f.remote();
        f.commit("local", "local change");
        let before = f.head();
        fs::write(peer.join("remote"), "remote change").unwrap();
        git(&peer, &["add", "."]);
        git(&peer, &["commit", "-m", "remote change"]);
        git(&peer, &["push"]);
        let result = f.remote_action(Kind::Pull, Some(mode));
        if mode == "ff-only" {
            assert!(!result.ok);
            assert_eq!(f.head(), before);
            assert_eq!(
                f.proof
                    .history_repository_state(&f.workspace.id)
                    .unwrap()
                    .behind,
                1
            );
        } else {
            assert!(result.ok, "{}", result.detail);
            assert!(f.repo.join("local").exists());
            assert!(f.repo.join("remote").exists());
            let count = git(&f.repo, &["show", "-s", "--format=%P", "HEAD"])
                .split_whitespace()
                .count();
            assert_eq!(count, if mode == "merge" { 2 } else { 1 });
        }
    }
}
#[test]
fn push_rejection_keeps_remote_history() {
    let mut f = Fixture::new();
    let peer = f.remote();
    f.commit("local", "local");
    fs::write(peer.join("remote"), "remote").unwrap();
    git(&peer, &["add", "."]);
    git(&peer, &["commit", "-m", "remote"]);
    git(&peer, &["push"]);
    let remote_head = git(&peer, &["rev-parse", "HEAD"]);
    let result = f.remote_action(Kind::Push, None);
    assert!(!result.ok);
    assert!(result.detail.contains("rejected"));
    assert!(git(&peer, &["ls-remote", "origin", "refs/heads/main"]).starts_with(&remote_head));
}
#[test]
fn rebase_replays_current_branch_without_updating_other_refs_or_autostashing() {
    let mut f = Fixture::new();
    git(&f.repo, &["branch", "base"]);
    f.commit("local", "local change");
    let original = f.head();
    git(&f.repo, &["branch", "keep-original"]);
    git(&f.repo, &["switch", "base"]);
    let base = f.commit("base", "base change");
    git(&f.repo, &["switch", "main"]);
    git(&f.repo, &["config", "rebase.updateRefs", "true"]);
    git(&f.repo, &["config", "rebase.autoStash", "true"]);
    fs::write(f.repo.join("dirty"), "dirty").unwrap();
    assert_eq!(
        f.prepare(action(Kind::Rebase, Some("refs/heads/base")))
            .unwrap_err()
            .code,
        "HISTORY_CLEAN_REQUIRED"
    );
    fs::remove_file(f.repo.join("dirty")).unwrap();
    assert!(f.run(action(Kind::Rebase, Some("refs/heads/base"))).ok);
    assert_ne!(f.head(), original);
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD^"]), base);
    assert_eq!(git(&f.repo, &["rev-parse", "keep-original"]), original);
}
#[test]
fn cherry_pick_revert_and_merge_parent_selection() {
    let mut f = Fixture::new();
    git(&f.repo, &["switch", "-c", "feature"]);
    let feature = f.commit("feature", "feature change");
    git(&f.repo, &["switch", "main"]);
    assert!(f.run(action(Kind::CherryPick, Some(&feature))).ok);
    assert!(f.repo.join("feature").exists());
    let picked = f.head();
    assert!(f.run(action(Kind::Revert, Some(&picked))).ok);
    assert!(!f.repo.join("feature").exists());
    git(&f.repo, &["switch", "-c", "other"]);
    f.commit("other", "other change");
    git(&f.repo, &["switch", "main"]);
    f.commit("main", "main change");
    assert!(f.run(action(Kind::Merge, Some("refs/heads/other"))).ok);
    let merge = f.head();
    assert!(f.prepare(action(Kind::Revert, Some(&merge))).is_err());
    let mut revert = action(Kind::Revert, Some(&merge));
    revert.mainline = Some(1);
    assert!(f.run(revert).ok);
    assert!(!f.repo.join("other").exists());
    assert!(f.repo.join("main").exists());
}
#[test]
fn reset_modes_preserve_or_discard_exactly_as_previewed() {
    for mode in ["soft", "mixed", "hard"] {
        let mut f = Fixture::new();
        let base = f.head();
        f.commit("code.txt", "changed\n");
        let mut r = action(Kind::Reset, Some(&base));
        r.mode = Some(mode.into());
        let p = f.prepare(r).unwrap();
        assert!(p.destructive);
        assert_eq!(p.affected_commits, 1);
        assert!(
            f.proof
                .execute_history_action(&f.workspace.id, &p.id)
                .unwrap()
                .ok
        );
        assert_eq!(f.head(), base);
        assert_eq!(
            fs::read_to_string(f.repo.join("code.txt")).unwrap(),
            if mode == "hard" {
                "initial\n"
            } else {
                "changed\n"
            }
        );
        assert_eq!(
            git(&f.repo, &["diff", "--cached", "--name-only"]).is_empty(),
            mode != "soft"
        );
    }
}
#[test]
fn merge_conflicts_can_be_staged_and_continued_or_aborted() {
    for abort in [true, false] {
        let mut f = Fixture::new();
        git(&f.repo, &["switch", "-c", "feature"]);
        f.commit("code.txt", "feature\n");
        git(&f.repo, &["switch", "main"]);
        let original = f.commit("code.txt", "main\n");
        let result = f.run(action(Kind::Merge, Some("refs/heads/feature")));
        assert!(!result.ok);
        assert_eq!(result.operation.as_deref(), Some("Merge"));
        assert_eq!(result.conflicts, vec!["code.txt"]);
        assert_eq!(
            f.prepare(action(Kind::Continue, None)).unwrap_err().code,
            "HISTORY_CONFLICTS"
        );
        if abort {
            assert!(f.run(action(Kind::Abort, None)).ok);
            assert_eq!(f.head(), original);
            assert_eq!(
                fs::read_to_string(f.repo.join("code.txt")).unwrap(),
                "main\n"
            );
        } else {
            fs::write(f.repo.join("code.txt"), "resolved\n").unwrap();
            assert!(f.run(action(Kind::StageResolution, Some("code.txt"))).ok);
            assert!(f.run(action(Kind::Continue, None)).ok);
            assert_eq!(
                git(&f.repo, &["show", "-s", "--format=%P"])
                    .split_whitespace()
                    .count(),
                2
            );
        }
        assert!(f
            .proof
            .changes(&f.workspace.id)
            .unwrap()
            .operation
            .is_none());
    }
}
#[test]
fn rebase_conflict_abort_restores_original_head() {
    let mut f = Fixture::new();
    git(&f.repo, &["switch", "-c", "feature"]);
    f.commit("code.txt", "feature\n");
    git(&f.repo, &["switch", "main"]);
    let original = f.commit("code.txt", "main\n");
    let result = f.run(action(Kind::Rebase, Some("refs/heads/feature")));
    assert!(!result.ok);
    assert_eq!(result.operation.as_deref(), Some("Rebase"));
    assert!(f.run(action(Kind::Abort, None)).ok);
    assert_eq!(f.head(), original);
    assert_eq!(git(&f.repo, &["branch", "--show-current"]), "main");
}
#[test]
fn delete_refuses_unmerged_or_linked_worktree_branch_and_switch_preserves_local_edits() {
    let mut f = Fixture::new();
    git(&f.repo, &["switch", "-c", "feature"]);
    f.commit("feature", "feature");
    git(&f.repo, &["switch", "main"]);
    assert!(
        !f.run(action(Kind::DeleteBranch, Some("refs/heads/feature")))
            .ok
    );
    let linked = f.temp.path().join("linked");
    git(
        &f.repo,
        &["worktree", "add", linked.to_str().unwrap(), "feature"],
    );
    assert!(!f.run(action(Kind::Switch, Some("refs/heads/feature"))).ok);
    assert_eq!(git(&f.repo, &["branch", "--show-current"]), "main");
    git(&f.repo, &["branch", "clean"]);
    fs::write(f.repo.join("code.txt"), "keep my changes\n").unwrap();
    assert!(f.run(action(Kind::Switch, Some("refs/heads/clean"))).ok);
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "keep my changes\n"
    );
}

#[test]
fn missing_remote_returns_actual_state_and_does_not_change_head() {
    let mut f = Fixture::new();
    git(
        &f.repo,
        &[
            "remote",
            "add",
            "offline",
            f.temp.path().join("missing.git").to_str().unwrap(),
        ],
    );
    let head = f.head();
    let mut fetch = action(Kind::Fetch, None);
    fetch.remote = Some("offline".into());
    let result = f.run(fetch);
    assert!(!result.ok);
    assert_eq!(result.head.as_deref(), Some(head.as_str()));
    assert_eq!(result.branch.as_deref(), Some("main"));
    assert!(result.operation.is_none());
    assert!(!result.detail.is_empty());
}

#[cfg(unix)]
#[test]
fn a_hook_changing_head_is_reported_as_an_unexpected_result() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    let target = f.head();
    git(&f.repo, &["branch", "feature"]);
    let newer = f.commit("later", "later");
    let hook = f.repo.join(".git/hooks/post-checkout");
    fs::write(&hook, format!("#!/bin/sh\ngit reset --hard {newer}\n")).unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let result = f.run(action(Kind::Switch, Some("refs/heads/feature")));
    assert!(!result.ok);
    assert!(result.warning.is_some());
    assert_eq!(result.head.as_deref(), Some(newer.as_str()));
    assert_ne!(result.head.as_deref(), Some(target.as_str()));
}
