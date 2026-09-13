use proof_core::{FileKind, Proof};
use std::{fs, path::Path, process::Command};
fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}
#[test]
fn branch_and_commit_comparison_is_frozen_visual_and_read_only() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.name", "Compare test"]);
    git(&repo, &["config", "user.email", "compare@example.invalid"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    git(
        &repo,
        &[
            "config",
            "core.hooksPath",
            root.path().join("no-hooks").to_str().unwrap(),
        ],
    );
    let text = format!("return 41\n{}", "// preserved context\n".repeat(20));
    fs::write(repo.join("before.py"), &text).unwrap();
    fs::write(repo.join("binary.dat"), [0, 1, 2]).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "Base"]);
    let base = git(&repo, &["rev-parse", "HEAD"]);
    git(&repo, &["checkout", "-b", "feature"]);
    fs::rename(repo.join("before.py"), repo.join("after name.py")).unwrap();
    fs::create_dir(repo.join("before.py")).unwrap();
    fs::write(
        repo.join("before.py/unrelated.txt"),
        "Must not appear in renamed file diff\n",
    )
    .unwrap();
    fs::write(repo.join("after name.py"), text.replace("41", "42")).unwrap();
    fs::write(repo.join("binary.dat"), [0, 9, 2]).unwrap();
    fs::write(repo.join("literal[1].txt"), "added\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "Target"]);
    let mut proof = Proof::open(root.path().join("data")).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    let head = git(&repo, &["rev-parse", "HEAD"]);
    let index = fs::read(repo.join(".git/index")).unwrap();
    let root_comparison = proof.compare_commit(&workspace.id, &base, 0).unwrap();
    assert_eq!(root_comparison.base_oid, "empty");
    assert_eq!(root_comparison.files.len(), 2);
    let root_file = proof
        .compare_file(&workspace.id, "empty", &base, "before.py")
        .unwrap();
    assert!(root_file
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .any(|l| l.kind == "add" && l.content == "return 41"));
    let comparison = proof
        .compare_refs(&workspace.id, "main", "refs/heads/feature")
        .unwrap();
    assert_eq!(comparison.base_oid, base);
    assert_eq!(comparison.target_oid, head);
    assert_eq!(comparison.files.len(), 4);
    git(&repo, &["branch", "-f", "main", "feature"]);
    let diff = proof
        .compare_file(
            &workspace.id,
            &comparison.base_oid,
            &comparison.target_oid,
            "after name.py",
        )
        .unwrap();
    assert_eq!(diff.old_path.as_deref(), Some("before.py"));
    assert_eq!(diff.kind, FileKind::Rename);
    assert!(!diff.patch.contains("unrelated.txt"));
    assert_eq!((diff.additions, diff.deletions), (1, 1));
    assert!(diff.hunks[0]
        .lines
        .iter()
        .any(|l| l.kind == "add" && l.content == "return 42"));
    assert!(!diff.can_stage && !diff.can_discard);
    assert!(
        proof.stage(&diff.id, None).is_err(),
        "Read-only snapshots must not be registered for writes"
    );
    let binary = proof
        .compare_file(&workspace.id, &base, &head, "binary.dat")
        .unwrap();
    assert_eq!(binary.kind, FileKind::Binary);
    assert!(binary.hunks.is_empty());
    let added = proof
        .compare_file(&workspace.id, &base, &head, "literal[1].txt")
        .unwrap();
    assert_eq!(added.additions, 1);
    let reversed = proof
        .compare_file(&workspace.id, &head, &base, "before.py")
        .unwrap();
    assert!(reversed
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .any(|l| l.kind == "add" && l.content == "return 41"));
    assert!(proof
        .compare_refs(&workspace.id, "--output=/tmp/invalid", "HEAD")
        .is_err());
    assert!(proof
        .compare_file(&workspace.id, "main", &head, "binary.dat")
        .is_err());
    assert!(proof
        .compare_refs(&workspace.id, &head, &head)
        .unwrap()
        .files
        .is_empty());
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        fs::read_to_string(repo.join("after name.py")).unwrap(),
        text.replace("41", "42")
    );
}

#[test]
fn a_non_utf8_commit_message_does_not_hide_utf8_file_changes() {
    use std::io::Write;
    use std::process::Stdio;
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    fs::write(repo.join("file.txt"), "UTF-8 source\n").unwrap();
    git(&repo, &["add", "file.txt"]);
    let tree = git(&repo, &["write-tree"]);
    let mut bytes=format!("tree {tree}\nauthor Test <test@example.invalid> 1000000000 +0000\ncommitter Test <test@example.invalid> 1000000000 +0000\nencoding ISO-8859-1\n\ncaf").into_bytes();
    bytes.extend([0xe9, b'\n']);
    let mut child = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["hash-object", "-t", "commit", "-w", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&bytes).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    let oid = String::from_utf8(out.stdout).unwrap();
    let oid = oid.trim();
    git(&repo, &["update-ref", "refs/heads/main", oid]);
    let mut proof = Proof::open(root.path().join("data")).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    let comparison = proof.compare_commit(&workspace.id, oid, 0).unwrap();
    assert_eq!(comparison.base_oid, "empty");
    let diff = proof
        .compare_file(&workspace.id, "empty", oid, "file.txt")
        .unwrap();
    assert_eq!(diff.additions, 1);
    assert!(diff.patch.contains("+UTF-8 source"));
}
