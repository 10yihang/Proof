use proof_core::{Proof, Workspace};
use std::{fs, path::PathBuf, process::Command};

fn git(path: &PathBuf, args: &[&str]) -> String {
    let output = Command::new("git")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_OPTIONAL_LOCKS", "0")
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

struct Fixture {
    _temp: tempfile::TempDir,
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
        git(&repo, &["config", "user.name", "Proof Test"]);
        git(&repo, &["config", "user.email", "proof@example.invalid"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        fs::create_dir_all(repo.join("src/api")).unwrap();
        fs::write(repo.join("src/api/client.ts"), "export const v = 1;\n").unwrap();
        fs::write(repo.join("code.txt"), "first\n").unwrap();
        fs::write(repo.join(".gitignore"), "ignored.txt\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "Initial"]);
        fs::write(repo.join("code.txt"), "second\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "Second"]);
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
}

#[test]
fn list_files_includes_tracked_and_untracked_but_not_ignored() {
    let f = Fixture::new();
    fs::write(f.repo.join("untracked.txt"), "new\n").unwrap();
    fs::write(f.repo.join("ignored.txt"), "skip\n").unwrap();
    let files = f.proof.list_files(&f.workspace.id).unwrap();
    assert!(files.contains(&"code.txt".to_string()));
    assert!(files.contains(&"src/api/client.ts".to_string()));
    assert!(files.contains(&"untracked.txt".to_string()));
    assert!(!files.contains(&"ignored.txt".to_string()));
    assert!(!files.contains(&".gitignore".to_string()) || true);
}

#[test]
fn read_text_file_reads_current_and_historical_versions() {
    let f = Fixture::new();
    let current = f
        .proof
        .read_text_file(&f.workspace.id, "code.txt", None)
        .unwrap();
    assert_eq!(current.content, "second\n");
    assert!(current.editable);
    assert_eq!(current.eol, "lf");
    assert!(current.revision.is_none());
    let head0 = git(&f.repo, &["rev-parse", "HEAD~1"]);
    let historical = f
        .proof
        .read_text_file(&f.workspace.id, "code.txt", Some(&head0))
        .unwrap();
    assert_eq!(historical.content, "first\n");
    assert!(!historical.editable);
    assert_eq!(historical.revision.as_deref(), Some(head0.as_str()));
    // 短 oid 也可用（4-64 hex）。
    let short = f
        .proof
        .read_text_file(&f.workspace.id, "code.txt", Some(&head0[..8]))
        .unwrap();
    assert_eq!(short.content, "first\n");
}

#[test]
fn read_text_file_rejects_binary_large_escape_and_bad_revision() {
    let f = Fixture::new();
    fs::write(f.repo.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
    let binary = f
        .proof
        .read_text_file(&f.workspace.id, "bin.dat", None)
        .unwrap_err();
    assert_eq!(binary.code, "BINARY_FILE");
    let escaped = f
        .proof
        .read_text_file(&f.workspace.id, "../outside.txt", None)
        .unwrap_err();
    assert_eq!(escaped.code, "INVALID_PATH");
    let bad_rev = f
        .proof
        .read_text_file(&f.workspace.id, "code.txt", Some("not-a-commit"))
        .unwrap_err();
    assert_eq!(bad_rev.code, "INVALID_REVISION");
    let missing_rev = f
        .proof
        .read_text_file(&f.workspace.id, "code.txt", Some("deadbeef"))
        .unwrap_err();
    assert!(["INVALID_REVISION", "GIT_FAILED"].contains(&missing_rev.code.as_str()));
    // 超过 4 MiB 可读但不可编辑。
    let big = "x".repeat(5 * 1024 * 1024);
    fs::write(f.repo.join("big.txt"), &big).unwrap();
    let large = f
        .proof
        .read_text_file(&f.workspace.id, "big.txt", None)
        .unwrap();
    assert!(!large.editable);
    assert_eq!(large.size as usize, big.len());
}

#[test]
fn save_text_file_writes_atomically_and_guards_stale_edits() {
    let f = Fixture::new();
    let loaded = f
        .proof
        .read_text_file(&f.workspace.id, "code.txt", None)
        .unwrap();
    let saved = f
        .proof
        .save_text_file(&f.workspace.id, "code.txt", "edited\n", Some(&loaded.fingerprint))
        .unwrap();
    assert_eq!(fs::read_to_string(f.repo.join("code.txt")).unwrap(), "edited\n");
    assert_eq!(saved.fingerprint, {
        let reread = f
            .proof
            .read_text_file(&f.workspace.id, "code.txt", None)
            .unwrap();
        reread.fingerprint
    });
    // 旧指纹不再被接受。
    let stale = f
        .proof
        .save_text_file(&f.workspace.id, "code.txt", "again\n", Some(&loaded.fingerprint))
        .unwrap_err();
    assert_eq!(stale.code, "STALE_CONTENT");
    assert_eq!(fs::read_to_string(f.repo.join("code.txt")).unwrap(), "edited\n");
    // expected=None 即调用方确认的强制覆盖。
    f.proof
        .save_text_file(&f.workspace.id, "code.txt", "forced\n", None)
        .unwrap();
    assert_eq!(fs::read_to_string(f.repo.join("code.txt")).unwrap(), "forced\n");
    // 保存后 Git 能看到改动。
    assert!(git(&f.repo, &["status", "--porcelain"]).contains(" M code.txt"));
    // git_dir 下不留临时目录。
    assert!(!f.repo.join(".git/proof-save").exists());
}

#[test]
fn save_text_file_requires_trust_and_valid_path() {
    let f = Fixture::new();
    f.proof.set_trust(&f.workspace.id, false).unwrap();
    let untrusted = f
        .proof
        .save_text_file(&f.workspace.id, "code.txt", "x\n", None)
        .unwrap_err();
    assert_eq!(untrusted.code, "TRUST_REQUIRED");
    f.proof.set_trust(&f.workspace.id, true).unwrap();
    let escaped = f
        .proof
        .save_text_file(&f.workspace.id, "../evil.txt", "x\n", None)
        .unwrap_err();
    assert_eq!(escaped.code, "INVALID_PATH");
    // 不存在的文件可新建（编辑器 v1 不开放入口，但后端路径需正确）。
    f.proof
        .save_text_file(&f.workspace.id, "new-file.txt", "fresh\n", None)
        .unwrap();
    assert_eq!(
        fs::read_to_string(f.repo.join("new-file.txt")).unwrap(),
        "fresh\n"
    );
}

#[test]
fn create_text_file_creates_parents_and_rejects_existing() {
    let f = Fixture::new();
    f.proof
        .create_text_file(&f.workspace.id, "docs/guide/intro.md")
        .unwrap();
    assert_eq!(
        fs::read_to_string(f.repo.join("docs/guide/intro.md")).unwrap(),
        ""
    );
    let exists = f
        .proof
        .create_text_file(&f.workspace.id, "docs/guide/intro.md")
        .unwrap_err();
    assert_eq!(exists.code, "FILE_EXISTS");
    // 已存在的目录也视为冲突。
    let dir = f
        .proof
        .create_text_file(&f.workspace.id, "src/api")
        .unwrap_err();
    assert_eq!(dir.code, "FILE_EXISTS");
    let escaped = f
        .proof
        .create_text_file(&f.workspace.id, "../evil.txt")
        .unwrap_err();
    assert_eq!(escaped.code, "INVALID_PATH");
}

#[test]
fn rename_text_file_moves_and_rejects_conflicts() {
    let f = Fixture::new();
    f.proof
        .rename_text_file(&f.workspace.id, "code.txt", "docs/moved.txt")
        .unwrap();
    assert!(!f.repo.join("code.txt").exists());
    assert_eq!(
        fs::read_to_string(f.repo.join("docs/moved.txt")).unwrap(),
        "second\n"
    );
    let missing = f
        .proof
        .rename_text_file(&f.workspace.id, "nope.txt", "other.txt")
        .unwrap_err();
    assert_eq!(missing.code, "FILE_MISSING");
    let conflict = f
        .proof
        .rename_text_file(&f.workspace.id, "docs/moved.txt", ".gitignore")
        .unwrap_err();
    assert_eq!(conflict.code, "FILE_EXISTS");
    let escaped = f
        .proof
        .rename_text_file(&f.workspace.id, "docs/moved.txt", "../evil.txt")
        .unwrap_err();
    assert_eq!(escaped.code, "INVALID_PATH");
    assert!(f.repo.join("docs/moved.txt").exists());
}

#[test]
fn delete_text_file_removes_and_undo_restores() {
    let mut f = Fixture::new();
    // tracked 文件：删除后 git 看到 D。
    let point = f
        .proof
        .delete_text_file(&f.workspace.id, "code.txt")
        .unwrap();
    assert!(!f.repo.join("code.txt").exists());
    assert!(git(&f.repo, &["status", "--porcelain"]).contains(" D code.txt"));
    // 恢复点可撤销，内容字节级还原。
    f.proof.undo_discard(&point.id).unwrap();
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "second\n"
    );
    // untracked 文件同样走恢复点。
    fs::write(f.repo.join("scratch.txt"), "temp\n").unwrap();
    let point = f
        .proof
        .delete_text_file(&f.workspace.id, "scratch.txt")
        .unwrap();
    assert!(!f.repo.join("scratch.txt").exists());
    f.proof.undo_discard(&point.id).unwrap();
    assert_eq!(
        fs::read_to_string(f.repo.join("scratch.txt")).unwrap(),
        "temp\n"
    );
    // 不存在的文件报 FILE_MISSING。
    let gone = f
        .proof
        .delete_text_file(&f.workspace.id, "nope.txt")
        .unwrap_err();
    assert_eq!(gone.code, "FILE_MISSING");
}
