use proof_core::{DiffRead, Proof, Side};
use std::{fs, path::Path, process::Command};

fn git(repo: &Path, args: &[&str]) -> Vec<u8> {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn fixture(before: &str, after: &str) -> (tempfile::TempDir, Proof, proof_core::Workspace) {
    let directory = tempfile::tempdir().unwrap();
    let repo = directory.path().join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    for (key, value) in [
        ("user.name", "Proof Read Test"),
        ("user.email", "read@example.invalid"),
        ("core.hooksPath", "/dev/null"),
        ("commit.gpgsign", "false"),
    ] {
        git(&repo, &["config", key, value]);
    }
    fs::write(repo.join("large.txt"), before).unwrap();
    git(&repo, &["add", "large.txt"]);
    git(&repo, &["commit", "-m", "Base"]);
    fs::write(repo.join("large.txt"), after).unwrap();
    let mut proof = Proof::open(directory.path().join("data")).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    proof.set_trust(&workspace.id, true).unwrap();
    (directory, proof, workspace)
}

#[test]
fn large_diff_waits_for_loading_and_never_creates_review_from_a_summary() {
    let before = format!("old {}\n", "x".repeat(1_300_000));
    let after = format!("new {}\n", "x".repeat(1_300_000));
    let (_directory, mut proof, workspace) = fixture(&before, &after);
    let repo = Path::new(&workspace.path);
    let index = fs::read(repo.join(".git/index")).unwrap();
    let read = proof
        .read_file_diff(&workspace.id, "large.txt", Side::Unstaged, false)
        .unwrap();
    let DiffRead::Deferred { summary } = &read else {
        panic!("Expected deferred preview")
    };
    assert!(summary.can_load);
    assert_eq!(summary.reason, "patch_size");
    assert!(summary.patch_bytes.is_none());
    let wire = serde_json::to_value(&read).unwrap();
    assert!(wire.get("diff").is_none());
    assert!(wire["summary"].get("id").is_none());
    assert!(wire["summary"].get("patch").is_none());
    let DiffRead::Ready { diff } = proof
        .read_file_diff(&workspace.id, "large.txt", Side::Unstaged, true)
        .unwrap()
    else {
        panic!("Expected explicit loaded Diff")
    };
    assert!(!diff.hunks.is_empty());
    assert!(diff
        .hunks
        .iter()
        .all(|hunk| hunk.review_state == "unreviewed"));
    assert!(fs::read(repo.join(".git/index")).unwrap() == index);
    assert!(fs::read(repo.join("large.txt")).unwrap() == after.as_bytes());
    assert!(proof.stage(&diff.id, None).unwrap().ok);
    assert!(git(repo, &["show", ":large.txt"]) == after.as_bytes());
}

#[test]
fn a_small_patch_in_a_large_file_still_opens_directly() {
    let before = (0..16_000)
        .map(|n| format!("item {n:05} {}\n", "x".repeat(75)))
        .collect::<String>();
    let after = before.replacen("item 00050", "edit 00050", 1);
    let (_directory, mut proof, workspace) = fixture(&before, &after);
    let read = proof
        .read_file_diff(&workspace.id, "large.txt", Side::Unstaged, false)
        .unwrap();
    assert!(matches!(read, DiffRead::Ready { .. }));
}

#[test]
fn history_uses_the_same_loading_gate_without_registering_write_snapshots() {
    let before = format!("old {}\n", "x".repeat(1_300_000));
    let after = format!("new {}\n", "x".repeat(1_300_000));
    let (_directory, mut proof, workspace) = fixture(&before, &after);
    let repo = Path::new(&workspace.path);
    let base = String::from_utf8(git(repo, &["rev-parse", "HEAD"])).unwrap();
    git(repo, &["add", "large.txt"]);
    git(repo, &["commit", "-m", "Large change"]);
    let target = String::from_utf8(git(repo, &["rev-parse", "HEAD"])).unwrap();
    assert!(matches!(
        proof
            .read_compare_file(
                &workspace.id,
                base.trim(),
                target.trim(),
                "large.txt",
                false
            )
            .unwrap(),
        DiffRead::Deferred { .. }
    ));
    let DiffRead::Ready { diff } = proof
        .read_compare_file(&workspace.id, base.trim(), target.trim(), "large.txt", true)
        .unwrap()
    else {
        panic!("Expected loaded history")
    };
    assert!(!diff.can_stage && !diff.can_discard);
    assert_eq!(
        proof.stage(&diff.id, None).unwrap_err().code,
        "SNAPSHOT_EXPIRED"
    );
}

#[test]
fn explicit_load_keeps_the_line_limit_instead_of_building_unbounded_rows() {
    let (_directory, mut proof, workspace) =
        fixture(&"old\n".repeat(51_000), &"new\n".repeat(51_000));
    let DiffRead::Deferred { summary } = proof
        .read_file_diff(&workspace.id, "large.txt", Side::Unstaged, true)
        .unwrap()
    else {
        panic!("Expected bounded summary")
    };
    assert!(!summary.can_load);
    assert_eq!(summary.reason, "read_limit");
}

#[test]
fn unread_coverage_preserves_normal_commit_and_blocks_strict_review() {
    let after = "new\n".repeat(51_000);
    let (_directory, mut proof, workspace) = fixture(&"old\n".repeat(51_000), &after);
    let repo = Path::new(&workspace.path);
    let token = proof.changes(&workspace.id).unwrap().token;
    proof
        .stage_files(&workspace.id, &["large.txt".into()], Side::Unstaged, &token)
        .unwrap();
    let index = fs::read(repo.join(".git/index")).unwrap();
    let head = git(repo, &["rev-parse", "HEAD"]);
    let preview = proof.commit_preview(&workspace.id).unwrap();
    assert!(preview.coverage_computed);
    assert_eq!(preview.unread_files, ["large.txt"]);
    assert_eq!((preview.reviewed, preview.total), (0, 0));
    let quick = proof.prepare_commit(&workspace.id, false, false).unwrap();
    assert!(!quick.coverage_computed);

    let mut preferences = proof.preferences().unwrap();
    preferences.strict_review = true;
    proof.set_preferences(preferences.clone()).unwrap();
    let strict = proof.prepare_commit(&workspace.id, false, false).unwrap();
    assert!(strict.coverage_computed);
    assert_eq!(strict.unread_files, ["large.txt"]);
    assert_eq!(
        proof.commit(&strict.id, "Needs review").unwrap_err().code,
        "REVIEW_REQUIRED"
    );
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    assert_eq!(git(repo, &["rev-parse", "HEAD"]), head);
    preferences.strict_review = false;
    proof.set_preferences(preferences).unwrap();
    assert!(proof.commit(&preview.id, "Large change").unwrap().ok);
    assert_eq!(git(repo, &["show", "HEAD:large.txt"]), after.as_bytes());
    assert_eq!(fs::read(repo.join("large.txt")).unwrap(), after.as_bytes());
    assert!(git(repo, &["status", "--porcelain"]).is_empty());
}

#[test]
fn content_capacity_releases_old_snapshots_before_the_entry_count_limit() {
    let before = format!("old {}\n", "x".repeat(1_300_000));
    let after = format!("new {}\n", "x".repeat(1_300_000));
    let (_directory, mut proof, workspace) = fixture(&before, &after);
    let mut ids = Vec::new();
    for _ in 0..10 {
        ids.push(
            proof
                .file_diff(&workspace.id, "large.txt", Side::Unstaged)
                .unwrap()
                .id,
        );
    }
    assert_eq!(
        proof.mark_reviewed(&ids[0], None, true).unwrap_err().code,
        "SNAPSHOT_EXPIRED"
    );
    proof
        .mark_reviewed(ids.last().unwrap(), None, true)
        .unwrap();
    let latest = proof
        .file_diff(&workspace.id, "large.txt", Side::Unstaged)
        .unwrap();
    assert!(latest
        .hunks
        .iter()
        .all(|hunk| hunk.review_state == "reviewed"));
}

#[cfg(unix)]
#[test]
fn cancelling_a_parallel_git_read_reaps_it_and_does_not_cancel_later_writes() {
    use std::{
        os::unix::fs::PermissionsExt,
        time::{Duration, Instant},
    };
    let (_directory, mut proof, workspace) = fixture("before\n", "after\n");
    let repo = Path::new(&workspace.path);
    let marker = repo.join(".git/read-started");
    let wrapper = _directory.path().join("slow-read-git");
    fs::write(
        &wrapper,
        r#"#!/bin/sh
config=0
repo=
previous=
for arg in "$@"; do
 [ "$arg" = config ] && config=1
 [ "$previous" = -C ] && repo="$arg"
 previous="$arg"
done
if [ "$config" = 1 ]; then
 : > "$repo/.git/read-started"
 sleep 30
fi
exec /usr/bin/git "$@"
"#,
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let mut preferences = proof.preferences().unwrap();
    let original_git = preferences.git_path.clone();
    preferences.git_path = wrapper.to_str().unwrap().into();
    proof.set_preferences(preferences).unwrap();
    let before_index = fs::read(repo.join(".git/index")).unwrap();
    let cancellation = proof_core::ReadCancellation::default();
    let result = std::thread::scope(|scope| {
        let read_cancel = cancellation.clone();
        let proof = &mut proof;
        let workspace_id = &workspace.id;
        let reader = scope.spawn(move || {
            read_cancel
                .run(|| proof.read_file_diff(workspace_id, "large.txt", Side::Unstaged, false))
        });
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(5));
        }
        let reached = marker.exists();
        let cancelled_at = Instant::now();
        cancellation.cancel();
        let result = reader.join().unwrap();
        assert!(reached, "Owned config read did not start");
        assert!(cancelled_at.elapsed() < Duration::from_secs(2));
        result
    });
    assert_eq!(result.unwrap_err().code, "READ_CANCELLED");
    assert!(fs::read(repo.join(".git/index")).unwrap() == before_index);
    let mut preferences = proof.preferences().unwrap();
    preferences.git_path = original_git;
    proof.set_preferences(preferences).unwrap();
    let diff = proof
        .file_diff(&workspace.id, "large.txt", Side::Unstaged)
        .unwrap();
    assert!(proof.stage(&diff.id, None).unwrap().ok);
    assert_eq!(git(repo, &["show", ":large.txt"]), b"after\n");
}

#[test]
fn file_stage_preserves_git_racy_timestamp_detection_in_private_index() {
    let (_directory, mut proof, workspace) = fixture("old\n", "new\n");
    let repo = Path::new(&workspace.path);
    git(repo, &["config", "core.trustctime", "false"]);
    let timestamp = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
    let path = repo.join("large.txt");
    fs::write(&path, "old\n").unwrap();
    fs::File::open(&path)
        .unwrap()
        .set_modified(timestamp)
        .unwrap();
    git(repo, &["add", "large.txt"]);
    fs::write(&path, "new\n").unwrap();
    fs::File::open(&path)
        .unwrap()
        .set_modified(timestamp)
        .unwrap();
    fs::File::open(repo.join(".git/index"))
        .unwrap()
        .set_modified(timestamp)
        .unwrap();
    let changes = proof.changes(&workspace.id).unwrap();
    assert!(changes
        .files
        .iter()
        .any(|f| f.path == "large.txt" && f.side == Side::Unstaged));
    assert!(
        proof
            .stage_files(
                &workspace.id,
                &["large.txt".into()],
                Side::Unstaged,
                &changes.token
            )
            .unwrap()
            .result
            .ok
    );
    assert_eq!(git(repo, &["show", ":large.txt"]), b"new\n");
}
