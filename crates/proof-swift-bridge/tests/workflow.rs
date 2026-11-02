use proof_core::Proof;
use proof_swift_bridge::{dispatch, Command, Request};
use serde_json::{json, Value};
use std::{fs, path::Path, process::Command as Process};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Process::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn call(core: &mut Proof, command: Value) -> proof_core::Result<Value> {
    dispatch(core, serde_json::from_value(command).unwrap())
}
#[test]
fn real_repository_review_stage_unstage_commit_and_history() {
    let repo = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q"]);
    git(repo.path(), &["config", "user.name", "Bridge Test"]);
    git(
        repo.path(),
        &["config", "user.email", "test@example.invalid"],
    );
    fs::write(repo.path().join("hello.txt"), "first\n").unwrap();
    git(repo.path(), &["add", "hello.txt"]);
    git(repo.path(), &["commit", "-qm", "initial"]);
    fs::write(repo.path().join("hello.txt"), "first\nsecond\n").unwrap();
    let mut core = Proof::open(data.path()).unwrap();
    let workspace = call(&mut core, json!({"method":"open", "path":repo.path()})).unwrap();
    let id = workspace["id"].as_str().unwrap();
    assert_eq!(workspace["trusted"], false);
    let diff = call(
        &mut core,
        json!({"method":"diff", "workspace":id, "path":"hello.txt", "side":"unstaged"}),
    )
    .unwrap();
    assert!(call(&mut core, json!({"method":"stage", "snapshot":diff["id"]})).is_err());
    call(
        &mut core,
        json!({"method":"trust", "workspace":id, "trusted":true}),
    )
    .unwrap();
    let diff = call(
        &mut core,
        json!({"method":"diff", "workspace":id, "path":"hello.txt", "side":"unstaged"}),
    )
    .unwrap();
    call(
        &mut core,
        json!({"method":"review", "snapshot":diff["id"], "reviewed":true}),
    )
    .unwrap();
    call(&mut core, json!({"method":"stage", "snapshot":diff["id"]})).unwrap();
    assert_eq!(
        git(repo.path(), &["diff", "--cached", "--name-only"]),
        "hello.txt"
    );
    let staged = call(
        &mut core,
        json!({"method":"diff", "workspace":id, "path":"hello.txt", "side":"staged"}),
    )
    .unwrap();
    assert_eq!(staged["hunks"][0]["reviewState"], "reviewed");
    call(
        &mut core,
        json!({"method":"stage", "snapshot":staged["id"]}),
    )
    .unwrap();
    assert_eq!(git(repo.path(), &["diff", "--cached", "--name-only"]), "");
    let diff = call(
        &mut core,
        json!({"method":"diff", "workspace":id, "path":"hello.txt", "side":"unstaged"}),
    )
    .unwrap();
    call(&mut core, json!({"method":"stage", "snapshot":diff["id"]})).unwrap();
    let changes = call(&mut core, json!({"method":"changes", "workspace":id})).unwrap();
    let preview = call(
        &mut core,
        json!({"method":"prepare_commit", "workspace":id, "token":changes["token"]}),
    )
    .unwrap();
    let result = call(&mut core, json!({"method":"commit", "preview":preview["id"], "message":"native\n\nReviewed second line"})).unwrap();
    assert_eq!(result["ok"], true);
    let history = call(
        &mut core,
        json!({"method":"history", "workspace":id, "offset":0}),
    )
    .unwrap();
    assert_eq!(history[0]["subject"], "native");
    let patch = call(
        &mut core,
        json!({"method":"commit_diff", "workspace":id, "oid":history[0]["oid"], "parent":0}),
    )
    .unwrap();
    assert!(patch.as_str().unwrap().contains("+second"));
}
#[test]
fn stale_content_and_preview_are_rejected_without_writing() {
    let repo = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q"]);
    git(repo.path(), &["config", "user.name", "Bridge Test"]);
    git(
        repo.path(),
        &["config", "user.email", "test@example.invalid"],
    );
    fs::write(repo.path().join("a"), "one\n").unwrap();
    let mut core = Proof::open(data.path()).unwrap();
    let ws = core.open_workspace(repo.path().to_str().unwrap()).unwrap();
    core.set_trust(&ws.id, true).unwrap();
    let diff = call(
        &mut core,
        json!({"method":"diff", "workspace":ws.id, "path":"a", "side":"unstaged"}),
    )
    .unwrap();
    fs::write(repo.path().join("a"), "two\n").unwrap();
    for command in [
        json!({"method":"stage", "snapshot":diff["id"]}),
        json!({"method":"review", "snapshot":diff["id"], "reviewed":true}),
    ] {
        assert_eq!(call(&mut core, command).unwrap_err().code, "STALE_CONTENT");
    }
    assert_eq!(git(repo.path(), &["diff", "--cached", "--name-only"]), "");
    git(repo.path(), &["add", "a"]);
    let changes = core.changes(&ws.id).unwrap();
    let preview = call(
        &mut core,
        json!({"method":"prepare_commit", "workspace":ws.id, "token":changes.token}),
    )
    .unwrap();
    fs::write(repo.path().join("a"), "three\n").unwrap();
    git(repo.path(), &["add", "a"]);
    assert!(call(
        &mut core,
        json!({"method":"commit", "preview":preview["id"], "message":"must not commit"})
    )
    .is_err());
    assert!(git(repo.path(), &["log", "--all", "--format=%s"]).is_empty());
}
#[test]
fn protocol_is_a_closed_whitelist() {
    for method in [
        "shell",
        "exec",
        "ai_review",
        "push",
        "discard",
        "set_preferences",
    ] {
        assert!(
            serde_json::from_value::<Request>(json!({"id":1,"command":{"method":method}})).is_err()
        );
    }
    assert!(serde_json::from_value::<Request>(
        json!({"id":1,"command":{"method":"hello","extra":"bad"}})
    )
    .is_err());
    let _: Command =
        serde_json::from_value(json!({"method":"open", "path":"/tmp/a\n\"b"})).unwrap();
}
