use proof_core::{Proof, Side, Workspace};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

struct Fixture {
    _temp: tempfile::TempDir,
    repo: PathBuf,
    proof: Proof,
    workspace: Workspace,
}
fn git(repo: &Path, args: &[&str]) -> String {
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
        "{:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
fn baseline() -> String {
    (1..=65).map(|n| format!("line {n}\n")).collect()
}

#[test]
fn commits_require_explicit_review_and_marks_stay_with_the_frozen_comparison() {
    let mut f = Fixture::new();
    let base = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_owned();
    f.change();
    git(&f.repo, &["commit", "-am", "Agent-produced commit"]);
    let target = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let diff = f
        .proof
        .compare_file(&f.workspace.id, &base, &target, "code.txt")
        .unwrap();
    assert_eq!(diff.hunks.len(), 2);
    assert!(diff.hunks.iter().all(|h| h.review_state == "unreviewed"));
    let bytes = fs::read(f.repo.join("code.txt")).unwrap();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let config = fs::read(f.repo.join(".git/config")).unwrap();
    let mut request = proof_core::ComparisonReviewRequest {
        workspace_id: f.workspace.id.clone(),
        base: base.clone(),
        target: target.clone(),
        path: "code.txt".into(),
        snapshot_id: diff.id.clone(),
        hunk_id: Some(diff.hunks[0].id.clone()),
        reviewed: true,
    };
    f.proof.mark_comparison_reviewed(request).unwrap();
    let reviewed = f
        .proof
        .compare_file(&f.workspace.id, &base, &target, "code.txt")
        .unwrap();
    assert_eq!(reviewed.hunks[0].review_state, "reviewed");
    assert_eq!(reviewed.hunks[1].review_state, "unreviewed");
    f.proof = Proof::open(f._temp.path().join("data")).unwrap();
    let restored = f
        .proof
        .compare_file(&f.workspace.id, &base, &target, "code.txt")
        .unwrap();
    assert_eq!(restored.hunks[0].review_state, "reviewed");
    assert_eq!(restored.hunks[1].review_state, "unreviewed");
    assert_eq!(
        f.proof.stage(&diff.id, None).unwrap_err().code,
        "SNAPSHOT_EXPIRED"
    );
    let reverse = f
        .proof
        .compare_file(&f.workspace.id, &target, &base, "code.txt")
        .unwrap();
    assert!(reverse.hunks.iter().all(|h| h.review_state == "unreviewed"));
    request = proof_core::ComparisonReviewRequest {
        workspace_id: f.workspace.id.clone(),
        base: base.clone(),
        target: target.clone(),
        path: "code.txt".into(),
        snapshot_id: "wrong snapshot".into(),
        hunk_id: None,
        reviewed: true,
    };
    assert_eq!(
        f.proof.mark_comparison_reviewed(request).unwrap_err().code,
        "COMPARE_CHANGED"
    );
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), bytes);
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(f.repo.join(".git/config")).unwrap(), config);
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]).trim(), target);
    fs::write(
        f.repo.join("code.txt"),
        String::from_utf8(bytes)
            .unwrap()
            .replace("line 30\n", "new local change\n"),
    )
    .unwrap();
    let local = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert!(local.hunks.iter().all(|h| h.review_state == "unreviewed"));
    git(&f.repo, &["commit", "-am", "Another unreviewed commit"]);
    let next = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let newer = f
        .proof
        .compare_file(&f.workspace.id, &base, &next, "code.txt")
        .unwrap();
    assert!(newer.hunks.iter().all(|h| h.review_state == "unreviewed"));
}

#[test]
fn historical_metadata_has_an_explicit_file_review_unit() {
    let mut f = Fixture::new();
    let base = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_owned();
    fs::write(f.repo.join("binary.dat"), b"\0binary body\0").unwrap();
    git(&f.repo, &["add", "binary.dat"]);
    git(&f.repo, &["commit", "-m", "Binary change"]);
    let target = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let diff = f
        .proof
        .compare_file(&f.workspace.id, &base, &target, "binary.dat")
        .unwrap();
    assert_eq!(diff.kind, proof_core::FileKind::Binary);
    assert_eq!(diff.hunks.len(), 1);
    assert_eq!(diff.hunks[0].review_state, "unreviewed");
    assert!(diff.hunks[0].lines.is_empty());
    f.proof
        .mark_comparison_reviewed(proof_core::ComparisonReviewRequest {
            workspace_id: f.workspace.id.clone(),
            base: base.clone(),
            target: target.clone(),
            path: diff.path.clone(),
            snapshot_id: diff.id.clone(),
            hunk_id: None,
            reviewed: true,
        })
        .unwrap();
    let reviewed = f
        .proof
        .compare_file(&f.workspace.id, &base, &target, &diff.path)
        .unwrap();
    assert_eq!(reviewed.hunks[0].review_state, "reviewed");
    assert!(!reviewed.can_stage);
}

#[test]
fn full_file_covers_unchanged_ends_without_expanding_the_staged_hunk() {
    let mut f = Fixture::new();
    let original: String = (1..=500).map(|n| format!("line {n}\n")).collect();
    fs::write(f.repo.join("code.txt"), &original).unwrap();
    git(&f.repo, &["add", "."]);
    git(&f.repo, &["commit", "-m", "Long file"]);
    let edited = original
        .replace("line 10\n", "change 10\n")
        .replace("line 445\n", "change 445\n");
    fs::write(f.repo.join("code.txt"), &edited).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let context = f.proof.read_diff_context(&diff.id, None).unwrap();
    assert!(context.full_file);
    let mut all_lines: Vec<_> = context
        .gaps
        .iter()
        .flat_map(|g| &g.lines)
        .chain(diff.hunks.iter().flat_map(|h| &h.lines))
        .filter(|line| line.new_line.is_some())
        .collect();
    all_lines.sort_by_key(|line| line.new_line);
    assert_eq!(all_lines.len(), 500);
    assert_eq!(
        all_lines
            .iter()
            .map(|line| format!("{}\n", line.content))
            .collect::<String>(),
        edited
    );
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read_to_string(f.repo.join("code.txt")).unwrap(), edited);
    f.proof.stage(&diff.id, Some(&diff.hunks[0].id)).unwrap();
    assert_eq!(
        git(&f.repo, &["show", ":code.txt"]),
        original.replace("line 10\n", "change 10\n")
    );
    assert_eq!(fs::read_to_string(f.repo.join("code.txt")).unwrap(), edited);
}

#[test]
fn historical_full_file_is_frozen_rename_aware_and_never_writable() {
    let mut f = Fixture::new();
    let base = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_owned();
    f.change();
    git(&f.repo, &["mv", "code.txt", "renamed.txt"]);
    git(&f.repo, &["commit", "-am", "Rename and edit"]);
    let target = git(&f.repo, &["rev-parse", "HEAD"]).trim().to_owned();
    fs::write(f.repo.join("renamed.txt"), "UNCOMMITTED TEXT\n").unwrap();
    let diff = f
        .proof
        .compare_file(&f.workspace.id, &base, &target, "renamed.txt")
        .unwrap();
    let context = f
        .proof
        .compare_context(
            &f.workspace.id,
            &base,
            &target,
            "renamed.txt",
            &diff.id,
            None,
        )
        .unwrap();
    assert!(context.full_file);
    let lines: Vec<_> = context.gaps.iter().flat_map(|g| &g.lines).collect();
    assert!(lines.iter().any(|line| line.content == "line 1"));
    assert!(lines.iter().any(|line| line.content == "line 65"));
    assert!(!lines
        .iter()
        .any(|line| line.content.contains("UNCOMMITTED")));
    assert_eq!(
        f.proof.stage(&diff.id, None).unwrap_err().code,
        "SNAPSHOT_EXPIRED"
    );
    let reverse = f
        .proof
        .compare_file(&f.workspace.id, &target, &base, "code.txt")
        .unwrap();
    let reverse_context = f
        .proof
        .compare_context(
            &f.workspace.id,
            &target,
            &base,
            "code.txt",
            &reverse.id,
            Some(25),
        )
        .unwrap();
    assert!(!reverse_context.full_file);
    assert!(reverse_context
        .gaps
        .iter()
        .flat_map(|g| &g.lines)
        .any(|line| line.content == "line 65"));
    assert_eq!(
        fs::read_to_string(f.repo.join("renamed.txt")).unwrap(),
        "UNCOMMITTED TEXT\n"
    );
    // Even after caching, a changed presentation cannot borrow the old ID.
    git(&f.repo, &["config", "diff.noprefix", "true"]);
    assert_eq!(
        f.proof
            .compare_context(
                &f.workspace.id,
                &base,
                &target,
                "renamed.txt",
                &diff.id,
                None
            )
            .unwrap_err()
            .code,
        "COMPARE_CHANGED"
    );
}

#[test]
fn full_file_is_bounded_by_bytes_and_line_count_with_original_diff_kept() {
    let mut f = Fixture::new();
    for original in [
        format!("{}\nend\n", ("x".repeat(1000) + "\n").repeat(5000)),
        format!("{}end\n", "short\n".repeat(100_010)),
    ] {
        fs::write(f.repo.join("code.txt"), &original).unwrap();
        git(&f.repo, &["add", "."]);
        git(&f.repo, &["commit", "-m", "Large unchanged context"]);
        let edited = original.replace("end\n", "changed end\n");
        fs::write(f.repo.join("code.txt"), &edited).unwrap();
        let diff = f
            .proof
            .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
            .unwrap();
        let index = fs::read(f.repo.join(".git/index")).unwrap();
        assert_eq!(
            f.proof.read_diff_context(&diff.id, None).unwrap_err().code,
            "CONTEXT_TOO_LARGE"
        );
        assert!(f.proof.diff_context(&diff.id, 10).is_ok());
        assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
        assert_eq!(fs::read_to_string(f.repo.join("code.txt")).unwrap(), edited);
    }
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Proof Reading Test"]);
        git(&repo, &["config", "user.email", "reading@example.invalid"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        git(&repo, &["config", "core.autocrlf", "false"]);
        git(
            &repo,
            &[
                "config",
                "core.hooksPath",
                repo.join(".git/hooks").to_str().unwrap(),
            ],
        );
        fs::write(repo.join("code.txt"), baseline()).unwrap();
        git(&repo, &["add", "code.txt"]);
        git(&repo, &["commit", "-m", "Initial"]);
        let mut proof = Proof::open(temp.path().join("data")).unwrap();
        let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
        proof.set_trust(&workspace.id, true).unwrap();
        Self {
            _temp: temp,
            repo,
            proof,
            workspace,
        }
    }
    fn change(&self) {
        fs::write(
            self.repo.join("code.txt"),
            baseline()
                .replace("line 10\n", "change 10\n")
                .replace("line 45\n", "change 45\n"),
        )
        .unwrap();
    }
}

#[test]
fn expanded_context_keeps_original_review_units_and_exact_hunk_stage() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(diff.hunks.len(), 2);
    let file = fs::read(f.repo.join("code.txt")).unwrap();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let context = f.proof.diff_context(&diff.id, 25).unwrap();
    assert_eq!(context.snapshot_id, diff.id);
    assert_eq!(
        context
            .gaps
            .iter()
            .filter(|g| g.before_hunk_id.is_some())
            .count(),
        2
    );
    assert!(context
        .gaps
        .iter()
        .flat_map(|g| &g.lines)
        .all(|l| l.kind == "context"));
    assert!(context
        .gaps
        .iter()
        .flat_map(|g| &g.lines)
        .any(|l| l.old_line == Some(30) && l.content == "line 30"));
    let mut numbers: Vec<_> = context
        .gaps
        .iter()
        .flat_map(|g| &g.lines)
        .filter_map(|l| l.old_line)
        .collect();
    let count = numbers.len();
    numbers.sort();
    numbers.dedup();
    assert_eq!(
        numbers.len(),
        count,
        "merged display context must not duplicate gap rows"
    );
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), file);
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    let next = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(next.patch, diff.patch);
    assert_eq!(
        next.hunks.iter().map(|h| &h.id).collect::<Vec<_>>(),
        diff.hunks.iter().map(|h| &h.id).collect::<Vec<_>>()
    );
    assert!(next.hunks.iter().all(|h| h.review_state == "unreviewed"));
    f.proof
        .mark_reviewed(&diff.id, Some(&diff.hunks[0].id), true)
        .unwrap();
    f.proof.stage(&diff.id, Some(&diff.hunks[0].id)).unwrap();
    assert_eq!(
        git(&f.repo, &["show", ":code.txt"]),
        baseline().replace("line 10\n", "change 10\n")
    );
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), file);
}

#[test]
fn captured_context_stays_frozen_and_new_context_refuses_external_changes() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let context = f.proof.diff_context(&diff.id, 10).unwrap();
    fs::write(f.repo.join("code.txt"), "external replacement\n").unwrap();
    assert_eq!(
        serde_json::to_value(f.proof.diff_context(&diff.id, 10).unwrap()).unwrap(),
        serde_json::to_value(context).unwrap()
    );
    assert_eq!(
        f.proof.diff_context(&diff.id, 25).unwrap_err().code,
        "STALE_CONTENT"
    );
    assert_eq!(
        f.proof
            .mark_reviewed(&diff.id, None, true)
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
    assert_eq!(
        f.proof
            .stage(&diff.id, Some(&diff.hunks[0].id))
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
}

#[test]
fn staged_and_unstaged_context_use_their_own_bases() {
    let mut f = Fixture::new();
    let staged = baseline().replace("line 10\n", "staged 10\n");
    fs::write(f.repo.join("code.txt"), &staged).unwrap();
    git(&f.repo, &["add", "code.txt"]);
    fs::write(
        f.repo.join("code.txt"),
        staged.replace("line 45\n", "working 45\n"),
    )
    .unwrap();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let first = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Staged)
        .unwrap();
    let second = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    let staged_context = f.proof.diff_context(&first.id, 100).unwrap();
    let unstaged_context = f.proof.diff_context(&second.id, 100).unwrap();
    assert!(staged_context
        .gaps
        .iter()
        .flat_map(|g| &g.lines)
        .any(|l| l.content == "line 45"));
    assert!(!staged_context
        .gaps
        .iter()
        .flat_map(|g| &g.lines)
        .any(|l| l.content == "working 45"));
    assert!(unstaged_context
        .gaps
        .iter()
        .flat_map(|g| &g.lines)
        .any(|l| l.content == "staged 10"));
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
}

#[test]
fn context_preserves_crlf_no_final_newline_and_literal_rename_paths() {
    let mut f = Fixture::new();
    let original = baseline()
        .replace('\n', "\r\n")
        .trim_end_matches("\r\n")
        .to_string();
    fs::write(f.repo.join("code.txt"), &original).unwrap();
    git(&f.repo, &["add", "code.txt"]);
    git(&f.repo, &["commit", "-m", "CRLF"]);
    let name = "renamed @@ file.txt";
    git(&f.repo, &["mv", "code.txt", name]);
    fs::write(
        f.repo.join(name),
        original.replace("line 10\r", "change 10\r"),
    )
    .unwrap();
    git(&f.repo, &["add", name]);
    let diff = f
        .proof
        .file_diff(&f.workspace.id, name, Side::Staged)
        .unwrap();
    let context = f.proof.diff_context(&diff.id, 100).unwrap();
    assert_eq!(diff.old_path.as_deref(), Some("code.txt"));
    assert!(context
        .gaps
        .iter()
        .flat_map(|g| &g.lines)
        .any(|l| l.content == "line 64\r"));
    assert!(context
        .gaps
        .iter()
        .flat_map(|g| &g.lines)
        .any(|l| l.kind == "note"));
}

#[test]
fn context_parameters_and_old_preferences_are_bounded_and_compatible() {
    let mut f = Fixture::new();
    f.change();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(f.proof.diff_context(&diff.id, 0).unwrap().context_lines, 0);
    assert_eq!(f.proof.diff_context(&diff.id, 4).unwrap().context_lines, 4);
    assert_eq!(
        f.proof
            .diff_context(&diff.id, u16::MAX)
            .unwrap()
            .context_lines,
        u16::MAX
    );
    assert_eq!(
        f.proof.diff_context("missing", 25).unwrap_err().code,
        "SNAPSHOT_EXPIRED"
    );
    let mut old = serde_json::to_value(f.proof.preferences().unwrap()).unwrap();
    old.as_object_mut().unwrap().remove("ignoreWhitespace");
    old.as_object_mut().unwrap().remove("showWhitespace");
    let restored: proof_core::Preferences = serde_json::from_value(old).unwrap();
    assert!(!restored.ignore_whitespace && !restored.show_whitespace);
}
