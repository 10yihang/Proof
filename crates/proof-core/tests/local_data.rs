use proof_core::{DataScope, ObserverAgent, ObserverConsent, Proof, RepositoryLayout, Side};
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
    fn registration(&self) -> proof_core::ObserverRegistrationSecret {
        self.proof
            .create_observer_registration(ObserverAgent::Codex, "0.153.4")
            .unwrap()
    }
}

#[test]
fn removing_recent_keeps_records_trust_and_source_even_when_repository_is_missing() {
    let mut f = Fixture::new();
    f.mark();
    let head = git(&f.repo, &["rev-parse", "HEAD"]);
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let hidden = f.root.path().join("moved");
    fs::rename(&f.repo, &hidden).unwrap();
    f.proof.remove_recent_workspace(&f.workspace.id).unwrap();
    assert!(f.proof.recent_workspaces().unwrap().is_empty());
    let stored = f.proof.data_workspaces().unwrap();
    assert_eq!(stored.len(), 1);
    assert!(!stored[0].recent);
    assert!(stored[0].workspace.trusted);
    assert_eq!(
        f.db()
            .query_row("SELECT count(*) FROM review_marks", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        1
    );
    fs::rename(&hidden, &f.repo).unwrap();
    let again = f.proof.open_workspace(f.repo.to_str().unwrap()).unwrap();
    assert_eq!(again.id, f.workspace.id);
    assert!(again.trusted);
    assert_eq!(f.proof.recent_workspaces().unwrap().len(), 1);
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
}

#[test]
fn deleting_repository_clears_linked_records_backups_and_snapshots_but_keeps_clone() {
    let mut f = Fixture::new();
    let diff = f.mark();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    f.proof.discard(&point.id).unwrap();
    let sibling = f.root.path().join("linked");
    git(
        &f.repo,
        &["worktree", "add", "-b", "linked", sibling.to_str().unwrap()],
    );
    let linked = f.proof.open_workspace(sibling.to_str().unwrap()).unwrap();
    let clone = f.root.path().join("clone");
    git(
        f.root.path(),
        &[
            "clone",
            "--no-hardlinks",
            f.repo.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    let independent = f.proof.open_workspace(clone.to_str().unwrap()).unwrap();
    f.proof
        .set_repository_layout(
            &f.workspace.id,
            RepositoryLayout {
                sidebar_width: 321,
                ..RepositoryLayout::default()
            },
        )
        .unwrap();
    f.proof
        .set_repository_layout(
            &independent.id,
            RepositoryLayout {
                sidebar_width: 333,
                ..RepositoryLayout::default()
            },
        )
        .unwrap();
    let secret = f.registration();
    f.proof
        .set_observer_consent(&ObserverConsent {
            installation_id: secret.installation.id,
            workspace_id: f.workspace.id.clone(),
            enabled: true,
            prompt: true,
            command: false,
            reply: false,
            output: false,
            background: true,
        })
        .unwrap();
    let source = fs::read(f.repo.join("code.txt")).unwrap();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let config = fs::read(f.repo.join(".git/config")).unwrap();
    let head = git(&f.repo, &["rev-parse", "HEAD"]);
    let plan = f
        .proof
        .prepare_data_deletion(DataScope::Repository {
            repository_id: f.workspace.repository_id.clone(),
        })
        .unwrap();
    assert_eq!(plan.workspaces.len(), 2);
    let deleted = f.proof.delete_local_data(&plan.id).unwrap();
    assert_eq!(deleted.deleted_workspace_ids.len(), 2);
    assert!(deleted.session.deleted_workspace_ids.contains(&linked.id));
    assert!(deleted.cleanup.wal_checkpoint_complete);
    assert_eq!(deleted.cleanup.pending_content_deletions, 0);
    assert!(!f.root.path().join("data/recovery").join(&point.id).exists());
    assert!(f.proof.recovery_content(&point.id).is_err());
    assert!(f.proof.stage(&diff.id, None).is_err());
    assert_eq!(f.proof.data_workspaces().unwrap().len(), 1);
    assert_eq!(
        f.proof
            .repository_layout(&independent.id)
            .unwrap()
            .sidebar_width,
        333
    );
    assert_eq!(fs::read(f.repo.join("code.txt")).unwrap(), source);
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(f.repo.join(".git/config")).unwrap(), config);
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]), head);
    let mut reopened = Proof::open(f.root.path().join("data")).unwrap();
    let new = reopened.open_workspace(f.repo.to_str().unwrap()).unwrap();
    assert_ne!(new.id, f.workspace.id);
    assert!(!new.trusted);
    assert!(reopened.observer_consents().unwrap().is_empty());
    assert_eq!(
        f.db()
            .query_row("SELECT count(*) FROM review_marks", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
    for filename in ["proof.sqlite3", "proof.sqlite3-wal"] {
        if let Ok(bytes) = fs::read(f.root.path().join("data").join(filename)) {
            assert!(!bytes
                .windows(b"DATA_DELETE_PRIVATE_CODE".len())
                .any(|w| w == b"DATA_DELETE_PRIVATE_CODE"));
        }
    }
}

#[test]
fn global_delete_resets_settings_and_registrations_with_a_durable_client_wipe() {
    let mut f = Fixture::new();
    f.mark();
    let secret = f.registration();
    let mut preferences = f.proof.preferences().unwrap();
    preferences.font_size = 24;
    f.proof.set_preferences(preferences).unwrap();
    f.db()
        .execute(
            "INSERT INTO settings VALUES('editor:application',?)",
            ["private app path"],
        )
        .unwrap();
    let observer = f.root.path().join("data/observer");
    fs::create_dir(&observer).unwrap();
    fs::write(observer.join("foreground.json"), "private old lease").unwrap();
    fs::write(observer.join("runtime.json"), "private old metrics").unwrap();
    let plan = f.proof.prepare_data_deletion(DataScope::All).unwrap();
    let result = f.proof.delete_local_data(&plan.id).unwrap();
    assert!(result.all);
    assert_eq!(result.session.wipe_epoch, result.session.epoch);
    assert!(result.session.epoch > 0);
    assert!(result.session.deleted_workspace_ids.is_empty());
    assert_eq!(result.cleanup.pending_content_deletions, 0);
    assert!(f.proof.data_workspaces().unwrap().is_empty());
    assert_eq!(
        f.proof.preferences().unwrap().font_size,
        proof_core::Preferences::default().font_size
    );
    assert!(f.proof.observer_installations().unwrap().is_empty());
    assert!(!f
        .proof
        .observer_transport_authorized(
            &secret.installation.id,
            &secret.token,
            ObserverAgent::Codex,
            "0.153.4"
        )
        .unwrap());
    assert!(!observer.join("foreground.json").exists());
    assert!(!observer.join("runtime.json").exists());
    assert!(f.proof.check_data_epoch(0).is_err());
    assert!(f.proof.check_data_epoch(result.session.epoch).is_ok());
    let again = Proof::open(f.root.path().join("data")).unwrap();
    assert_eq!(
        again.data_session().unwrap().wipe_epoch,
        result.session.wipe_epoch
    );
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "DATA_DELETE_PRIVATE_CODE\n"
    );
}

#[test]
fn deletion_preview_is_bound_to_scope_and_database_failure_rolls_back() {
    let mut f = Fixture::new();
    f.mark();
    let plan = f.proof.prepare_data_deletion(DataScope::All).unwrap();
    let linked = f.root.path().join("later");
    git(
        &f.repo,
        &["worktree", "add", "-b", "later", linked.to_str().unwrap()],
    );
    f.proof.open_workspace(linked.to_str().unwrap()).unwrap();
    assert_eq!(
        f.proof.delete_local_data(&plan.id).unwrap_err().code,
        "DATA_SCOPE_CHANGED"
    );
    let plan = f.proof.prepare_data_deletion(DataScope::All).unwrap();
    f.db().execute_batch("CREATE TRIGGER deny_delete BEFORE DELETE ON review_marks BEGIN SELECT RAISE(ABORT,'fixture'); END").unwrap();
    assert!(f.proof.delete_local_data(&plan.id).is_err());
    assert_eq!(f.proof.data_session().unwrap().epoch, 0);
    assert_eq!(f.proof.data_workspaces().unwrap().len(), 2);
    assert_eq!(
        f.db()
            .query_row("SELECT count(*) FROM review_marks", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        1
    );
    f.db().execute_batch("DROP TRIGGER deny_delete").unwrap();
    f.proof.cancel_data_deletion(&plan.id);
    assert_eq!(
        f.proof.delete_local_data(&plan.id).unwrap_err().code,
        "DATA_PREVIEW_EXPIRED"
    );
}

#[test]
fn committed_delete_reports_pinned_wal_and_finishes_after_reader_closes() {
    let mut f = Fixture::new();
    let diff = f.mark();
    f.proof.discard_preview(&diff.id, None).unwrap();
    let reader = f.db();
    reader.execute_batch("BEGIN").unwrap();
    let old: Vec<u8> = reader
        .query_row("SELECT before_data FROM recovery_points", [], |r| r.get(0))
        .unwrap();
    assert!(old.starts_with(b"DATA_DELETE_PRIVATE_CODE"));
    let preview = f.proof.prepare_data_deletion(DataScope::All).unwrap();
    let result = f.proof.delete_local_data(&preview.id).unwrap();
    assert!(!result.cleanup.wal_checkpoint_complete);
    assert_eq!(f.proof.data_workspaces().unwrap().len(), 0);
    drop(reader);
    assert!(
        f.proof
            .maintain_local_data()
            .unwrap()
            .wal_checkpoint_complete
    );
    for filename in ["proof.sqlite3", "proof.sqlite3-wal"] {
        if let Ok(bytes) = fs::read(f.root.path().join("data").join(filename)) {
            assert!(!bytes.windows(old.len()).any(|w| w == old));
        }
    }
}

#[test]
fn file_cleanup_failure_is_durable_and_does_not_restore_deleted_records() {
    let mut f = Fixture::new();
    let diff = f.mark();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    f.proof.discard(&point.id).unwrap();
    let folder = f.root.path().join("data/recovery").join(&point.id);
    fs::create_dir(folder.join("unexpected")).unwrap();
    let preview = f.proof.prepare_data_deletion(DataScope::All).unwrap();
    let result = f.proof.delete_local_data(&preview.id).unwrap();
    assert_eq!(result.cleanup.pending_content_deletions, 1);
    assert!(result.cleanup.content_cleanup_error.is_some());
    assert!(f.proof.recovery_content(&point.id).is_err());
    let reopened = Proof::open(f.root.path().join("data")).unwrap();
    assert_eq!(
        reopened.data_usage(None).unwrap().pending_content_deletions,
        1
    );
    fs::remove_dir(folder.join("unexpected")).unwrap();
    assert_eq!(
        reopened
            .maintain_local_data()
            .unwrap()
            .pending_content_deletions,
        0
    );
    assert!(!folder.exists());
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "original\n"
    );
}

#[cfg(unix)]
#[test]
fn recovery_leases_and_symlink_storage_cannot_delete_source_files() {
    use std::os::{fd::AsRawFd, unix::fs::symlink};
    let mut f = Fixture::new();
    let diff = f.mark();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    let root = f.root.path().join("data/recovery");
    let folder = root.join(&point.id);
    let lease = fs::File::open(&folder).unwrap();
    assert_eq!(
        unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    let preview = f.proof.prepare_data_deletion(DataScope::All).unwrap();
    assert_eq!(
        f.proof.delete_local_data(&preview.id).unwrap_err().code,
        "RECOVERY_BUSY"
    );
    assert_eq!(f.proof.data_session().unwrap().epoch, 0);
    drop(lease);
    let real = f.root.path().join("moved-recovery");
    fs::rename(&root, &real).unwrap();
    symlink(&real, &root).unwrap();
    assert!(f.proof.delete_local_data(&preview.id).is_err());
    assert!(real.join(&point.id).exists());
    assert_eq!(f.proof.data_session().unwrap().epoch, 0);
    fs::remove_file(&root).unwrap();
    fs::rename(real, &root).unwrap();
    // A symlink stored as a backup is unlinked, never followed to its target.
    let outside = f.root.path().join("outside.txt");
    fs::write(&outside, "outside remains\n").unwrap();
    symlink(&outside, folder.join("original")).unwrap();
    f.proof.delete_local_data(&preview.id).unwrap();
    assert_eq!(fs::read_to_string(outside).unwrap(), "outside remains\n");
    assert_eq!(
        fs::read_to_string(f.repo.join("code.txt")).unwrap(),
        "DATA_DELETE_PRIVATE_CODE\n"
    );
}

#[test]
fn queued_observation_does_not_return_after_deletion_reopen_and_new_consent() {
    let mut f = Fixture::new();
    let secret = f.registration();
    let consent = |id: String| ObserverConsent {
        installation_id: secret.installation.id.clone(),
        workspace_id: id,
        enabled: true,
        prompt: true,
        command: false,
        reply: false,
        output: false,
        background: true,
    };
    f.proof
        .set_observer_consent(&consent(f.workspace.id.clone()))
        .unwrap();
    let revision = f.proof.observer_policy_revision().unwrap();
    let payload=serde_json::to_vec(&serde_json::json!({"hook_event_name":"UserPromptSubmit","cwd":f.repo,"session_id":"native-session","event_id":"native-event","prompt":"DATA_DELETE_PRIVATE_PROMPT"})).unwrap();
    let input = || proof_core::ObserverInput {
        installation_id: &secret.installation.id,
        token: &secret.token,
        agent: ObserverAgent::Codex,
        agent_version: "0.153.4",
        payload: &payload,
        bridge_started_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64,
        foreground_lease_until: None,
        received_policy_revision: revision,
        received_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64,
    };
    assert!(f.proof.ingest_observer_event(input()).unwrap());
    let preview = f
        .proof
        .prepare_data_deletion(DataScope::Repository {
            repository_id: f.workspace.repository_id.clone(),
        })
        .unwrap();
    f.proof.delete_local_data(&preview.id).unwrap();
    let next = f.proof.open_workspace(f.repo.to_str().unwrap()).unwrap();
    f.proof.set_trust(&next.id, true).unwrap();
    f.proof
        .set_observer_consent(&consent(next.id.clone()))
        .unwrap();
    assert!(!f.proof.ingest_observer_event(input()).unwrap());
    assert!(f
        .proof
        .observer_events(&next.id, None, 0)
        .unwrap()
        .is_empty());
}

#[test]
fn old_collector_generation_cannot_recreate_health_or_activity_after_global_delete() {
    let mut f = Fixture::new();
    let collector = Proof::open(f.root.path().join("data")).unwrap();
    let generation = collector.observer_storage_generation().unwrap();
    let preview = f.proof.prepare_data_deletion(DataScope::All).unwrap();
    f.proof.delete_local_data(&preview.id).unwrap();
    assert!(!collector
        .with_observer_storage_generation(generation, || panic!(
            "must not write old collector metadata"
        ))
        .unwrap());
    assert_eq!(
        f.db()
            .query_row("SELECT count(*) FROM observer_gaps", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn spec_all_delete_clears_crash_leftover_private_indexes() {
    let mut f = Fixture::new();
    fs::write(
        f.repo.join("PRIVATE_INDEX_FILENAME.txt"),
        "some staged content\n",
    )
    .unwrap();
    git(&f.repo, &["add", "PRIVATE_INDEX_FILENAME.txt"]);
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let data = f.root.path().join("data");
    // Stage uses TempDir::new_in(data_dir)/index; simulate its crash residue.
    let temp = tempfile::TempDir::new_in(&data).unwrap();
    fs::write(temp.path().join("index"), &index).unwrap();
    let stage_private = temp.keep();
    // Commit uses NamedTempFile::new_in(data_dir); same crash lifetime.
    let temp = tempfile::NamedTempFile::new_in(&data).unwrap();
    fs::write(temp.path(), &index).unwrap();
    let (_, commit_private) = temp.keep().unwrap();
    let preview = f.proof.prepare_data_deletion(DataScope::All).unwrap();
    let result = f.proof.delete_local_data(&preview.id).unwrap();
    eprintln!(
        "RESULT pending={} error={:?} stage_exists={} commit_exists={}",
        result.cleanup.pending_content_deletions,
        result.cleanup_error,
        stage_private.exists(),
        commit_private.exists()
    );
    assert!(
        !stage_private.exists() && !commit_private.exists(),
        "All deletion leaves Proof's private Git index caches on disk"
    );
}

#[cfg(unix)]
#[test]
fn spec_inflight_commit_cannot_repopulate_operations_after_all_deletion() {
    use std::{
        os::unix::fs::PermissionsExt,
        time::{Duration, Instant},
    };
    let mut f = Fixture::new();
    git(&f.repo, &["add", "code.txt"]);
    let preview = f
        .proof
        .prepare_commit(&f.workspace.id, false, false)
        .unwrap();
    let data = f.root.path().join("data");
    let gate = f.root.path().join("release");
    let entered = f.root.path().join("entered");
    let hook = f.repo.join(".git/hooks/pre-commit");
    fs::write(
        &hook,
        format!(
            "#!/bin/sh\ntouch '{}'\nwhile [ ! -e '{}' ]; do sleep 0.01; done\n",
            entered.display(),
            gate.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    let mut running = f.proof;
    let writer =
        std::thread::spawn(move || running.commit(&preview.id, "Already requested commit"));
    let start = Instant::now();
    while !entered.exists() && start.elapsed() < Duration::from_secs(8) {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !entered.exists() {
        fs::write(&gate, b"go").unwrap();
        let _ = writer.join();
        panic!("hook never entered");
    }
    let mut deletion = Proof::open(&data).unwrap();
    let plan = deletion.prepare_data_deletion(DataScope::All).unwrap();
    let result = deletion.delete_local_data(&plan.id);
    fs::write(&gate, b"go").unwrap();
    result.unwrap();
    let committed = writer.join().unwrap().unwrap();
    assert!(committed.ok);
    assert!(committed.warning.is_some());
    assert_eq!(
        git(&f.repo, &["log", "-1", "--format=%s"]),
        "Already requested commit"
    );
    assert_eq!(
        deletion
            .maintain_local_data()
            .unwrap()
            .pending_content_deletions,
        0
    );
    assert_eq!(fs::read_dir(data.join("transient")).unwrap().count(), 0);
    let db = Connection::open(data.join("proof.sqlite3")).unwrap();
    let operations: u64 = db
        .query_row("SELECT count(*) FROM operations", [], |r| r.get(0))
        .unwrap();
    eprintln!("OPERATIONS AFTER DELETE {operations}");
    assert_eq!(
        operations, 0,
        "inflight pre-deletion command recreated product history"
    );
}

#[test]
fn standards_pending_runtime_cleanup_must_not_remove_new_generation_metadata() {
    let mut f = Fixture::new();
    let runtime = f.root.path().join("data/observer");
    fs::create_dir_all(runtime.join("runtime.json")).unwrap();
    let preview = f.proof.prepare_data_deletion(DataScope::All).unwrap();
    let deleted = f.proof.delete_local_data(&preview.id).unwrap();
    assert_eq!(deleted.cleanup.pending_content_deletions, 1);
    fs::remove_dir(runtime.join("runtime.json")).unwrap();
    let written = f
        .proof
        .with_observer_storage_generation(deleted.session.wipe_epoch, || {
            fs::write(
                runtime.join("runtime.json"),
                "new authorized collector metadata",
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    assert!(written);
    let cleaned = f.proof.maintain_local_data().unwrap();
    eprintln!(
        "new generation={}, pending={}, new runtime exists={}",
        deleted.session.wipe_epoch,
        cleaned.pending_content_deletions,
        runtime.join("runtime.json").exists()
    );
    assert!(
        runtime.join("runtime.json").exists(),
        "old deletion job removed a later authorized collector's runtime file"
    );
}
