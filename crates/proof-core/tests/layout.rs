use proof_core::{Proof, RepositoryLayout, Side};
use std::{fs, path::Path, process::Command};

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
fn create_repo(path: &Path) {
    fs::create_dir_all(path).unwrap();
    git(path, &["init", "-b", "main"]);
    git(path, &["config", "user.name", "Proof Layout Test"]);
    git(path, &["config", "user.email", "layout@example.invalid"]);
    git(path, &["config", "commit.gpgsign", "false"]);
    git(
        path,
        &[
            "config",
            "core.hooksPath",
            path.join(".git/hooks").to_str().unwrap(),
        ],
    );
    fs::write(path.join("code.txt"), "original\n").unwrap();
    git(path, &["add", "code.txt"]);
    git(path, &["commit", "-m", "Initial"]);
}

#[test]
fn layout_shares_local_repository_survives_reopen_and_reset_preserves_work() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    create_repo(&repo);
    let sibling = temp.path().join("sibling");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-b",
            "sibling",
            sibling.to_str().unwrap(),
        ],
    );
    let clone = temp.path().join("clone");
    git(
        temp.path(),
        &[
            "clone",
            "--no-hardlinks",
            repo.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    let data = temp.path().join("data");
    let mut proof = Proof::open(&data).unwrap();
    let a = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    let b = proof.open_workspace(sibling.to_str().unwrap()).unwrap();
    let c = proof.open_workspace(clone.to_str().unwrap()).unwrap();
    assert_eq!(a.repository_id, b.repository_id);
    assert_ne!(a.id, b.id);
    assert_ne!(a.repository_id, c.repository_id);
    proof.set_trust(&a.id, true).unwrap();
    fs::write(repo.join("code.txt"), "reviewed change\n").unwrap();
    fs::write(
        repo.join("agent-config.json"),
        "{\"hooks\":\"owned by user\"}",
    )
    .unwrap();
    let diff = proof.file_diff(&a.id, "code.txt", Side::Unstaged).unwrap();
    proof
        .mark_reviewed(&diff.id, Some(&diff.hunks[0].id), true)
        .unwrap();
    let index = fs::read(repo.join(".git/index")).unwrap();
    let config = fs::read(repo.join(".git/config")).unwrap();
    let mut prefs = proof.preferences().unwrap();
    prefs.font_size = 19;
    proof.set_preferences(prefs).unwrap();
    let layout = RepositoryLayout {
        sidebar_width: 370,
        context_width: 410,
        sidebar_open: false,
        context_open: Some(true),
    };
    proof.set_repository_layout(&a.id, layout.clone()).unwrap();
    assert_eq!(proof.repository_layout(&b.id).unwrap(), layout);
    assert_eq!(
        proof.repository_layout(&c.id).unwrap(),
        RepositoryLayout::default()
    );
    drop(proof);
    let mut reopened = Proof::open(&data).unwrap();
    assert_eq!(reopened.repository_layout(&a.id).unwrap(), layout);
    reopened
        .set_repository_layout(&b.id, RepositoryLayout::default())
        .unwrap();
    assert_eq!(
        reopened.repository_layout(&a.id).unwrap(),
        RepositoryLayout::default()
    );
    assert_eq!(reopened.preferences().unwrap().font_size, 19);
    let after = reopened
        .file_diff(&a.id, "code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(after.hunks[0].review_state, "reviewed");
    assert_eq!(after.patch, diff.patch);
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(repo.join(".git/config")).unwrap(), config);
    assert_eq!(
        fs::read_to_string(repo.join("agent-config.json")).unwrap(),
        "{\"hooks\":\"owned by user\"}"
    );
    assert_eq!(reopened.recent_workspaces().unwrap().len(), 3);
}

#[test]
fn invalid_or_failed_layout_updates_preserve_saved_value_and_replaced_identity_does_not_inherit() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    create_repo(&repo);
    let data = temp.path().join("data");
    let mut proof = Proof::open(&data).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    let saved = RepositoryLayout {
        sidebar_width: 320,
        ..RepositoryLayout::default()
    };
    proof
        .set_repository_layout(&workspace.id, saved.clone())
        .unwrap();
    for layout in [
        RepositoryLayout {
            sidebar_width: 0,
            ..saved.clone()
        },
        RepositoryLayout {
            context_width: 65535,
            ..saved.clone()
        },
    ] {
        assert_eq!(
            proof
                .set_repository_layout(&workspace.id, layout)
                .unwrap_err()
                .code,
            "INVALID_LAYOUT"
        );
    }
    assert!(proof
        .set_repository_layout("unknown", saved.clone())
        .is_err());
    let db = rusqlite::Connection::open(data.join("proof.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_layout BEFORE UPDATE ON repository_layouts BEGIN SELECT RAISE(FAIL,'injected storage failure'); END;").unwrap();
    assert!(proof
        .set_repository_layout(&workspace.id, RepositoryLayout::default())
        .is_err());
    assert_eq!(proof.repository_layout(&workspace.id).unwrap(), saved);
    db.execute_batch("DROP TRIGGER fail_layout").unwrap();
    fs::rename(repo.join(".git"), temp.path().join("retired-git")).unwrap();
    git(&repo, &["init", "-b", "main"]);
    assert_eq!(
        proof.repository_layout(&workspace.id).unwrap_err().code,
        "WORKSPACE_REPLACED"
    );
    assert_eq!(
        proof
            .set_repository_layout(&workspace.id, saved)
            .unwrap_err()
            .code,
        "WORKSPACE_REPLACED"
    );
    let replacement = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    assert_ne!(replacement.repository_id, workspace.repository_id);
    assert_eq!(
        proof.repository_layout(&replacement.id).unwrap(),
        RepositoryLayout::default()
    );
}

#[test]
fn schema_three_migrates_without_replacing_existing_preferences() {
    let temp = tempfile::tempdir().unwrap();
    let proof = Proof::open(temp.path()).unwrap();
    let mut prefs = proof.preferences().unwrap();
    prefs.font_size = 21;
    proof.set_preferences(prefs).unwrap();
    drop(proof);
    let db = rusqlite::Connection::open(temp.path().join("proof.sqlite3")).unwrap();
    db.execute_batch("DROP TABLE repository_layouts; PRAGMA user_version=3;")
        .unwrap();
    drop(db);
    let proof = Proof::open(temp.path()).unwrap();
    assert_eq!(proof.preferences().unwrap().font_size, 21);
    let db = rusqlite::Connection::open(temp.path().join("proof.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        4
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM repository_layouts", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
}
