//! Native session persistence against a loopback-only model fixture.
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
#[ignore = "Installed Claude Code, synthetic API key and loopback model; no account or quota"]
fn installed_claude_persists_a_resumable_print_session() {
    let (executable, _, _) = resolve_executable(
        AgentKind::ClaudeCode,
        &locate(AgentKind::ClaudeCode).expect("Claude installed"),
    )
    .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let runtime = root.join("job");
    let project = root.join("project");
    fs::create_dir_all(&runtime).unwrap();
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(runtime.join("home")).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let stopped = done.clone();
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut calls = 0;
        while !stopped.load(Ordering::Relaxed) && Instant::now() < deadline {
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
                if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .map(|l| l.trim().parse::<usize>().unwrap())
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break serde_json::from_slice::<Value>(&bytes[end + 4..end + 4 + length])
                            .unwrap_or(Value::Null);
                    }
                }
            };
            if body.get("messages").is_none() {
                write!(connection, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
                continue;
            }
            calls += 1;
            let message = serde_json::json!({"id":"msg_fixture","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"{\"ok\":true}"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}});
            let (mime, response) = if body["stream"] == true {
                let events = [
                    serde_json::json!({"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}),
                    serde_json::json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                    serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\"ok\":true}"}}),
                    serde_json::json!({"type":"content_block_stop","index":0}),
                    serde_json::json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}),
                    serde_json::json!({"type":"message_stop"}),
                ];
                (
                    "text/event-stream",
                    events
                        .iter()
                        .map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()))
                        .collect::<String>(),
                )
            } else {
                ("application/json", message.to_string())
            };
            write!(connection, "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        }
        calls
    });
    let setup = isolated_command_options(
        AgentKind::ClaudeCode,
        &executable,
        &runtime,
        None,
        Some(&project),
    )
    .unwrap();
    let args = setup.get_args().collect::<Vec<_>>();
    let profile = format!("{}(deny network*)(allow network-outbound (remote ip \"localhost:*\"))(allow network-inbound (local ip \"localhost:*\"))", args[1].to_string_lossy());
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .args(["-p", &profile])
        .arg(&executable)
        .args([
            "--print",
            "--safe-mode",
            "--output-format",
            "stream-json",
            "--verbose",
            "--tools",
            "",
            "--setting-sources",
            "",
            "--model",
            "claude-sonnet-4-6",
        ])
        .env_clear()
        .envs(setup.get_envs().filter_map(|(k, v)| v.map(|v| (k, v))))
        .env("HOME", runtime.join("home"))
        .env("ANTHROPIC_API_KEY", "fixture-only")
        .env("ANTHROPIC_BASE_URL", format!("http://{address}"))
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .current_dir(&project);
    let mut resume = Command::new(command.get_program());
    resume
        .args(command.get_args())
        .env_clear()
        .envs(command.get_envs().filter_map(|(k, v)| v.map(|v| (k, v))))
        .current_dir(&project);
    let output = process::run(
        command,
        Some(b"Return only {\"ok\":true}. Do not use tools."),
        Duration::from_secs(35),
    );
    let output = output.unwrap();
    assert_eq!(output.code, 0, "{}", safe_failure_text(&output));
    assert_eq!(
        decode(AgentKind::ClaudeCode, &output.stdout).unwrap()["ok"],
        true
    );
    let id = output
        .stdout
        .split(|b| *b == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .find_map(|v| v["session_id"].as_str().map(str::to_owned))
        .unwrap();
    let saved = root.join("native-cli/projects");
    super::super::sessions::publish_transcripts(
        AgentKind::ClaudeCode,
        &runtime,
        &runtime.join("claude/projects"),
        &saved,
        &id,
    )
    .unwrap();
    assert!(saved.is_dir());
    resume
        .args(["--resume", &id])
        .env("CLAUDE_CONFIG_DIR", saved.parent().unwrap());
    let resumed = process::run(
        resume,
        Some(b"Continue this conversation and return the same JSON."),
        Duration::from_secs(15),
    );
    done.store(true, Ordering::Relaxed);
    let calls = server.join().unwrap();
    let resumed = resumed.unwrap();
    assert_eq!(resumed.code, 0, "{}", safe_failure_text(&resumed));
    assert_eq!(
        decode(AgentKind::ClaudeCode, &resumed.stdout).unwrap()["ok"],
        true
    );
    assert!(calls >= 2);
}
