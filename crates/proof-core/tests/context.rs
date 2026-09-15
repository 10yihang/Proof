use proof_core::{
    ContextAction, ContextLink, ContextMutation, ObserverAgent, ObserverConsent, ObserverInput,
    ObserverRegistrationSecret, Proof, Workspace,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, path::Path, process::Command};

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn git(repo: &Path, args: &[&str]) {
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
}
struct Fixture {
    root: tempfile::TempDir,
    proof: Proof,
    workspace: Workspace,
    installation: ObserverRegistrationSecret,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Context Test"]);
        git(&repo, &["config", "user.email", "context@example.invalid"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        git(&repo, &["config", "core.hooksPath", "/dev/null"]);
        fs::write(repo.join("file.txt"), "initial\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "Initial"]);
        let mut proof = Proof::open(root.path().join("data")).unwrap();
        let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
        let installation = proof
            .create_observer_registration(ObserverAgent::Claude, "2.1.236")
            .unwrap();
        let result = Self {
            root,
            proof,
            workspace,
            installation,
        };
        result.authorize(&result.workspace);
        result
    }
    fn authorize(&self, workspace: &Workspace) {
        self.proof.set_trust(&workspace.id, true).unwrap();
        self.proof
            .set_observer_consent(&ObserverConsent {
                installation_id: self.installation.installation.id.clone(),
                workspace_id: workspace.id.clone(),
                enabled: true,
                prompt: true,
                command: true,
                reply: true,
                output: true,
                background: false,
            })
            .unwrap();
    }
    fn ingest(&self, workspace: &Workspace, session: Option<&str>, call: &str, path: &str) {
        self.ingest_as(workspace, session, call, path, None);
    }
    fn ingest_as(
        &self,
        workspace: &Workspace,
        session: Option<&str>,
        call: &str,
        path: &str,
        child: Option<&str>,
    ) {
        let payload = json!({"hook_event_name":"PostToolUse", "cwd": workspace.path,
            "session_id":session, "agent_id":child, "tool_use_id":call, "tool_name":"Write",
            "tool_input":{"file_path":path,"content":"initial\n"}, "tool_response":{"success":true},
            "prompt":format!("Task {session:?}"), "last_assistant_message":"Tests passed, says the Agent"});
        assert!(self
            .proof
            .ingest_observer_event(ObserverInput {
                installation_id: &self.installation.installation.id,
                token: &self.installation.token,
                agent: ObserverAgent::Claude,
                agent_version: "2.1.236",
                payload: &serde_json::to_vec(&payload).unwrap(),
                bridge_started_at: now(),
                foreground_lease_until: Some(now() + 5000),
                received_policy_revision: self.proof.observer_policy_revision().unwrap(),
                received_at: now(),
            })
            .unwrap());
    }
    fn candidate(&self, native: &str) -> ContextLink {
        self.proof
            .context_candidates(&self.workspace.id, "file.txt", native, None)
            .unwrap()
            .links
            .remove(0)
    }
    fn update(&self, link: &ContextLink, action: ContextAction, note: &str) -> ContextMutation {
        self.proof
            .update_context_association(
                &self.workspace.id,
                "file.txt",
                &link.session.id,
                action,
                note,
                &link.revision,
            )
            .unwrap()
    }
    fn db(&self) -> Connection {
        Connection::open(self.root.path().join("data/proof.sqlite3")).unwrap()
    }
    fn original_payloads(&self) -> Vec<String> {
        self.db()
            .prepare("SELECT payload FROM observer_events ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }
}

#[test]
fn corrections_are_reversible_and_preserve_original_events_and_git() {
    let f = Fixture::new();
    f.ingest(&f.workspace, Some("observed"), "write-1", "file.txt");
    f.ingest(&f.workspace, Some("unrelated"), "write-2", "other.txt");
    let original = f.original_payloads();
    let paths = [
        "file.txt",
        ".git/index",
        ".git/HEAD",
        ".git/config",
        ".git/refs/heads/main",
    ];
    let before: Vec<_> = paths
        .iter()
        .map(|p| fs::read(Path::new(&f.workspace.path).join(p)).unwrap())
        .collect();
    let auto = f.candidate("observed");
    assert!(auto.active && auto.user_override.is_none());
    assert!(auto.original_evidence.matched_at_capture);
    let excluded = f.update(
        &auto,
        ContextAction::Exclude,
        "This session is unrelated to my change",
    );
    assert!(f
        .proof
        .observer_file_context(&f.workspace.id, "file.txt")
        .unwrap()
        .is_empty());
    let entry = excluded.change.unwrap();
    assert_eq!(entry.original_evidence.path_event_count, 1);
    assert_eq!(serde_json::to_value(entry.source).unwrap(), "user");
    f.proof
        .undo_context_association(&f.workspace.id, "file.txt", &entry.id, &entry.revision)
        .unwrap();
    assert_eq!(
        f.proof
            .context_overview(&f.workspace.id, "file.txt")
            .unwrap()
            .links
            .len(),
        1
    );
    let manual = f.update(
        &f.candidate("unrelated"),
        ContextAction::Link,
        "My explicit link",
    );
    assert_eq!(
        manual
            .change
            .as_ref()
            .unwrap()
            .original_evidence
            .path_event_count,
        0
    );
    assert_eq!(
        f.proof
            .observer_file_context(&f.workspace.id, "file.txt")
            .unwrap()
            .len(),
        2
    );
    let edited = f
        .update(
            &f.candidate("unrelated"),
            ContextAction::Link,
            "Updated note",
        )
        .change
        .unwrap();
    f.proof
        .undo_context_association(&f.workspace.id, "file.txt", &edited.id, &edited.revision)
        .unwrap();
    assert_eq!(
        f.candidate("unrelated").user_override.unwrap().note,
        "My explicit link"
    );
    f.update(&f.candidate("unrelated"), ContextAction::Automatic, "");
    assert!(!f.candidate("unrelated").active);
    let history = f
        .proof
        .context_history(&f.workspace.id, "file.txt", 0)
        .unwrap();
    assert_eq!(history.entries.len(), 6);
    assert_eq!(history.entries.iter().filter(|e| e.can_undo).count(), 2);
    assert_eq!(f.original_payloads(), original);
    for (path, bytes) in paths.iter().zip(before) {
        assert_eq!(
            fs::read(Path::new(&f.workspace.path).join(path)).unwrap(),
            bytes,
            "{path}"
        );
    }
    let reopened = Proof::open(f.root.path().join("data")).unwrap();
    assert_eq!(
        reopened
            .context_history(&f.workspace.id, "file.txt", 0)
            .unwrap()
            .entries
            .len(),
        6
    );
}

#[test]
fn same_native_session_never_crosses_clone_worktree_or_subagent_boundaries() {
    let mut f = Fixture::new();
    let linked_path = f.root.path().join("linked");
    let clone_path = f.root.path().join("clone");
    git(
        Path::new(&f.workspace.path),
        &[
            "worktree",
            "add",
            "-b",
            "linked",
            linked_path.to_str().unwrap(),
        ],
    );
    git(
        f.root.path(),
        &[
            "clone",
            "--local",
            &f.workspace.path,
            clone_path.to_str().unwrap(),
        ],
    );
    let linked = f
        .proof
        .open_workspace(linked_path.to_str().unwrap())
        .unwrap();
    let clone = f
        .proof
        .open_workspace(clone_path.to_str().unwrap())
        .unwrap();
    for w in [&f.workspace, &linked, &clone] {
        f.authorize(w);
        f.ingest(w, Some("same-native-id"), "same-call", "file.txt");
    }
    let a = f.candidate("same-native-id");
    for w in [&linked, &clone] {
        let links = f
            .proof
            .context_candidates(&w.id, "file.txt", "", None)
            .unwrap()
            .links;
        assert_eq!(links.len(), 1);
        assert_ne!(links[0].session.id, a.session.id);
        assert!(f
            .proof
            .context_session_events(&f.workspace.id, &links[0].session.id, None)
            .is_err());
        assert!(f
            .proof
            .update_context_association(
                &w.id,
                "file.txt",
                &a.session.id,
                ContextAction::Link,
                "",
                &a.revision
            )
            .is_err());
    }
    f.ingest_as(
        &f.workspace,
        Some("same-native-id"),
        "same-call",
        "file.txt",
        Some("child-agent"),
    );
    let child = f
        .proof
        .context_candidates(&f.workspace.id, "file.txt", "child-agent", None)
        .unwrap()
        .links
        .remove(0);
    assert_eq!(
        child.session.native_agent_id.as_deref(),
        Some("child-agent")
    );
    assert_ne!(child.session.id, a.session.id);
    f.ingest(&f.workspace, None, "local-call-1", "file.txt");
    f.ingest(&f.workspace, None, "local-call-2", "file.txt");
    let links = f
        .proof
        .context_candidates(&f.workspace.id, "file.txt", "", None)
        .unwrap()
        .links;
    assert_eq!(links.len(), 4);
    assert_eq!(
        links
            .iter()
            .filter(|l| l.session.native_session_id.is_none())
            .count(),
        2
    );
}

#[test]
fn revisions_prevent_lost_notes_and_aba_but_allow_independent_session_edits() {
    let f = Fixture::new();
    f.ingest(&f.workspace, Some("A"), "a", "file.txt");
    f.ingest(&f.workspace, Some("B"), "b", "file.txt");
    let a = f.candidate("Task Some(\"A\")");
    let b = f.candidate("Task Some(\"B\")");
    let first = f.update(&a, ContextAction::Link, "note").change.unwrap();
    f.update(&b, ContextAction::Link, "independent");
    assert_eq!(
        f.proof
            .update_context_association(
                &f.workspace.id,
                "file.txt",
                &a.session.id,
                ContextAction::Link,
                "stale",
                &a.revision
            )
            .unwrap_err()
            .code,
        "CONTEXT_CHANGED"
    );
    let undone = f
        .proof
        .undo_context_association(&f.workspace.id, "file.txt", &first.id, &first.revision)
        .unwrap();
    assert!(undone.change.unwrap().after.is_none());
    assert_eq!(
        f.proof
            .update_context_association(
                &f.workspace.id,
                "file.txt",
                &a.session.id,
                ContextAction::Link,
                "old ABA",
                &a.revision
            )
            .unwrap_err()
            .code,
        "CONTEXT_CHANGED"
    );
}

#[test]
fn failed_history_write_rolls_back_override_and_keeps_revision() {
    let f = Fixture::new();
    f.ingest(&f.workspace, Some("session"), "write", "file.txt");
    let before = f.candidate("session");
    f.db().execute_batch("CREATE TRIGGER fail_context BEFORE INSERT ON observer_association_history BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;").unwrap();
    assert!(f
        .proof
        .update_context_association(
            &f.workspace.id,
            "file.txt",
            &before.session.id,
            ContextAction::Link,
            "not saved",
            &before.revision
        )
        .is_err());
    let after = f.candidate("session");
    assert_eq!(after.revision, before.revision);
    assert!(after.user_override.is_none());
    assert!(f
        .proof
        .context_history(&f.workspace.id, "file.txt", 0)
        .unwrap()
        .entries
        .is_empty());
}

#[test]
fn expired_sources_leave_notes_but_clearing_observations_invalidates_pending_corrections() {
    let f = Fixture::new();
    f.ingest(&f.workspace, Some("session"), "write", "file.txt");
    f.update(
        &f.candidate("session"),
        ContextAction::Link,
        "Keep note until its own retention expires",
    );
    f.db()
        .execute("UPDATE observer_events SET expires_at=1", [])
        .unwrap();
    let link = f.candidate("session");
    assert!(link.session.cleared);
    assert_eq!(link.original_evidence.path_event_count, 0);
    assert!(
        f.proof
            .context_session_events(&f.workspace.id, &link.session.id, None)
            .unwrap()
            .cleared
    );
    let edited = f.update(&link, ContextAction::Link, "Local note remains editable");
    let excluded = f.update(&f.candidate("session"), ContextAction::Exclude, "");
    assert!(f
        .proof
        .context_overview(&f.workspace.id, "file.txt")
        .unwrap()
        .links
        .is_empty());
    let excluded = excluded.change.unwrap();
    f.proof
        .undo_context_association(
            &f.workspace.id,
            "file.txt",
            &excluded.id,
            &excluded.revision,
        )
        .unwrap();
    let stale = f.candidate("session");
    f.proof.clear_observer_data(&f.workspace.id).unwrap();
    assert!(f
        .proof
        .update_context_association(
            &f.workspace.id,
            "file.txt",
            &stale.session.id,
            ContextAction::Link,
            "cannot resurrect",
            &stale.revision
        )
        .is_err());
    assert!(f
        .proof
        .undo_context_association(
            &f.workspace.id,
            "file.txt",
            &edited.change.unwrap().id,
            &edited.revision
        )
        .is_err());
    assert!(f
        .proof
        .context_candidates(&f.workspace.id, "file.txt", "", None)
        .unwrap()
        .links
        .is_empty());
    assert!(f
        .proof
        .context_history(&f.workspace.id, "file.txt", 0)
        .unwrap()
        .entries
        .is_empty());
}

#[test]
fn history_pages_have_stable_order_and_only_latest_per_session_can_be_undone() {
    let f = Fixture::new();
    f.ingest(&f.workspace, Some("session"), "write", "file.txt");
    for i in 0..36 {
        f.update(
            &f.candidate("session"),
            ContextAction::Link,
            &format!("note {i}"),
        );
    }
    let page = f
        .proof
        .context_history(&f.workspace.id, "file.txt", 0)
        .unwrap();
    assert_eq!(page.entries.len(), 30);
    assert_eq!(page.entries[0].after.as_ref().unwrap().note, "note 35");
    assert_eq!(page.entries.iter().filter(|e| e.can_undo).count(), 1);
    let older = &page.entries[1];
    assert!(f
        .proof
        .undo_context_association(&f.workspace.id, "file.txt", &older.id, &older.revision)
        .is_err());
    let rest = f
        .proof
        .context_history(&f.workspace.id, "file.txt", page.next_offset.unwrap())
        .unwrap();
    assert_eq!(rest.entries.len(), 6);
    assert!(rest.next_offset.is_none());
    let payload: Value = serde_json::from_str(&f.db().query_row("SELECT payload FROM observer_association_history ORDER BY CAST(json_extract(payload,'$.sequence') AS INTEGER) DESC LIMIT 1",[],|r|r.get::<_,String>(0)).unwrap()).unwrap();
    assert_eq!(payload["source"], "user");
    assert_eq!(payload["sequence"], 36);
}

#[test]
fn retention_and_reappearing_native_session_invalidate_the_old_editor() {
    let f = Fixture::new();
    f.ingest(&f.workspace, Some("same-session"), "old-event", "file.txt");
    f.db()
        .execute("UPDATE observer_sessions SET first_received_at=1", [])
        .unwrap();
    f.update(
        &f.candidate("same-session"),
        ContextAction::Link,
        "Recent local note",
    );
    let before_cleanup = f.candidate("same-session");
    f.db()
        .execute("UPDATE observer_events SET expires_at=1", [])
        .unwrap();
    f.proof.maintain_local_data().unwrap();
    let cleared = f.candidate(&before_cleanup.session.id);
    assert!(cleared.session.cleared);
    assert_ne!(cleared.revision, before_cleanup.revision);
    f.ingest(&f.workspace, Some("same-session"), "new-event", "file.txt");
    let next = f.candidate("same-session");
    assert_eq!(next.session.id, before_cleanup.session.id);
    assert_ne!(next.revision, before_cleanup.revision);
    assert!(f
        .proof
        .update_context_association(
            &f.workspace.id,
            "file.txt",
            &next.session.id,
            ContextAction::Link,
            "stale source",
            &before_cleanup.revision
        )
        .is_err());
    assert_eq!(next.user_override.unwrap().note, "Recent local note");
}

#[test]
fn session_events_page_without_duplicates_and_mask_expired_output_without_rewriting_evidence() {
    let f = Fixture::new();
    for i in 0..25 {
        f.ingest(
            &f.workspace,
            Some("session"),
            &format!("call-{i}"),
            "file.txt",
        );
    }
    let link = f.candidate("session");
    f.db().execute("UPDATE observer_events SET content_expires_at=1,payload=json_set(payload,'$.output','expired output','$.fieldStatus.output','recorded','$.fieldStatus.prompt','not_authorized','$.prompt',NULL)",[]).unwrap();
    let original = f.original_payloads();
    let first = f
        .proof
        .context_session_events(&f.workspace.id, &link.session.id, None)
        .unwrap();
    assert_eq!(first.events.len(), 20);
    assert!(first
        .events
        .iter()
        .all(|e| e.output.is_none() && e.field_status["output"] == "expired"));
    assert_eq!(first.expiry.len(), 20);
    assert!(first
        .expiry
        .values()
        .all(|e| e.content_expires_at == 1 && e.expires_at > now()));
    let rest = f
        .proof
        .context_session_events(&f.workspace.id, &link.session.id, first.next)
        .unwrap();
    assert_eq!(rest.events.len(), 5);
    assert!(rest.next.is_none());
    assert!(rest
        .events
        .iter()
        .all(|e| !first.events.iter().any(|f| f.id == e.id)));
    assert_eq!(
        f.proof
            .context_overview(&f.workspace.id, "file.txt")
            .unwrap()
            .links[0]
            .session
            .prompt_status,
        "not_authorized"
    );
    assert_eq!(f.original_payloads(), original);
}

#[test]
fn candidate_cursor_survives_new_activity_and_removed_earlier_rows() {
    let f = Fixture::new();
    for i in 0..31 {
        let native = format!("native-{i:03}");
        f.ingest(&f.workspace, Some(&native), "write", "file.txt");
        f.db()
            .execute(
                "UPDATE observer_sessions SET first_received_at=? WHERE native_session_id=?",
                rusqlite::params![i + 1, native],
            )
            .unwrap();
    }
    let first = f
        .proof
        .context_candidates(&f.workspace.id, "file.txt", "", None)
        .unwrap();
    assert_eq!(first.links.len(), 30);
    let unread = f.candidate("native-000");
    assert!(!first
        .links
        .iter()
        .any(|l| l.session.id == unread.session.id));
    f.ingest(&f.workspace, Some("native-000"), "new-activity", "file.txt");
    f.db()
        .execute(
            "UPDATE observer_events SET expires_at=1 WHERE session_id=?",
            [&first.links[0].session.id],
        )
        .unwrap();
    f.proof.maintain_local_data().unwrap();
    let second = f
        .proof
        .context_candidates(&f.workspace.id, "file.txt", "", first.next)
        .unwrap();
    assert_eq!(second.links.len(), 1);
    assert_eq!(second.links[0].session.id, unread.session.id);
    assert!(second.next.is_none());
}

#[test]
fn expired_history_cannot_revalidate_an_old_editor_in_a_continuing_session() {
    let f = Fixture::new();
    f.ingest(&f.workspace, Some("continues"), "write", "file.txt");
    let original = f.candidate("continues");
    f.update(&original, ContextAction::Link, "Temporary note");
    f.db().execute_batch("UPDATE observer_associations SET updated_at=1; UPDATE observer_association_history SET created_at=1;").unwrap();
    assert_ne!(f.candidate("continues").revision, original.revision);
    f.proof.maintain_local_data().unwrap();
    assert_ne!(f.candidate("continues").revision, original.revision);
    assert!(f
        .proof
        .update_context_association(
            &f.workspace.id,
            "file.txt",
            &original.session.id,
            ContextAction::Link,
            "old note",
            &original.revision
        )
        .is_err());
    // A deletion through an older helper's SQL also runs the database trigger.
    let latest = f.candidate("continues");
    f.update(&latest, ContextAction::Link, "Removed by peer");
    f.db()
        .execute_batch(
            "DELETE FROM observer_associations; DELETE FROM observer_association_history;",
        )
        .unwrap();
    assert_ne!(f.candidate("continues").revision, latest.revision);
}

#[test]
fn mutation_rejects_unsafe_paths_oversized_notes_and_replaced_git_identity() {
    let f = Fixture::new();
    f.ingest(&f.workspace, Some("session"), "write", "file.txt");
    let link = f.candidate("session");
    for path in [
        "",
        "../file.txt",
        "/tmp/file.txt",
        ".git/config",
        "nested/.GIT/config",
    ] {
        assert!(
            f.proof.context_overview(&f.workspace.id, path).is_err(),
            "{path}"
        );
    }
    for note in ["字".repeat(2001), "a\0b".into()] {
        assert!(f
            .proof
            .update_context_association(
                &f.workspace.id,
                "file.txt",
                &link.session.id,
                ContextAction::Link,
                &note,
                &link.revision
            )
            .is_err());
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(f.root.path(), Path::new(&f.workspace.path).join("outside"))
            .unwrap();
        assert!(f
            .proof
            .context_overview(&f.workspace.id, "outside/file.txt")
            .is_err());
    }
    fs::rename(
        Path::new(&f.workspace.path).join(".git"),
        f.root.path().join("old-git"),
    )
    .unwrap();
    // Reading already captured metadata needs no live Git process or source checkout.
    assert_eq!(
        f.proof
            .context_overview(&f.workspace.id, "file.txt")
            .unwrap()
            .links
            .len(),
        1
    );
    git(Path::new(&f.workspace.path), &["init", "-b", "main"]);
    assert_eq!(
        f.proof
            .update_context_association(
                &f.workspace.id,
                "file.txt",
                &link.session.id,
                ContextAction::Link,
                "wrong repo",
                &link.revision
            )
            .unwrap_err()
            .code,
        "WORKSPACE_REPLACED"
    );
}

#[test]
fn deleting_all_data_keeps_context_usable_without_restarting_proof() {
    let mut f = Fixture::new();
    f.ingest(&f.workspace, Some("before-wipe"), "write", "file.txt");
    f.update(
        &f.candidate("before-wipe"),
        ContextAction::Link,
        "Remove this note",
    );
    let deletion = f
        .proof
        .prepare_data_deletion(proof_core::DataScope::All)
        .unwrap();
    f.proof.delete_local_data(&deletion.id).unwrap();
    f.workspace = f
        .proof
        .open_workspace(f.root.path().join("repo").to_str().unwrap())
        .unwrap();
    f.installation = f
        .proof
        .create_observer_registration(ObserverAgent::Claude, "2.1.236")
        .unwrap();
    f.authorize(&f.workspace);
    f.ingest(&f.workspace, Some("after-wipe"), "write", "file.txt");
    let link = f.candidate("after-wipe");
    assert!(link.active && link.user_override.is_none());
    f.update(&link, ContextAction::Link, "A new note after deletion");
    assert_eq!(
        f.proof
            .context_history(&f.workspace.id, "file.txt", 0)
            .unwrap()
            .entries
            .len(),
        1
    );
}
