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
    assert_eq!(opened["result"]["path"], path.to_str().unwrap());
    assert_eq!(
        exchange(json!({"id":20,"command":{"method":"recent"}}))["result"][0]["id"],
        opened["result"]["id"]
    );
    drop(input);
    assert!(child.wait().unwrap().success());
}
