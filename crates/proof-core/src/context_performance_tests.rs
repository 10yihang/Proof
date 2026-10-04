use super::*;
use serde_json::json;
use std::{
    fs,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
    time::Instant,
};

static STATEMENTS: AtomicUsize = AtomicUsize::new(0);
fn count_statement(_: rusqlite::trace::TraceEvent<'_>) {
    STATEMENTS.fetch_add(1, Ordering::Relaxed);
}

fn fixture(sessions: usize, events: usize) -> (tempfile::TempDir, Proof, crate::Workspace) {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .arg(&repo)
        .status()
        .unwrap()
        .success());
    fs::write(repo.join("file.txt"), "fixture\n").unwrap();
    let mut proof = Proof::open(temp.path().join("data")).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    let registration = proof
        .create_observer_registration(ObserverAgent::Claude, "2.1.236")
        .unwrap();
    let at = now();
    let tx = rusqlite::Transaction::new_unchecked(
        &proof.store.connection,
        TransactionBehavior::Immediate,
    )
    .unwrap();
    for s in 0..sessions {
        tx.execute(
            "INSERT INTO observer_sessions VALUES(?,?,?,?,?,?,?)",
            params![
                format!("session-{s}"),
                workspace.id,
                registration.installation.id,
                format!("native-{s}"),
                None::<String>,
                at,
                at
            ],
        )
        .unwrap();
    }
    for i in 0..events {
        let session = format!("session-{}", i % sessions);
        let id = format!("event-{i:06}");
        let path = if i / sessions % 4 == 0 {
            "file.txt"
        } else {
            "other.txt"
        };
        let payload = json!({"id":id,"idOrigin":"local","workspaceId":workspace.id,"installationId":registration.installation.id,"sessionId":session,"nativeSessionId":session,"nativeAgentId":null,"nativeEventKey":id,"turnId":format!("turn-{}",i/sessions),"agent":"claude","kind":"PostToolUse","sourceAt":null,"receivedAt":at+i as u64,"bridgeStartedAt":at,"toolName":"Write","toolRef":id,"paths":[path],"prompt":format!("Task {session}"),"command":null,"reply":null,"output":null,"exitCode":null,"commandState":"not_provided","validationState":"no_structured_report","versionRelation":"unconfirmed_post_only","matchedContentHashes":{},"fieldStatus":{"prompt":"recorded"},"possiblyDuplicate":false,"truncated":false});
        tx.execute(
            "INSERT INTO observer_events VALUES(?,?,?,?,?,?,?,?,?)",
            params![
                id,
                workspace.id,
                registration.installation.id,
                session,
                id,
                at + i as u64,
                payload.to_string(),
                at + OBSERVATION_RETENTION_MS,
                at + OBSERVATION_RETENTION_MS
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    (temp, proof, workspace)
}

#[test]
#[ignore = "same-fixture context performance measurement; no Agent or user repository"]
fn context_overview_benchmark() {
    for sessions in [1, 30] {
        let (_temp, proof, workspace) = fixture(sessions, 10_000);
        proof.store.connection.trace_v2(
            rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
            Some(count_statement),
        );
        let mut samples = Vec::new();
        let mut statements = Vec::new();
        for _ in 0..5 {
            STATEMENTS.store(0, Ordering::Relaxed);
            let started = Instant::now();
            let result = proof.context_overview(&workspace.id, "file.txt").unwrap();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            statements.push(STATEMENTS.load(Ordering::Relaxed));
            assert_eq!(result.links.len(), sessions);
            assert_eq!(
                result
                    .links
                    .iter()
                    .map(|l| l.original_evidence.path_event_count)
                    .sum::<u64>(),
                if sessions == 1 { 2500 } else { 2520 }
            );
        }
        println!("BENCH context sessions={sessions} events=10000 milliseconds={samples:?} sql_statements={statements:?}");
    }
}

#[test]
fn batch_links_preserve_revisions_evidence_prompt_and_order() {
    let (_temp, proof, workspace) = fixture(30, 1_000);
    let ids: Vec<_> = (0..30).rev().map(|s| format!("session-{s}")).collect();
    let before = ids
        .iter()
        .map(|id| {
            serde_json::to_value(
                link(&proof.store.connection, &workspace.id, "file.txt", id).unwrap(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        serde_json::to_value(
            links(&proof.store.connection, &workspace.id, "file.txt", &ids).unwrap()
        )
        .unwrap(),
        serde_json::to_value(before).unwrap()
    );
    // A manually linked session without file events uses its full-session prompt.
    let before = ids
        .iter()
        .map(|id| {
            serde_json::to_value(
                link(&proof.store.connection, &workspace.id, "missing.txt", id).unwrap(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        serde_json::to_value(
            links(&proof.store.connection, &workspace.id, "missing.txt", &ids).unwrap()
        )
        .unwrap(),
        serde_json::to_value(before).unwrap()
    );
}

#[test]
fn overview_statement_count_stays_bounded_across_sessions() {
    let (_temp, proof, workspace) = fixture(30, 300);
    STATEMENTS.store(0, Ordering::Relaxed);
    proof.store.connection.trace_v2(
        rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
        Some(count_statement),
    );
    assert_eq!(
        proof
            .context_overview(&workspace.id, "file.txt")
            .unwrap()
            .links
            .len(),
        30
    );
    assert!(STATEMENTS.load(Ordering::Relaxed) <= 10);
}

#[test]
fn version_seven_paths_backfill_and_follow_updates_expiry_and_deletion() {
    let (temp, proof, workspace) = fixture(1, 12);
    let original = proof.context_overview(&workspace.id, "file.txt").unwrap();
    let revision = original.links[0].revision.clone();
    proof.store.connection.execute_batch("DROP TRIGGER observer_paths_inserted; DROP TRIGGER observer_paths_updated; DROP TRIGGER observer_paths_deleted; DROP TABLE observer_event_paths; PRAGMA user_version=7;").unwrap();
    drop(proof);
    let proof = Proof::open(temp.path().join("data")).unwrap();
    let next = proof.context_overview(&workspace.id, "file.txt").unwrap();
    assert_eq!(next.links[0].revision, revision);
    assert_eq!(next.links[0].original_evidence.path_event_count, 3);
    let before = serde_json::to_value(&next).unwrap();
    let changes = proof.store.connection.total_changes();
    let redacted=proof.store.connection.execute("UPDATE observer_events SET payload=json_set(payload,'$.output',NULL,'$.fieldStatus.output','expired')",[]).unwrap();
    assert_eq!(
        proof.store.connection.total_changes() - changes,
        redacted as u64,
        "output-only redaction must not rebuild path rows"
    );
    assert_eq!(
        serde_json::to_value(proof.context_overview(&workspace.id, "file.txt").unwrap()).unwrap(),
        before,
        "redaction does not alter evidence or revisions"
    );
    proof.store.connection.execute("UPDATE observer_events SET payload=json_set(payload,'$.paths',json('[\"new.txt\",\"new.txt\"]')) WHERE id='event-000000'",[]).unwrap();
    assert_eq!(
        proof
            .context_overview(&workspace.id, "new.txt")
            .unwrap()
            .links[0]
            .original_evidence
            .path_event_count,
        1
    );
    proof
        .store
        .connection
        .execute(
            "UPDATE observer_events SET expires_at=1 WHERE id='event-000000'",
            [],
        )
        .unwrap();
    assert!(proof
        .context_overview(&workspace.id, "new.txt")
        .unwrap()
        .links
        .is_empty());
    proof
        .store
        .connection
        .execute("DELETE FROM observer_events WHERE id='event-000000'", [])
        .unwrap();
    assert_eq!(
        proof
            .store
            .connection
            .query_row(
                "SELECT count(*) FROM observer_event_paths WHERE event_id='event-000000'",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn failed_path_backfill_rolls_back_index_and_schema_version_then_can_retry() {
    let (temp, proof, workspace) = fixture(1, 12);
    let before =
        serde_json::to_value(proof.context_overview(&workspace.id, "file.txt").unwrap()).unwrap();
    proof.store.connection.execute_batch("DROP TRIGGER observer_paths_inserted; DROP TRIGGER observer_paths_updated; DROP TRIGGER observer_paths_deleted;
        DROP TABLE observer_event_paths; DROP INDEX observer_event_session_order;
        CREATE TABLE observer_event_paths (event_id TEXT NOT NULL REFERENCES observer_events(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(event_id,path));
        CREATE TRIGGER reject_backfill BEFORE INSERT ON observer_event_paths BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END;
        PRAGMA user_version=7;").unwrap();
    drop(proof);
    assert!(Proof::open(temp.path().join("data")).is_err());
    let db = Connection::open(temp.path().join("data/proof.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        7
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM observer_event_paths", [], |r| r
            .get::<_, u64>(0))
            .unwrap(),
        0
    );
    assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('observer_path_lookup','observer_event_session_order','observer_paths_inserted','observer_paths_updated','observer_paths_deleted')",[],|r|r.get::<_,u64>(0)).unwrap(),0);
    db.execute_batch("DROP TRIGGER reject_backfill;").unwrap();
    drop(db);
    let proof = Proof::open(temp.path().join("data")).unwrap();
    assert_eq!(
        serde_json::to_value(proof.context_overview(&workspace.id, "file.txt").unwrap()).unwrap(),
        before
    );
}
