use super::*;
use crate::{AiRisk, LineSide};
use std::{path::Path, process::Command};
fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn fixture(content: &str) -> (tempfile::TempDir, Proof, String) {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.name", "Locator test"]);
    git(&repo, &["config", "user.email", "locator@example.invalid"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    fs::write(repo.join("focus.rs"), content).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "base"]);
    let mut proof = Proof::open(temp.path().join("data")).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    proof.set_trust(&workspace.id, true).unwrap();
    (temp, proof, workspace.id)
}
fn finding(line: u32, end: u32) -> AiFinding {
    AiFinding {
        severity: AiRisk::High,
        title: "Test finding".into(),
        description: "Test".into(),
        file: "focus.rs".into(),
        side: Side::Unstaged,
        line,
        end_line: Some(end),
        line_side: LineSide::New,
        suggestion: "Fix".into(),
    }
}
fn anchor(proof: &Proof, _workspace: &str, content: &str) -> FindingAnchors {
    FindingAnchors {
        epoch: proof.cached_data_epoch,
        target_oid: None,
        files: vec![FindingAnchor {
            path: "focus.rs".into(),
            current_path: "focus.rs".into(),
            source: "worktree".into(),
            content: content.into(),
        }],
        entries: vec![FindingAnchorEntry {
            file: Some(0),
            reason: None,
        }],
    }
}
fn locate(proof: &Proof, id: &str, original: &str, line: u32, end: u32) -> FindingLocation {
    proof
        .resolve_captured_finding_location(
            id,
            &finding(line, end),
            Some(&anchor(proof, id, original)),
            0,
        )
        .unwrap()
}
#[test]
fn exact_shifted_and_modified_positions_preserve_git_and_review_marks() {
    let original = "before\nunsafe_call();\nafter\n";
    let (temp, proof, id) = fixture(original);
    let repo = temp.path().join("repo");
    let head = git(&repo, &["rev-parse", "HEAD"]);
    let index = fs::read(repo.join(".git/index")).unwrap();
    assert_eq!(locate(&proof, &id, original, 2, 2).status, "exact");
    fs::write(repo.join("focus.rs"), format!("intro\n{original}")).unwrap();
    let mapped = locate(&proof, &id, original, 2, 2);
    assert_eq!(mapped.status, "shifted");
    assert_eq!(mapped.current.unwrap().line, Some(3));
    fs::write(repo.join("focus.rs"), "before\nsafe_call();\nafter\n").unwrap();
    let mapped = locate(&proof, &id, original, 2, 2);
    assert_eq!(mapped.status, "modified");
    assert_eq!(mapped.current.unwrap().line, Some(2));
    assert_eq!(mapped.original.unwrap().line, Some(2));
    fs::write(
        repo.join("focus.rs"),
        "before\nafter\nunrelated_scope\nunsafe_call();\nend\n",
    )
    .unwrap();
    let mapped = locate(&proof, &id, original, 2, 2);
    assert_eq!(mapped.status, "deleted");
    assert_ne!(mapped.current.unwrap().line, Some(4));
    assert_eq!(mapped.candidates[0].line, 4);
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    assert_eq!(
        proof
            .store
            .connection
            .query_row("SELECT COUNT(*) FROM review_marks", [], |row| row
                .get::<_, u32>(0))
            .unwrap(),
        0
    );
}
#[test]
fn deletion_and_duplicate_anchors_do_not_jump_to_an_unrelated_occurrence() {
    let original = "left\nunsafe_call();\nright\n";
    let (temp, proof, id) = fixture(original);
    let path = temp.path().join("repo/focus.rs");
    fs::write(&path, "left\nright\n").unwrap();
    let result = locate(&proof, &id, original, 2, 2);
    assert_eq!(result.status, "deleted");
    assert_eq!(result.current.unwrap().line, Some(1));
    let repeated = "a\nx\nb\nc\nd\ne\nf\na\nx\nb\nc\nd\ne\nf\n";
    fs::write(&path, format!("intro\n{repeated}")).unwrap();
    let result = locate(&proof, &id, repeated, 2, 2);
    assert_eq!(result.status, "ambiguous");
    assert_eq!(result.candidates.len(), 2);
    assert_eq!(result.current.unwrap().line, None);
    let distinct = "left\nx\nright\nother\nx\nend\n";
    fs::write(&path, "left\nright\nother\nx\nend\n").unwrap();
    let result = locate(&proof, &id, distinct, 2, 2);
    assert_eq!(result.status, "ambiguous");
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(result.current.unwrap().line, None);
    fs::write(&path, "left\nfixed\nright\nother\nx\nend\n").unwrap();
    assert_eq!(locate(&proof, &id, distinct, 2, 2).status, "ambiguous");
    fs::write(&path, "left\nfixed\nright\nother\nfixed\nend\n").unwrap();
    let result = locate(&proof, &id, distinct, 2, 2);
    assert_eq!(result.status, "ambiguous");
    assert!(result.candidates.is_empty());
    assert_eq!(result.current.unwrap().line, None);
    fs::remove_file(&path).unwrap();
    let result = locate(&proof, &id, original, 2, 2);
    assert_eq!(result.status, "deleted");
    assert!(result.current.is_none());
    assert!(result.original.is_some());
}
#[test]
fn staged_old_new_and_historical_sources_are_captured_from_correct_versions() {
    let (temp, proof, id) = fixture("head\n");
    let repo = temp.path().join("repo");
    fs::write(repo.join("focus.rs"), "index\n").unwrap();
    git(&repo, &["add", "focus.rs"]);
    fs::write(repo.join("focus.rs"), "worktree\n").unwrap();
    let scope = AiScope::Local {
        workspace_id: id.clone(),
        expected_token: proof.changes(&id).unwrap().token,
        files: None,
    };
    let files = proof.changes(&id).unwrap().files;
    let mut old = finding(1, 1);
    old.side = Side::Staged;
    old.line_side = LineSide::Old;
    let mut new = old.clone();
    new.line_side = LineSide::New;
    let capture = proof
        .capture_finding_anchors(&id, &scope, &[old, new, finding(1, 1)], &files)
        .unwrap();
    assert_eq!(capture.files[0].content, "head\n");
    assert_eq!(capture.files[1].content, "index\n");
    assert_eq!(capture.files[2].content, "worktree\n");
    let base = git(&repo, &["rev-parse", "HEAD"]);
    git(&repo, &["commit", "-m", "target"]);
    let target = git(&repo, &["rev-parse", "HEAD"]);
    let scope = AiScope::Comparison {
        workspace_id: id.clone(),
        base: base.clone(),
        target: target.clone(),
        path: None,
        paths: None,
    };
    let files = proof.frozen_comparison(&id, &base, &target).unwrap().files;
    let mut old = finding(1, 1);
    old.line_side = LineSide::Old;
    let capture = proof
        .capture_finding_anchors(&id, &scope, &[old, finding(1, 1)], &files)
        .unwrap();
    assert_eq!(capture.files[0].content, "head\n");
    assert_eq!(capture.files[1].content, "index\n");
}
#[test]
fn unavailable_boundaries_and_invalid_original_lines_are_explicit() {
    let (temp, proof, id) = fixture("line\n");
    let path = temp.path().join("repo/focus.rs");
    let result = proof
        .resolve_captured_finding_location(&id, &finding(1, 1), None, 0)
        .unwrap();
    assert_eq!(result.status, "unavailable");
    assert_eq!(result.current.unwrap().line, None);
    let result = locate(&proof, &id, "line\n", 90, 90);
    assert_eq!(result.reason.as_deref(), Some("ORIGINAL_LINE_UNAVAILABLE"));
    fs::write(&path, [0, 1, 2]).unwrap();
    let result = locate(&proof, &id, "line\n", 1, 1);
    assert_eq!(result.reason.as_deref(), Some("BINARY_FILE"));
    assert!(result.original.is_some());
    fs::write(&path, "x".repeat(FILE_LIMIT + 1)).unwrap();
    assert_eq!(
        locate(&proof, &id, "line\n", 1, 1).reason.as_deref(),
        Some("FILE_TOO_LARGE")
    );
    let mut outside = finding(1, 1);
    outside.file = "../outside.rs".into();
    assert!(proof
        .resolve_captured_finding_location(&id, &outside, None, 0)
        .is_err());
    proof.set_trust(&id, false).unwrap();
    assert_eq!(
        proof
            .resolve_captured_finding_location(&id, &finding(1, 1), None, 0)
            .unwrap_err()
            .code,
        "TRUST_REQUIRED"
    );
}
#[test]
fn persisted_anchors_restore_and_follow_git_verified_renames() {
    let original = "before\nunsafe_call();\nafter\n";
    let (temp, proof, id) = fixture(original);
    let repo = temp.path().join("repo");
    let head = git(&repo, &["rev-parse", "HEAD"]);
    let mut anchors = anchor(&proof, &id, original);
    anchors.target_oid = Some(head.clone());
    let at = crate::now();
    let report = serde_json::json!({"revision":0,"decisions":["pending"],"id":"location-report","provider":"codex","task":"review","scope":{"kind":"local","workspaceId":id,"expectedToken":"captured","files":null},"fingerprint":"captured","capturedAt":at,"files":[],"groups":[],"review":{"summary":"Review","overallRisk":"high","findings":[finding(2,2)],"behaviorChanges":[],"missingTests":[],"reviewPriority":["focus.rs"]},"limitations":[]});
    proof
        .store
        .connection
        .execute(
            "INSERT INTO ai_review_reports VALUES(?,?,?,?,?,?)",
            rusqlite::params!["location-report", id, "local", at, 0, report.to_string()],
        )
        .unwrap();
    proof
        .save_finding_anchors("location-report", &anchors)
        .unwrap();
    assert!(
        !serde_json::to_value(proof.ai_review_report(&id, "location-report").unwrap())
            .unwrap()
            .to_string()
            .contains("unsafe_call")
    );
    proof.clear_observer_data(&id).unwrap();
    drop(proof);
    let proof = Proof::open(temp.path().join("data")).unwrap();
    git(&repo, &["mv", "focus.rs", "renamed.rs"]);
    let result = proof
        .resolve_finding_location(&id, "location-report", 0)
        .unwrap();
    assert_eq!(result.path, "renamed.rs");
    assert_eq!(result.status, "exact");
    git(&repo, &["commit", "-m", "rename"]);
    let result = proof
        .resolve_finding_location(&id, "location-report", 0)
        .unwrap();
    assert_eq!(result.path, "renamed.rs");
    assert_eq!(result.current.unwrap().line, Some(2));
    assert_eq!(result.original.unwrap().path, "focus.rs");
    proof
        .store
        .connection
        .execute(
            "DELETE FROM ai_review_reports WHERE id='location-report'",
            [],
        )
        .unwrap();
    assert_eq!(
        proof
            .store
            .connection
            .query_row("SELECT count(*) FROM ai_finding_anchors", [], |row| row
                .get::<_, u32>(0))
            .unwrap(),
        0
    );
}
#[test]
fn anchors_deduplicate_sources_and_bound_serialized_storage() {
    let (temp, proof, id) = fixture("line\n");
    let repo = temp.path().join("repo");
    let content = "x".repeat(400_000) + "\n";
    fs::write(repo.join("focus.rs"), &content).unwrap();
    let scope = AiScope::Local {
        workspace_id: id.clone(),
        expected_token: proof.changes(&id).unwrap().token,
        files: None,
    };
    let files = proof.changes(&id).unwrap().files;
    let findings = vec![finding(1, 1); 100];
    let captures = proof
        .capture_finding_anchors(&id, &scope, &findings, &files)
        .unwrap();
    assert_eq!(captures.files.len(), 1);
    assert_eq!(captures.entries.len(), 100);
    assert!(captures.entries.iter().all(|entry| entry.file == Some(0)));
    assert!(serde_json::to_vec(&captures).unwrap().len() < FILE_LIMIT);
    // JSON escaping is part of the actual storage budget, not only UTF-8 bytes.
    fs::write(repo.join("focus.rs"), "\u{1}".repeat(800_000)).unwrap();
    let captures = proof
        .capture_finding_anchors(&id, &scope, &[finding(1, 1)], &files)
        .unwrap();
    assert!(captures.files.is_empty());
    assert_eq!(
        captures.entries[0].reason.as_deref(),
        Some("ANCHOR_STORAGE_LIMIT")
    );
}
