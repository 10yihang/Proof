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

#[test]
fn automatic_fetch_updates_only_remote_refs_and_throttles_linked_worktrees() {
    let mut f = Fixture::new();
    let peer = f.remote();
    let old_head = f.head();
    fs::write(peer.join("remote.txt"), "remote change\n").unwrap();
    git(&peer, &["add", "."]);
    git(&peer, &["commit", "-m", "Remote update"]);
    git(&peer, &["push", "origin", "main"]);
    let remote_head = git(&peer, &["rev-parse", "HEAD"]);
    fs::write(f.repo.join("staged.txt"), "staged\n").unwrap();
    git(&f.repo, &["add", "."]);
    fs::write(f.repo.join("code.txt"), "local work\n").unwrap();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    fs::write(f.repo.join(".git/FETCH_HEAD"), "preserve manual fetch\n").unwrap();
    // Even a configured refspec that targets local refs must not be used by
    // automatic fetch. It owns remote-tracking refs only.
    git(
        &f.repo,
        &[
            "config",
            "remote.origin.fetch",
            "+refs/heads/*:refs/heads/*",
        ],
    );
    let job = f
        .proof
        .prepare_history_fetch(&f.workspace.id)
        .unwrap()
        .unwrap();
    assert!(f
        .proof
        .prepare_history_fetch(&f.workspace.id)
        .unwrap()
        .is_none());
    // Having a prepared network job must not retain mutable access to Proof.
    assert_eq!(
        f.proof.changes(&f.workspace.id).unwrap().head.as_deref(),
        Some(old_head.as_str())
    );
    job.execute().unwrap();
    assert_eq!(
        git(&f.repo, &["rev-parse", "refs/remotes/origin/main"]),
        remote_head
    );
    assert_eq!(f.head(), old_head);
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "local work\n"
    );
    assert_eq!(
        fs::read_to_string(f.repo.join(".git/FETCH_HEAD")).unwrap(),
        "preserve manual fetch\n"
    );
    assert!(f
        .proof
        .prepare_history_fetch(&f.workspace.id)
        .unwrap()
        .is_none());
    let tree = f.temp.path().join("linked");
    git(
        &f.repo,
        &["worktree", "add", "-b", "linked", tree.to_str().unwrap()],
    );
    let linked = f.proof.open_workspace(tree.to_str().unwrap()).unwrap();
    f.proof.set_trust(&linked.id, true).unwrap();
    assert_eq!(linked.repository_id, f.workspace.repository_id);
    assert!(f.proof.prepare_history_fetch(&linked.id).unwrap().is_none());
}

#[test]
fn push_can_publish_a_selected_local_branch_without_switching_head() {
    let mut f = Fixture::new();
    f.remote();
    let main = f.head();
    git(&f.repo, &["switch", "-c", "feature/publish"]);
    let feature = f.commit("feature.txt", "feature change\n");
    git(&f.repo, &["switch", "main"]);
    let mut request = action(Kind::Push, Some("refs/heads/feature/publish"));
    request.remote = Some("origin".into());
    request.name = Some("review/feature".into());
    let preview = f.prepare(request).unwrap();
    assert_eq!(preview.target_oid.as_deref(), Some(feature.as_str()));
    assert!(preview
        .arguments
        .contains(&"refs/heads/feature/publish:refs/heads/review/feature".into()));
    let result = f
        .proof
        .execute_history_action(&f.workspace.id, &preview.id)
        .unwrap();
    assert!(result.ok, "{}", result.detail);
    assert_eq!(f.head(), main);
    assert_eq!(git(&f.repo, &["branch", "--show-current"]), "main");
    assert_eq!(
        git(
            &f.temp.path().join("remote.git"),
            &["rev-parse", "refs/heads/review/feature"]
        ),
        feature
    );
    let state = f
        .proof
        .history_branch_state(&f.workspace.id, Some("feature/publish"))
        .unwrap();
    assert_eq!(state.upstream_remote.as_deref(), Some("origin"));
    assert_eq!(state.upstream_branch.as_deref(), Some("review/feature"));
    assert_eq!(
        f.proof
            .history_repository_state(&f.workspace.id)
            .unwrap()
            .upstream_branch
            .as_deref(),
        Some("main")
    );
}

#[test]
fn stash_preserves_staged_content_and_optionally_includes_untracked_files() {
    let mut f = Fixture::new();
    fs::write(f.repo.join("code.txt"), "staged version\n").unwrap();
    git(&f.repo, &["add", "code.txt"]);
    fs::write(f.repo.join("code.txt"), "worktree version\n").unwrap();
    fs::write(f.repo.join("untracked.txt"), "new file\n").unwrap();
    let mut save = action(Kind::Stash, None);
    save.name = Some("work in progress".into());
    assert!(f.run(save.clone()).ok);
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "initial\n"
    );
    assert!(f.repo.join("untracked.txt").exists());
    let entries = f.proof.stashes(&f.workspace.id).unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].subject.contains("work in progress"));
    let mut apply = action(Kind::StashApply, Some(&entries[0].selector));
    apply.mode = Some("index".into());
    assert!(f.run(apply).ok);
    assert_eq!(git(&f.repo, &["show", ":code.txt"]), "staged version");
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "worktree version\n"
    );
    assert_eq!(f.proof.stashes(&f.workspace.id).unwrap().len(), 1);
    save.mode = Some("include-untracked".into());
    assert!(f.run(save).ok);
    assert!(!f.repo.join("untracked.txt").exists());
    assert!(f.proof.changes(&f.workspace.id).unwrap().files.is_empty());
    assert!(f.run(action(Kind::StashPop, Some("stash@{0}"))).ok);
    assert_eq!(
        fs::read_to_string(f.repo.join("untracked.txt")).unwrap(),
        "new file\n"
    );
    assert_eq!(f.proof.stashes(&f.workspace.id).unwrap().len(), 1);
}

#[test]
fn stash_pop_conflicts_keep_the_saved_stash_and_report_conflicts() {
    let mut f = Fixture::new();
    fs::write(f.repo.join("code.txt"), "saved work\n").unwrap();
    assert!(f.run(action(Kind::Stash, None)).ok);
    let stash = f.proof.stashes(&f.workspace.id).unwrap()[0].oid.clone();
    f.commit("code.txt", "new base\n");
    let result = f.run(action(Kind::StashPop, Some("stash@{0}")));
    assert!(!result.ok);
    assert_eq!(result.conflicts, ["code.txt"]);
    assert_eq!(f.proof.stashes(&f.workspace.id).unwrap()[0].oid, stash);
}

#[test]
fn stash_preview_rejects_reflog_changes_even_when_its_tip_did_not_change() {
    let mut f = Fixture::new();
    for i in 0..3 {
        fs::write(f.repo.join("code.txt"), format!("saved {i}\n")).unwrap();
        assert!(f.run(action(Kind::Stash, None)).ok);
    }
    let preview = f
        .prepare(action(Kind::StashDrop, Some("stash@{1}")))
        .unwrap();
    assert!(preview.destructive);
    let tip = git(&f.repo, &["rev-parse", "refs/stash"]);
    git(&f.repo, &["stash", "drop", "stash@{2}"]);
    assert_eq!(git(&f.repo, &["rev-parse", "refs/stash"]), tip);
    assert_eq!(
        f.proof
            .execute_history_action(&f.workspace.id, &preview.id)
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
    assert_eq!(f.proof.stashes(&f.workspace.id).unwrap().len(), 2);
}

#[test]
fn multi_file_discard_is_previewed_and_recoverable_without_index_changes() {
    let mut f = Fixture::new();
    fs::write(f.repo.join("code.txt"), "local edit\n").unwrap();
    fs::write(f.repo.join("new.txt"), "untracked edit\n").unwrap();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let token = f.proof.changes(&f.workspace.id).unwrap().token;
    let points = f
        .proof
        .discard_files_preview(
            &f.workspace.id,
            &["code.txt".into(), "new.txt".into()],
            &token,
        )
        .unwrap();
    assert_eq!(points.len(), 2);
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "local edit\n"
    );
    let ids: Vec<_> = points.iter().map(|p| p.id.clone()).collect();
    let result = f
        .proof
        .discard_files(&f.workspace.id, &ids, &token)
        .unwrap();
    assert!(result.error.is_none(), "{:?}", result.error);
    assert_eq!(result.applied.len(), 2);
    assert!(result.applied.iter().all(|action| action.result.ok));
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "initial\n"
    );
    assert!(!f.repo.join("new.txt").exists());
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    for id in &ids {
        assert!(f.proof.undo_discard(id).unwrap().result.ok);
    }
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "local edit\n"
    );
    assert_eq!(
        fs::read_to_string(f.repo.join("new.txt")).unwrap(),
        "untracked edit\n"
    );
}

#[test]
fn multi_file_discard_rejects_a_changed_selection_before_any_file_is_discarded() {
    let mut f = Fixture::new();
    fs::write(f.repo.join("code.txt"), "keep first\n").unwrap();
    fs::write(f.repo.join("new.txt"), "keep second\n").unwrap();
    let token = f.proof.changes(&f.workspace.id).unwrap().token;
    let points = f
        .proof
        .discard_files_preview(
            &f.workspace.id,
            &["code.txt".into(), "new.txt".into()],
            &token,
        )
        .unwrap();
    fs::write(f.repo.join("new.txt"), "newer editor save\n").unwrap();
    let ids: Vec<_> = points.iter().map(|p| p.id.clone()).collect();
    assert_eq!(
        f.proof
            .discard_files(&f.workspace.id, &ids, &token)
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "keep first\n"
    );
    assert_eq!(
        fs::read_to_string(f.repo.join("new.txt")).unwrap(),
        "newer editor save\n"
    );
    for id in &ids {
        f.proof.cancel_discard_preview(id).unwrap();
    }
}

#[test]
fn untracked_binary_discard_preserves_exact_bytes_and_never_exposes_lossy_text() {
    let mut f = Fixture::new();
    let name = ":(glob)*literal.bin";
    let bytes = b"\0\xff\x01binary data";
    fs::write(f.repo.join(name), bytes).unwrap();
    let token = f.proof.changes(&f.workspace.id).unwrap().token;
    let points = f
        .proof
        .discard_files_preview(&f.workspace.id, &[name.into()], &token)
        .unwrap();
    assert!(points[0].removes_file);
    let id = points[0].id.clone();
    let content = f.proof.recovery_content(&id).unwrap();
    assert_eq!(content["binaryContent"], true);
    assert!(content["before"].is_null());
    let result = f
        .proof
        .discard_files(&f.workspace.id, std::slice::from_ref(&id), &token)
        .unwrap();
    assert!(result.error.is_none());
    assert!(!f.repo.join(name).exists());
    assert!(f.proof.undo_discard(&id).unwrap().result.ok);
    assert_eq!(fs::read(f.repo.join(name)).unwrap(), bytes);
}

#[test]
fn automatic_fetch_skips_untrusted_and_remote_less_repositories_and_limits_failures() {
    let mut f = Fixture::new();
    assert!(f
        .proof
        .prepare_history_fetch(&f.workspace.id)
        .unwrap()
        .is_none());
    f.remote();
    f.proof.set_trust(&f.workspace.id, false).unwrap();
    assert!(f
        .proof
        .prepare_history_fetch(&f.workspace.id)
        .unwrap()
        .is_none());
    f.proof.set_trust(&f.workspace.id, true).unwrap();
    git(
        &f.repo,
        &[
            "remote",
            "set-url",
            "origin",
            f.temp.path().join("missing.git").to_str().unwrap(),
        ],
    );
    let job = f
        .proof
        .prepare_history_fetch(&f.workspace.id)
        .unwrap()
        .unwrap();
    assert!(job.execute().is_err());
    assert!(f
        .proof
        .prepare_history_fetch(&f.workspace.id)
        .unwrap()
        .is_none());
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
fn force_with_lease_rewrites_only_the_confirmed_remote_branch() {
    let mut f = Fixture::new();
    f.remote();
    let published = f.commit("local", "Published work");
    git(&f.repo, &["push", "origin", "main"]);
    git(&f.repo, &["branch", "keep-original"]);
    git(&f.repo, &["push", "origin", "keep-original"]);
    git(&f.repo, &["commit", "--amend", "-m", "Rewritten work"]);
    let rewritten = f.head();
    let mut request = action(Kind::Push, Some("refs/heads/main"));
    request.remote = Some("origin".into());
    request.name = Some("main".into());
    request.mode = Some("force-with-lease".into());
    let preview = f.prepare(request).unwrap();
    assert!(preview
        .arguments
        .contains(&format!("--force-with-lease=refs/heads/main:{published}")));
    assert!(preview.destructive);
    assert!(!preview.arguments.contains(&"--force".into()));
    let result = f
        .proof
        .execute_history_action(&f.workspace.id, &preview.id)
        .unwrap();
    assert!(result.ok, "{}", result.detail);
    let remote = f.temp.path().join("remote.git");
    assert_eq!(git(&remote, &["rev-parse", "main"]), rewritten);
    assert_eq!(git(&remote, &["rev-parse", "keep-original"]), published);
    assert_eq!(f.head(), rewritten);
}

#[test]
fn force_with_lease_rejects_remote_updates_after_preview_even_with_background_fetch() {
    for fetch_after_preview in [false, true] {
        let mut f = Fixture::new();
        let peer = f.remote();
        git(&f.repo, &["commit", "--amend", "-m", "Rewritten initial"]);
        let local = f.head();
        let mut request = action(Kind::Push, None);
        request.remote = Some("origin".into());
        request.name = Some("main".into());
        request.mode = Some("force-with-lease".into());
        let preview = f.prepare(request).unwrap();
        git(
            &peer,
            &["commit", "--allow-empty", "-m", "Someone else's work"],
        );
        git(&peer, &["push", "origin", "main"]);
        let other = git(&peer, &["rev-parse", "HEAD"]);
        if fetch_after_preview {
            git(&f.repo, &["fetch", "origin"]);
        }
        let result = f.proof.execute_history_action(&f.workspace.id, &preview.id);
        if fetch_after_preview {
            assert_eq!(result.unwrap_err().code, "STALE_CONTENT");
        } else {
            let result = result.unwrap();
            assert!(!result.ok);
            assert!(result.detail.contains("stale info"), "{}", result.detail);
        }
        assert_eq!(
            git(&f.temp.path().join("remote.git"), &["rev-parse", "main"]),
            other
        );
        assert_eq!(f.head(), local);
        assert!(f
            .proof
            .execute_history_action(&f.workspace.id, &preview.id)
            .is_err());
    }
}

#[test]
fn force_with_lease_reads_the_push_destination_and_protects_absent_branches() {
    let mut f = Fixture::new();
    f.remote();
    let initial = f.head();
    let push_remote = f.temp.path().join("push.git");
    fs::create_dir(&push_remote).unwrap();
    git(&push_remote, &["init", "--bare", "-b", "main"]);
    git(
        &f.repo,
        &[
            "config",
            "remote.origin.pushurl",
            push_remote.to_str().unwrap(),
        ],
    );
    let mut request = action(Kind::Push, None);
    request.remote = Some("origin".into());
    request.name = Some("main".into());
    request.mode = Some("force-with-lease".into());
    let preview = f.prepare(request.clone()).unwrap();
    assert!(preview.expected_remote_oid.is_none());
    assert!(preview
        .arguments
        .contains(&"--force-with-lease=refs/heads/main:".into()));
    // The fetch destination has main, but the actual push destination does not.
    git(&f.repo, &["push", "origin", "main"]);
    let local = f.commit("local", "Local only");
    // Preparing again freezes the actual push remote's old Commit.
    let current = f.prepare(request.clone()).unwrap();
    assert_eq!(
        current.expected_remote_oid.as_deref(),
        Some(initial.as_str())
    );
    assert!(current
        .arguments
        .contains(&format!("--force-with-lease=refs/heads/main:{initial}")));
    assert!(f
        .proof
        .execute_history_action(&f.workspace.id, &preview.id)
        .is_err());
    assert!(
        f.proof
            .execute_history_action(&f.workspace.id, &current.id)
            .unwrap()
            .ok
    );
    assert_eq!(git(&push_remote, &["rev-parse", "main"]), local);
    assert_eq!(
        git(&f.temp.path().join("remote.git"), &["rev-parse", "main"]),
        initial
    );
    for mode in ["force", "--force", "+", "invalid"] {
        request.mode = Some(mode.into());
        assert!(f.prepare(request.clone()).is_err());
    }
}

#[test]
fn force_with_lease_does_not_overwrite_a_concurrently_created_branch() {
    let mut f = Fixture::new();
    f.remote();
    let initial = f.head();
    f.commit("local", "Local only");
    let mut request = action(Kind::Push, None);
    request.remote = Some("origin".into());
    request.name = Some("new-branch".into());
    request.mode = Some("force-with-lease".into());
    let preview = f.prepare(request).unwrap();
    assert!(preview.expected_remote_oid.is_none());
    let remote = f.temp.path().join("remote.git");
    git(&remote, &["update-ref", "refs/heads/new-branch", &initial]);
    let result = f
        .proof
        .execute_history_action(&f.workspace.id, &preview.id)
        .unwrap();
    assert!(!result.ok);
    assert!(result.detail.contains("stale info"), "{}", result.detail);
    assert_eq!(git(&remote, &["rev-parse", "new-branch"]), initial);
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
fn merge_preserves_unrelated_unstaged_and_untracked_changes() {
    for diverged in [false, true] {
        let mut f = Fixture::new();
        git(&f.repo, &["switch", "-c", "feature"]);
        let feature = f.commit("feature.txt", "feature change\n");
        git(&f.repo, &["switch", "main"]);
        if diverged {
            f.commit("main.txt", "main change\n");
        }
        fs::write(f.repo.join("code.txt"), "local edit\n").unwrap();
        fs::write(f.repo.join("untracked.txt"), "local notes\n").unwrap();
        let before = git(&f.repo, &["status", "--porcelain"]);

        let result = f.run(action(Kind::Merge, Some("refs/heads/feature")));

        assert!(result.ok, "{}", result.detail);
        git(&f.repo, &["merge-base", "--is-ancestor", &feature, "HEAD"]);
        assert_eq!(git(&f.repo, &["status", "--porcelain"]), before);
        assert_eq!(git(&f.repo, &["show", "HEAD:code.txt"]), "initial");
        assert_eq!(
            fs::read_to_string(f.repo.join("code.txt")).unwrap(),
            "local edit\n"
        );
        assert_eq!(
            fs::read_to_string(f.repo.join("untracked.txt")).unwrap(),
            "local notes\n"
        );
    }
}

#[test]
fn cherry_pick_and_revert_preserve_unrelated_unstaged_and_untracked_changes() {
    for kind in [Kind::CherryPick, Kind::Revert] {
        let mut f = Fixture::new();
        git(&f.repo, &["switch", "-c", "feature"]);
        let feature = f.commit("feature.txt", "feature change\n");
        if kind == Kind::CherryPick {
            git(&f.repo, &["switch", "main"]);
        }
        let head = f.head();
        fs::write(f.repo.join("code.txt"), "local edit\n").unwrap();
        fs::write(f.repo.join("untracked.txt"), "local notes\n").unwrap();
        let before = git(&f.repo, &["status", "--porcelain"]);

        let result = f.run(action(kind, Some(&feature)));

        assert!(result.ok, "{kind:?}: {}", result.detail);
        assert_ne!(f.head(), head);
        assert_eq!(
            f.repo.join("feature.txt").exists(),
            kind == Kind::CherryPick
        );
        assert_eq!(git(&f.repo, &["status", "--porcelain"]), before);
        assert_eq!(git(&f.repo, &["show", "HEAD:code.txt"]), "initial");
        assert_eq!(
            fs::read_to_string(f.repo.join("code.txt")).unwrap(),
            "local edit\n"
        );
        assert_eq!(
            fs::read_to_string(f.repo.join("untracked.txt")).unwrap(),
            "local notes\n"
        );
    }
}

#[test]
fn pull_preserves_unrelated_unstaged_and_untracked_changes_for_every_strategy() {
    for mode in ["ff-only", "merge", "rebase"] {
        let mut f = Fixture::new();
        let peer = f.remote();
        if mode != "ff-only" {
            f.commit("local.txt", "local commit\n");
        }
        fs::write(peer.join("remote.txt"), "remote change\n").unwrap();
        git(&peer, &["add", "remote.txt"]);
        git(&peer, &["commit", "-m", "Remote update"]);
        git(&peer, &["push"]);
        let remote = git(&peer, &["rev-parse", "HEAD"]);
        fs::write(f.repo.join("code.txt"), "local edit\n").unwrap();
        fs::write(f.repo.join("untracked.txt"), "local notes\n").unwrap();
        let before = git(&f.repo, &["status", "--porcelain"]);

        let result = f.remote_action(Kind::Pull, Some(mode));

        assert!(result.ok, "{mode}: {}", result.detail);
        git(&f.repo, &["merge-base", "--is-ancestor", &remote, "HEAD"]);
        assert_eq!(git(&f.repo, &["status", "--porcelain"]), before);
        assert_eq!(git(&f.repo, &["show", "HEAD:code.txt"]), "initial");
        assert_eq!(
            fs::read_to_string(f.repo.join("code.txt")).unwrap(),
            "local edit\n"
        );
        assert_eq!(
            fs::read_to_string(f.repo.join("untracked.txt")).unwrap(),
            "local notes\n"
        );
    }
}

#[test]
fn fast_forward_merge_and_pull_preserve_unrelated_staged_and_unstaged_changes() {
    for kind in [Kind::Merge, Kind::Pull] {
        let mut f = Fixture::new();
        if kind == Kind::Pull {
            f.remote();
        }
        git(&f.repo, &["switch", "-c", "feature"]);
        let feature = f.commit("feature.txt", "feature change\n");
        if kind == Kind::Pull {
            git(&f.repo, &["push", "origin", "feature:main"]);
        }
        git(&f.repo, &["switch", "main"]);
        fs::write(f.repo.join("code.txt"), "staged edit\n").unwrap();
        git(&f.repo, &["add", "code.txt"]);
        fs::write(f.repo.join("code.txt"), "unstaged edit\n").unwrap();
        let before = git(&f.repo, &["status", "--porcelain"]);

        let result = if kind == Kind::Pull {
            f.remote_action(kind, None)
        } else {
            f.run(action(kind, Some("refs/heads/feature")))
        };

        assert!(result.ok, "{kind:?}: {}", result.detail);
        assert_eq!(f.head(), feature);
        assert_eq!(git(&f.repo, &["status", "--porcelain"]), before);
        assert_eq!(git(&f.repo, &["show", "HEAD:code.txt"]), "initial");
        assert_eq!(git(&f.repo, &["show", ":code.txt"]), "staged edit");
        assert_eq!(
            fs::read_to_string(f.repo.join("code.txt")).unwrap(),
            "unstaged edit\n"
        );
    }
}

#[test]
fn history_actions_report_git_rejections_without_overwriting_local_edits() {
    for (kind, mode) in [
        (Kind::Merge, None),
        (Kind::CherryPick, None),
        (Kind::Revert, None),
        (Kind::Pull, Some("ff-only")),
        (Kind::Pull, Some("merge")),
        (Kind::Switch, None),
        (Kind::CheckoutCommit, None),
    ] {
        let mut f = Fixture::new();
        if kind == Kind::Pull {
            f.remote();
        }
        git(&f.repo, &["switch", "-c", "feature"]);
        let feature = f.commit("code.txt", "feature edit\n");
        if kind == Kind::Pull {
            git(&f.repo, &["push", "origin", "feature:main"]);
        }
        if kind != Kind::Revert {
            git(&f.repo, &["switch", "main"]);
        }
        // Merge must still reject actual overwrites even if user config enables autostash.
        git(&f.repo, &["config", "merge.autoStash", "true"]);
        fs::write(f.repo.join("code.txt"), "local edit\n").unwrap();
        let head = f.head();
        let before = git(&f.repo, &["status", "--porcelain"]);
        let staged = git(&f.repo, &["diff", "--cached"]);
        let mut request = action(
            kind,
            Some(if matches!(kind, Kind::Merge | Kind::Switch) {
                "refs/heads/feature"
            } else {
                &feature
            }),
        );
        if kind == Kind::Pull {
            request.target = None;
            request.remote = Some("origin".into());
            request.name = Some("main".into());
            request.mode = mode.map(str::to_owned);
        }

        let result = f.run(request);

        assert!(!result.ok, "{kind:?} {mode:?}: {}", result.detail);
        assert!(result.detail.contains("code.txt"), "{}", result.detail);
        assert_eq!(f.head(), head);
        assert_eq!(git(&f.repo, &["status", "--porcelain"]), before);
        assert_eq!(git(&f.repo, &["diff", "--cached"]), staged);
        assert_eq!(
            fs::read_to_string(f.repo.join("code.txt")).unwrap(),
            "local edit\n"
        );
        assert!(git(&f.repo, &["stash", "list"]).is_empty());
    }
}

#[test]
fn merge_does_not_overwrite_an_obstructing_untracked_file() {
    let mut f = Fixture::new();
    git(&f.repo, &["switch", "-c", "feature"]);
    f.commit("new.txt", "incoming content\n");
    git(&f.repo, &["switch", "main"]);
    fs::write(f.repo.join("new.txt"), "untracked content\n").unwrap();
    let head = f.head();

    let result = f.run(action(Kind::Merge, Some("refs/heads/feature")));

    assert!(!result.ok);
    assert!(result.detail.contains("new.txt"), "{}", result.detail);
    assert_eq!(f.head(), head);
    assert_eq!(git(&f.repo, &["status", "--porcelain"]), "?? new.txt");
    assert_eq!(
        fs::read_to_string(f.repo.join("new.txt")).unwrap(),
        "untracked content\n"
    );
}

#[test]
fn commit_creating_actions_do_not_include_unrelated_staged_edits() {
    for kind in [Kind::Merge, Kind::CherryPick, Kind::Revert] {
        let mut f = Fixture::new();
        git(&f.repo, &["switch", "-c", "feature"]);
        let feature = f.commit("feature.txt", "feature change\n");
        if kind != Kind::Revert {
            git(&f.repo, &["switch", "main"]);
            f.commit("main.txt", "main change\n");
        }
        fs::write(f.repo.join("code.txt"), "staged edit\n").unwrap();
        git(&f.repo, &["add", "code.txt"]);
        fs::write(f.repo.join("code.txt"), "unstaged edit\n").unwrap();
        let head = f.head();
        let before = git(&f.repo, &["status", "--porcelain"]);

        let result = f.run(action(kind, Some(&feature)));

        assert!(!result.ok, "{kind:?}: {}", result.detail);
        assert_eq!(f.head(), head);
        assert_eq!(git(&f.repo, &["status", "--porcelain"]), before);
        assert_eq!(git(&f.repo, &["show", ":code.txt"]), "staged edit");
        assert_eq!(
            fs::read_to_string(f.repo.join("code.txt")).unwrap(),
            "unstaged edit\n"
        );
    }
}

#[test]
fn rebase_autostashes_dirty_worktree_and_replays_current_branch() {
    let mut f = Fixture::new();
    git(&f.repo, &["branch", "base"]);
    f.commit("local", "local change");
    let original = f.head();
    git(&f.repo, &["branch", "keep-original"]);
    git(&f.repo, &["switch", "base"]);
    let base = f.commit("base", "base change");
    git(&f.repo, &["switch", "main"]);
    // 配置里显式关掉 autoStash、打开 updateRefs：Proof 的
    // --autostash / -c rebase.updateRefs=false 必须覆盖用户配置。
    git(&f.repo, &["config", "rebase.updateRefs", "true"]);
    git(&f.repo, &["config", "rebase.autoStash", "false"]);
    // 已跟踪文件的未提交改动与 untracked 文件都不再阻塞 rebase。
    fs::write(f.repo.join("local"), "dirty edit").unwrap();
    fs::write(f.repo.join("untracked"), "keep me").unwrap();
    assert!(f.run(action(Kind::Rebase, Some("refs/heads/base"))).ok);
    assert_ne!(f.head(), original);
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD^"]), base);
    assert_eq!(git(&f.repo, &["rev-parse", "keep-original"]), original);
    // autostash 回放：脏改动与 untracked 文件都还在。
    assert_eq!(fs::read_to_string(f.repo.join("local")).unwrap(), "dirty edit");
    assert_eq!(fs::read_to_string(f.repo.join("untracked")).unwrap(), "keep me");
    assert_eq!(git(&f.repo, &["status", "--porcelain"]), " M local\n?? untracked");
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
        f.commit("local.txt", "committed content\n");
        git(&f.repo, &["switch", "-c", "feature"]);
        f.commit("code.txt", "feature\n");
        git(&f.repo, &["switch", "main"]);
        let original = f.commit("code.txt", "main\n");
        fs::write(f.repo.join("local.txt"), "unrelated local edit\n").unwrap();
        fs::write(f.repo.join("untracked.txt"), "local notes\n").unwrap();
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
        assert_eq!(
            fs::read_to_string(f.repo.join("local.txt")).unwrap(),
            "unrelated local edit\n"
        );
        assert_eq!(
            fs::read_to_string(f.repo.join("untracked.txt")).unwrap(),
            "local notes\n"
        );
        assert_eq!(
            git(&f.repo, &["status", "--porcelain"]),
            " M local.txt\n?? untracked.txt"
        );
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
