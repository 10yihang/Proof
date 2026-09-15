use proof_core::{DataScope, DiagnosticMetrics, DiagnosticOptions, ObserverAgent, Proof};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{fs, path::Path, process::Command, time::Duration};
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn git(root: &Path, args: &[&str]) -> String {
    let value = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(value.status.success(), "{:?}", value);
    String::from_utf8(value.stdout).unwrap()
}
struct Fixture {
    root: tempfile::TempDir,
    proof: Proof,
    workspace: proof_core::Workspace,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("PRIVATE_PROJECT_NAME");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Diagnostic Test"]);
        git(
            &repo,
            &["config", "user.email", "diagnostic@example.invalid"],
        );
        git(&repo, &["config", "commit.gpgsign", "false"]);
        git(&repo, &["config", "core.hooksPath", "/dev/null"]);
        fs::write(repo.join("code.txt"), "PRIVATE_SOURCE_CODE\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "initial"]);
        git(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://PRIVATE_CREDENTIAL@example.invalid/PRIVATE_REMOTE",
            ],
        );
        let mut proof = Proof::open(root.path().join("data")).unwrap();
        let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
        let installation = proof
            .create_observer_registration(ObserverAgent::Codex, "0.153.4")
            .unwrap();
        let db = Connection::open(root.path().join("data/proof.sqlite3")).unwrap();
        db.execute("INSERT INTO observer_sessions VALUES('PRIVATE_SESSION',?,?,'PRIVATE_NATIVE_SESSION',NULL,?,?)",params![workspace.id,installation.installation.id,now(),now()]).unwrap();
        // The event payload is deliberately hostile. Diagnostics must never read or redact it.
        db.execute("INSERT INTO observer_events VALUES('PRIVATE_EVENT',?,?,'PRIVATE_SESSION','PRIVATE_NATIVE_KEY',?,?,?,?)",params![workspace.id,installation.installation.id,now(),json!({"prompt":"PRIVATE_PROMPT","output":"PRIVATE_COMMAND_OUTPUT","command":"PRIVATE_COMMAND","reply":"PRIVATE_REPLY"}).to_string(),now()+100_000,now()+100_000]).unwrap();
        proof
            .record_observer_gap(
                Some(&installation.installation.id),
                "transport_queue_full",
                Some(3),
            )
            .unwrap();
        db.execute("INSERT INTO observer_gaps VALUES('PRIVATE_GAP',NULL,?,'PRIVATE_ERROR_STRING',NULL,?,NULL)",params![workspace.id,now()]).unwrap();
        Self {
            root,
            proof,
            workspace,
        }
    }
    fn preview(&mut self, options: DiagnosticOptions) -> proof_core::DiagnosticPreview {
        let generation = self.proof.diagnostic_generation().unwrap();
        let mut metrics = DiagnosticMetrics::default();
        metrics.record(
            generation,
            Some(generation.data_epoch),
            "file_diff",
            Duration::from_millis(27),
            Some("PRIVATE_ERROR_STRING"),
            Some(&json!({"output":"PRIVATE_OUTPUT"})),
        );
        metrics.record(
            generation,
            Some(generation.data_epoch),
            "changes",
            Duration::from_millis(15),
            None,
            Some(&json!({"gitVersion":"git version 2.53.0 (PRIVATE_SUFFIX)"})),
        );
        self.proof
            .prepare_diagnostic(options, metrics.snapshot(generation))
            .unwrap()
    }
}
#[test]
fn default_projection_excludes_all_content_identifiers_paths_urls_and_error_prose() {
    let mut f = Fixture::new();
    let preview = f.preview(DiagnosticOptions::default());
    assert!(!preview.content.contains("PRIVATE_"));
    assert!(!preview.content.contains(&f.workspace.id));
    assert!(!preview.content.contains(&f.workspace.path));
    let doc: Value = serde_json::from_str(&preview.content).unwrap();
    assert_eq!(doc["additional"], json!({}));
    assert_eq!(doc["performance"]["summary"]["gitVersion"], "2.53.0");
    assert_eq!(
        doc["performance"]["summary"]["errors"]["UNCLASSIFIED_ERROR"],
        1
    );
    assert_eq!(
        doc["observerGaps"]["byCode"]["transport_queue_full"]["knownDroppedEvents"],
        3
    );
    assert_eq!(doc["records"]["observerEvents"], 1);
    assert_eq!(doc["observerQueue"]["status"], "unavailable");
}
#[test]
fn opt_in_categories_are_independent_and_export_matches_preview_without_git_writes() {
    let mut f = Fixture::new();
    let repo = Path::new(&f.workspace.path);
    let head = git(repo, &["rev-parse", "HEAD"]);
    let index = fs::read(repo.join(".git/index")).unwrap();
    let config = fs::read(repo.join(".git/config")).unwrap();
    let paths = f.preview(DiagnosticOptions {
        include_paths: true,
        include_timeline: false,
    });
    let doc: Value = serde_json::from_str(&paths.content).unwrap();
    assert!(doc["additional"]["gapTimeline"].is_null());
    assert!(paths.content.contains("PRIVATE_PROJECT_NAME"));
    assert!(!paths.content.contains("PRIVATE_PROMPT"));
    assert!(!paths.content.contains("PRIVATE_CREDENTIAL"));
    let timeline = f.preview(DiagnosticOptions {
        include_paths: false,
        include_timeline: true,
    });
    let doc: Value = serde_json::from_str(&timeline.content).unwrap();
    assert!(doc["additional"]["localPaths"].is_null());
    assert!(!timeline.content.contains("PRIVATE_"));
    assert_eq!(
        doc["additional"]["gapTimeline"]["entries"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let destination = f.root.path().join("diagnostic.json");
    let job = f
        .proof
        .prepare_diagnostic_export(&paths.id, &paths.sha256)
        .unwrap();
    let saved = job.run(&destination).unwrap();
    assert_eq!(fs::read_to_string(&destination).unwrap(), paths.content);
    assert_eq!(saved.sha256, paths.sha256);
    assert_eq!(saved.bytes, paths.content.len());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let repo = Path::new(&f.workspace.path);
    assert_eq!(git(repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(repo.join(".git/config")).unwrap(), config);
    assert_eq!(
        fs::read_to_string(repo.join("code.txt")).unwrap(),
        "PRIVATE_SOURCE_CODE\n"
    );
}
#[test]
fn cancellation_digest_mismatch_eviction_and_duplicate_save_cannot_export() {
    let mut f = Fixture::new();
    let preview = f.preview(DiagnosticOptions::default());
    assert!(f
        .proof
        .prepare_diagnostic_export(&preview.id, "wrong")
        .is_err());
    f.proof.cancel_diagnostic(&preview.id);
    assert!(f
        .proof
        .prepare_diagnostic_export(&preview.id, &preview.sha256)
        .is_err());
    let oldest = f.preview(DiagnosticOptions::default());
    for _ in 0..4 {
        f.preview(DiagnosticOptions::default());
    }
    assert!(f
        .proof
        .validate_diagnostic(&oldest.id, &oldest.sha256)
        .is_err());
    let latest = f.preview(DiagnosticOptions::default());
    let job = f
        .proof
        .prepare_diagnostic_export(&latest.id, &latest.sha256)
        .unwrap();
    assert!(f
        .proof
        .prepare_diagnostic_export(&latest.id, &latest.sha256)
        .is_err());
    drop(job);
    assert!(!f.root.path().join("diagnostic.json").exists());
}
#[test]
fn existing_files_and_symlinks_are_not_overwritten() {
    let mut f = Fixture::new();
    let destination = f.root.path().join("existing.json");
    fs::write(&destination, "KEEP").unwrap();
    let p = f.preview(DiagnosticOptions::default());
    let error = f
        .proof
        .prepare_diagnostic_export(&p.id, &p.sha256)
        .unwrap()
        .run(&destination)
        .unwrap_err();
    assert_eq!(error.code, "DIAGNOSTIC_DESTINATION_EXISTS");
    assert_eq!(fs::read_to_string(&destination).unwrap(), "KEEP");
    #[cfg(unix)]
    {
        let link = f.root.path().join("link.json");
        std::os::unix::fs::symlink(&destination, &link).unwrap();
        let p = f.preview(DiagnosticOptions::default());
        assert!(f
            .proof
            .prepare_diagnostic_export(&p.id, &p.sha256)
            .unwrap()
            .run(&link)
            .is_err());
        assert_eq!(fs::read_to_string(&destination).unwrap(), "KEEP");
    }
}
#[test]
fn another_core_deleting_records_invalidates_prepared_exports_and_measurements() {
    let mut f = Fixture::new();
    let mut other = Proof::open(f.root.path().join("data")).unwrap();
    let p = f.preview(DiagnosticOptions {
        include_paths: true,
        include_timeline: true,
    });
    let job = f.proof.prepare_diagnostic_export(&p.id, &p.sha256).unwrap();
    let mut metrics = DiagnosticMetrics::default();
    let old = f.proof.diagnostic_generation().unwrap();
    metrics.record(
        old,
        Some(old.data_epoch),
        "changes",
        Duration::from_millis(1),
        None,
        None,
    );
    other.clear_observer_data(&f.workspace.id).unwrap();
    let destination = f.root.path().join("stale.json");
    assert_eq!(
        job.run(&destination).unwrap_err().code,
        "DIAGNOSTIC_EXPIRED"
    );
    assert!(!destination.exists());
    assert!(metrics
        .snapshot(f.proof.diagnostic_generation().unwrap())
        .actions
        .is_empty());
    let p = f.preview(DiagnosticOptions::default());
    let job = f.proof.prepare_diagnostic_export(&p.id, &p.sha256).unwrap();
    let deletion = other.prepare_data_deletion(DataScope::All).unwrap();
    other.delete_local_data(&deletion.id).unwrap();
    assert!(job.run(&destination).is_err());
    assert!(!destination.exists());
}
#[test]
fn health_projection_validates_freshness_and_does_not_export_raw_runtime_fields() {
    let mut f = Fixture::new();
    let runtime = f.root.path().join("data/observer/runtime.json");
    fs::create_dir_all(runtime.parent().unwrap()).unwrap();
    let health = json!({"schemaVersion":1,"storageGeneration":0,"cleanShutdown":false,"heartbeatAt":now(),"socketPath":"PRIVATE_SOCKET","token":"PRIVATE_TOKEN","metrics":{"received":10,"queued":2,"processing":1,"queueCapacity":4,"PRIVATE_METRIC":123}});
    fs::write(&runtime, health.to_string()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let p = f.preview(DiagnosticOptions::default());
    let doc: Value = serde_json::from_str(&p.content).unwrap();
    assert_eq!(doc["observerQueue"]["status"], "running");
    assert_eq!(doc["observerQueue"]["snapshot"]["queued"], 2);
    assert!(!p.content.contains("PRIVATE_"));
    let mut stale = health;
    stale["heartbeatAt"] = json!(0);
    fs::write(&runtime, stale.to_string()).unwrap();
    let p = f.preview(DiagnosticOptions::default());
    let doc: Value = serde_json::from_str(&p.content).unwrap();
    assert_eq!(doc["observerQueue"]["status"], "stale");
}

#[test]
fn real_adapter_states_are_preserved_and_late_measurements_do_not_cross_deletion() {
    let mut f = Fixture::new();
    let db = Connection::open(f.root.path().join("data/proof.sqlite3")).unwrap();
    for state in [
        "configured_pending",
        "receiving_unverified",
        "helper_changed",
        "revoked",
    ] {
        db.execute("UPDATE observer_installations SET state=?", [state])
            .unwrap();
        let p = f.preview(DiagnosticOptions::default());
        let doc: Value = serde_json::from_str(&p.content).unwrap();
        assert_eq!(doc["installations"]["entries"][0]["state"], state);
    }
    let old = f.proof.diagnostic_generation().unwrap();
    let mut metrics = DiagnosticMetrics::default();
    metrics.record(
        old,
        Some(old.data_epoch),
        "file_diff",
        Duration::from_millis(15),
        None,
        None,
    );
    f.proof.clear_observer_data(&f.workspace.id).unwrap();
    let current = f.proof.diagnostic_generation().unwrap();
    assert!(metrics.snapshot(current).actions.is_empty());
    metrics.record(
        old,
        Some(old.data_epoch),
        "file_diff",
        Duration::from_millis(200),
        Some("STORAGE_ERROR"),
        None,
    );
    let report = metrics.snapshot(current);
    assert!(report.actions.is_empty());
    assert!(report.errors.is_empty());
}

#[test]
#[cfg(unix)]
fn readonly_fallback_is_not_mistaken_for_a_writer_lease() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    let database = f.root.path().join("data/proof.sqlite3");
    let _other = Proof::open(f.root.path().join("data")).unwrap();
    let p = f.preview(DiagnosticOptions {
        include_paths: true,
        include_timeline: true,
    });
    let job = f.proof.prepare_diagnostic_export(&p.id, &p.sha256).unwrap();
    fs::set_permissions(&database, fs::Permissions::from_mode(0o444)).unwrap();
    let connection =
        Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .unwrap();
    let actually_readonly = connection.is_readonly("main").unwrap();
    let destination = f.root.path().join("readonly.json");
    let result = job.run(&destination);
    fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(actually_readonly, "fixture must run as a non-root user");
    assert_eq!(result.unwrap_err().code, "DIAGNOSTIC_STORAGE_READONLY");
    assert!(!destination.exists());
}
#[test]
fn application_information_exports_when_the_store_cannot_even_open() {
    let root = tempfile::tempdir().unwrap();
    let blocked = root.path().join("PRIVATE_DATA_LOCATION");
    fs::write(&blocked, "KEEP").unwrap();
    let error = match Proof::open(&blocked) {
        Err(e) => e,
        Ok(_) => panic!("Fixture should block the store"),
    };
    let mut diagnostics =
        proof_core::ApplicationDiagnostics::new(blocked.clone(), Some(&error.code));
    let p = diagnostics.prepare().unwrap();
    assert!(p.application_only);
    assert!(!p.content.contains("PRIVATE"));
    assert!(!p.content.contains(root.path().to_str().unwrap()));
    let json: Value = serde_json::from_str(&p.content).unwrap();
    assert_eq!(json["scope"], "application_only");
    assert_eq!(json["localRecordsRead"], false);
    assert!(json["startupErrorCode"].is_string());
    let destination = root.path().join("application.json");
    diagnostics
        .take_export(&p.id, &p.sha256)
        .unwrap()
        .run(&destination)
        .unwrap();
    assert_eq!(fs::read_to_string(destination).unwrap(), p.content);
    assert_eq!(fs::read_to_string(blocked).unwrap(), "KEEP");
    let p = diagnostics.prepare().unwrap();
    diagnostics.cancel(&p.id);
    assert!(diagnostics.take_export(&p.id, &p.sha256).is_err());
}

#[test]
#[cfg(unix)]
fn application_report_cannot_export_into_data_alias_or_use_a_forged_preview() {
    let mut f = Fixture::new();
    let alias = f.root.path().join("data-alias");
    std::os::unix::fs::symlink(f.root.path().join("data"), &alias).unwrap();
    let mut application = proof_core::ApplicationDiagnostics::new(alias.clone(), None);
    let ordinary = f.preview(DiagnosticOptions {
        include_paths: true,
        include_timeline: true,
    });
    assert!(application
        .take_export(&ordinary.id, &ordinary.sha256)
        .is_err());
    let mut p = application.prepare().unwrap();
    let original = p.content.clone();
    p.content = "PRIVATE_FORGED_BODY".into();
    let destination = f.root.path().join("safe-application.json");
    application
        .take_export(&p.id, &p.sha256)
        .unwrap()
        .run(&destination)
        .unwrap();
    assert_eq!(fs::read_to_string(destination).unwrap(), original);
    let p = application.prepare().unwrap();
    let inner = alias.join("application.json");
    assert!(application
        .take_export(&p.id, &p.sha256)
        .unwrap()
        .run(&inner)
        .is_err());
    assert!(!inner.exists());
}
