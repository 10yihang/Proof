//! Opt-in installed CLI regression. The model endpoint is a local fixture;
//! no user credentials, source files, remote service or model quota are used.
use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Instant;

#[test]
#[ignore = "Opt-in real Codex reads a synthetic snapshot through tools; loopback only, no credentials or model quota"]
fn installed_codex_reads_snapshot_with_tools_and_streams_activity() {
    snapshot_tool_fixture("proof-fixture", false);
}

#[test]
#[ignore = "Opt-in real Codex Code Mode with bundled model metadata; loopback only, no credentials or model quota"]
fn installed_codex_code_mode_reads_snapshot_and_preserves_write_protection() {
    snapshot_tool_fixture("gpt-6-astra", true);
}

fn snapshot_tool_fixture(model: &str, code_mode: bool) {
    let executable = fs::canonicalize(locate(AgentKind::Codex).unwrap()).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let runtime = root.join("runtime");
    let snapshot = root.join("snapshot");
    let shared = root.join("synthetic-login");
    for path in [&runtime, &snapshot, &shared] {
        fs::create_dir(path).unwrap();
    }
    fs::write(
        snapshot.join("manifest.json"),
        "proof-snapshot-tool-marker\n",
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let server_done = done.clone();
    let server = std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(45);
        let mut calls = 0;
        let mut saw_tool_output = false;
        while !server_done.load(Ordering::Relaxed) && Instant::now() < until {
            let Ok((mut connection, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            };
            connection
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 8192];
            let body = loop {
                let n = connection.read(&mut buffer).unwrap();
                assert!(n > 0 && bytes.len() < 1024 * 1024);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    assert!(!headers.contains("authorization:"));
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break serde_json::from_slice::<Value>(&bytes[end + 4..end + 4 + length])
                            .unwrap();
                    }
                }
            };
            calls += 1;
            let item = if calls == 1 {
                if code_mode {
                    // Code Mode-only catalogs can convey the tool surface in the
                    // prompt instead of a top-level Responses tools array.
                    serde_json::json!({"id":"ctc_proof_read","type":"custom_tool_call","status":"completed","call_id":"call_proof_read","name":"exec","input":"const result = await tools.exec_command({cmd: \"cat manifest.json; if printf forbidden > manifest.json; then exit 99; fi\", max_output_tokens: 1000}); text(result);"})
                } else {
                    let tools = body["tools"].as_array().unwrap();
                    let tool = tools
                        .iter()
                        .find(|tool| {
                            matches!(
                                tool["name"].as_str(),
                                Some("exec_command" | "shell_command" | "shell")
                            )
                        })
                        .unwrap_or_else(|| {
                            panic!(
                                "No native shell tool: {}",
                                serde_json::to_string(tools).unwrap()
                            )
                        });
                    let properties = &tool["parameters"]["properties"];
                    let arguments = if properties.get("cmd").is_some() {
                        serde_json::json!({"cmd":"cat manifest.json; printf forbidden > manifest.json"})
                    } else if properties["command"]["type"] == "array" {
                        serde_json::json!({"command":["/bin/sh","-c","cat manifest.json; printf forbidden > manifest.json"]})
                    } else {
                        serde_json::json!({"command":"cat manifest.json; printf forbidden > manifest.json"})
                    };
                    serde_json::json!({"id":"fc_proof_read","type":"function_call","status":"completed","call_id":"call_proof_read","name":tool["name"],"arguments":arguments.to_string()})
                }
            } else {
                for item in body["input"].as_array().unwrap() {
                    if matches!(
                        item["type"].as_str(),
                        Some("custom_tool_call_output" | "function_call_output")
                    ) && !item["output"]
                        .to_string()
                        .contains("proof-snapshot-tool-marker")
                    {
                        eprintln!("Synthetic tool result: {}", item["output"]);
                    }
                }
                saw_tool_output = body["input"]
                    .to_string()
                    .contains("proof-snapshot-tool-marker");

                serde_json::json!({"id":"msg_proof_result","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"{\"ok\":true}","annotations":[]}]})
            };
            let events = [
                serde_json::json!({"type":"response.created","response":{"id":format!("resp_{calls}"),"status":"in_progress","output":[]}}),
                serde_json::json!({"type":"response.output_item.done","output_index":0,"item":item}),
                serde_json::json!({"type":"response.completed","response":{"id":format!("resp_{calls}"),"status":"completed","output":[item],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}),
            ];
            let response = events
                .iter()
                .map(|event| {
                    format!(
                        "event: {}\ndata: {event}\n\n",
                        event["type"].as_str().unwrap()
                    )
                })
                .collect::<String>();
            write!(connection, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
            if calls >= 2 {
                break;
            }
        }
        (calls, saw_tool_output)
    });
    let schema = serde_json::json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false});
    fs::write(
        runtime.join("schema.json"),
        serde_json::to_vec(&schema).unwrap(),
    )
    .unwrap();
    let base = isolated_command_options(
        AgentKind::Codex,
        &executable,
        &runtime,
        Some(&shared),
        Some(&snapshot),
    )
    .unwrap();
    let mut command = Command::new(base.get_program());
    command.env_clear().current_dir(&snapshot);
    for (index, arg) in base.get_args().enumerate() {
        if index == 1 {
            command.arg(format!("{}(deny network-outbound (remote ip))(allow network-outbound (remote tcp \"localhost:{}\"))", arg.to_string_lossy(), address.port()));
        } else {
            command.arg(arg);
        }
    }
    for (key, value) in base.get_envs() {
        if let Some(value) = value {
            command.env(key, value);
        }
    }
    command.args(externally_sandboxed_arguments(AgentKind::Codex, &runtime, &schema).unwrap());
    command.args(["--model", model, "-c", "model_provider=\"proof-fixture\"", "-c", &format!("model_providers.proof-fixture={{name=\"Proof fixture\",base_url=\"http://{address}/v1\",wire_api=\"responses\",requires_openai_auth=false}}")]);
    let paths = vec!["manifest.json".to_owned()];
    let events = std::cell::RefCell::new(Vec::new());
    let emit = |event| events.borrow_mut().push(event);
    let mut activity = crate::ai::progress::ActivityStream::new(&paths, &emit);
    let result = process::run_observed(
        command,
        Some(b"Read manifest.json with your shell tool, then return JSON with ok true."),
        Duration::from_secs(30),
        &mut |bytes| activity.feed(bytes),
    );
    done.store(true, Ordering::Relaxed);
    let (calls, saw_tool_output) = server.join().unwrap();
    let output = result.unwrap();
    assert_eq!(output.code, 0, "{}", safe_failure_text(&output));
    assert_eq!(calls, 2);
    assert!(
        saw_tool_output,
        "Native tool did not read the snapshot; {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        decode(AgentKind::Codex, &output.stdout).unwrap()["ok"],
        true
    );
    assert!(events
        .borrow()
        .iter()
        .any(|event| event.path.as_deref() == Some("manifest.json")));
    assert_eq!(
        fs::read_to_string(snapshot.join("manifest.json")).unwrap(),
        "proof-snapshot-tool-marker\n"
    );
}

#[test]
#[ignore = "Opt-in real Codex with a loopback fixture and no remote networking"]
fn installed_codex_completes_after_private_runtime_initialization() {
    let executable = fs::canonicalize(locate(AgentKind::Codex).unwrap()).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let shared = root.join("synthetic-shared-agent");
    fs::create_dir_all(shared.join("sessions")).unwrap();
    let identity = uuid::Uuid::new_v4().to_string();
    fs::write(shared.join("installation_id"), &identity).unwrap();
    fs::write(shared.join("config.toml"), "# existing config\n").unwrap();
    fs::write(shared.join("sessions/existing.jsonl"), "existing session\n").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let server_done = Arc::clone(&done);
    let server = std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(45);
        while !server_done.load(Ordering::Relaxed) && Instant::now() < until {
            match listener.accept() {
                Ok((mut connection, _)) => {
                    connection
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let mut chunk = [0u8; 8192];
                    let body = loop {
                        let n = connection.read(&mut chunk).unwrap();
                        assert!(n > 0 && bytes.len() < 256 * 1024);
                        bytes.extend_from_slice(&chunk[..n]);
                        if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                            assert!(headers.starts_with("post /v1/responses "));
                            assert!(
                                !headers.contains("authorization:"),
                                "Fixture must receive no credentials"
                            );
                            let length: usize = headers
                                .lines()
                                .find_map(|line| line.strip_prefix("content-length:"))
                                .unwrap()
                                .trim()
                                .parse()
                                .unwrap();
                            if bytes.len() >= end + 4 + length {
                                break serde_json::from_slice::<Value>(
                                    &bytes[end + 4..end + 4 + length],
                                )
                                .unwrap();
                            }
                        }
                    };
                    let message = serde_json::json!({"id":"msg_proof_fixture","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"{\"ok\":true}","annotations":[]}]});
                    let events = [
                        serde_json::json!({"type":"response.created","response":{"id":"resp_proof_fixture","status":"in_progress","output":[]}}),
                        serde_json::json!({"type":"response.output_item.done","output_index":0,"item":message}),
                        serde_json::json!({"type":"response.completed","response":{"id":"resp_proof_fixture","status":"completed","output":[message],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}),
                    ];
                    let response = events
                        .iter()
                        .map(|v| format!("event: {}\ndata: {v}\n\n", v["type"].as_str().unwrap()))
                        .collect::<String>();
                    write!(connection, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
                    connection.flush().unwrap();
                    return Some(body);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("Local fixture listener: {error}"),
            }
        }
        None
    });
    let mut results = Vec::new();
    for private_runtime in [false, true] {
        let job = root.join(if private_runtime {
            "fixed-job"
        } else {
            "old-job"
        });
        fs::create_dir(&job).unwrap();
        let schema = serde_json::json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false});
        fs::write(
            job.join("schema.json"),
            serde_json::to_vec(&schema).unwrap(),
        )
        .unwrap();
        let base = isolated_command_with_login(AgentKind::Codex, &executable, &job, Some(&shared))
            .unwrap();
        let mut command = Command::new(base.get_program());
        command.env_clear().current_dir(&job);
        for (i, arg) in base.get_args().enumerate() {
            if i == 1 {
                command.arg(format!("{}(deny network-outbound (remote ip))(allow network-outbound (remote tcp \"localhost:{}\"))", arg.to_string_lossy(), address.port()));
            } else {
                command.arg(arg);
            }
        }
        for (key, value) in base.get_envs() {
            if let Some(value) = value {
                command.env(key, value);
            }
        }
        if !private_runtime {
            // Reproduce the old launch against synthetic shared state only.
            command.env("CODEX_HOME", &shared);
        }
        command.args(arguments(AgentKind::Codex, &job, &schema).unwrap());
        command.args(["--model", "proof-fixture", "-c", "model_provider=\"proof-fixture\"", "-c", &format!("model_providers.proof-fixture={{name=\"Proof fixture\",base_url=\"http://{address}/v1\",wire_api=\"responses\",requires_openai_auth=false}}")]);
        results.push(process::run_diff(
            command,
            Some(b"No files. Return JSON with ok true."),
            Duration::from_secs(20),
            256 * 1024,
        ));
    }
    done.store(true, Ordering::Relaxed);
    let request = server.join().unwrap();
    let before = results.remove(0).unwrap();
    assert_ne!(before.code, 0);
    assert!(
        String::from_utf8_lossy(&before.stderr)
            .contains("failed to initialize in-process app-server client"),
        "{}",
        String::from_utf8_lossy(&before.stderr)
    );
    let after = results.remove(0).unwrap();
    assert_eq!(after.code, 0, "{}", safe_failure_text(&after));
    assert_eq!(decode(AgentKind::Codex, &after.stdout).unwrap()["ok"], true);
    assert_eq!(request.unwrap()["model"], "proof-fixture");
    assert!(root.join("fixed-job/codex/installation_id").is_file());
    assert_eq!(
        fs::read_to_string(shared.join("installation_id")).unwrap(),
        identity
    );
    assert_eq!(
        fs::read_to_string(shared.join("config.toml")).unwrap(),
        "# existing config\n"
    );
    assert_eq!(
        fs::read_to_string(shared.join("sessions/existing.jsonl")).unwrap(),
        "existing session\n"
    );
    println!("Real Codex: old runtime failed; private runtime completed a loopback fixture response; shared files unchanged; zero remote model calls.");
}
