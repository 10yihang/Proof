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
        "checkout",
        "create_branch",
        "delete_branch",
        "fetch",
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

#[test]
fn branches_are_read_only_and_include_local_and_cached_remote_refs() {
    let repo = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q"]);
    git(repo.path(), &["config", "user.name", "Bridge Test"]);
    git(
        repo.path(),
        &["config", "user.email", "test@example.invalid"],
    );
    let mut core = Proof::open(data.path()).unwrap();
    let workspace = call(&mut core, json!({"method":"open", "path":repo.path()})).unwrap();
    let id = workspace["id"].as_str().unwrap();
    let request = json!({"method":"branches", "workspace":id});
    let command: Command = serde_json::from_value(request.clone()).unwrap();
    assert!(command.cancellable());
    assert_eq!(call(&mut core, request.clone()).unwrap(), json!([]));

    fs::write(repo.path().join("a"), "one\n").unwrap();
    git(repo.path(), &["add", "a"]);
    git(repo.path(), &["commit", "-qm", "initial"]);
    git(repo.path(), &["branch", "feature/native"]);
    let head = git(repo.path(), &["rev-parse", "HEAD"]);
    let current = git(repo.path(), &["branch", "--show-current"]);
    git(
        repo.path(),
        &["update-ref", "refs/remotes/origin/main", &head],
    );
    fs::write(repo.path().join("a"), "two\n").unwrap();
    git(repo.path(), &["add", "a"]);
    let status_before = git(repo.path(), &["status", "--porcelain"]);
    let index_before = fs::read(repo.path().join(".git/index")).unwrap();

    let rows = call(&mut core, request).unwrap();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows
        .iter()
        .any(|row| row["name"] == current && row["current"] == true && row["remote"] == false));
    assert!(rows.iter().any(|row| row["name"] == "feature/native"
        && row["current"] == false
        && row["remote"] == false));
    assert!(rows
        .iter()
        .any(|row| row["name"] == "origin/main" && row["remote"] == true));
    assert!(rows.iter().all(|row| row["oid"] == head));
    assert_eq!(
        fs::read(repo.path().join(".git/index")).unwrap(),
        index_before
    );
    assert_eq!(git(repo.path(), &["status", "--porcelain"]), status_before);
    assert_eq!(git(repo.path(), &["rev-parse", "HEAD"]), head);
    assert_eq!(git(repo.path(), &["branch", "--show-current"]), current);
    assert_eq!(workspace["trusted"], false);
}

fn repository() -> (tempfile::TempDir, Proof, String) {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-qb", "main"]);
    git(&repo, &["config", "user.name", "Bridge Test"]);
    git(&repo, &["config", "user.email", "test@example.invalid"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    git(&repo, &["config", "core.hooksPath", "/dev/null"]);
    fs::write(
        repo.join("a"),
        (1..=30).map(|i| format!("line {i}\n")).collect::<String>(),
    )
    .unwrap();
    git(&repo, &["add", "a"]);
    git(&repo, &["commit", "-qm", "initial"]);
    let mut core = Proof::open(temp.path().join("data")).unwrap();
    let ws = core.open_workspace(repo.to_str().unwrap()).unwrap();
    (temp, core, ws.id)
}
fn prepare(core: &mut Proof, id: &str, request: Value) -> proof_core::Result<Value> {
    let token = core.changes(id).unwrap().token;
    call(
        core,
        json!({"method":"prepare_history_action", "workspace":id, "token":token, "request":request}),
    )
}
fn execute(core: &mut Proof, id: &str, preview: &Value) -> proof_core::Result<Value> {
    call(
        core,
        json!({"method":"execute_history_action", "workspace":id, "preview":preview["id"]}),
    )
}

#[test]
fn branch_previews_require_trust_reject_stale_state_and_cannot_replay() {
    let (temp, mut core, id) = repository();
    let repo = temp.path().join("repo");
    git(&repo, &["branch", "feature"]);
    let request = json!({"kind":"switch", "target":"refs/heads/feature"});
    assert_eq!(
        prepare(&mut core, &id, request.clone()).unwrap_err().code,
        "TRUST_REQUIRED"
    );
    core.set_trust(&id, true).unwrap();
    let preview = prepare(&mut core, &id, request.clone()).unwrap();
    fs::write(repo.join("new"), "changed after preview").unwrap();
    assert!(execute(&mut core, &id, &preview).is_err());
    assert_eq!(git(&repo, &["branch", "--show-current"]), "main");
    let preview = prepare(&mut core, &id, request.clone()).unwrap();
    core.set_trust(&id, false).unwrap();
    assert_eq!(
        execute(&mut core, &id, &preview).unwrap_err().code,
        "TRUST_REQUIRED"
    );
    core.set_trust(&id, true).unwrap();
    let preview = prepare(&mut core, &id, request).unwrap();
    assert_eq!(execute(&mut core, &id, &preview).unwrap()["ok"], true);
    assert_eq!(git(&repo, &["branch", "--show-current"]), "feature");
    assert!(execute(&mut core, &id, &preview).is_err());
}

#[test]
fn local_remote_fetch_pull_push_and_tracking_switch_use_previews() {
    let (temp, mut core, id) = repository();
    let repo = temp.path().join("repo");
    let remote = temp.path().join("remote.git");
    fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "--bare", "-q"]);
    git(
        &repo,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    core.set_trust(&id, true).unwrap();
    let push = prepare(&mut core, &id, json!({"kind":"push", "remote":"origin"})).unwrap();
    assert_eq!(execute(&mut core, &id, &push).unwrap()["ok"], true);
    assert_eq!(
        git(&remote, &["rev-parse", "refs/heads/main"]),
        git(&repo, &["rev-parse", "HEAD"])
    );
    let peer = temp.path().join("peer");
    git(
        temp.path(),
        &[
            "clone",
            "-qb",
            "main",
            remote.to_str().unwrap(),
            peer.to_str().unwrap(),
        ],
    );
    git(&peer, &["config", "user.name", "Bridge Peer"]);
    git(&peer, &["config", "user.email", "peer@example.invalid"]);
    git(&peer, &["config", "commit.gpgsign", "false"]);
    git(&peer, &["config", "core.hooksPath", "/dev/null"]);
    fs::write(peer.join("remote.txt"), "from peer\n").unwrap();
    git(&peer, &["add", "remote.txt"]);
    git(&peer, &["commit", "-qm", "peer change"]);
    git(&peer, &["push", "-q", "origin", "main"]);
    let before = git(&repo, &["rev-parse", "HEAD"]);
    let fetch = prepare(&mut core, &id, json!({"kind":"fetch", "remote":"origin"})).unwrap();
    assert_eq!(execute(&mut core, &id, &fetch).unwrap()["ok"], true);
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), before);
    let state = call(&mut core, json!({"method":"history_state", "workspace":id})).unwrap();
    assert_eq!(state["behind"], 1);
    let pull = prepare(
        &mut core,
        &id,
        json!({"kind":"pull", "remote":"origin", "name":"main"}),
    )
    .unwrap();
    assert!(pull["arguments"]
        .as_array()
        .unwrap()
        .contains(&json!("--ff-only")));
    assert_eq!(execute(&mut core, &id, &pull).unwrap()["ok"], true);
    assert_eq!(
        fs::read_to_string(repo.join("remote.txt")).unwrap(),
        "from peer\n"
    );
    git(
        &peer,
        &["push", "-q", "origin", "HEAD:refs/heads/remote-feature"],
    );
    let fetch = prepare(&mut core, &id, json!({"kind":"fetch", "remote":"origin"})).unwrap();
    assert_eq!(execute(&mut core, &id, &fetch).unwrap()["ok"], true);
    let switch = prepare(&mut core, &id, json!({"kind":"switch", "target":"refs/remotes/origin/remote-feature", "name":"remote-feature"})).unwrap();
    assert_eq!(execute(&mut core, &id, &switch).unwrap()["ok"], true);
    assert_eq!(git(&repo, &["branch", "--show-current"]), "remote-feature");
}

#[test]
fn hunk_review_stage_unstage_leave_the_other_hunk_untouched() {
    let (temp, mut core, id) = repository();
    let repo = temp.path().join("repo");
    let original = fs::read_to_string(repo.join("a")).unwrap();
    fs::write(
        repo.join("a"),
        original
            .replace("line 2\n", "changed 2\n")
            .replace("line 28\n", "changed 28\n"),
    )
    .unwrap();
    core.set_trust(&id, true).unwrap();
    let diff = call(
        &mut core,
        json!({"method":"diff", "workspace":id, "path":"a", "side":"unstaged"}),
    )
    .unwrap();
    assert_eq!(diff["hunks"].as_array().unwrap().len(), 2);
    call(&mut core, json!({"method":"review", "snapshot":diff["id"], "hunk":diff["hunks"][0]["id"], "reviewed":true})).unwrap();
    call(
        &mut core,
        json!({"method":"stage", "snapshot":diff["id"], "hunk":diff["hunks"][0]["id"]}),
    )
    .unwrap();
    let staged = call(
        &mut core,
        json!({"method":"diff", "workspace":id, "path":"a", "side":"staged"}),
    )
    .unwrap();
    assert_eq!(staged["hunks"].as_array().unwrap().len(), 1);
    assert_eq!(staged["hunks"][0]["reviewState"], "reviewed");
    assert!(git(&repo, &["diff", "--cached"]).contains("+changed 2"));
    assert!(!git(&repo, &["diff", "--cached"]).contains("+changed 28"));
    call(
        &mut core,
        json!({"method":"stage", "snapshot":staged["id"], "hunk":staged["hunks"][0]["id"]}),
    )
    .unwrap();
    assert!(git(&repo, &["diff", "--cached"]).is_empty());
    let stale = call(
        &mut core,
        json!({"method":"diff", "workspace":id, "path":"a", "side":"unstaged"}),
    )
    .unwrap();
    fs::write(repo.join("a"), "external change\n").unwrap();
    assert_eq!(
        call(
            &mut core,
            json!({"method":"stage", "snapshot":stale["id"], "hunk":stale["hunks"][0]["id"]})
        )
        .unwrap_err()
        .code,
        "STALE_CONTENT"
    );
}

#[test]
fn extended_commands_remain_bounded_and_ai_requires_owned_cancellation() {
    let (_temp, mut core, id) = repository();
    core.set_trust(&id, true).unwrap();
    for request in [
        json!({"kind":"reset", "target":"HEAD", "mode":"hard"}),
        json!({"kind":"push", "remote":"origin", "mode":"force-with-lease"}),
        json!({"kind":"pull", "remote":"origin", "mode":"rebase"}),
    ] {
        assert_eq!(
            prepare(&mut core, &id, request).unwrap_err().code,
            "INVALID_REQUEST"
        );
    }
    let command = json!({"method":"run_ai_task", "request":{"provider":"codex", "task":"review", "scope":{"kind":"local", "workspaceId":id, "expectedToken":core.changes(&id).unwrap().token}}});
    assert_eq!(
        call(&mut core, command.clone()).unwrap_err().code,
        "INVALID_READ_REQUEST"
    );
    let cancellation = proof_core::ReadCancellation::default();
    cancellation.cancel();
    assert_eq!(
        cancellation
            .run(|| call(&mut core, command))
            .unwrap_err()
            .code,
        "READ_CANCELLED"
    );
    assert!(!core.has_active_ai_task());
    for method in ["execute_history_action", "stage", "commit"] {
        let command: Command = serde_json::from_value(match method {
            "execute_history_action" => json!({"method":method,"workspace":id,"preview":"x"}),
            "stage" => json!({"method":method,"snapshot":"x"}),
            _ => json!({"method":method,"preview":"x","message":"x"}),
        })
        .unwrap();
        assert!(!command.cancellable());
    }
}

#[cfg(unix)]
#[test]
fn ai_settings_mock_cli_and_task_guards_do_not_invoke_real_agents() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, mut core, id) = repository();
    let mock = temp.path().join("mock-codex");
    fs::write(
        &mock,
        "#!/bin/sh\nprintf 'fixture CLI, no inference available\\n'\n",
    )
    .unwrap();
    fs::set_permissions(&mock, fs::Permissions::from_mode(0o700)).unwrap();
    let original = call(&mut core, json!({"method":"agent_settings"})).unwrap();
    let update = json!({"expectedRevision":original["revision"], "defaultProvider":"codex", "codex":{"executablePath":mock,"model":null}, "claudeCode":{"executablePath":null,"model":null}});
    let saved = call(
        &mut core,
        json!({"method":"set_agent_settings", "update":update}),
    )
    .unwrap();
    assert_eq!(saved["codex"]["executablePath"], mock.to_str().unwrap());
    assert!(call(
        &mut core,
        json!({"method":"set_agent_settings", "update":update})
    )
    .is_err());
    let token = core.changes(&id).unwrap().token;
    let request = json!({"method":"run_ai_task", "request":{"provider":"codex", "task":"review", "scope":{"kind":"local", "workspaceId":id,"expectedToken":token}}});
    let scope = proof_core::ReadCancellation::default();
    assert_eq!(
        scope
            .run(|| call(&mut core, request.clone()))
            .unwrap_err()
            .code,
        "TRUST_REQUIRED"
    );
    core.set_trust(&id, true).unwrap();
    fs::write(temp.path().join("repo/a"), "modified\n").unwrap();
    assert_eq!(
        scope.run(|| call(&mut core, request)).unwrap_err().code,
        "STALE_CONTENT"
    );
    for task in ["review", "commit"] {
        if task == "commit" {
            git(&temp.path().join("repo"), &["add", "a"]);
        }
        let token = core.changes(&id).unwrap().token;
        let request = json!({"method":"run_ai_task", "request":{"provider":"codex", "task":task, "scope":{"kind":"local", "workspaceId":id,"expectedToken":token}}});
        // Capability probes cannot exec the shell interpreter on macOS. That
        // denial is intentional; the compiled fixture below tests successful AI.
        // Other platforms refuse an unverified read-only sandbox.
        let error = scope.run(|| call(&mut core, request)).unwrap_err();
        #[cfg(target_os = "macos")]
        assert_eq!(error.code, "AI_STARTUP_PERMISSION", "{}", error.detail);
        #[cfg(not(target_os = "macos"))]
        assert!(
            matches!(
                error.code.as_str(),
                "AI_ISOLATION_UNAVAILABLE" | "AI_UNSUPPORTED" | "AI_AGENT_FAILED"
            ),
            "{}: {}",
            error.code,
            error.detail
        );
        assert!(!core.has_active_ai_task());
    }
    assert_eq!(
        git(&temp.path().join("repo"), &["log", "-1", "--format=%s"]),
        "initial"
    );
    assert!(core.ai_review_reports(&id, "local").unwrap().is_empty());
}

// This is a compiled fixture, never an installed Agent or a model endpoint.
// The real core sandbox, parser, report persistence and commit-draft paths run.
#[cfg(target_os = "macos")]
#[test]
fn macos_mock_ai_review_commit_and_running_cancellation() {
    let (temp, mut core, id) = repository();
    let repo = temp.path().join("repo");
    let source = temp.path().join("mock.c");
    let executable = temp.path().join("mock-agent");
    let review = json!({"analysisStatus":"completed", "blockers":[], "summary":"Fixture review", "overallRisk":"low", "findings":[], "behaviorChanges":[], "missingTests":[], "reviewPriority":["a"]});
    let commit =
        json!({"analysisStatus":"completed", "blockers":[], "message":"Update fixture lines"});
    let event = |value: Value| {
        json!({"type":"item.completed", "item":{"type":"agent_message", "text":value.to_string()}})
            .to_string()
    };
    // JSON string quoting is also valid for these ASCII C string literals.
    let review_event = serde_json::to_string(&event(review)).unwrap();
    let commit_event = serde_json::to_string(&event(commit)).unwrap();
    fs::write(
        &source,
        format!(
            r#"
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {{
    int slow = 0;
    for (int i=1;i<argc;i++) {{
        if (!strcmp(argv[i],"--help")) {{
            puts("--ignore-user-config --ignore-rules --ephemeral --output-schema"); return 0;
        }}
        if (!strcmp(argv[i],"slow-fixture")) slow = 30;
        if (!strcmp(argv[i],"stale-fixture")) slow = 2;
    }}
    char input[131072] = {{0}};
    size_t n = fread(input,1,sizeof(input)-1,stdin); input[n]=0;
    FILE *write = fopen("a", "w");
    if (write) {{ fclose(write); return 12; }}
    if (slow) sleep(slow);
    if (strstr(input,"Write a Git commit message")) puts({commit_event});
    else puts({review_event});
    puts("{{\"type\":\"turn.completed\"}}");
    return 0;
}}
"#
        ),
    )
    .unwrap();
    assert!(Process::new("/usr/bin/cc")
        .arg(&source)
        .arg("-o")
        .arg(&executable)
        .status()
        .unwrap()
        .success());
    let executable = fs::canonicalize(executable).unwrap();
    core.set_trust(&id, true).unwrap();
    fs::write(repo.join("a"), "modified\n").unwrap();
    let set_model = |core: &mut Proof, model: Option<&str>| {
        let current = call(core, json!({"method":"agent_settings"})).unwrap();
        call(core, json!({"method":"set_agent_settings", "update":{"expectedRevision":current["revision"], "defaultProvider":"codex", "codex":{"executablePath":executable,"model":model},"claudeCode":{"executablePath":null,"model":null}}})).unwrap();
    };
    set_model(&mut core, None);
    for task in ["review", "commit"] {
        if task == "commit" {
            git(&repo, &["add", "a"]);
        }
        let token = core.changes(&id).unwrap().token;
        let request = json!({"method":"run_ai_task","request":{"provider":"codex","task":task,"scope":{"kind":"local","workspaceId":id,"expectedToken":token}}});
        let result = proof_core::ReadCancellation::default()
            .run(|| call(&mut core, request))
            .unwrap();
        if task == "review" {
            assert_eq!(result["review"]["summary"], "Fixture review");
        } else {
            assert_eq!(result["commitMessage"], "Update fixture lines");
        }
        assert!(!core.has_active_ai_task());
    }
    assert_eq!(core.ai_review_reports(&id, "local").unwrap().len(), 1);
    assert_eq!(git(&repo, &["log", "-1", "--format=%s"]), "initial");
    assert_eq!(fs::read_to_string(repo.join("a")).unwrap(), "modified\n");
    set_model(&mut core, Some("stale-fixture"));
    let token = core.changes(&id).unwrap().token;
    let request = json!({"method":"run_ai_task","request":{"provider":"codex","task":"review","scope":{"kind":"local","workspaceId":id,"expectedToken":token}}});
    let changing_repo = repo.clone();
    let editor = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        fs::write(changing_repo.join("a"), "changed while analyzing\n").unwrap();
    });
    let error = proof_core::ReadCancellation::default()
        .run(|| call(&mut core, request))
        .unwrap_err();
    editor.join().unwrap();
    assert_eq!(error.code, "STALE_CONTENT");
    assert_eq!(core.ai_review_reports(&id, "local").unwrap().len(), 1);
    set_model(&mut core, Some("slow-fixture"));
    let token = core.changes(&id).unwrap().token;
    let request = json!({"method":"run_ai_task","request":{"provider":"codex","task":"review","scope":{"kind":"local","workspaceId":id,"expectedToken":token}}});
    let cancellation = proof_core::ReadCancellation::default();
    let cancel = cancellation.clone();
    let worker = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(1));
        cancel.cancel();
    });
    let started = std::time::Instant::now();
    let error = cancellation.run(|| call(&mut core, request)).unwrap_err();
    worker.join().unwrap();
    assert_eq!(error.code, "READ_CANCELLED");
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    assert!(!core.has_active_ai_task());
    assert_eq!(core.ai_review_reports(&id, "local").unwrap().len(), 1);
}
