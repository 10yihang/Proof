use proof_core::{Proof, Side, Workspace};
use std::{fs, path::PathBuf, process::Command};

struct Fixture {
    _temp: tempfile::TempDir,
    repo: PathBuf,
    data: PathBuf,
    proof: Proof,
    workspace: Workspace,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let data = temp.path().join("data");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Proof Test"]);
        git(&repo, &["config", "user.email", "proof@example.invalid"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        git(&repo, &["config", "core.autocrlf", "false"]);
        let hooks = repo.join(".git/hooks");
        git(
            &repo,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        );
        fs::write(repo.join("code.txt"), baseline()).unwrap();
        git(&repo, &["add", "--", "code.txt"]);
        git(&repo, &["commit", "-m", "Initial"]);
        let mut proof = Proof::open(&data).unwrap();
        let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
        proof.set_trust(&workspace.id, true).unwrap();
        Self {
            _temp: temp,
            repo,
            data,
            proof,
            workspace,
        }
    }
    fn change(&self) {
        fs::write(
            self.repo.join("code.txt"),
            baseline()
                .replace("line 3\n", "changed 3\n")
                .replace("line 25\n", "changed 25\n"),
        )
        .unwrap();
    }
}
fn baseline() -> String {
    (1..=35).map(|i| format!("line {i}\n")).collect()
}
fn git(repo: &PathBuf, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn child_paths_and_worktrees_have_correct_identity() {
    let mut f = Fixture::new();
    fs::create_dir(f.repo.join("child")).unwrap();
    assert_eq!(
        f.workspace.id,
        f.proof
            .open_workspace(f.repo.join("child").to_str().unwrap())
            .unwrap()
            .id
    );
    let other = f._temp.path().join("worktree");
    git(
        &f.repo,
        &["worktree", "add", "-b", "feature", other.to_str().unwrap()],
    );
    let workspace = f.proof.open_workspace(other.to_str().unwrap()).unwrap();
    assert_eq!(workspace.repository_id, f.workspace.repository_id);
    assert_ne!(workspace.id, f.workspace.id);
    let clone = f._temp.path().join("clone");
    git(
        &f.repo,
        &[
            "clone",
            "--no-hardlinks",
            f.repo.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    assert_ne!(
        f.proof
            .open_workspace(clone.to_str().unwrap())
            .unwrap()
            .repository_id,
        f.workspace.repository_id
    );
}

#[test]
fn stages_exactly_one_hunk_and_keeps_worktree_bytes() {
    let mut f = Fixture::new();
    f.change();
    let working = fs::read(f.repo.join("code.txt")).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(diff.hunks.len(), 2);
    f.proof.stage(&diff.id, Some(&diff.hunks[0].id)).unwrap();
    assert_eq!(
        git(&f.repo, &["show", ":code.txt"]),
        baseline().replace("line 3\n", "changed 3\n")
    );
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), working);
    let changes = f.proof.changes(&f.workspace.id).unwrap();
    assert!(changes.files.iter().any(|f| f.side == Side::Staged));
    assert!(changes.files.iter().any(|f| f.side == Side::Unstaged));
    let staged = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Staged)
        .unwrap();
    f.proof.stage(&staged.id, None).unwrap();
    assert_eq!(git(&f.repo, &["show", ":code.txt"]), baseline());
}

#[test]
fn rejects_a_stale_patch_without_changing_index() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let before = fs::read(f.repo.join(".git/index")).unwrap();
    fs::write(f.repo.join("code.txt"), "newer external change\n").unwrap();
    assert_eq!(
        f.proof
            .stage(&diff.id, Some(&diff.hunks[0].id))
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
    assert_eq!(before, fs::read(f.repo.join(".git/index")).unwrap());
}

#[test]
fn review_is_explicit_persisted_and_invalidated_by_content() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    f.proof
        .mark_reviewed(&diff.id, Some(&diff.hunks[0].id), true)
        .unwrap();
    assert_eq!(git(&f.repo, &["show", ":code.txt"]), baseline());
    f.proof = Proof::open(&f.data).unwrap();
    let reopened = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(reopened.hunks[0].review_state, "reviewed");
    assert_ne!(reopened.hunks[1].review_state, "reviewed");
    fs::write(
        f.repo.join("code.txt"),
        baseline().replace("line 3\n", "changed again\n"),
    )
    .unwrap();
    let changed = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(changed.hunks[0].review_state, "needs_review");
}

#[test]
fn branch_change_does_not_inherit_completion() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    f.proof.mark_reviewed(&diff.id, None, true).unwrap();
    let changes = f.proof.changes(&f.workspace.id).unwrap();
    f.proof
        .switch_branch(&f.workspace.id, "feature", true, &changes.token)
        .unwrap();
    let changed = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert!(changed.hunks.iter().all(|h| h.review_state != "reviewed"));
}

#[test]
fn stages_untracked_literal_paths_including_newline_and_leading_dash() {
    let mut f = Fixture::new();
    for path in ["中文 空格.txt", "line\nbreak.txt", "-option.txt"] {
        fs::write(f.repo.join(path), "new file\n").unwrap();
        let diff = f
            .proof
            .file_diff(&f.workspace.id, path, Side::Unstaged)
            .unwrap();
        f.proof.stage(&diff.id, None).unwrap();
        assert_eq!(git(&f.repo, &["show", &format!(":{path}")]), "new file\n");
    }
}

#[test]
fn commits_only_previewed_index_and_keeps_unstaged_work() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    f.proof.stage(&diff.id, Some(&diff.hunks[0].id)).unwrap();
    let preview = f.proof.commit_preview(&f.workspace.id).unwrap();
    let worktree = fs::read(f.repo.join("code.txt")).unwrap();
    let result = f.proof.commit(&preview.id, "Selected change").unwrap();
    assert!(result.ok, "{:?}", result);
    assert_eq!(
        git(&f.repo, &["show", "HEAD:code.txt"]),
        baseline().replace("line 3\n", "changed 3\n")
    );
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), worktree);
    assert!(git(&f.repo, &["diff", "--cached"]).is_empty());
    assert!(!f.repo.join(".git/index.lock").exists());
}

#[test]
fn rejects_external_index_changes_since_commit_preview() {
    let mut f = Fixture::new();
    f.change();
    git(&f.repo, &["add", "--", "code.txt"]);
    let preview = f.proof.commit_preview(&f.workspace.id).unwrap();
    let head = git(&f.repo, &["rev-parse", "HEAD"]);
    fs::write(f.repo.join("extra.txt"), "external staged file").unwrap();
    git(&f.repo, &["add", "--", "extra.txt"]);
    assert_eq!(
        f.proof.commit(&preview.id, "Should fail").unwrap_err().code,
        "STALE_CONTENT"
    );
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        git(&f.repo, &["show", ":extra.txt"]),
        "external staged file"
    );
}

#[test]
fn never_removes_an_existing_index_lock() {
    let mut f = Fixture::new();
    f.change();
    git(&f.repo, &["add", "--", "code.txt"]);
    let preview = f.proof.commit_preview(&f.workspace.id).unwrap();
    fs::write(f.repo.join(".git/index.lock"), "other process").unwrap();
    assert_eq!(
        f.proof.commit(&preview.id, "Should fail").unwrap_err().code,
        "GIT_LOCKED"
    );
    assert_eq!(
        fs::read_to_string(f.repo.join(".git/index.lock")).unwrap(),
        "other process"
    );
}

#[test]
fn strict_review_is_only_a_gui_commit_policy() {
    let mut f = Fixture::new();
    f.change();
    git(&f.repo, &["add", "--", "code.txt"]);
    let mut prefs = f.proof.preferences().unwrap();
    prefs.strict_review = true;
    f.proof.set_preferences(prefs).unwrap();
    let preview = f.proof.commit_preview(&f.workspace.id).unwrap();
    assert_eq!(
        f.proof
            .commit(&preview.id, "Needs review")
            .unwrap_err()
            .code,
        "REVIEW_REQUIRED"
    );
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Staged)
        .unwrap();
    f.proof.mark_reviewed(&diff.id, None, true).unwrap();
    assert!(f.proof.commit(&preview.id, "Reviewed").unwrap().ok);
}

#[cfg(unix)]
#[test]
fn respects_failing_git_hooks_and_keeps_head_and_index() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.change();
    git(&f.repo, &["add", "--", "code.txt"]);
    let hook = f.repo.join(".git/hooks/pre-commit");
    fs::write(&hook, "#!/bin/sh\nprintf 'fixture rejection' >&2\nexit 1\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    let preview = f.proof.commit_preview(&f.workspace.id).unwrap();
    let head = git(&f.repo, &["rev-parse", "HEAD"]);
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    assert_eq!(
        f.proof
            .commit(&preview.id, "Rejected by hook")
            .unwrap_err()
            .code,
        "COMMIT_FAILED"
    );
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert!(!f.repo.join(".git/index.lock").exists());
}

#[cfg(unix)]
#[test]
fn untrusted_view_does_not_execute_clean_filters() {
    let mut f = Fixture::new();
    fs::write(f.repo.join(".gitattributes"), "code.txt filter=proof\n").unwrap();
    let marker = f._temp.path().join("filter-executed");
    git(
        &f.repo,
        &[
            "config",
            "filter.proof.clean",
            &format!("touch '{}'; cat", marker.display()),
        ],
    );
    f.proof.set_trust(&f.workspace.id, false).unwrap();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert!(!marker.exists());
    assert!(!diff.can_stage);
    assert_eq!(
        f.proof.stage(&diff.id, None).unwrap_err().code,
        "TRUST_REQUIRED"
    );
}

#[test]
fn history_and_worktree_lists_use_real_git_data() {
    let f = Fixture::new();
    let history = f.proof.history(&f.workspace.id, 0, None).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].subject, "Initial");
    assert_eq!(history[0].oid, git(&f.repo, &["rev-parse", "HEAD"]).trim());
    assert_eq!(
        f.proof.worktrees(&f.workspace.id).unwrap()[0]
            .branch
            .as_deref(),
        Some("main")
    );
    assert!(f
        .proof
        .branches(&f.workspace.id)
        .unwrap()
        .iter()
        .any(|b| b.name == "main" && b.current));
}

#[test]
fn independent_hunk_review_survives_another_hunk_change() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    f.proof
        .mark_reviewed(&diff.id, Some(&diff.hunks[0].id), true)
        .unwrap();
    fs::write(
        f.repo.join("code.txt"),
        baseline()
            .replace("line 3\n", "changed 3\n")
            .replace("line 25\n", "different later change\n"),
    )
    .unwrap();
    let next = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(next.hunks[0].review_state, "reviewed");
    assert_ne!(next.hunks[1].review_state, "reviewed");
}

#[test]
fn exact_review_can_move_to_the_staged_comparison() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    f.proof
        .mark_reviewed(&diff.id, Some(&diff.hunks[0].id), true)
        .unwrap();
    f.proof.stage(&diff.id, Some(&diff.hunks[0].id)).unwrap();
    let staged = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Staged)
        .unwrap();
    assert_eq!(staged.hunks.len(), 1);
    assert_eq!(staged.hunks[0].review_state, "reviewed");
    assert_eq!(f.proof.commit_preview(&f.workspace.id).unwrap().reviewed, 1);
    let unstaged = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert!(unstaged.hunks.iter().all(|h| h.review_state != "reviewed"));
}

#[test]
fn root_commit_diff_includes_nested_files_and_only_selected_commit() {
    let f = Fixture::new();
    let first = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_string();
    let initial = f.proof.commit_diff(&f.workspace.id, &first, 0).unwrap();
    assert!(initial.contains("+line 1"));
    fs::create_dir(f.repo.join("nested")).unwrap();
    fs::write(f.repo.join("nested/file.txt"), "nested content\n").unwrap();
    git(&f.repo, &["add", "--", "nested/file.txt"]);
    git(&f.repo, &["commit", "-m", "Nested change"]);
    let second = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_string();
    let patch = f.proof.commit_diff(&f.workspace.id, &second, 0).unwrap();
    assert!(patch.contains("nested content"));
    assert!(!patch.contains("+line 1\n"));
    assert_eq!(
        f.proof
            .commit_diff(&f.workspace.id, "--all", 0)
            .unwrap_err()
            .code,
        "INVALID_REVISION"
    );
}

#[cfg(unix)]
#[test]
fn spec_race_cannot_retarget_staged_hunk_to_other_identical_block() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    let block = "context one\ncontext two\ncontext three\nold value\ncontext four\ncontext five\ncontext six\n";
    let base = format!("prefix one\nprefix two\n{block}gap one\ngap two\ngap three\ngap four\ngap five\ngap six\ngap seven\ngap eight\n{block}tail one\ntail two\n");
    fs::write(f.repo.join("code.txt"), &base).unwrap();
    git(&f.repo, &["add", "code.txt"]);
    git(&f.repo, &["commit", "-m", "Repeated blocks"]);
    fs::write(
        f.repo.join("code.txt"),
        base.replacen("old value", "chosen value", 1),
    )
    .unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(diff.hunks.len(), 1);
    let injection = f._temp.path().join("external-index.txt");
    fs::write(&injection, base.replacen("old value", "external value", 1)).unwrap();
    let oid = git(&f.repo, &["hash-object", "-w", injection.to_str().unwrap()]);
    let wrapper = f._temp.path().join("git-wrapper");
    let script=format!("#!/bin/sh\nproof_apply=0\nproof_check=0\nfor arg in \"$@\"; do\n  [ \"$arg\" = apply ] && proof_apply=1\n  [ \"$arg\" = --check ] && proof_check=1\ndone\nif [ \"$proof_apply:$proof_check\" = 1:1 ]; then\n  env -u GIT_INDEX_FILE /usr/bin/git -C '{}' update-index --cacheinfo 100644,{},code.txt\nfi\nexec /usr/bin/git \"$@\"\n",f.repo.display(),oid.trim());
    fs::write(&wrapper, script).unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let mut prefs = f.proof.preferences().unwrap();
    prefs.git_path = wrapper.to_str().unwrap().into();
    f.proof.set_preferences(prefs).unwrap();
    let result = f.proof.stage(&diff.id, Some(&diff.hunks[0].id));
    println!("stage result: {:?}", result);
    let actual = git(&f.repo, &["show", ":code.txt"]);
    println!("actual index:\n{actual}");
    assert!(result.unwrap().ok);
    assert_eq!(actual, base.replacen("old value", "chosen value", 1));
}

#[cfg(unix)]
#[test]
fn spec_commit_on_different_branch_reports_mismatch() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.change();
    git(&f.repo, &["add", "code.txt"]);
    git(&f.repo, &["branch", "other"]);
    let old_main = git(&f.repo, &["rev-parse", "main"]);
    let hook = f.repo.join(".git/hooks/pre-commit");
    fs::write(&hook, "#!/bin/sh\ngit symbolic-ref HEAD refs/heads/other\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    let preview = f.proof.commit_preview(&f.workspace.id).unwrap();
    assert_eq!(preview.branch.as_deref(), Some("main"));
    let result = f.proof.commit(&preview.id, "Branch mismatch");
    println!("commit result: {:?}", result);
    println!(
        "actual branch: {}",
        git(&f.repo, &["branch", "--show-current"])
    );
    let result = result.unwrap();
    assert!(!result.ok);
    assert!(result.warning.is_some());
    assert_eq!(git(&f.repo, &["rev-parse", "main"]), old_main);
    assert_ne!(git(&f.repo, &["rev-parse", "other"]), old_main);
}

#[cfg(unix)]
#[test]
fn spec_text_hunk_does_not_stage_unselected_executable_bit() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.change();
    fs::set_permissions(f.repo.join("code.txt"), fs::Permissions::from_mode(0o755)).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert!(diff.can_stage_hunks);
    let result = f.proof.stage(&diff.id, Some(&diff.hunks[0].id)).unwrap();
    println!("mode stage result: {:?}", result);
    let actual = git(&f.repo, &["ls-files", "--stage", "code.txt"]);
    println!("actual entry: {actual}");
    assert!(actual.starts_with("100644 "));
}

#[test]
fn spec_split_index_private_copy_compatibility() {
    let mut f = Fixture::new();
    f.change();
    git(&f.repo, &["add", "code.txt"]);
    git(&f.repo, &["update-index", "--split-index"]);
    let shared = git(&f.repo, &["rev-parse", "--shared-index-path"]);
    assert!(!shared.trim().is_empty());
    let preview = f.proof.commit_preview(&f.workspace.id).unwrap();
    let result = f.proof.commit(&preview.id, "Split index");
    println!("split index path: {shared}, result: {:?}", result);
    assert!(result.unwrap().ok);
}

#[test]
fn spec_unborn_stage_and_private_commit_compatibility() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.name", "Proof Test"]);
    git(&repo, &["config", "user.email", "proof@example.invalid"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    git(&repo, &["config", "core.hooksPath", "/dev/null"]);
    let mut proof = Proof::open(temp.path().join("data")).unwrap();
    let w = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    proof.set_trust(&w.id, true).unwrap();
    fs::write(repo.join("new.txt"), "new content\n").unwrap();
    let diff = proof.file_diff(&w.id, "new.txt", Side::Unstaged).unwrap();
    proof.stage(&diff.id, None).unwrap();
    let preview = proof.commit_preview(&w.id).unwrap();
    let result = proof.commit(&preview.id, "Unborn first commit");
    println!("unborn result: {:?}", result);
    assert!(result.unwrap().ok);
}

#[test]
fn source_strings_cannot_impersonate_git_metadata() {
    let mut f = Fixture::new();
    fs::write(f.repo.join("code.txt"), "const limit = 160000;\n// Subproject commit ordinary source\n// GIT binary patch\nconst other = 120000;\n").unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(diff.kind, proof_core::FileKind::Text);
    assert!(diff.can_stage_hunks);
    f.proof.stage(&diff.id, Some(&diff.hunks[0].id)).unwrap();
    assert!(git(&f.repo, &["show", ":code.txt"]).contains("const limit = 160000;"));
}

#[cfg(unix)]
#[test]
fn type_change_is_a_file_action_and_keeps_the_symlink_target() {
    use std::os::unix::fs::symlink;
    let mut f = Fixture::new();
    fs::remove_file(f.repo.join("code.txt")).unwrap();
    symlink("other.txt", f.repo.join("code.txt")).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(diff.kind, proof_core::FileKind::Symlink);
    assert!(!diff.can_stage_hunks);
    assert!(f.proof.stage(&diff.id, Some(&diff.hunks[0].id)).is_err());
    assert!(git(&f.repo, &["ls-files", "--stage", "code.txt"]).starts_with("100644 "));
    f.proof.stage(&diff.id, None).unwrap();
    assert!(git(&f.repo, &["ls-files", "--stage", "code.txt"]).starts_with("120000 "));
    assert_eq!(git(&f.repo, &["show", ":code.txt"]), "other.txt");
}

#[cfg(unix)]
#[test]
fn renamed_target_branch_returns_actual_commit_with_mismatch_warning() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.change();
    git(&f.repo, &["add", "code.txt"]);
    let hook = f.repo.join(".git/hooks/pre-commit");
    fs::write(&hook, "#!/bin/sh\ngit branch -m renamed\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    let preview = f.proof.commit_preview(&f.workspace.id).unwrap();
    let result = f
        .proof
        .commit(&preview.id, "Commit with renamed branch")
        .unwrap();
    assert!(!result.ok);
    assert!(result.warning.is_some());
    assert_eq!(
        result.actual_head.as_deref(),
        Some(git(&f.repo, &["rev-parse", "HEAD"]).trim())
    );
    assert_eq!(result.actual_branch.as_deref(), Some("renamed"));
}

#[test]
fn stage_and_unstage_preserve_split_index_linked_worktree_semantics() {
    let mut f = Fixture::new();
    let linked = f._temp.path().join("linked");
    git(
        &f.repo,
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    );
    let w = f.proof.open_workspace(linked.to_str().unwrap()).unwrap();
    f.proof.set_trust(&w.id, true).unwrap();
    for (repo, w) in [(f.repo.clone(), f.workspace.clone()), (linked, w)] {
        git(&repo, &["update-index", "--split-index"]);
        fs::write(
            repo.join("code.txt"),
            baseline()
                .replace("line 3\n", "changed 3\n")
                .replace("line 25\n", "changed 25\n"),
        )
        .unwrap();
        let diff = f
            .proof
            .file_diff(&w.id, "code.txt", Side::Unstaged)
            .unwrap();
        assert!(f.proof.stage(&diff.id, Some(&diff.hunks[0].id)).unwrap().ok);
        assert_eq!(
            git(&repo, &["show", ":code.txt"]),
            baseline().replace("line 3\n", "changed 3\n")
        );
        let diff = f.proof.file_diff(&w.id, "code.txt", Side::Staged).unwrap();
        assert!(f.proof.stage(&diff.id, None).unwrap().ok);
        assert_eq!(git(&repo, &["show", ":code.txt"]), baseline());
        assert!(!PathBuf::from(w.git_dir).join("index.lock").exists());
    }
}
