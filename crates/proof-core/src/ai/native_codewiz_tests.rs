//! Optional native Codewiz regression, using synthetic credentials and a local
//! model fixture. No company endpoint, real repository or model quota is used.
use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

#[test]
#[ignore = "Installed Codewiz version/help and local credential presence only; no model calls"]
fn installed_codewiz_probe_detects_the_existing_installation() {
    let temp = tempfile::tempdir().unwrap();
    let proof = crate::Proof::open(temp.path()).unwrap();
    let result = proof
        .prepare_agent_probe(AgentKind::Codewiz, AgentOptions::default())
        .unwrap()
        .run()
        .unwrap();
    assert!(
        result.compatible,
        "{} {} {}",
        result.executable_path.display(),
        result.version,
        result.detail
    );
    assert!(!result.version.is_empty());
    println!(
        "Codewiz {} compatible={} local_credentials={:?}",
        result.version, result.compatible, result.authenticated
    );
}

#[test]
#[ignore = "Installed Codewiz, loopback model only; no credentials or quota"]
fn installed_codewiz_reads_snapshot_and_cannot_modify_it() {
    let (executable, _, _) = resolve_executable(
        AgentKind::Codewiz,
        &locate(AgentKind::Codewiz).expect("Codewiz installed"),
    )
    .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let runtime = root.join("runtime");
    let snapshot = root.join("snapshot");
    let config = root.join("fixture-config");
    for path in [&runtime, &snapshot, &config] {
        fs::create_dir(path).unwrap();
    }
    fs::write(snapshot.join("manifest.json"), "proof-codewiz-read-marker").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    fs::write(config.join("codewiz.json"), serde_json::json!({
        "model":"proof/test", "small_model":"proof/test", "enabled_providers":["proof"],
        "provider":{"proof":{"npm":"@ai-sdk/openai-compatible","name":"Fixture", "options":{"baseURL":format!("http://{address}/v1"),"apiKey":"fixture-only"}, "models":{"test":{"name":"Test", "limit":{"context":64000,"output":4096}}}}}
    }).to_string()).unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let stopped = done.clone();
    let server = std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(45);
        let mut saw_read = false;
        let mut saw_protection = false;
        let mut calls = 0;
        while !stopped.load(Ordering::Relaxed) && Instant::now() < until {
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
                assert!(n > 0 && bytes.len() < 2 * 1024 * 1024);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let length: usize = header
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
            let content = body["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|v| v["role"] == "tool")
                .map(ToString::to_string)
                .collect::<String>();
            saw_read |= content.contains("proof-codewiz-read-marker");
            saw_protection |= content.to_lowercase().contains("operation not permitted")
                || content.to_lowercase().contains("read-only file system")
                || content.to_lowercase().contains("permission denied");
            let delta = if saw_read {
                serde_json::json!({"content":"{\"ok\":true}"})
            } else {
                let tools = body["tools"].as_array().expect("Read tools present");
                assert!(tools.iter().any(|v| v["function"]["name"] == "bash"));
                assert!(!tools.iter().any(|v| matches!(
                    v["function"]["name"].as_str(),
                    Some("edit" | "write" | "task")
                )));
                serde_json::json!({"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"bash","arguments":serde_json::json!({"command":"cat manifest.json; printf forbidden > manifest.json", "description":"Read snapshot and check write protection"}).to_string()}}]})
            };
            let mut response = String::new();
            for (delta, reason) in [
                (delta, Value::Null),
                (
                    serde_json::json!({}),
                    Value::String(if saw_read { "stop" } else { "tool_calls" }.into()),
                ),
            ] {
                response.push_str(&format!("data: {}\n\n", serde_json::json!({"id":format!("chat-{calls}"),"object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":delta,"finish_reason":reason}]})));
            }
            response.push_str("data: [DONE]\n\n");
            write!(connection, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
        }
        (saw_read, saw_protection)
    });
    // Build the shared OS profile without importing ANY real CLI login/config.
    let mut command = isolated_command_options(
        AgentKind::Codex,
        &executable,
        &runtime,
        None,
        Some(&snapshot),
    )
    .unwrap();
    codewiz::configure_from(&mut command, &runtime, true, Some(&config), None, None).unwrap();
    // Deny every external network endpoint for this opt-in fixture.
    let args: Vec<_> = command
        .get_args()
        .map(|s| s.to_string_lossy().into_owned())
        .collect();
    let profile = format!("{}{}(deny network*)(allow network-outbound (remote ip \"localhost:*\"))(allow network-inbound (local ip \"localhost:*\"))", args[1], codewiz::startup_profile(&runtime).unwrap());
    let env: Vec<_> = command
        .get_envs()
        .filter_map(|(k, v)| v.map(|v| (k.to_owned(), v.to_owned())))
        .collect();
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .args(["-p", &profile])
        .arg(&executable)
        .args(codewiz::arguments())
        .current_dir(&snapshot)
        .env_clear()
        .envs(env);
    let events = std::cell::RefCell::new(Vec::new());
    let paths = vec!["manifest.json".into()];
    let emit = |event| events.borrow_mut().push(event);
    let mut activity = super::super::progress::ActivityStream::new(&paths, &emit);
    let output = process::run_observed(command, Some(codewiz::prompt("Read manifest.json; report JSON.", &serde_json::json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]})).as_bytes()), Duration::from_secs(40), &mut |bytes| activity.feed(bytes));
    done.store(true, Ordering::Relaxed);
    let (read, protection) = server.join().unwrap();
    let output = output.unwrap();
    assert_eq!(
        output.code,
        0,
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(codewiz::decode(&output.stdout).unwrap()["ok"], true);
    assert!(
        read && protection,
        "Native read and write-denial evidence required"
    );
    assert_eq!(
        fs::read_to_string(snapshot.join("manifest.json")).unwrap(),
        "proof-codewiz-read-marker"
    );
    assert!(!events.borrow().is_empty());
}
