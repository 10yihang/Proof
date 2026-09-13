use crate as proof_core;
use proof_core::{DataScope, Proof, Side};
use rusqlite::Connection;
use std::{fs, path::Path, process::Command};

fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
struct Fixture {
    root: tempfile::TempDir,
    proof: Proof,
    repo: std::path::PathBuf,
    workspace: proof_core::Workspace,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("source");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Proof Data Test"]);
        git(&repo, &["config", "user.email", "data@example.invalid"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        git(
            &repo,
            &[
                "config",
                "core.hooksPath",
                repo.join(".git/hooks").to_str().unwrap(),
            ],
        );
        fs::write(repo.join("code.txt"), "original\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "Initial"]);
        let mut proof = Proof::open(root.path().join("data")).unwrap();
        let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
        proof.set_trust(&workspace.id, true).unwrap();
        fs::write(repo.join("code.txt"), "DATA_DELETE_PRIVATE_CODE\n").unwrap();
        Self {
            root,
            proof,
            repo,
            workspace,
        }
    }
    fn db(&self) -> Connection {
        Connection::open(self.root.path().join("data/proof.sqlite3")).unwrap()
    }
    fn mark(&mut self) -> proof_core::FileDiff {
        let diff = self
            .proof
            .file_diff(&self.workspace.id, "code.txt", Side::Unstaged)
            .unwrap();
        self.proof.mark_reviewed(&diff.id, None, true).unwrap();
        diff
    }
}

#[test]
fn standards_recovery_starting_after_lease_probe_cannot_write_after_deletion() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    static BLOCKED: AtomicBool = AtomicBool::new(false);
    let mut f = Fixture::new();
    let diff = f.mark();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    let before = fs::read(f.repo.join("code.txt")).unwrap();
    let mut worker = Proof::open(f.root.path().join("data")).unwrap();
    worker
        .store
        .connection
        .busy_handler(Some(|_| {
            BLOCKED.store(true, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(1));
            true
        }))
        .unwrap();
    let (start, ready) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        ready.recv().unwrap();
        worker.discard(&point.id)
    });
    let mut triggered = false;
    f.proof.store.connection.update_hook(Some(
        move |_: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
            if table == "data_file_deletions" && !triggered {
                triggered = true;
                start.send(()).unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                while !BLOCKED.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
        },
    ));
    let preview = f
        .proof
        .prepare_data_deletion(DataScope::Repository {
            repository_id: f.workspace.repository_id.clone(),
        })
        .unwrap();
    let result = f.proof.delete_local_data(&preview.id).unwrap();
    let recovery = thread.join().unwrap();
    eprintln!(
        "recovery blocked on SQL={}, deletion epoch={}, recovery={:?}",
        BLOCKED.load(Ordering::SeqCst),
        result.session.epoch,
        recovery
    );
    assert!(BLOCKED.load(Ordering::SeqCst));
    assert!(recovery.is_err());
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), before);
    assert_eq!(
        f.db()
            .query_row("SELECT count(*) FROM recovery_points", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
}
