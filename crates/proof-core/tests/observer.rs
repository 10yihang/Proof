use proof_core::{
    ObserverAgent, ObserverConsent, ObserverInput, ObserverRegistrationSecret, Proof, Workspace,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

struct Fixture {
    _temp: tempfile::TempDir,
    data: PathBuf,
    repo: PathBuf,
    proof: Proof,
    workspace: Workspace,
    registration: ObserverRegistrationSecret,
}
fn git(path: &Path, args: &[&str]) {
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
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Proof Observer Test"]);
        git(&repo, &["config", "user.email", "proof@example.invalid"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        fs::write(repo.join("file.txt"), "initial\n").unwrap();
        git(&repo, &["add", "file.txt"]);
        git(&repo, &["commit", "-m", "Initial"]);
        let mut proof = Proof::open(&data).unwrap();
        let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
        proof.set_trust(&workspace.id, true).unwrap();
        let registration = proof
            .create_observer_registration(ObserverAgent::Claude, "2.1.236")
            .unwrap();
        Self {
            _temp: temp,
            data,
            repo,
            proof,
            workspace,
            registration,
        }
    }
    fn consent(&self) -> ObserverConsent {
        ObserverConsent {
            installation_id: self.registration.installation.id.clone(),
            workspace_id: self.workspace.id.clone(),
            enabled: true,
            prompt: false,
            command: false,
            reply: false,
            output: false,
            background: false,
        }
    }
    fn event(&self) -> Value {
        json!({"hook_event_name":"PostToolUse","cwd":self.repo,"session_id":"native-session-1","tool_use_id":"native-call-1","tool_name":"Bash",
        "tool_input":{"command":"secret-command --key=DO_NOT_STORE"},"tool_response":{"exit_code":0,"stdout":"SECRET_OUTPUT_NOT_AUTHORIZED"},"prompt":"SECRET_PROMPT_NOT_AUTHORIZED","last_assistant_message":"SECRET_REPLY_NOT_AUTHORIZED","transcript_path":"/must/not/read/transcript.jsonl"})
    }
    fn ingest(&self, value: &Value) -> bool {
        self.proof
            .ingest_observer_event(ObserverInput {
                installation_id: &self.registration.installation.id,
                token: &self.registration.token,
                agent: ObserverAgent::Claude,
                agent_version: "2.1.236",
                payload: &serde_json::to_vec(value).unwrap(),
                bridge_started_at: 1,
                foreground_lease_until: Some(lease()),
                received_policy_revision: self.proof.observer_policy_revision().unwrap(),
                received_at: lease() - 5000,
            })
            .unwrap()
    }
}
fn lease() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 5000
}

#[test]
fn l0_records_nothing_and_l1_stores_only_authorized_metadata() {
    let f = Fixture::new();
    assert!(!f.ingest(&f.event()));
    assert!(f
        .proof
        .observer_events(&f.workspace.id, None, 0)
        .unwrap()
        .is_empty());
    f.proof.set_observer_consent(&f.consent()).unwrap();
    assert!(f.ingest(&f.event()));
    let events = f.proof.observer_events(&f.workspace.id, None, 0).unwrap();
    let event = &events[0];
    assert!(
        event.prompt.is_none()
            && event.command.is_none()
            && event.reply.is_none()
            && event.output.is_none()
    );
    assert_eq!(event.exit_code, Some(0));
    assert_eq!(event.command_state, "command_succeeded");
    assert_eq!(event.validation_state, "no_structured_report");
    assert_eq!(event.version_relation, "unconfirmed_post_only");
    assert!(event.source_at.is_none());
    for path in [
        f.data.join("proof.sqlite3"),
        f.data.join("proof.sqlite3-wal"),
    ] {
        if let Ok(bytes) = fs::read(path) {
            let content = String::from_utf8_lossy(&bytes);
            assert!(
                !content.contains("SECRET_")
                    && !content.contains("DO_NOT_STORE")
                    && !content.contains("must/not/read")
            );
        }
    }
}

#[test]
fn field_consent_is_explicit_bounded_and_does_not_promote_agent_claims() {
    let f = Fixture::new();
    let mut consent = f.consent();
    consent.prompt = true;
    consent.reply = true;
    consent.output = true;
    f.proof.set_observer_consent(&consent).unwrap();
    let mut event = f.event();
    event["prompt"] = "字".repeat(30_000).into();
    event["last_assistant_message"] = "所有测试都通过了，10000个用例".into();
    assert!(f.ingest(&event));
    let event = f
        .proof
        .observer_events(&f.workspace.id, None, 0)
        .unwrap()
        .remove(0);
    assert!(event.command.is_none());
    assert!(event.truncated);
    assert!(event.prompt.as_ref().unwrap().len() <= 64 * 1024);
    let total = event.prompt.as_ref().map_or(0, |s| s.len())
        + event.reply.as_ref().map_or(0, |s| s.len())
        + event.output.as_ref().map_or(0, |s| s.len());
    assert!(total <= 64 * 1024);
    assert_eq!(event.validation_state, "no_structured_report");
    assert_eq!(event.field_status["command"], "not_authorized");
}

#[test]
fn native_tool_identity_deduplicates_but_absent_identity_does_not() {
    let f = Fixture::new();
    f.proof.set_observer_consent(&f.consent()).unwrap();
    assert!(f.ingest(&f.event()));
    assert!(!f.ingest(&f.event()));
    let mut event = f.event();
    event["hook_event_name"] = "UserPromptSubmit".into();
    event.as_object_mut().unwrap().remove("tool_use_id");
    assert!(f.ingest(&event));
    assert!(f.ingest(&event));
    let events = f.proof.observer_events(&f.workspace.id, None, 0).unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events.iter().filter(|e| e.possibly_duplicate).count(), 2);
    assert!(events.iter().all(|e| e.id_origin == "local"));
}

#[test]
fn pause_and_bad_registration_never_persist_new_events() {
    let f = Fixture::new();
    f.proof.set_observer_consent(&f.consent()).unwrap();
    assert!(!f
        .proof
        .ingest_observer_event(ObserverInput {
            installation_id: &f.registration.installation.id,
            token: "bad",
            agent: ObserverAgent::Claude,
            agent_version: "2.1.236",
            payload: &serde_json::to_vec(&f.event()).unwrap(),
            bridge_started_at: 1,
            foreground_lease_until: Some(lease()),
            received_policy_revision: f.proof.observer_policy_revision().unwrap(),
            received_at: lease() - 5000,
        })
        .unwrap());
    f.proof.pause_all_observers().unwrap();
    assert!(!f.ingest(&f.event()));
    assert!(f
        .proof
        .observer_events(&f.workspace.id, None, 0)
        .unwrap()
        .is_empty());
    assert!(!f
        .proof
        .ingest_observer_event(ObserverInput {
            installation_id: &f.registration.installation.id,
            token: &f.registration.token,
            agent: ObserverAgent::Codex,
            agent_version: "0.153.4",
            payload: &serde_json::to_vec(&f.event()).unwrap(),
            bridge_started_at: 1,
            foreground_lease_until: Some(lease()),
            received_policy_revision: f.proof.observer_policy_revision().unwrap(),
            received_at: lease() - 5000,
        })
        .unwrap());
}

#[test]
fn identical_session_ids_in_two_clones_do_not_cross_workspace_scope() {
    let mut f = Fixture::new();
    f.proof.set_observer_consent(&f.consent()).unwrap();
    assert!(f.ingest(&f.event()));
    let other = f._temp.path().join("other");
    git(
        &f.repo,
        &["clone", f.repo.to_str().unwrap(), other.to_str().unwrap()],
    );
    let workspace = f.proof.open_workspace(other.to_str().unwrap()).unwrap();
    f.proof.set_trust(&workspace.id, true).unwrap();
    let mut event = f.event();
    event["cwd"] = other.to_str().unwrap().into();
    assert!(!f.ingest(&event));
    let mut consent = f.consent();
    consent.workspace_id = workspace.id.clone();
    f.proof.set_observer_consent(&consent).unwrap();
    assert!(f.ingest(&event));
    let a = f.proof.observer_events(&f.workspace.id, None, 0).unwrap();
    let b = f.proof.observer_events(&workspace.id, None, 0).unwrap();
    assert_eq!(a.len(), 1);
    assert_eq!(b.len(), 1);
    assert_ne!(a[0].session_id, b[0].session_id);
}

#[test]
fn direct_file_evidence_requires_matching_content_and_scope() {
    let f = Fixture::new();
    f.proof.set_observer_consent(&f.consent()).unwrap();
    fs::write(f.repo.join("file.txt"), "written\n").unwrap();
    let mut event = f.event();
    event["tool_name"] = "Write".into();
    event["tool_input"] = json!({"file_path":f.repo.join("file.txt"),"content":"written\n"});
    event["tool_response"] = json!({"success":true});
    assert!(f.ingest(&event));
    let events = f
        .proof
        .observer_events(&f.workspace.id, Some("file.txt"), 0)
        .unwrap();
    assert_eq!(events.len(), 1);
    assert!(events[0].matched_content_hashes.contains_key("file.txt"));
    fs::write(f.repo.join("file.txt"), "later external edit\n").unwrap();
    event["tool_use_id"] = "next-call".into();
    assert!(f.ingest(&event));
    let events = f
        .proof
        .observer_events(&f.workspace.id, Some("file.txt"), 0)
        .unwrap();
    assert!(events[0].matched_content_hashes.is_empty());
    event["tool_use_id"] = "outside".into();
    event["tool_input"]["file_path"] = "../outside.txt".into();
    assert!(f.ingest(&event));
    let events = f.proof.observer_events(&f.workspace.id, None, 0).unwrap();
    assert!(events[0].paths.is_empty());
    assert_eq!(events[0].field_status["paths"], "limited_or_outside_scope");
}

#[test]
fn foreground_expiry_blocks_ingestion_without_background_authorization() {
    let f = Fixture::new();
    let mut consent = f.consent();
    f.proof.set_observer_consent(&consent).unwrap();
    let event = serde_json::to_vec(&f.event()).unwrap();
    let submit = || {
        f.proof
            .ingest_observer_event(ObserverInput {
                installation_id: &f.registration.installation.id,
                token: &f.registration.token,
                agent: ObserverAgent::Claude,
                agent_version: "2.1.236",
                payload: &event,
                bridge_started_at: 1,
                foreground_lease_until: None,
                received_policy_revision: f.proof.observer_policy_revision().unwrap(),
                received_at: lease() - 5000,
            })
            .unwrap()
    };
    assert!(!submit());
    consent.background = true;
    f.proof.set_observer_consent(&consent).unwrap();
    assert!(submit());
    assert_eq!(
        f.proof
            .observer_events(&f.workspace.id, None, 0)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn queued_event_cannot_gain_later_field_consent_or_resume_authorization() {
    let f = Fixture::new();
    let mut consent = f.consent();
    f.proof.set_observer_consent(&consent).unwrap();
    let initial_revision = f.proof.observer_policy_revision().unwrap();
    consent.prompt = true;
    f.proof.set_observer_consent(&consent).unwrap();
    let submit = |revision| {
        f.proof
            .ingest_observer_event(ObserverInput {
                installation_id: &f.registration.installation.id,
                token: &f.registration.token,
                agent: ObserverAgent::Claude,
                agent_version: "2.1.236",
                payload: &serde_json::to_vec(&f.event()).unwrap(),
                bridge_started_at: 1,
                foreground_lease_until: Some(lease()),
                received_policy_revision: revision,
                received_at: lease() - 5000,
            })
            .unwrap()
    };
    assert!(!submit(initial_revision));
    f.proof.pause_all_observers().unwrap();
    let paused_revision = f.proof.observer_policy_revision().unwrap();
    f.proof.set_observer_consent(&consent).unwrap();
    assert!(!submit(paused_revision));
    assert!(f
        .proof
        .observer_events(&f.workspace.id, None, 0)
        .unwrap()
        .is_empty());
    assert!(f.ingest(&f.event()));
}

#[test]
fn parent_consent_excludes_nested_repository_and_git_metadata_paths() {
    let f = Fixture::new();
    f.proof.set_observer_consent(&f.consent()).unwrap();
    let nested = f.repo.join("nested");
    fs::create_dir(&nested).unwrap();
    git(&nested, &["init", "-b", "main"]);
    fs::write(nested.join("secret.txt"), "nested secret\n").unwrap();
    let mut event = f.event();
    event["tool_name"] = "Write".into();
    event["tool_response"] = json!({"success":true});
    event["tool_input"] =
        json!({"file_path":nested.join("secret.txt"),"content":"nested secret\n"});
    assert!(f.ingest(&event));
    let rows = f.proof.observer_events(&f.workspace.id, None, 0).unwrap();
    assert!(rows[0].paths.is_empty() && rows[0].matched_content_hashes.is_empty());
    assert_eq!(rows[0].field_status["paths"], "limited_or_outside_scope");
    event["tool_use_id"] = "metadata-call".into();
    event["tool_input"]["file_path"] = f.repo.join(".git/config").to_str().unwrap().into();
    assert!(f.ingest(&event));
    let rows = f.proof.observer_events(&f.workspace.id, None, 0).unwrap();
    assert!(rows
        .iter()
        .all(|e| e.paths.is_empty() && e.matched_content_hashes.is_empty()));
}

#[test]
fn actual_git_metadata_with_a_custom_directory_name_is_excluded() {
    let mut f = Fixture::new();
    let metadata = f.repo.join("repository-metadata");
    git(
        &f.repo,
        &["init", "--separate-git-dir", metadata.to_str().unwrap()],
    );
    f.workspace = f.proof.open_workspace(f.repo.to_str().unwrap()).unwrap();
    f.proof.set_trust(&f.workspace.id, true).unwrap();
    f.proof.set_observer_consent(&f.consent()).unwrap();
    let event = json!({"hook_event_name":"PostToolUse","cwd":f.repo,"session_id":"metadata","tool_use_id":"metadata-write","tool_name":"Write","tool_input":{"file_path":metadata.join("config"),"content":fs::read_to_string(metadata.join("config")).unwrap()},"tool_response":{"success":true}});
    assert!(f.ingest(&event));
    let rows = f.proof.observer_events(&f.workspace.id, None, 0).unwrap();
    assert!(rows[0].paths.is_empty() && rows[0].matched_content_hashes.is_empty());
}

fn assert_not_in_database_files(data: &Path, secret: &str) {
    for name in ["proof.sqlite3", "proof.sqlite3-wal", "proof.sqlite3-shm"] {
        if let Ok(bytes) = fs::read(data.join(name)) {
            assert!(
                !bytes.windows(secret.len()).any(|w| w == secret.as_bytes()),
                "secret remained in {name}"
            );
        }
    }
}

#[test]
fn retention_redacts_output_then_deletes_task_events_and_database_copies() {
    let f = Fixture::new();
    let mut consent = f.consent();
    consent.prompt = true;
    consent.output = true;
    f.proof.set_observer_consent(&consent).unwrap();
    let mut event = f.event();
    event["prompt"] = "TASK_RETAINED_UNTIL_30_DAYS".into();
    event["tool_response"]["stdout"] = "OUTPUT_DELETE_AT_7_DAYS_EXACT".into();
    assert!(f.ingest(&event));
    let database = rusqlite::Connection::open(f.data.join("proof.sqlite3")).unwrap();
    database
        .execute("UPDATE observer_events SET content_expires_at=0", [])
        .unwrap();
    let report = f.proof.maintain_local_data().unwrap();
    assert_eq!(report.redacted_outputs, 1);
    assert!(report.wal_checkpoint_complete);
    let rows = f.proof.observer_events(&f.workspace.id, None, 0).unwrap();
    assert_eq!(
        rows[0].prompt.as_deref(),
        Some("TASK_RETAINED_UNTIL_30_DAYS")
    );
    assert!(rows[0].output.is_none());
    assert_eq!(rows[0].field_status["output"], "expired");
    assert_not_in_database_files(&f.data, "OUTPUT_DELETE_AT_7_DAYS_EXACT");
    database
        .execute("UPDATE observer_events SET expires_at=0", [])
        .unwrap();
    let report = f.proof.maintain_local_data().unwrap();
    assert_eq!(report.deleted_events, 1);
    assert_eq!(report.deleted_sessions, 1);
    assert!(report.wal_checkpoint_complete);
    assert_not_in_database_files(&f.data, "TASK_RETAINED_UNTIL_30_DAYS");
    assert!(Proof::open(&f.data)
        .unwrap()
        .observer_events(&f.workspace.id, None, 0)
        .unwrap()
        .is_empty());
}

#[test]
fn explicit_cleanup_pauses_scope_and_reports_a_reader_that_pins_old_wal() {
    let f = Fixture::new();
    let mut consent = f.consent();
    consent.prompt = true;
    f.proof.set_observer_consent(&consent).unwrap();
    let mut event = f.event();
    event["prompt"] = "DELETED_TASK_MUST_NOT_REAPPEAR".into();
    assert!(f.ingest(&event));
    let reader = rusqlite::Connection::open(f.data.join("proof.sqlite3")).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    let _: String = reader
        .query_row("SELECT payload FROM observer_events LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    // Cleanup remains available after the source repository moves away.
    let moved = f._temp.path().join("moved-repo");
    fs::rename(&f.repo, &moved).unwrap();
    let report = f.proof.clear_observer_data(&f.workspace.id).unwrap();
    assert_eq!(report.deleted_events, 1);
    assert!(!report.wal_checkpoint_complete);
    assert!(
        f.proof
            .data_usage(Some(&f.workspace.id))
            .unwrap()
            .cleanup_pending
    );
    assert!(!f.proof.observer_consents().unwrap()[0].enabled);
    reader.execute_batch("ROLLBACK").unwrap();
    drop(reader);
    assert!(
        f.proof
            .maintain_local_data()
            .unwrap()
            .wal_checkpoint_complete
    );
    assert_not_in_database_files(&f.data, "DELETED_TASK_MUST_NOT_REAPPEAR");
    let reopened = Proof::open(&f.data).unwrap();
    let usage = reopened.data_usage(Some(&f.workspace.id)).unwrap();
    assert_eq!(usage.observer_events, 0);
    assert_eq!(usage.observer_sessions, 0);
    assert!(!usage.cleanup_pending);
    assert_eq!(fs::read(moved.join("file.txt")).unwrap(), b"initial\n");
    git(&moved, &["diff", "--exit-code", "HEAD"]);
}

#[test]
fn soft_limit_stops_new_event_content_and_recovers_after_space_is_freed() {
    let f = Fixture::new();
    f.proof.set_observer_consent(&f.consent()).unwrap();
    let large = f.data.join("bounded-quota-fixture");
    fs::File::create(&large)
        .unwrap()
        .set_len(proof_core::DATA_SOFT_LIMIT)
        .unwrap();
    let result = f.proof.ingest_observer_event(ObserverInput {
        installation_id: &f.registration.installation.id,
        token: &f.registration.token,
        agent: ObserverAgent::Claude,
        agent_version: "2.1.236",
        payload: &serde_json::to_vec(&f.event()).unwrap(),
        bridge_started_at: 1,
        foreground_lease_until: Some(lease()),
        received_policy_revision: f.proof.observer_policy_revision().unwrap(),
        received_at: lease() - 5000,
    });
    assert!(matches!(result,Err(error) if error.code=="OBSERVER_STORAGE_LIMIT"));
    let usage = f.proof.data_usage(Some(&f.workspace.id)).unwrap();
    assert!(usage.content_collection_paused);
    assert_eq!(usage.observer_events, 0);
    fs::remove_file(large).unwrap();
    assert!(f.ingest(&f.event()));
    assert!(!f.proof.data_usage(None).unwrap().content_collection_paused);
}

#[test]
fn expired_review_records_do_not_mark_current_content_reviewed() {
    let mut f = Fixture::new();
    fs::write(f.repo.join("file.txt"), "changed\n").unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "file.txt", proof_core::Side::Unstaged)
        .unwrap();
    f.proof.mark_reviewed(&diff.id, None, true).unwrap();
    let database = rusqlite::Connection::open(f.data.join("proof.sqlite3")).unwrap();
    database
        .execute_batch(
            "UPDATE review_marks SET updated_at=0; UPDATE review_events SET created_at=0;",
        )
        .unwrap();
    let report = f.proof.maintain_local_data().unwrap();
    assert!(report.deleted_review_records >= 2);
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "file.txt", proof_core::Side::Unstaged)
        .unwrap();
    assert!(diff.hunks.iter().all(|h| h.review_state == "unreviewed"));
}

#[test]
fn canceling_recovery_preview_clears_its_source_from_database_and_wal() {
    let mut f = Fixture::new();
    let secret = "CANCELED_PREVIEW_PRIVATE_SOURCE_617152";
    fs::write(f.repo.join("file.txt"), format!("{secret}\n")).unwrap();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "file.txt", proof_core::Side::Unstaged)
        .unwrap();
    let point = f.proof.discard_preview(&diff.id, None).unwrap();
    f.proof.cancel_discard_preview(&point.id).unwrap();
    assert!(
        f.proof
            .maintain_local_data()
            .unwrap()
            .wal_checkpoint_complete
    );
    assert!(!f.proof.data_usage(None).unwrap().cleanup_pending);
    assert_not_in_database_files(&f.data, secret);
    assert!(f.proof.recovery_points(&f.workspace.id).unwrap().is_empty());
    assert_eq!(
        fs::read_to_string(f.repo.join("file.txt")).unwrap(),
        format!("{secret}\n")
    );
}

#[test]
fn clearing_database_content_reclaims_free_pages_and_unblocks_capture() {
    let f = Fixture::new();
    let mut consent = f.consent();
    consent.output = true;
    f.proof.set_observer_consent(&consent).unwrap();
    let mut event = f.event();
    event["tool_response"]["stdout"] = json!("x".repeat(60 * 1024));
    assert!(f.ingest(&event));
    let db = rusqlite::Connection::open(f.data.join("proof.sqlite3")).unwrap();
    let seed: String = db
        .query_row("SELECT id FROM observer_events LIMIT 1", [], |r| r.get(0))
        .unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    for number in 0..160 {
        let id = format!("quota-fixture-{number}");
        db.execute("INSERT INTO observer_events SELECT ?1,workspace_id,installation_id,session_id,?1,received_at,json_set(payload,'$.id',?1,'$.nativeEventKey',?1),content_expires_at,expires_at FROM observer_events WHERE id=?2",rusqlite::params![id,seed]).unwrap();
    }
    db.execute_batch("COMMIT; PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    let before_size = fs::metadata(f.data.join("proof.sqlite3")).unwrap().len();
    assert!(before_size > 8 * 1024 * 1024);
    let filler = f.data.join("other-bounded-application-data");
    fs::File::create(&filler)
        .unwrap()
        .set_len(proof_core::DATA_SOFT_LIMIT - 8 * 1024 * 1024)
        .unwrap();
    assert!(f.proof.data_usage(None).unwrap().content_collection_paused);
    let cleared = f.proof.clear_observer_data(&f.workspace.id).unwrap();
    assert_eq!(cleared.deleted_events, 161);
    assert!(cleared.wal_checkpoint_complete);
    assert!(!cleared.database_compaction_pending);
    let after_size = fs::metadata(f.data.join("proof.sqlite3")).unwrap().len();
    assert!(after_size < before_size / 2);
    let usage = f.proof.data_usage(Some(&f.workspace.id)).unwrap();
    assert_eq!(usage.observer_events, 0);
    assert!(!usage.content_collection_paused);
    f.proof.set_observer_consent(&consent).unwrap();
    assert!(f.ingest(&f.event()));
}

#[test]
fn storage_status_uses_the_same_reserved_space_as_event_admission() {
    let f = Fixture::new();
    f.proof.set_observer_consent(&f.consent()).unwrap();
    let bytes = f.proof.data_usage(None).unwrap().application_bytes;
    let filler = f.data.join("nearly-full-fixture");
    fs::File::create(&filler)
        .unwrap()
        .set_len(proof_core::DATA_SOFT_LIMIT - bytes - 4096)
        .unwrap();
    let usage = f.proof.data_usage(None).unwrap();
    assert!(usage.content_collection_paused);
    let result = f.proof.ingest_observer_event(ObserverInput {
        installation_id: &f.registration.installation.id,
        token: &f.registration.token,
        agent: ObserverAgent::Claude,
        agent_version: "2.1.236",
        payload: &serde_json::to_vec(&f.event()).unwrap(),
        bridge_started_at: 1,
        foreground_lease_until: Some(lease()),
        received_policy_revision: f.proof.observer_policy_revision().unwrap(),
        received_at: lease() - 5000,
    });
    assert!(matches!(result,Err(error) if error.code=="OBSERVER_STORAGE_LIMIT"));
    assert!(f.proof.data_usage(None).unwrap().content_collection_paused);
}
