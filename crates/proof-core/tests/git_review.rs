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

#[test]
#[ignore = "Manual latency sample; use --ignored --nocapture on the target machine"]
fn file_open_latency_sample() {
    let mut f = Fixture::new();
    f.change();
    let mut timings = Vec::new();
    for _ in 0..10 {
        let start = std::time::Instant::now();
        f.proof
            .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
            .unwrap();
        timings.push(start.elapsed().as_millis());
    }
    timings.sort();
    eprintln!("file_diff latency ms (sorted): {timings:?}");
    assert!(timings[9] <= 500, "local cold Diff exceeds 500 ms");
}

#[test]
fn batch_stage_selected_files_preserves_unselected_content_and_supports_unstage() {
    let mut f = Fixture::new();
    f.change();
    fs::write(f.repo.join("-中文\nfile.txt"), "selected new\n").unwrap();
    fs::write(f.repo.join("unselected.txt"), "leave me\n").unwrap();
    let before_worktree = fs::read(f.repo.join("code.txt")).unwrap();
    let token = f.proof.changes(&f.workspace.id).unwrap().token;
    let paths = vec!["code.txt".into(), "-中文\nfile.txt".into()];
    let stage = f
        .proof
        .stage_files(&f.workspace.id, &paths, Side::Unstaged, &token)
        .unwrap();
    assert!(stage.result.ok);
    assert_eq!(
        git(&f.repo, &["show", ":-中文\nfile.txt"]),
        "selected new\n"
    );
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), before_worktree);
    assert!(!git(&f.repo, &["diff", "--cached", "--name-only"]).contains("unselected.txt"));
    let unstage = f
        .proof
        .stage_files(&f.workspace.id, &paths, Side::Staged, &stage.token)
        .unwrap();
    assert!(unstage.result.ok);
    assert!(git(&f.repo, &["diff", "--cached"]).is_empty());
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), before_worktree);
}

#[test]
fn batch_stage_is_atomic_and_refuses_stale_or_invalid_selections() {
    let mut f = Fixture::new();
    f.change();
    let token = f.proof.changes(&f.workspace.id).unwrap().token;
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let paths = vec!["code.txt".into(), "missing.txt".into()];
    assert!(f
        .proof
        .stage_files(&f.workspace.id, &paths, Side::Unstaged, &token)
        .is_err());
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    fs::write(f.repo.join("code.txt"), "newer content").unwrap();
    assert_eq!(
        f.proof
            .stage_files(
                &f.workspace.id,
                &["code.txt".into()],
                Side::Unstaged,
                &token
            )
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert!(!f.repo.join(".git/index.lock").exists());
}

#[test]
fn batch_unstage_unborn_and_commit_all_without_review() {
    let mut f = Fixture::new();
    git(&f.repo, &["checkout", "--orphan", "fresh"]);
    let changes = f.proof.changes(&f.workspace.id).unwrap();
    let result = f
        .proof
        .stage_files(
            &f.workspace.id,
            &["code.txt".into()],
            Side::Staged,
            &changes.token,
        )
        .unwrap();
    assert!(result.result.ok);
    assert!(git(&f.repo, &["ls-files"]).is_empty());
    assert!(f.repo.join("code.txt").exists());
    let stage = f
        .proof
        .stage_files(
            &f.workspace.id,
            &["code.txt".into()],
            Side::Unstaged,
            &result.token,
        )
        .unwrap();
    let preview = f
        .proof
        .prepare_commit_checked(&f.workspace.id, false, false, Some(&stage.token))
        .unwrap();
    assert!(
        f.proof
            .commit(&preview.id, "Initial from composer")
            .unwrap()
            .ok
    );
    assert_eq!(git(&f.repo, &["show", "HEAD:code.txt"]), baseline());
}

#[test]
fn amend_root_and_message_only_keep_parentage_and_worktree() {
    let mut f = Fixture::new();
    let root = git(&f.repo, &["rev-parse", "HEAD"]);
    f.change();
    let worktree = fs::read(f.repo.join("code.txt")).unwrap();
    let preview = f
        .proof
        .prepare_commit(&f.workspace.id, true, false)
        .unwrap();
    assert_eq!(preview.message, "Initial");
    assert!(preview.amend);
    assert!(
        f.proof
            .commit(&preview.id, "Renamed initial commit")
            .unwrap()
            .ok
    );
    assert_ne!(git(&f.repo, &["rev-parse", "HEAD"]), root);
    assert_eq!(git(&f.repo, &["show", "-s", "--format=%P", "HEAD"]), "\n");
    assert_eq!(git(&f.repo, &["show", "HEAD:code.txt"]), baseline());
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), worktree);
}

#[test]
fn amend_uses_only_selected_index_and_rejects_new_head() {
    let mut f = Fixture::new();
    fs::write(f.repo.join("one.txt"), "one\n").unwrap();
    git(&f.repo, &["add", "one.txt"]);
    git(&f.repo, &["commit", "-m", "Second"]);
    let parent = git(&f.repo, &["rev-parse", "HEAD^"]);
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    f.proof.stage(&diff.id, Some(&diff.hunks[0].id)).unwrap();
    let preview = f
        .proof
        .prepare_commit(&f.workspace.id, true, false)
        .unwrap();
    assert!(f.proof.commit(&preview.id, "Second, amended").unwrap().ok);
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD^"]), parent);
    assert_eq!(
        git(&f.repo, &["show", "HEAD:code.txt"]),
        baseline().replace("line 3\n", "changed 3\n")
    );
    assert!(git(&f.repo, &["diff"]).contains("changed 25"));
    let preview = f
        .proof
        .prepare_commit(&f.workspace.id, true, false)
        .unwrap();
    git(&f.repo, &["commit", "--allow-empty", "-m", "external"]);
    assert_eq!(
        f.proof
            .commit(&preview.id, "must not amend new head")
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
}

#[test]
fn file_versions_invalidate_only_the_edited_file_even_for_same_size_edits() {
    let f = Fixture::new();
    f.change();
    fs::write(f.repo.join("other.txt"), "first\n").unwrap();
    let a = f.proof.changes(&f.workspace.id).unwrap();
    fs::write(f.repo.join("other.txt"), "later\n").unwrap();
    let b = f.proof.changes(&f.workspace.id).unwrap();
    assert_ne!(a.token, b.token);
    assert_eq!(
        a.file_versions["unstaged:code.txt"],
        b.file_versions["unstaged:code.txt"]
    );
    assert_ne!(
        a.file_versions["unstaged:other.txt"],
        b.file_versions["unstaged:other.txt"]
    );
}

#[test]
fn dropdown_switch_tracks_remote_and_preserves_local_edits_on_failure() {
    let mut f = Fixture::new();
    git(
        &f.repo,
        &[
            "remote",
            "add",
            "origin",
            "https://example.invalid/fixture.git",
        ],
    );
    git(
        &f.repo,
        &["update-ref", "refs/remotes/origin/feature", "HEAD"],
    );
    let token = f.proof.changes(&f.workspace.id).unwrap().token;
    assert!(
        f.proof
            .switch_branch_from(
                &f.workspace.id,
                "feature",
                true,
                &token,
                Some("origin/feature")
            )
            .unwrap()
            .ok
    );
    assert_eq!(
        git(&f.repo, &["config", "branch.feature.remote"]),
        "origin\n"
    );
    f.change();
    let before = fs::read(f.repo.join("code.txt")).unwrap();
    let token = f.proof.changes(&f.workspace.id).unwrap().token;
    assert!(f
        .proof
        .switch_branch(&f.workspace.id, "not-there", false, &token)
        .is_err());
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), before);
    assert!(f
        .proof
        .switch_branch(&f.workspace.id, "@{-1}", false, &token)
        .is_err());
}

#[test]
fn batch_stage_rename_does_not_include_a_recreated_old_file_or_directory() {
    for directory in [false, true] {
        let mut f = Fixture::new();
        git(&f.repo, &["mv", "code.txt", "renamed.txt"]);
        fs::write(
            f.repo.join("renamed.txt"),
            baseline().replace("line 3", "selected change"),
        )
        .unwrap();
        if directory {
            fs::create_dir(f.repo.join("code.txt")).unwrap();
            fs::write(f.repo.join("code.txt/unselected.txt"), "not selected").unwrap();
        } else {
            fs::write(f.repo.join("code.txt"), "not selected").unwrap();
        }
        let changes = f.proof.changes(&f.workspace.id).unwrap();
        let unstaged = changes
            .files
            .iter()
            .find(|file| file.path == "renamed.txt" && file.side == Side::Unstaged)
            .unwrap();
        assert!(unstaged.old_path.is_none());
        let stage = f
            .proof
            .stage_files(
                &f.workspace.id,
                &["renamed.txt".into()],
                Side::Unstaged,
                &changes.token,
            )
            .unwrap();
        assert!(stage.result.ok);
        assert!(!git(&f.repo, &["ls-files"])
            .lines()
            .any(|path| path == "code.txt" || path.starts_with("code.txt/")));
        assert!(git(&f.repo, &["show", ":renamed.txt"]).contains("selected change"));
    }
}

#[test]
fn attributes_and_included_config_invalidate_cached_diff_versions() {
    let mut f = Fixture::new();
    f.change();
    let before = f.proof.changes(&f.workspace.id).unwrap();
    fs::write(f.repo.join(".gitattributes"), "code.txt -diff\n").unwrap();
    let after = f.proof.changes(&f.workspace.id).unwrap();
    assert_ne!(
        before.file_versions["unstaged:code.txt"],
        after.file_versions["unstaged:code.txt"]
    );
    assert_eq!(
        f.proof
            .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
            .unwrap()
            .kind,
        proof_core::FileKind::Binary
    );
    fs::create_dir_all(f.repo.join(".git/info")).unwrap();
    fs::write(f.repo.join(".git/info/attributes"), "code.txt diff\n").unwrap();
    let info = f.proof.changes(&f.workspace.id).unwrap();
    assert_ne!(after.token, info.token);
    assert_ne!(
        after.file_versions["unstaged:code.txt"],
        info.file_versions["unstaged:code.txt"]
    );
    fs::write(
        f.repo.join(".git/diff-config"),
        "[diff]\n  algorithm = patience\n",
    )
    .unwrap();
    git(&f.repo, &["config", "include.path", "diff-config"]);
    let included = f.proof.changes(&f.workspace.id).unwrap();
    fs::write(
        f.repo.join(".git/diff-config"),
        "[diff]\n  algorithm = histogram\n",
    )
    .unwrap();
    assert_ne!(
        included.file_versions["unstaged:code.txt"],
        f.proof.changes(&f.workspace.id).unwrap().file_versions["unstaged:code.txt"]
    );
}

#[cfg(unix)]
#[test]
fn environment_changes_during_capture_reject_diff_and_old_stage() {
    use std::os::unix::fs::PermissionsExt;
    for change in ["config", "attribute"] {
        let mut f = Fixture::new();
        f.change();
        fs::write(
            f.repo.join(".git/proof-diff-config"),
            "[diff]\n algorithm = patience\n",
        )
        .unwrap();
        git(&f.repo, &["config", "include.path", "proof-diff-config"]);
        fs::write(f.repo.join(".git/info/attributes"), "code.txt diff\n").unwrap();
        let before = f
            .proof
            .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
            .unwrap();
        let source = fs::read(f.repo.join("code.txt")).unwrap();
        let index = fs::read(f.repo.join(".git/index")).unwrap();
        let head = git(&f.repo, &["rev-parse", "HEAD"]);
        let wrapper = f._temp.path().join("git-change-diff-environment");
        fs::write(
            &wrapper,
            r#"#!/bin/sh
is_diff=0
previous=
repo=
for arg in "$@"; do
 [ "$arg" = diff ] && is_diff=1
 [ "$previous" = -C ] && repo="$arg"
 previous="$arg"
done
/usr/bin/git "$@"
result=$?
if [ "$is_diff" = 1 ]; then
 if [ '__CASE__' = config ]; then
  printf '[diff]\n algorithm = histogram\n' > "$repo/.git/proof-diff-config"
 else
  printf 'code.txt -diff\n' > "$repo/.git/info/attributes"
 fi
fi
exit "$result"
"#
            .replace("__CASE__", change),
        )
        .unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
        let mut preferences = f.proof.preferences().unwrap();
        preferences.git_path = wrapper.to_str().unwrap().into();
        f.proof.set_preferences(preferences).unwrap();
        assert_eq!(
            f.proof
                .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
                .unwrap_err()
                .code,
            "STALE_CONTENT"
        );
        assert_eq!(
            f.proof.stage(&before.id, None).unwrap_err().code,
            "STALE_CONTENT"
        );
        assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), source);
        assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
        assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]), head);
        assert!(!f.repo.join(".git/index.lock").exists());
    }
}

#[cfg(unix)]
#[test]
fn failed_guard_read_after_apply_does_not_publish_private_index() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let source = fs::read(f.repo.join("code.txt")).unwrap();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let wrapper = f._temp.path().join("git-fail-guard-after-apply");
    fs::write(
        &wrapper,
        r#"#!/bin/sh
command=
check=0
previous=
repo=
for arg in "$@"; do
 case "$arg" in apply|config) command="$arg";; esac
 [ "$arg" = --check ] && check=1
 [ "$previous" = -C ] && repo="$arg"
 previous="$arg"
done
if [ "$command" = config ] && [ -e "$repo/.git/proof-applied" ]; then
 printf 'Fixture config read failed\n' >&2
 exit 128
fi
/usr/bin/git "$@"
result=$?
if [ "$command" = apply ] && [ "$check" = 0 ] && [ "$result" = 0 ]; then
 : > "$repo/.git/proof-applied"
fi
exit "$result"
"#,
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let mut preferences = f.proof.preferences().unwrap();
    preferences.git_path = wrapper.to_str().unwrap().into();
    f.proof.set_preferences(preferences).unwrap();
    let error = f.proof.stage(&diff.id, None).unwrap_err();
    assert!(
        error.detail.contains("Fixture config read failed"),
        "{error:?}"
    );
    assert!(f.repo.join(".git/proof-applied").exists());
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), source);
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert!(!f.repo.join(".git/index.lock").exists());
}

#[test]
fn batch_unstage_rename_rejects_unselected_index_descendant_changes() {
    let mut f = Fixture::new();
    git(&f.repo, &["mv", "code.txt", "renamed.txt"]);
    fs::create_dir(f.repo.join("code.txt")).unwrap();
    fs::write(f.repo.join("code.txt/unselected.txt"), "staged version\n").unwrap();
    git(&f.repo, &["add", "code.txt/unselected.txt"]);
    fs::write(
        f.repo.join("code.txt/unselected.txt"),
        "staged version\nworktree version\n",
    )
    .unwrap();
    let before = git(&f.repo, &["ls-files", "--stage"]);
    let token = f.proof.changes(&f.workspace.id).unwrap().token;
    assert_eq!(
        f.proof
            .stage_files(
                &f.workspace.id,
                &["renamed.txt".into()],
                Side::Staged,
                &token
            )
            .unwrap_err()
            .code,
        "INDEX_SCOPE_CHANGED"
    );
    assert_eq!(git(&f.repo, &["ls-files", "--stage"]), before);
    assert_eq!(
        git(&f.repo, &["show", ":code.txt/unselected.txt"]),
        "staged version\n"
    );
    assert!(fs::read_to_string(f.repo.join("code.txt/unselected.txt"))
        .unwrap()
        .contains("worktree version"));
}

#[test]
fn discarded_hunk_and_restart_undo_preserve_other_hunk_and_index() {
    let mut f = Fixture::new();
    f.change();
    let before = fs::read(f.repo.join("code.txt")).unwrap();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert!(diff.can_discard_hunks);
    let preview = f
        .proof
        .discard_preview(&diff.id, Some(&diff.hunks[0].id))
        .unwrap();
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), before);
    assert!(f.proof.discard(&preview.id).unwrap().result.ok);
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        baseline().replace("line 25\n", "changed 25\n")
    );
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    drop(f.proof);
    let mut reopened = Proof::open(&f.data).unwrap();
    assert_eq!(
        reopened.recovery_points(&f.workspace.id).unwrap()[0].status,
        "applied"
    );
    assert!(reopened.undo_discard(&preview.id).unwrap().result.ok);
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), before);
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
}

#[test]
fn discard_and_undo_reject_later_edits_and_deletions() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let preview = f.proof.discard_preview(&diff.id, None).unwrap();
    fs::write(f.repo.join("code.txt"), "external before discard\n").unwrap();
    assert_eq!(
        f.proof.discard(&preview.id).unwrap_err().code,
        "STALE_CONTENT"
    );
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "external before discard\n"
    );
    f.proof.cancel_discard_preview(&preview.id).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let preview = f.proof.discard_preview(&diff.id, None).unwrap();
    assert!(f.proof.discard(&preview.id).unwrap().result.ok);
    fs::write(f.repo.join("code.txt"), "external after discard\n").unwrap();
    assert_eq!(
        f.proof.undo_discard(&preview.id).unwrap_err().code,
        "STALE_CONTENT"
    );
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "external after discard\n"
    );
    fs::remove_file(f.repo.join("code.txt")).unwrap();
    assert_eq!(
        f.proof.undo_discard(&preview.id).unwrap_err().code,
        "RECOVERY_MISSING_PATH"
    );
    assert!(!f.repo.join("code.txt").exists());
}

#[test]
fn recovery_storage_failure_and_full_quota_leave_source_untouched() {
    let mut f = Fixture::new();
    f.change();
    let before = fs::read(f.repo.join("code.txt")).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let connection = rusqlite::Connection::open(f.data.join("proof.sqlite3")).unwrap();
    connection.execute_batch("CREATE TRIGGER deny_recovery BEFORE INSERT ON recovery_points BEGIN SELECT RAISE(ABORT, 'disk full simulation'); END;").unwrap();
    assert_eq!(
        f.proof.discard_preview(&diff.id, None).unwrap_err().code,
        "STORAGE_ERROR"
    );
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), before);
    connection
        .execute_batch("DROP TRIGGER deny_recovery;")
        .unwrap();
    let preview = f.proof.discard_preview(&diff.id, None).unwrap();
    connection
        .execute(
            "UPDATE recovery_points SET reserved_bytes=?",
            [256 * 1024 * 1024],
        )
        .unwrap();
    assert_eq!(
        f.proof.discard_preview(&diff.id, None).unwrap_err().code,
        "RECOVERY_FULL"
    );
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), before);
    f.proof.cancel_discard_preview(&preview.id).unwrap();
    assert!(f.proof.recovery_points(&f.workspace.id).unwrap().is_empty());
}

#[test]
fn file_discard_targets_index_including_staged_edits() {
    let mut f = Fixture::new();
    let staged = baseline().replace("line 3\n", "staged 3\n");
    fs::write(f.repo.join("code.txt"), &staged).unwrap();
    git(&f.repo, &["add", "code.txt"]);
    let working = staged.replace("line 25\n", "unstaged 25\n");
    fs::write(f.repo.join("code.txt"), &working).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let preview = f.proof.discard_preview(&diff.id, None).unwrap();
    assert!(f.proof.discard(&preview.id).unwrap().result.ok);
    assert_eq!(fs::read_to_string(f.repo.join("code.txt")).unwrap(), staged);
    assert_eq!(git(&f.repo, &["show", ":code.txt"]), staged);
    assert!(f.proof.undo_discard(&preview.id).unwrap().result.ok);
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        working
    );
}

#[test]
fn binary_file_discard_and_undo_roundtrip() {
    let mut f = Fixture::new();
    // 含 NUL 的字节序列，Git 与 Proof 都会判定为二进制。
    let original: Vec<u8> = (0..=255u8).cycle().take(4096).collect();
    let edited: Vec<u8> = (0..=255u8).rev().cycle().take(4096).collect();
    fs::write(f.repo.join("image.png"), &original).unwrap();
    git(&f.repo, &["add", "image.png"]);
    git(&f.repo, &["commit", "-m", "image"]);
    fs::write(f.repo.join("image.png"), &edited).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "image.png", Side::Unstaged)
        .unwrap();
    // 整文件丢弃支持二进制；Hunk 级仍不支持。
    assert!(diff.can_discard);
    assert!(!diff.can_discard_hunks);
    let preview = f.proof.discard_preview(&diff.id, None).unwrap();
    assert!(f.proof.discard(&preview.id).unwrap().result.ok);
    assert_eq!(fs::read(f.repo.join("image.png")).unwrap(), original);
    assert!(f.proof.undo_discard(&preview.id).unwrap().result.ok);
    assert_eq!(fs::read(f.repo.join("image.png")).unwrap(), edited);
}

#[test]
fn tracked_deletion_can_be_recovered_and_undone_without_touching_index() {
    let mut f = Fixture::new();
    fs::remove_file(f.repo.join("code.txt")).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let preview = f.proof.discard_preview(&diff.id, None).unwrap();
    assert!(f.proof.discard(&preview.id).unwrap().result.ok);
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        baseline()
    );
    assert!(f.proof.undo_discard(&preview.id).unwrap().result.ok);
    assert!(!f.repo.join("code.txt").exists());
    assert_eq!(git(&f.repo, &["show", ":code.txt"]), baseline());
}

#[test]
fn discard_handles_crlf_and_no_final_newline() {
    for (ending, autocrlf, final_newline) in [
        ("\r\n", "true", true),
        ("\n", "false", false),
        ("\r\n", "false", false),
    ] {
        let mut f = Fixture::new();
        git(&f.repo, &["config", "core.autocrlf", autocrlf]);
        let base = if final_newline {
            baseline()
        } else {
            baseline().trim_end_matches('\n').to_string()
        }
        .replace('\n', ending);
        fs::write(f.repo.join("code.txt"), &base).unwrap();
        git(&f.repo, &["add", "code.txt"]);
        let changed = base
            .replace(&format!("line 3{ending}"), &format!("changed 3{ending}"))
            .replace("line 35", "changed 35");
        fs::write(f.repo.join("code.txt"), &changed).unwrap();
        let diff = f
            .proof
            .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
            .unwrap();
        let preview = f
            .proof
            .discard_preview(&diff.id, Some(&diff.hunks.last().unwrap().id))
            .unwrap();
        assert!(f.proof.discard(&preview.id).unwrap().result.ok);
        assert_eq!(
            fs::read_to_string(f.repo.join("code.txt")).unwrap(),
            base.replace(&format!("line 3{ending}"), &format!("changed 3{ending}"))
        );
        assert!(f.proof.undo_discard(&preview.id).unwrap().result.ok);
        assert_eq!(
            fs::read_to_string(f.repo.join("code.txt")).unwrap(),
            changed
        );
    }
}

#[test]
fn discard_refuses_tracked_and_untracked_hardlinks_and_unknown_database_versions() {
    let mut f = Fixture::new();
    f.change();
    fs::hard_link(f.repo.join("code.txt"), f.repo.join("other-link")).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(
        f.proof.discard_preview(&diff.id, None).unwrap_err().code,
        "UNSUPPORTED_RECOVERY_FILE"
    );
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "other-link", Side::Unstaged)
        .unwrap();
    assert_eq!(
        f.proof.discard_preview(&diff.id, None).unwrap_err().code,
        "UNSUPPORTED_RECOVERY_FILE"
    );
    drop(f.proof);
    rusqlite::Connection::open(f.data.join("proof.sqlite3"))
        .unwrap()
        .execute_batch("PRAGMA user_version=99")
        .unwrap();
    assert!(matches!(Proof::open(&f.data), Err(error) if error.code == "DATABASE_VERSION"));
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
fn reviewed_unstage_can_leave_no_remaining_worktree_diff() {
    let mut f = Fixture::new();
    f.change();
    git(&f.repo, &["add", "--", "code.txt"]);
    fs::write(f.repo.join("code.txt"), baseline()).unwrap();
    let staged = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Staged)
        .unwrap();
    f.proof.mark_reviewed(&staged.id, None, true).unwrap();
    let result = f.proof.stage(&staged.id, None).unwrap();
    assert!(result.ok && result.warning.is_none(), "{result:?}");
    assert!(f.proof.changes(&f.workspace.id).unwrap().files.is_empty());
    assert_eq!(git(&f.repo, &["show", ":code.txt"]), baseline());
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        baseline()
    );
}

#[cfg(unix)]
#[test]
fn diff_base_matches_the_validated_content_after_a_branch_switch_during_status() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    let other = git(
        &f.repo,
        &[
            "commit-tree",
            "HEAD^{tree}",
            "-p",
            "HEAD",
            "-m",
            "Other base",
        ],
    )
    .trim()
    .to_string();
    git(&f.repo, &["update-ref", "refs/heads/other", &other]);
    f.change();
    let source = fs::read(f.repo.join("code.txt")).unwrap();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let wrapper = f._temp.path().join("git-switch-after-status");
    fs::write(
        &wrapper,
        r#"#!/bin/sh
is_status=0
previous=
repo=
for arg in "$@"; do
 [ "$arg" = status ] && is_status=1
 [ "$previous" = -C ] && repo="$arg"
 previous="$arg"
done
/usr/bin/git "$@"
result=$?
if [ "$is_status" = 1 ] && [ ! -e "$repo/.git/proof-switched" ]; then
 : > "$repo/.git/proof-switched"
 /usr/bin/git -C "$repo" symbolic-ref HEAD refs/heads/other || exit 1
fi
exit "$result"
"#,
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let mut preferences = f.proof.preferences().unwrap();
    preferences.git_path = wrapper.to_str().unwrap().into();
    f.proof.set_preferences(preferences).unwrap();

    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(diff.base, format!("{other}:other"));
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), source);
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    f.proof.mark_reviewed(&diff.id, None, true).unwrap();
    let result = f.proof.stage(&diff.id, None).unwrap();
    assert!(result.ok && result.warning.is_none(), "{result:?}");
    assert_eq!(result.actual_head.as_deref(), Some(other.as_str()));
    assert_eq!(result.actual_branch.as_deref(), Some("other"));
}

#[cfg(unix)]
#[test]
fn staging_without_review_does_not_depend_on_reading_a_review_migration_target() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.change();
    let wrapper = f._temp.path().join("git-without-target-reader");
    fs::write(&wrapper, "#!/bin/sh\nis_diff=0\nis_cached=0\nfor arg in \"$@\"; do\n [ \"$arg\" = diff ] && is_diff=1\n [ \"$arg\" = --cached ] && is_cached=1\ndone\nif [ \"$is_diff:$is_cached\" = 1:1 ]; then\n echo 'Review migration target reader unavailable' >&2\n exit 1\nfi\nexec /usr/bin/git \"$@\"\n").unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let mut preferences = f.proof.preferences().unwrap();
    preferences.git_path = wrapper.to_str().unwrap().into();
    f.proof.set_preferences(preferences).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let result = f.proof.stage(&diff.id, Some(&diff.hunks[0].id)).unwrap();
    assert!(result.ok);
    assert!(
        result.warning.is_none(),
        "Unreviewed Stage should not read a migration target: {:?}",
        result.warning
    );
    let staged = git(&f.repo, &["show", ":code.txt"]);
    assert!(staged.contains("changed 3") && !staged.contains("changed 25"));
    assert!(fs::read_to_string(f.repo.join("code.txt"))
        .unwrap()
        .contains("changed 25"));
    let remaining = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    f.proof.mark_reviewed(&remaining.id, None, true).unwrap();
    let captured = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert!(captured.hunks.iter().all(|h| h.review_state == "reviewed"));
    f.proof.mark_reviewed(&captured.id, None, false).unwrap();
    let after_revoke = f.proof.stage(&captured.id, None).unwrap();
    assert!(after_revoke.ok && after_revoke.warning.is_none());

    git(&f.repo, &["reset", "--quiet", "HEAD", "--", "code.txt"]);
    let reviewed = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    f.proof.mark_reviewed(&reviewed.id, None, true).unwrap();
    let with_review = f.proof.stage(&reviewed.id, None).unwrap();
    assert!(with_review.ok);
    assert!(with_review
        .warning
        .as_deref()
        .is_some_and(|warning| warning.contains("GIT_FAILED")));
    assert_eq!(
        git(&f.repo, &["show", ":code.txt"]),
        fs::read_to_string(f.repo.join("code.txt")).unwrap()
    );
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

#[test]
fn standards_undoing_record_remains_recoverable_after_restart() {
    let mut f = Fixture::new();
    f.change();
    let before = fs::read(f.repo.join("code.txt")).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    assert!(f.proof.discard(&point.id).unwrap().result.ok);
    // The exact durable state immediately after perform_recovery saves
    // "undoing", before any filesystem move starts.
    let connection = rusqlite::Connection::open(f.data.join("proof.sqlite3")).unwrap();
    let (payload, point_json): (String, String) = connection
        .query_row(
            "SELECT payload,point FROM recovery_points WHERE id=?",
            [&point.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let mut payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    let mut point_json: serde_json::Value = serde_json::from_str(&point_json).unwrap();
    payload["point"]["status"] = "undoing".into();
    point_json["status"] = "undoing".into();
    connection
        .execute(
            "UPDATE recovery_points SET payload=?,point=? WHERE id=?",
            rusqlite::params![payload.to_string(), point_json.to_string(), point.id],
        )
        .unwrap();
    drop(connection);
    drop(f.proof);
    let mut reopened = Proof::open(&f.data).unwrap();
    let action = reopened.undo_discard(&point.id);
    assert!(
        action.is_ok(),
        "persisted undoing state is stranded: {action:?}"
    );
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), before);
}

#[test]
fn standards_recovery_quota_is_atomic_across_workspaces() {
    let mut f = Fixture::new();
    let other = f._temp.path().join("other-repository");
    git(
        &f.repo,
        &[
            "clone",
            "--no-hardlinks",
            f.repo.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    let w2 = f.proof.open_workspace(other.to_str().unwrap()).unwrap();
    f.proof.set_trust(&w2.id, true).unwrap();
    f.change();
    fs::write(
        other.join("code.txt"),
        baseline().replace("line 3\n", "other change\n"),
    )
    .unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    const CAPACITY: u64 = 256 * 1024 * 1024;
    let connection = rusqlite::Connection::open(f.data.join("proof.sqlite3")).unwrap();
    connection
        .execute(
            "UPDATE recovery_points SET reserved_bytes=? WHERE id=?",
            rusqlite::params![CAPACITY - 12000, point.id],
        )
        .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = [f.workspace.id.clone(), w2.id]
        .into_iter()
        .map(|id| {
            let data = f.data.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut proof = Proof::open(data).unwrap();
                let diff = proof.file_diff(&id, "code.txt", Side::Unstaged).unwrap();
                barrier.wait();
                proof.discard_preview(&diff.id, None)
            })
        })
        .collect();
    let outcomes: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let reserved: u64 = connection
        .query_row("SELECT SUM(reserved_bytes) FROM recovery_points", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(
        reserved <= CAPACITY,
        "quota exceeded by {} bytes; outcomes: {outcomes:?}",
        reserved - CAPACITY
    );
}

#[cfg(unix)]
#[test]
fn standards_growing_captured_inode_does_not_hide_durable_recovery_bytes() {
    let mut f = Fixture::new();
    f.change();
    let writer = fs::OpenOptions::new()
        .write(true)
        .open(f.repo.join("code.txt"))
        .unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    assert!(f.proof.discard(&point.id).unwrap().result.ok);
    // An editor that kept the original FD now grows the captured inode.
    writer.set_len(33 * 1024 * 1024).unwrap();
    let content = f.proof.recovery_content(&point.id);
    assert!(
        content.is_ok(),
        "immutable before/after bytes are hidden by a changed captured inode: {content:?}"
    );
    let content = content.unwrap();
    assert!(content["capturedWarning"].is_string());
    assert!(content["before"].as_str().unwrap().contains("changed 3"));
    writer.set_len(257 * 1024 * 1024).unwrap();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(
        f.proof.discard_preview(&diff.id, None).unwrap_err().code,
        "RECOVERY_FULL"
    );
}

fn set_recovery_state(data: &std::path::Path, id: &str, state: &str) {
    let connection = rusqlite::Connection::open(data.join("proof.sqlite3")).unwrap();
    let payload: String = connection
        .query_row(
            "SELECT payload FROM recovery_points WHERE id=?",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&payload).unwrap();
    value["point"]["status"] = state.into();
    connection
        .execute(
            "UPDATE recovery_points SET point=?,payload=? WHERE id=?",
            rusqlite::params![value["point"].to_string(), value.to_string(), id],
        )
        .unwrap();
}

#[test]
fn recovery_resumes_each_durable_filesystem_boundary_after_restart() {
    for boundary in [
        "before-capture",
        "after-capture",
        "after-install",
        "undo-before-capture",
        "undo-after-capture",
        "undo-after-install",
        "failed-capture",
    ] {
        let mut f = Fixture::new();
        f.change();
        let before = fs::read(f.repo.join("code.txt")).unwrap();
        let diff = f
            .proof
            .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
            .unwrap();
        let point = f.proof.discard_preview(&diff.id, None).unwrap();
        let directory = f.data.join("recovery").join(&point.id);
        match boundary {
            "before-capture" => set_recovery_state(&f.data, &point.id, "applying"),
            "after-capture" | "failed-capture" => {
                fs::rename(f.repo.join("code.txt"), directory.join("original")).unwrap();
                set_recovery_state(
                    &f.data,
                    &point.id,
                    if boundary == "failed-capture" {
                        "conflict"
                    } else {
                        "applying"
                    },
                );
            }
            _ => {
                assert!(f.proof.discard(&point.id).unwrap().result.ok);
                if boundary == "undo-after-capture" {
                    fs::rename(f.repo.join("code.txt"), directory.join("discarded-version"))
                        .unwrap();
                }
                if boundary == "undo-after-install" {
                    assert!(f.proof.undo_discard(&point.id).unwrap().result.ok);
                }
                set_recovery_state(
                    &f.data,
                    &point.id,
                    if boundary == "after-install" {
                        "applying"
                    } else {
                        "undoing"
                    },
                );
            }
        }
        drop(f.proof);
        let mut reopened = Proof::open(&f.data).unwrap();
        let mut result = reopened.undo_discard(&point.id);
        if ["after-capture", "undo-after-capture", "failed-capture"].contains(&boundary) {
            assert_eq!(result.unwrap_err().code, "RECOVERY_MISSING_PATH");
            assert!(!f.repo.join("code.txt").exists());
            result = reopened.restore_missing_recovery(&point.id);
        }
        assert!(
            result.as_ref().is_ok_and(|r| r.result.ok),
            "boundary {boundary}: {result:?}"
        );
        assert_eq!(
            fs::read(f.repo.join("code.txt")).unwrap(),
            before,
            "boundary {boundary}"
        );
        assert_eq!(git(&f.repo, &["show", ":code.txt"]), baseline());
    }
}

#[test]
fn expired_recovery_releases_saved_bytes_and_never_changes_source() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    assert!(f.proof.discard(&point.id).unwrap().result.ok);
    let connection = rusqlite::Connection::open(f.data.join("proof.sqlite3")).unwrap();
    connection
        .execute(
            "UPDATE recovery_points SET expires_at=0 WHERE id=?",
            [&point.id],
        )
        .unwrap();
    assert!(f.proof.recovery_content(&point.id).is_err());
    assert!(f.proof.recovery_points(&f.workspace.id).unwrap().is_empty());
    assert!(!f.data.join("recovery").join(point.id).exists());
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        baseline()
    );
}

#[test]
fn file_discard_uses_smudge_filter_but_inexact_hunk_transform_is_rejected() {
    let mut f = Fixture::new();
    fs::write(f.repo.join(".gitattributes"), "code.txt filter=wrapped\n").unwrap();
    git(
        &f.repo,
        &["config", "filter.wrapped.clean", "sed 's/^WORK://'"],
    );
    git(
        &f.repo,
        &["config", "filter.wrapped.smudge", "sed 's/^/WORK:/'"],
    );
    let working = baseline()
        .replace("line 3\n", "changed 3\n")
        .lines()
        .map(|l| format!("WORK:{l}\n"))
        .collect::<String>();
    fs::write(f.repo.join("code.txt"), &working).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert!(f
        .proof
        .discard_preview(&diff.id, Some(&diff.hunks[0].id))
        .is_err());
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        working
    );
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    assert!(f.proof.discard(&point.id).unwrap().result.ok);
    let expected = baseline()
        .lines()
        .map(|l| format!("WORK:{l}\n"))
        .collect::<String>();
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        expected
    );
    assert!(f.proof.undo_discard(&point.id).unwrap().result.ok);
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        working
    );
}

#[cfg(unix)]
#[test]
fn external_deletion_after_discard_requires_separate_recreate_consent() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.change();
    let before = fs::read(f.repo.join("code.txt")).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    let original = f.data.join("recovery").join(&point.id).join("original");
    let marker = f._temp.path().join("removed-after-install");
    let wrapper = f._temp.path().join("git-wrapper");
    let script=format!("#!/bin/sh\nif [ -e '{}' ] && [ ! -e '{}' ]; then\n  /bin/rm '{}'\n  /usr/bin/touch '{}'\nfi\nexec /usr/bin/git \"$@\"\n",original.display(),marker.display(),f.repo.join("code.txt").display(),marker.display());
    fs::write(&wrapper, script).unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let mut prefs = f.proof.preferences().unwrap();
    prefs.git_path = wrapper.to_str().unwrap().into();
    f.proof.set_preferences(prefs).unwrap();
    let result = f.proof.discard(&point.id).unwrap();
    println!("discard after external deletion: {:?}", result);
    assert_eq!(result.point.status, "conflict");
    assert!(!result.result.ok);
    assert!(marker.exists());
    assert!(!f.repo.join("code.txt").exists());
    let result = f.proof.undo_discard(&point.id);
    println!("undo after external deletion: {:?}", result);
    assert_eq!(result.unwrap_err().code, "RECOVERY_MISSING_PATH");
    assert!(!f.repo.join("code.txt").exists());
    assert!(
        f.proof
            .restore_missing_recovery(&point.id)
            .unwrap()
            .result
            .ok
    );
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), before);
}

#[test]
fn blame_separates_uncommitted_lines_and_selected_commit() {
    let f = Fixture::new();
    let oid = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_string();
    f.change();
    let current = f
        .proof
        .file_blame(&f.workspace.id, "code.txt", None, 0)
        .unwrap();
    assert_eq!(current.total_lines, 35);
    assert_eq!(current.lines.iter().filter(|l| l.uncommitted).count(), 2);
    assert!(current.lines[2].author.is_none());
    assert!(current.lines[2].oid.is_none());
    assert_eq!(current.lines[2].summary, "未提交变化");
    assert_eq!(current.lines[0].oid.as_deref(), Some(oid.as_str()));
    let historical = f
        .proof
        .file_blame(&f.workspace.id, "code.txt", Some(&oid), 0)
        .unwrap();
    assert_eq!(historical.revision.as_deref(), Some(oid.as_str()));
    assert!(historical.lines.iter().all(|l| !l.uncommitted));
    assert_eq!(historical.lines[2].content, "line 3");
    assert_eq!(historical.lines[2].author.as_deref(), Some("Proof Test"));
    assert!(f
        .proof
        .file_blame(&f.workspace.id, "code.txt", Some("--help"), 0)
        .is_err());
}

#[test]
fn blame_paginates_and_untracked_files_have_no_fabricated_author() {
    let f = Fixture::new();
    let text: String = (1..=923).map(|n| format!("new {n}\n")).collect();
    fs::write(f.repo.join("new.txt"), &text).unwrap();
    for (offset, count, more) in [(0, 400, true), (400, 400, true), (800, 123, false)] {
        let page = f
            .proof
            .file_blame(&f.workspace.id, "new.txt", None, offset)
            .unwrap();
        assert_eq!(page.lines.len(), count);
        assert_eq!(page.has_more, more);
        assert!(page
            .lines
            .iter()
            .all(|l| l.uncommitted && l.author.is_none()));
        assert_eq!(page.lines[0].line, offset as u32 + 1);
    }
    git(&f.repo, &["add", "new.txt"]);
    let staged = f
        .proof
        .file_blame(&f.workspace.id, "new.txt", None, 400)
        .unwrap();
    assert!(staged.lines.iter().all(|l| l.uncommitted));
    git(&f.repo, &["commit", "-m", "Add many lines"]);
    let page = f
        .proof
        .file_blame(&f.workspace.id, "new.txt", None, 800)
        .unwrap();
    assert_eq!(page.lines[0].line, 801);
    assert!(!page.lines[0].uncommitted);
    assert_eq!(page.lines.last().unwrap().content, "new 923");
}

#[test]
fn file_history_follows_rename_and_blame_preserves_literal_origin_path() {
    let f = Fixture::new();
    let old_path = "-旧 文件\nname.txt";
    fs::write(f.repo.join(old_path), "原来的第一行\nsecond line\n").unwrap();
    git(&f.repo, &["add", "--", old_path]);
    git(&f.repo, &["commit", "-m", "Original filename"]);
    let old_oid = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_string();
    git(&f.repo, &["mv", "--", old_path, "new-name.txt"]);
    git(&f.repo, &["commit", "-m", "Rename"]);
    let history = f
        .proof
        .history(&f.workspace.id, 0, Some("new-name.txt"))
        .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[1].oid, old_oid);
    let current = f
        .proof
        .file_blame(&f.workspace.id, "new-name.txt", None, 0)
        .unwrap();
    assert_eq!(current.lines[0].origin_path, old_path);
    assert_eq!(current.lines[0].oid.as_deref(), Some(old_oid.as_str()));
    assert!(f
        .proof
        .file_blame(&f.workspace.id, "new-name.txt", Some(&old_oid), 0)
        .is_err());
    let original = f
        .proof
        .file_blame(&f.workspace.id, old_path, Some(&old_oid), 0)
        .unwrap();
    assert_eq!(original.lines[0].content, "原来的第一行");
}

#[cfg(target_os = "macos")]
#[test]
fn discard_and_interrupted_restore_preserve_extended_attributes() {
    let mut f = Fixture::new();
    f.change();
    let source = f.repo.join("code.txt");
    let attribute = "com.proof.test";
    let set = Command::new("/usr/bin/xattr")
        .args(["-w", attribute, "retained-metadata"])
        .arg(&source)
        .output()
        .unwrap();
    assert!(set.status.success());
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    assert!(f.proof.discard(&point.id).unwrap().result.ok);
    let read_attribute = || {
        let output = Command::new("/usr/bin/xattr")
            .args(["-p", attribute])
            .arg(&source)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            "retained-metadata"
        );
    };
    read_attribute();
    fs::rename(
        &source,
        f.data
            .join("recovery")
            .join(&point.id)
            .join("discarded-version"),
    )
    .unwrap();
    set_recovery_state(&f.data, &point.id, "undoing");
    assert_eq!(
        f.proof.undo_discard(&point.id).unwrap_err().code,
        "RECOVERY_MISSING_PATH"
    );
    assert!(
        f.proof
            .restore_missing_recovery(&point.id)
            .unwrap()
            .result
            .ok
    );
    read_attribute();
}

#[test]
fn review_cancel_can_retry_after_metadata_delete_fails() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    let connection = rusqlite::Connection::open(f.data.join("proof.sqlite3")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_delete BEFORE DELETE ON recovery_points BEGIN SELECT RAISE(ABORT, 'injected storage error'); END;").unwrap();
    assert!(f.proof.cancel_discard_preview(&point.id).is_err());
    connection
        .execute_batch("DROP TRIGGER fail_delete;")
        .unwrap();
    let retry = f.proof.cancel_discard_preview(&point.id);
    assert!(
        retry.is_ok(),
        "retry cannot release a prepared point after transient metadata failure: {retry:?}"
    );
    assert!(f.proof.recovery_points(&f.workspace.id).unwrap().is_empty());
}

#[test]
fn blame_does_not_present_clean_filter_output_as_worktree_text() {
    let f = Fixture::new();
    fs::write(f.repo.join(".gitattributes"), "code.txt filter=upper\n").unwrap();
    git(&f.repo, &["config", "filter.upper.clean", "tr a-z A-Z"]);
    fs::write(f.repo.join("code.txt"), "lower case\n").unwrap();
    assert_eq!(
        f.proof
            .file_blame(&f.workspace.id, "code.txt", None, 0)
            .unwrap_err()
            .code,
        "BLAME_TRANSFORM"
    );
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "lower case\n"
    );
    let oid = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_string();
    let committed = f
        .proof
        .file_blame(&f.workspace.id, "code.txt", Some(&oid), 0)
        .unwrap();
    assert_eq!(committed.lines[0].content, "line 1");
}

#[test]
fn replaced_git_directory_invalidates_workspace_authority() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    fs::rename(f.repo.join(".git"), f.repo.join(".git-previous")).unwrap();
    git(&f.repo, &["init", "-b", "main"]);
    assert_eq!(
        f.proof.changes(&f.workspace.id).unwrap_err().code,
        "WORKSPACE_REPLACED"
    );
    assert_eq!(
        f.proof.discard(&point.id).unwrap_err().code,
        "WORKSPACE_REPLACED"
    );
    assert_eq!(
        f.proof.stage(&diff.id, None).unwrap_err().code,
        "WORKSPACE_REPLACED"
    );
    let reopened = f.proof.open_workspace(f.repo.to_str().unwrap()).unwrap();
    assert_ne!(f.workspace.id, reopened.id);
    assert!(!reopened.trusted);
    assert!(fs::read_to_string(f.repo.join("code.txt"))
        .unwrap()
        .contains("changed 3"));
}

#[test]
fn final_review_existing_recovery_context_remains_usable() {
    use sha2::{Digest, Sha256};
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    assert!(f.proof.discard(&point.id).unwrap().result.ok);
    // Persist exactly the context fingerprint produced by the preceding v2
    // build: workspace UUID, HEAD, branch and index. No repository data changes.
    let head = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_string();
    let branch = git(&f.repo, &["branch", "--show-current"])
        .trim()
        .to_string();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let mut digest = Sha256::new();
    for bytes in [
        f.workspace.id.as_bytes(),
        head.as_bytes(),
        branch.as_bytes(),
        &index,
    ] {
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    let legacy_context = format!("{:x}", digest.finalize());
    let connection = rusqlite::Connection::open(f.data.join("proof.sqlite3")).unwrap();
    let payload: String = connection
        .query_row(
            "SELECT payload FROM recovery_points WHERE id=?",
            [&point.id],
            |r| r.get(0),
        )
        .unwrap();
    let mut payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    payload["context"] = legacy_context.into();
    payload.as_object_mut().unwrap().remove("schema_version");
    connection
        .execute(
            "UPDATE recovery_points SET payload=? WHERE id=?",
            rusqlite::params![payload.to_string(), point.id],
        )
        .unwrap();
    drop(connection);
    drop(f.proof);
    let mut proof = Proof::open(&f.data).unwrap();
    let action = proof.undo_discard(&point.id);
    assert!(
        action.as_ref().is_ok_and(|a| a.result.ok),
        "unchanged v2 recovery point becomes unusable: {action:?}"
    );
}

#[test]
fn final_review_reopen_linked_worktree_after_common_directory_replacement() {
    let mut f = Fixture::new();
    let linked = f._temp.path().join("linked");
    git(
        &f.repo,
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    );
    let before = f.proof.open_workspace(linked.to_str().unwrap()).unwrap();
    f.proof.set_trust(&before.id, true).unwrap();
    // Replace only the common git directory inode while preserving the linked
    // worktree's own git directory inode and all Git data.
    let previous = f.repo.join(".git.previous");
    fs::rename(f.repo.join(".git"), &previous).unwrap();
    fs::create_dir(f.repo.join(".git")).unwrap();
    for entry in fs::read_dir(previous).unwrap() {
        let entry = entry.unwrap();
        fs::rename(entry.path(), f.repo.join(".git").join(entry.file_name())).unwrap();
    }
    assert_eq!(
        f.proof.changes(&before.id).unwrap_err().code,
        "WORKSPACE_REPLACED"
    );
    let reopened = f.proof.open_workspace(linked.to_str().unwrap()).unwrap();
    let current = f.proof.changes(&reopened.id);
    assert!(!reopened.trusted && current.is_ok(), "reopen does not reset authority or resolve the identity mismatch: workspace={reopened:?}, changes={current:?}");
}

#[test]
fn legacy_prepared_recovery_migrates_only_when_original_base_matches() {
    use sha2::{Digest, Sha256};
    for change_base in [false, true] {
        let mut f = Fixture::new();
        f.change();
        let diff = f
            .proof
            .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
            .unwrap();
        let point = f.proof.discard_preview(&diff.id, None).unwrap();
        let hash = |parts: &[&[u8]]| {
            let mut digest = Sha256::new();
            for bytes in parts {
                digest.update((bytes.len() as u64).to_le_bytes());
                digest.update(bytes);
            }
            format!("{:x}", digest.finalize())
        };
        let head = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_string();
        let index = fs::read(f.repo.join(".git/index")).unwrap();
        let before = fs::read(f.repo.join("code.txt")).unwrap();
        let mut worktree = format!(
            "{:?}:",
            fs::metadata(f.repo.join("code.txt")).unwrap().permissions()
        )
        .into_bytes();
        worktree.extend_from_slice(&before);
        let context = hash(&[f.workspace.id.as_bytes(), head.as_bytes(), b"main", &index]);
        let guard = hash(&[
            f.workspace.id.as_bytes(),
            head.as_bytes(),
            b"main",
            &index,
            &worktree,
            &[],
        ]);
        let db = rusqlite::Connection::open(f.data.join("proof.sqlite3")).unwrap();
        let payload: String = db
            .query_row(
                "SELECT payload FROM recovery_points WHERE id=?",
                [&point.id],
                |r| r.get(0),
            )
            .unwrap();
        let mut payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        payload.as_object_mut().unwrap().remove("schema_version");
        payload["context"] = context.into();
        payload["guard"] = guard.into();
        db.execute(
            "UPDATE recovery_points SET payload=? WHERE id=?",
            rusqlite::params![payload.to_string(), point.id],
        )
        .unwrap();
        if change_base {
            git(&f.repo, &["add", "code.txt"]);
        }
        let result = f.proof.discard(&point.id);
        if change_base {
            assert_eq!(result.unwrap_err().code, "STALE_CONTENT");
            assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), before);
        } else {
            assert!(result.unwrap().result.ok);
            assert_eq!(
                fs::read_to_string(f.repo.join("code.txt")).unwrap(),
                baseline()
            );
        }
    }
}
