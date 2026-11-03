use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn process_round_trip_frames_errors_and_escaped_paths() {
    let data = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    let path = repo.path().join("repo with \"quotes\"\nand a newline");
    std::fs::create_dir(&path).unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .arg(&path)
        .status()
        .unwrap()
        .success());
    let mut child = Command::new(env!("CARGO_BIN_EXE_proof-swift-bridge"))
        .arg(data.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut exchange = |request: Value| {
        writeln!(input, "{request}").unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        serde_json::from_str::<Value>(&line).unwrap()
    };
    let hello = exchange(json!({"id":17,"command":{"method":"hello"}}));
    assert_eq!(hello, json!({"id":17,"result":{"protocol":1}}));
    let rejected =
        exchange(json!({"id":18,"command":{"method":"exec","command":"touch should-not-exist"}}));
    assert_eq!(rejected["id"], 18);
    assert_eq!(rejected["error"]["code"], "INVALID_REQUEST");
    let opened = exchange(json!({"id":19,"command":{"method":"open","path":path}}));
    assert_eq!(opened["id"], 19);
    assert_eq!(
        opened["result"]["path"],
        std::fs::canonicalize(&path).unwrap().to_str().unwrap()
    );
    assert_eq!(
        exchange(json!({"id":20,"command":{"method":"recent"}}))["result"][0]["id"],
        opened["result"]["id"]
    );
    drop(input);
    assert!(child.wait().unwrap().success());
}

#[cfg(unix)]
#[test]
fn full_queue_still_delivers_cancellation_and_keeps_frames_whole() {
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::mpsc,
        time::{Duration, Instant},
    };
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let marker = temp.path().join("started");
    let git = temp.path().join("slow-git");
    fs::write(
        &git,
        format!(
            "#!/bin/sh\nprintf started > '{}'\n/bin/sleep 30\nexit 1\n",
            marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&git, fs::Permissions::from_mode(0o700)).unwrap();
    let core = proof_core::Proof::open(&data).unwrap();
    let mut preferences = core.preferences().unwrap();
    preferences.git_path = git.to_str().unwrap().into();
    core.set_preferences(preferences).unwrap();
    drop(core);
    let mut child = Command::new(env!("CARGO_BIN_EXE_proof-swift-bridge"))
        .arg(&data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            tx.send(serde_json::from_str::<Value>(&line.unwrap()).unwrap())
                .unwrap();
        }
    });
    writeln!(
        input,
        "{}",
        json!({"id":1,"command":{"method":"open","path":temp.path()}})
    )
    .unwrap();
    input.flush().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !marker.exists() {
        let _ = child.kill();
        panic!("Owned Git fixture did not start");
    }
    for id in 2..=65 {
        writeln!(input, "{}", json!({"id":id,"command":{"method":"hello"}})).unwrap();
    }
    writeln!(input, "{}", json!({"cancel":1})).unwrap();
    input.flush().unwrap();
    let mut responses = std::collections::HashMap::new();
    for _ in 0..65 {
        let response = match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(response) => response,
            Err(error) => {
                let _ = child.kill();
                panic!("Cancellation blocked behind queued work: {error}");
            }
        };
        assert!(responses
            .insert(response["id"].as_u64().unwrap(), response)
            .is_none());
    }
    assert_eq!(responses[&1]["error"]["code"], "READ_CANCELLED");
    assert!(responses
        .values()
        .any(|r| r["error"]["code"] == "BRIDGE_BUSY"));
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
}
