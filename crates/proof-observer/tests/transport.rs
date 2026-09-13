#![cfg(unix)]
use proof_observer::{
    protocol::*,
    server::{ReceiptPolicy, Server},
};
use std::{
    fs,
    io::Write,
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

fn temporary_directory() -> tempfile::TempDir {
    tempfile::tempdir_in(if cfg!(target_os = "macos") {
        "/private/tmp"
    } else {
        "/tmp"
    })
    .unwrap()
}

// A failed assertion must not leave a collector running in the background.
struct CollectorChild(Option<std::process::Child>);
impl std::ops::Deref for CollectorChild {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for CollectorChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().unwrap()
    }
}
impl CollectorChild {
    fn finish(mut self) -> std::process::Output {
        self.0.take().unwrap().wait_with_output().unwrap()
    }
}
impl Drop for CollectorChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn registration(dir: &Path, socket: &Path) -> PathBuf {
    let registration = Registration {
        schema_version: 1,
        installation_id: uuid::Uuid::new_v4().to_string(),
        agent: Agent::Codex,
        agent_version: "0.153.4".into(),
        socket_path: socket.to_str().unwrap().into(),
        token: "a".repeat(64),
    };
    let path = dir.join("registration.json");
    fs::write(&path, serde_json::to_vec(&registration).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    path
}
fn bridge(path: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_proof-observer"));
    command
        .args(["bridge", "--registration"])
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

#[test]
fn bridge_forwards_to_real_socket_with_zero_output() {
    let temp = tempfile::tempdir_in("/private/tmp").unwrap();
    let socket = temp.path().join("runtime/observe.sock");
    let server = Server::bind(&socket).unwrap();
    let registration = registration(temp.path(), &socket);
    let running = Arc::new(AtomicBool::new(true));
    let control = running.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let service = std::thread::spawn(move || {
        server
            .run(
                control,
                || {
                    Some(ReceiptPolicy {
                        revision: 0,
                        foreground_lease_until: None,
                    })
                },
                move |event| {
                    send.send(event.payload).unwrap();
                    true
                },
                |_| {},
            )
            .unwrap()
    });
    let mut child = bridge(&registration).spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"{\"hook_event_name\":\"Stop\"}")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty() && output.stderr.is_empty());
    assert_eq!(
        receive.recv_timeout(Duration::from_secs(2)).unwrap(),
        b"{\"hook_event_name\":\"Stop\"}"
    );
    running.store(false, Ordering::Release);
    service.join().unwrap();
    assert!(!socket.exists());
}

#[test]
fn bridge_bounds_never_closed_stdin_and_missing_service() {
    let temp = tempfile::tempdir_in("/private/tmp").unwrap();
    let path = registration(temp.path(), &temp.path().join("absent.sock"));
    let started = Instant::now();
    let mut child = bridge(&path).spawn().unwrap();
    let launch_time = started.elapsed();
    let input = child.stdin.take().unwrap();
    let output = child.wait_with_output().unwrap();
    drop(input);
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(500),
        "bridge total {elapsed:?}; process spawn {launch_time:?}"
    );
    assert!(output.status.success() && output.stdout.is_empty() && output.stderr.is_empty());
    let mut child = bridge(&path).spawn().unwrap();
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success() && output.stdout.is_empty() && output.stderr.is_empty());
}

#[test]
fn slow_receiver_large_input_and_bad_config_are_neutral_and_bounded() {
    let temp = tempfile::tempdir_in("/private/tmp").unwrap();
    let socket = temp.path().join("slow.sock");
    let _listener = UnixListener::bind(&socket).unwrap();
    let path = registration(temp.path(), &socket);
    let started = Instant::now();
    let mut child = bridge(&path).spawn().unwrap();
    let launch_time = started.elapsed();
    let mut input = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        let _ = input.write_all(&vec![b'x'; MAX_INPUT]);
    });
    let output = child.wait_with_output().unwrap();
    writer.join().unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(500),
        "bridge total {elapsed:?}; process spawn {launch_time:?}"
    );
    assert!(output.status.success() && output.stdout.is_empty() && output.stderr.is_empty());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
    let output = bridge(&path).output().unwrap();
    assert!(output.status.success() && output.stdout.is_empty() && output.stderr.is_empty());
}

#[test]
fn another_service_cannot_replace_the_live_socket() {
    let temp = tempfile::tempdir_in("/private/tmp").unwrap();
    let socket = temp.path().join("runtime/socket");
    let server = Server::bind(&socket).unwrap();
    assert!(Server::bind(&socket).is_err());
    assert!(socket.exists());
    drop(server);
    assert!(!socket.exists());
}

#[test]
fn full_data_deletion_stops_collector_without_recreating_old_health_or_gaps() {
    use proof_core::{DataScope, ObserverAgent, ObserverConsent, Proof};
    let temp = temporary_directory();
    let data = temp.path().join("data");
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["init", "-b", "main"])
        .output()
        .unwrap()
        .status
        .success());
    let mut proof = Proof::open(&data).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    proof.set_trust(&workspace.id, true).unwrap();
    let registration = proof
        .create_observer_registration(ObserverAgent::Claude, "2.1.236")
        .unwrap();
    proof
        .set_observer_consent(&ObserverConsent {
            installation_id: registration.installation.id,
            workspace_id: workspace.id,
            enabled: true,
            prompt: false,
            command: false,
            reply: false,
            output: false,
            background: true,
        })
        .unwrap();
    let mut service = CollectorChild(Some(
        Command::new(env!("CARGO_BIN_EXE_proof-observer"))
            .args(["serve", "--data-dir"])
            .arg(&data)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    ));
    let health = data.join("observer/runtime.json");
    let started = Instant::now();
    while !health.exists() {
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(service.try_wait().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(10));
    }
    let preview = proof.prepare_data_deletion(DataScope::All).unwrap();
    let deleted = proof.delete_local_data(&preview.id).unwrap();
    assert_eq!(deleted.cleanup.pending_content_deletions, 0);
    let started = Instant::now();
    while service.try_wait().unwrap().is_none() {
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(service.finish().status.success());
    assert!(!health.exists());
    assert!(!health.with_extension("pending").exists());
    assert!(proof.observer_gaps(None).unwrap().is_empty());
    assert!(proof.data_workspaces().unwrap().is_empty());
    assert_eq!(
        String::from_utf8(
            Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(["status", "--porcelain"])
                .output()
                .unwrap()
                .stdout
        )
        .unwrap(),
        ""
    );
}

#[test]
fn standalone_collector_persists_authorized_fields_and_stops_cleanly() {
    use proof_core::{ObserverAgent, ObserverConsent, Proof};
    let temp = tempfile::tempdir_in("/private/tmp").unwrap();
    let data = temp.path().join("data");
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    let output = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["init", "-b", "main"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let mut proof = Proof::open(&data).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    proof.set_trust(&workspace.id, true).unwrap();
    let secret = proof
        .create_observer_registration(ObserverAgent::Claude, "2.1.236")
        .unwrap();
    proof
        .set_observer_consent(&ObserverConsent {
            installation_id: secret.installation.id.clone(),
            workspace_id: workspace.id.clone(),
            enabled: true,
            prompt: true,
            command: false,
            reply: false,
            output: false,
            background: true,
        })
        .unwrap();
    let mut service = CollectorChild(Some(
        Command::new(env!("CARGO_BIN_EXE_proof-observer"))
            .args(["serve", "--data-dir"])
            .arg(&data)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    ));
    let health = data.join("observer/runtime.json");
    let start = Instant::now();
    while !health.exists() {
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(service.try_wait().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(10));
    }
    let socket = proof_observer::runtime::socket_path(&fs::canonicalize(&data).unwrap()).unwrap();
    let reg = Registration {
        schema_version: 1,
        installation_id: secret.installation.id,
        agent: Agent::Claude,
        agent_version: "2.1.236".into(),
        socket_path: socket.to_str().unwrap().into(),
        token: secret.token,
    };
    let path = temp.path().join("bridge-registration.json");
    fs::write(&path, serde_json::to_vec(&reg).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let event = serde_json::json!({"hook_event_name":"UserPromptSubmit","session_id":"native-session","cwd":repo,"prompt":"authorized task text","last_assistant_message":"not authorized reply"});
    let mut hook = bridge(&path).spawn().unwrap();
    hook.stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&event).unwrap())
        .unwrap();
    let output = hook.wait_with_output().unwrap();
    assert!(output.status.success() && output.stdout.is_empty() && output.stderr.is_empty());
    let start = Instant::now();
    let event = loop {
        let events = proof.observer_events(&workspace.id, None, 0).unwrap();
        if let Some(event) = events.into_iter().next() {
            break event;
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(event.prompt.as_deref(), Some("authorized task text"));
    assert!(event.reply.is_none());
    assert_eq!(event.version_relation, "unconfirmed_post_only");
    // Signal only the child collector created by this test, never an Agent.
    unsafe {
        libc::kill(service.id() as i32, libc::SIGTERM);
    }
    let start = Instant::now();
    while service.try_wait().unwrap().is_none() {
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = service.finish();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!socket.exists());
    let health: serde_json::Value = serde_json::from_slice(&fs::read(health).unwrap()).unwrap();
    assert_eq!(health["cleanShutdown"], true);
}

struct ObservationFixture {
    _temp: tempfile::TempDir,
    repo: PathBuf,
    data: PathBuf,
    proof: proof_core::Proof,
    workspace_id: String,
    consent: proof_core::ObserverConsent,
    registration: Registration,
}
impl ObservationFixture {
    fn new(background: bool) -> Self {
        let temp = temporary_directory();
        let repo = temp.path().join("repo");
        let data = temp.path().join("data");
        fs::create_dir(&repo).unwrap();
        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["init", "-b", "main"])
            .output()
            .unwrap()
            .status
            .success());
        let mut proof = proof_core::Proof::open(&data).unwrap();
        let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
        proof.set_trust(&workspace.id, true).unwrap();
        let secret = proof
            .create_observer_registration(Agent::Claude, "2.1.236")
            .unwrap();
        let consent = proof_core::ObserverConsent {
            installation_id: secret.installation.id.clone(),
            workspace_id: workspace.id.clone(),
            enabled: true,
            prompt: true,
            command: false,
            reply: false,
            output: false,
            background,
        };
        proof.set_observer_consent(&consent).unwrap();
        let socket =
            proof_observer::runtime::socket_path(&fs::canonicalize(&data).unwrap()).unwrap();
        let registration = Registration {
            schema_version: 1,
            installation_id: secret.installation.id,
            agent: Agent::Claude,
            agent_version: "2.1.236".into(),
            socket_path: socket.to_str().unwrap().into(),
            token: secret.token,
        };
        Self {
            _temp: temp,
            repo,
            data,
            proof,
            workspace_id: workspace.id,
            consent,
            registration,
        }
    }
    fn send(&self, id: &str, prompt: &str) {
        use std::os::unix::net::UnixStream;
        let payload=serde_json::to_vec(&serde_json::json!({"hook_event_name":"UserPromptSubmit","cwd":self.repo,"session_id":id,"prompt":prompt})).unwrap();
        let mut frame = encode_header(&self.registration, payload.len(), now(), None).unwrap();
        frame.extend(payload);
        let mut stream = UnixStream::connect(&self.registration.socket_path).unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        stream.write_all(&frame).unwrap();
    }
}
fn wait_until(mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while !condition() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "condition did not become true"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn check_queued_authorization(pause: bool) {
    use proof_core::{ObserverInput, Proof};
    use std::sync::atomic::AtomicU64;
    let f = ObservationFixture::new(pause);
    let server = Server::bind(Path::new(&f.registration.socket_path)).unwrap();
    let metrics = server.metrics.clone();
    let policy = Proof::open(&f.data).unwrap();
    let journal = Proof::open(&f.data).unwrap();
    let lease = Arc::new(AtomicU64::new(now() + 5000));
    let captured_lease = lease.clone();
    let running = Arc::new(AtomicBool::new(true));
    let control = running.clone();
    let (entered_send, entered_receive) = std::sync::mpsc::channel();
    let (resume_send, resume_receive) = std::sync::mpsc::channel();
    let service = std::thread::spawn(move || {
        let mut first = true;
        server
            .run(
                control,
                move || {
                    Some(ReceiptPolicy {
                        revision: policy.observer_policy_revision().ok()?,
                        foreground_lease_until: Some(captured_lease.load(Ordering::Acquire))
                            .filter(|v| *v > now()),
                    })
                },
                move |envelope| {
                    if first {
                        first = false;
                        entered_send.send(()).unwrap();
                        let _ = resume_receive.recv_timeout(Duration::from_secs(5));
                    }
                    let h = envelope.header;
                    journal
                        .ingest_observer_event(ObserverInput {
                            installation_id: &h.installation_id,
                            token: &h.token,
                            agent: h.agent,
                            agent_version: &h.agent_version,
                            payload: &envelope.payload,
                            bridge_started_at: h.bridge_started_at,
                            foreground_lease_until: envelope.foreground_lease_until,
                            received_policy_revision: envelope.policy_revision,
                            received_at: envelope.received_at,
                        })
                        .unwrap()
                },
                |_| {},
            )
            .unwrap();
    });
    f.send("blocking-worker", "before pause");
    entered_receive
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    if pause {
        f.proof.pause_all_observers().unwrap();
    } else {
        lease.store(0, Ordering::Release);
    }
    f.send(
        "unauthorized-window",
        "SECRET_RECEIVED_WITHOUT_AUTHORIZATION",
    );
    wait_until(|| metrics.snapshot().received == 2);
    if pause {
        f.proof.set_observer_consent(&f.consent).unwrap();
    } else {
        lease.store(now() + 5000, Ordering::Release);
    }
    resume_send.send(()).unwrap();
    wait_until(|| {
        let m = metrics.snapshot();
        m.processed + m.rejected == 2
    });
    f.send("fresh-authorized", "new authorized event");
    wait_until(|| {
        let m = metrics.snapshot();
        m.processed + m.rejected == 3
    });
    running.store(false, Ordering::Release);
    service.join().unwrap();
    let rows = f.proof.observer_events(&f.workspace_id, None, 0).unwrap();
    assert!(!rows
        .iter()
        .any(|e| e.prompt.as_deref() == Some("SECRET_RECEIVED_WITHOUT_AUTHORIZATION")));
    assert!(rows
        .iter()
        .any(|e| e.prompt.as_deref() == Some("new authorized event")));
}

#[test]
fn queued_event_received_while_paused_does_not_gain_resume_consent() {
    check_queued_authorization(true);
}

#[test]
fn queued_event_received_without_gui_does_not_gain_a_later_gui_lease() {
    check_queued_authorization(false);
}

#[test]
fn collector_sigterm_cancels_its_blocked_git_read_and_exits() {
    let f = ObservationFixture::new(true);
    let marker = f._temp.path().join("entered");
    let gate = f._temp.path().join("block");
    let wrapper = f._temp.path().join("git-wrapper");
    fs::write(&wrapper,b"#!/bin/sh\nif [ -n \"$PROOF_TEST_GIT_GATE\" ] && [ -f \"$PROOF_TEST_GIT_GATE\" ]; then\n  : > \"$PROOF_TEST_GIT_ENTERED\"\n  while :; do /bin/sleep 1; done\nfi\nexec /usr/bin/git \"$@\"\n").unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let mut preferences = f.proof.preferences().unwrap();
    preferences.git_path = wrapper.to_str().unwrap().into();
    f.proof.set_preferences(preferences).unwrap();
    fs::write(&gate, b"block this fixture's owned Git read").unwrap();
    let mut service = CollectorChild(Some(
        Command::new(env!("CARGO_BIN_EXE_proof-observer"))
            .args(["serve", "--data-dir"])
            .arg(&f.data)
            .env("PROOF_TEST_GIT_GATE", &gate)
            .env("PROOF_TEST_GIT_ENTERED", &marker)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    ));
    let health = f.data.join("observer/runtime.json");
    wait_until(|| health.exists());
    f.send("blocked-read", "local fixture");
    wait_until(|| marker.exists());
    let started = Instant::now();
    unsafe {
        libc::kill(service.id() as i32, libc::SIGTERM);
    }
    wait_until(|| service.try_wait().unwrap().is_some());
    let output = service.finish();
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(output.status.success() && output.stdout.is_empty() && output.stderr.is_empty());
    assert!(!Path::new(&f.registration.socket_path).exists());
    let health: serde_json::Value = serde_json::from_slice(&fs::read(health).unwrap()).unwrap();
    assert_eq!(health["cleanShutdown"], true);
}
