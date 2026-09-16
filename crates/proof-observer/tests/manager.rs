#![cfg(target_os = "macos")]
use proof_core::{DataScope, ObserverAgent, ObserverConsent, Proof};
use proof_observer::manager::{AgentConfigPaths, CaptureFields, ObserverManager};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().into()
}
fn repository(path: &Path) {
    fs::create_dir(path).unwrap();
    git(path, &["init", "-b", "main"]);
    git(path, &["config", "user.name", "Hook test"]);
    git(path, &["config", "user.email", "hook@example.invalid"]);
    git(path, &["config", "commit.gpgsign", "false"]);
    git(
        path,
        &[
            "config",
            "core.hooksPath",
            path.join(".git/hooks").to_str().unwrap(),
        ],
    );
    fs::write(path.join("code.txt"), "unchanged source\n").unwrap();
    git(path, &["add", "."]);
    git(path, &["commit", "-m", "Initial"]);
}
struct Fixture {
    root: tempfile::TempDir,
    proof: Proof,
    manager: ObserverManager,
    workspace: proof_core::Workspace,
    program: PathBuf,
    config: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir_in("/private/tmp").unwrap();
        let repo = root.path().join("repo");
        repository(&repo);
        fs::create_dir(root.path().join("user")).unwrap();
        fs::create_dir(root.path().join("user/.codex")).unwrap();
        let config = root.path().join("user/.codex/hooks.json");
        fs::write(&config,"{\n  \"keep\": \"PRIVATE_CONFIG\",\n  \"hooks\": {\"PostToolUse\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"true\"}]}]}}\n").unwrap();
        let program = root.path().join("codex");
        fs::write(&program, "#!/bin/sh\nprintf 'codex-cli 0.153.4\\n'\n").unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let mut proof = Proof::open(root.path().join("data")).unwrap();
        let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
        proof.set_trust(&workspace.id, true).unwrap();
        let manager = ObserverManager::new(
            root.path().join("data"),
            PathBuf::from(env!("CARGO_BIN_EXE_proof-observer")),
            AgentConfigPaths {
                codex: root.path().join("user/.codex"),
                claude: root.path().join("user/.claude"),
                codewiz: root.path().join("user/codewiz"),
            },
        );
        Self {
            root,
            proof,
            manager,
            workspace,
            program,
            config,
        }
    }
    fn preview(&mut self) -> proof_observer::manager::HookPreview {
        let probe = self
            .proof
            .probe_observer(ObserverAgent::Codex, self.program.to_str().unwrap())
            .unwrap();
        self.manager
            .preview_install(
                &self.proof,
                &self.workspace.id,
                self.program.to_str().unwrap(),
                probe,
                CaptureFields::default(),
            )
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!(
                "runtime health: {:?}",
                fs::read_to_string(self.root.path().join("data/observer/runtime.json"))
            );
        }
        let _ = self.manager.stop_owned_runtime(&self.proof);
    }
}

#[test]
fn codewiz_plugin_installs_captures_native_turns_and_uninstalls_without_changing_user_config() {
    let mut f = Fixture::new();
    fs::write(&f.program, "#!/bin/sh\nprintf '0.1.99\\n'\n").unwrap();
    let config = f.root.path().join("user/codewiz");
    fs::create_dir_all(config.join("plugins")).unwrap();
    let user_config = b"{ // preserve user settings\n \"plugin\": [\"company-plugin\"], \"model\": \"company/model\"\n}\n";
    fs::write(config.join("codewiz.jsonc"), user_config).unwrap();
    fs::write(
        config.join("plugins/company.js"),
        "// existing company plugin",
    )
    .unwrap();
    fs::write(config.join("package.json"), r#"{"type":"module"}"#).unwrap();
    let probe = f
        .proof
        .probe_observer(ObserverAgent::Codewiz, f.program.to_str().unwrap())
        .unwrap();
    let preview = f
        .manager
        .preview_install(
            &f.proof,
            &f.workspace.id,
            f.program.to_str().unwrap(),
            probe,
            CaptureFields {
                prompt: true,
                command: true,
                reply: true,
                output: true,
                background: true,
            },
        )
        .unwrap();
    assert!(!preview.requires_hook_trust);
    assert!(preview.config_path.ends_with("plugins/proof-observer.js"));
    assert!(
        !Path::new(&preview.config_path).exists(),
        "Preview must not write configuration"
    );
    let result = f.manager.apply(&f.proof, &preview.id).unwrap();
    assert!(result.observing_enabled, "{:?}", result.warning);
    let output = Command::new("node").args(["--input-type=module", "-e", r#"
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const plugin = (await import(pathToFileURL(process.argv[1]))).default;
const hooks = await plugin({directory: process.argv[2]});
assert.deepEqual(Object.keys(hooks).sort(), ['chat.message', 'dispose', 'event']);
const event = async (type, properties) => hooks.event({event:{type,properties}});
await event('session.created', {info:{id:'session-native'}});
const prompt = {message:{id:'user-native',sessionID:'session-native',role:'user'},parts:[{type:'text',text:'Review authentication'}]};
const before = JSON.stringify(prompt);
await hooks['chat.message']({sessionID:'session-native'}, prompt);
assert.equal(JSON.stringify(prompt), before);
const info = {id:'assistant-native',sessionID:'session-native',role:'assistant',parentID:'user-native'};
await event('message.updated', {info});
const read = {id:'part-read',messageID:info.id,sessionID:info.sessionID,type:'tool',tool:'read',callID:'read-native',state:{status:'completed',input:{filePath:process.argv[2]+'/code.txt'},output:'unchanged source'}};
await event('message.part.updated', {part:read});
await event('message.part.updated', {part:read});
await event('message.part.updated', {part:{id:'part-bash',messageID:info.id,sessionID:info.sessionID,type:'tool',tool:'bash',callID:'bash-native',state:{status:'completed',input:{command:'git status --short'},output:'status result',metadata:{exit:0}}}});
await event('message.part.updated', {part:{id:'part-text',messageID:info.id,sessionID:info.sessionID,type:'text',text:'Finished reviewing the file',time:{end:1}}});
const finalReply = event('message.updated', {info:{...info,time:{completed:2},finish:'stop'}});
await hooks.dispose();
await finalReply;
await event('message.updated', {info:{...info,time:{completed:2},finish:'stop'}});
assert.equal(JSON.stringify(prompt), before);
"#, &preview.config_path, &f.workspace.path]).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.is_empty(),
        "Passive plugin cannot emit model feedback"
    );
    let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let events = loop {
        let events = f.proof.observer_events(&f.workspace.id, None, 0).unwrap();
        if events.len() == 5 || std::time::Instant::now() >= until {
            break events;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    assert_eq!(
        events.len(),
        5,
        "{:?}",
        events.iter().map(|e| &e.kind).collect::<Vec<_>>()
    );
    assert!(events.iter().all(|e| e.agent == ObserverAgent::Codewiz));
    let read = events
        .iter()
        .find(|e| e.tool_ref.as_deref() == Some("read-native"))
        .unwrap();
    assert_eq!(read.paths, ["code.txt"]);
    assert_eq!(read.turn_id.as_deref(), Some("user-native"));
    let bash = events
        .iter()
        .find(|e| e.tool_ref.as_deref() == Some("bash-native"))
        .unwrap();
    assert_eq!(bash.command.as_deref(), Some("git status --short"));
    assert_eq!(bash.exit_code, Some(0));
    assert!(events
        .iter()
        .any(|e| e.reply.as_deref() == Some("Finished reviewing the file")));
    assert_eq!(
        f.proof
            .context_overview(&f.workspace.id, "code.txt")
            .unwrap()
            .links[0]
            .session
            .agent,
        Some(ObserverAgent::Codewiz)
    );
    let uninstall = f
        .manager
        .preview_uninstall(&f.proof, &result.installation_id)
        .unwrap();
    f.manager.apply(&f.proof, &uninstall.id).unwrap();
    assert!(!Path::new(&preview.config_path).exists());
    assert_eq!(fs::read(config.join("codewiz.jsonc")).unwrap(), user_config);
    assert_eq!(
        fs::read_to_string(config.join("plugins/company.js")).unwrap(),
        "// existing company plugin"
    );
    assert_eq!(
        git(Path::new(&f.workspace.path), &["status", "--porcelain"]),
        ""
    );
}

#[test]
#[ignore = "Installed Codewiz with synthetic config and loopback HTTP only; no model calls or user sessions"]
fn installed_codewiz_loads_the_plugin_and_delivers_native_session_events() {
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        time::{Duration, Instant},
    };
    let mut f = Fixture::new();
    let location = f
        .proof
        .observer_program_locations()
        .unwrap()
        .into_iter()
        .find(|p| p.agent == ObserverAgent::Codewiz)
        .expect("Codewiz installed");
    let source = location.executable_path.unwrap();
    let probe = f
        .proof
        .probe_observer(ObserverAgent::Codewiz, &source)
        .unwrap();
    let native = probe.executable_path.clone();
    let version = probe.version.clone();
    let config = f.root.path().join("user/codewiz");
    fs::create_dir_all(&config).unwrap();
    fs::write(config.join("codewiz.json"), r#"{"autoupdate":false,"share":"disabled","snapshot":false,"plugin":[],"mcp":{},"lsp":false,"formatter":false,"enabled_providers":[],"permission":"deny"}"#).unwrap();
    let preview = f
        .manager
        .preview_install(
            &f.proof,
            &f.workspace.id,
            &source,
            probe,
            CaptureFields {
                background: true,
                ..Default::default()
            },
        )
        .unwrap();
    let installed = f.manager.apply(&f.proof, &preview.id).unwrap();
    assert!(installed.observing_enabled, "{:?}", installed.warning);
    // This plugin has no package dependencies. A read-only config directory
    // prevents Codewiz's unrelated npm bootstrap in this offline native test.
    struct ReadOnlyConfig(PathBuf);
    impl Drop for ReadOnlyConfig {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }
    fs::set_permissions(&config, fs::Permissions::from_mode(0o500)).unwrap();
    let read_only_config = ReadOnlyConfig(config.clone());
    for part in ["home", "cache", "state", "share", "bin"] {
        fs::create_dir_all(f.root.path().join(part)).unwrap();
    }
    let ps = f.root.path().join("bin/ps");
    fs::write(&ps, "#!/bin/sh\nprintf 'PID PPID ELAPSED COMMAND\\n'\n").unwrap();
    fs::set_permissions(&ps, fs::Permissions::from_mode(0o700)).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let quote = |p: &Path| serde_json::to_string(&p.to_string_lossy()).unwrap();
    let socket = proof_observer::runtime::socket_path(&f.root.path().join("data")).unwrap();
    let profile = format!("(version 1)(allow default)(deny file-write*)(allow file-write* (subpath {})(literal \"/dev/null\"))(deny signal)(deny network-outbound)(allow network-outbound (remote ip \"localhost:*\")(remote unix-socket (literal {})))", quote(f.root.path()), quote(&socket));
    let log_path = f.root.path().join("native-codewiz.log");
    let log = fs::File::create(&log_path).unwrap();
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .args([
            "-p",
            &profile,
            &native,
            "serve",
            "--print-logs",
            "--log-level",
            "DEBUG",
            "--hostname",
            "127.0.0.1",
            "--port",
            &port.to_string(),
        ])
        .current_dir(&f.workspace.path)
        .env_clear()
        .env("APP_NAME", "codewiz")
        .env("HOME", f.root.path().join("home"))
        .env("OPENCODE_TEST_HOME", f.root.path().join("home"))
        .env("OPENCODE_CONFIG_CONTENT", "{}")
        .env(
            "OPENCODE_TEST_MANAGED_CONFIG_DIR",
            f.root.path().join("home/managed"),
        )
        .env("XDG_CONFIG_HOME", f.root.path().join("user"))
        .env("XDG_CACHE_HOME", f.root.path().join("cache"))
        .env("XDG_DATA_HOME", f.root.path().join("share"))
        .env("XDG_STATE_HOME", f.root.path().join("state"))
        .env("TMPDIR", f.root.path())
        .env("LANG", "en_US.UTF-8")
        .env(
            "PATH",
            format!(
                "{}:/usr/bin:/bin:/opt/homebrew/bin",
                f.root.path().join("bin").display()
            ),
        )
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdout(log.try_clone().unwrap())
        .stderr(log);
    for key in [
        "OPENCODE_DISABLE_AUTOUPDATE",
        "OPENCODE_DISABLE_MODELS_FETCH",
        "OPENCODE_DISABLE_DEFAULT_PLUGINS",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS",
        "OPENCODE_DISABLE_LSP_DOWNLOAD",
        "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER",
        "OPENCODE_DISABLE_FFF",
    ] {
        command.env(key, "true");
    }
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut server = Server(command.spawn().unwrap());
    let until = Instant::now() + Duration::from_secs(30);
    let mut stream = loop {
        if let Ok(stream) = TcpStream::connect(("127.0.0.1", port)) {
            break stream;
        }
        if server.0.try_wait().unwrap().is_some() || Instant::now() >= until {
            panic!(
                "Codewiz startup: {}",
                fs::read_to_string(&log_path).unwrap()
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let body = r#"{"title":"Proof Hook fixture; no model"}"#;
    write!(stream, "POST /session?directory={} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", f.workspace.path, body.len()).unwrap();
    let mut response = String::new();
    if let Err(error) = stream.read_to_string(&mut response) {
        assert!(
            response.starts_with("HTTP/1.1 200"),
            "HTTP read {error}: {response}; native log: {}",
            fs::read_to_string(&log_path).unwrap()
        );
    }
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "Native session response: {response}; {}",
        fs::read_to_string(&log_path).unwrap()
    );
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let events = f.proof.observer_events(&f.workspace.id, None, 0).unwrap();
        if let Some(event) = events.iter().find(|e| e.kind == "SessionStart") {
            assert_eq!(event.agent, ObserverAgent::Codewiz);
            assert!(event.native_session_id.is_some());
            println!("Codewiz {version}: native local plugin delivered SessionStart without a model call");
            break;
        }
        assert!(
            Instant::now() < until,
            "No native plugin event: {}",
            fs::read_to_string(&log_path).unwrap()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(server);
    drop(read_only_config);
    let uninstall = f
        .manager
        .preview_uninstall(&f.proof, &installed.installation_id)
        .unwrap();
    f.manager.apply(&f.proof, &uninstall.id).unwrap();
}

#[test]
fn codewiz_missing_config_is_not_created_by_preview_and_symlink_replacement_is_rejected() {
    let mut f = Fixture::new();
    fs::write(&f.program, "#!/bin/sh\nprintf '0.1.99\\n'\n").unwrap();
    let config = f.root.path().join("user/codewiz");
    let outside = f.root.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let probe = f
        .proof
        .probe_observer(ObserverAgent::Codewiz, f.program.to_str().unwrap())
        .unwrap();
    let preview = f
        .manager
        .preview_install(
            &f.proof,
            &f.workspace.id,
            f.program.to_str().unwrap(),
            probe,
            CaptureFields::default(),
        )
        .unwrap();
    assert!(!config.exists());
    std::os::unix::fs::symlink(&outside, &config).unwrap();
    assert!(f.manager.apply(&f.proof, &preview.id).is_err());
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
}

#[test]
fn preview_cancel_install_probe_and_uninstall_preserve_user_hooks_and_git() {
    let mut f = Fixture::new();
    let before = fs::read(&f.config).unwrap();
    let repo = PathBuf::from(&f.workspace.path);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    let index = fs::read(repo.join(".git/index")).unwrap();
    let preview = f.preview();
    assert!(preview.requires_hook_trust);
    assert!(f.proof.observer_installations().unwrap().is_empty());
    assert_eq!(fs::read(&f.config).unwrap(), before);
    f.manager.cancel(&preview.id);
    assert!(f.manager.apply(&f.proof, &preview.id).is_err());
    let preview = f.preview();
    let result = f.manager.apply(&f.proof, &preview.id).unwrap();
    assert!(result.observing_enabled, "{:?}", result.warning);
    assert_eq!(
        f.proof
            .observer_events(&f.workspace.id, None, 0)
            .unwrap()
            .len(),
        0,
        "The connection probe must not invent an Agent activity"
    );
    let directory = f
        .root
        .path()
        .join("data/observer/installations")
        .join(&result.installation_id);
    assert_eq!(
        fs::read(directory.join("config-backup.json")).unwrap(),
        before
    );
    assert_eq!(
        fs::metadata(directory.join("registration.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let encoded = serde_json::to_string(&preview).unwrap();
    let registration: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.join("registration.json")).unwrap()).unwrap();
    assert!(!encoded.contains(registration["token"].as_str().unwrap()));
    let uninstall = f
        .manager
        .preview_uninstall(&f.proof, &result.installation_id)
        .unwrap();
    f.manager.apply(&f.proof, &uninstall.id).unwrap();
    assert_eq!(fs::read(&f.config).unwrap(), before);
    assert!(!directory.exists());
    assert!(f
        .proof
        .observer_consents()
        .unwrap()
        .iter()
        .all(|p| !p.enabled));
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read_to_string(repo.join("code.txt")).unwrap(),
        "unchanged source\n"
    );
}

#[test]
fn changed_policy_or_program_refuses_an_old_install_preview() {
    let mut f = Fixture::new();
    let before = fs::read(&f.config).unwrap();
    let preview = f.preview();
    f.proof.pause_all_observers().unwrap();
    assert_eq!(
        f.manager.apply(&f.proof, &preview.id).unwrap_err().code,
        "OBSERVER_POLICY_CHANGED"
    );
    assert_eq!(fs::read(&f.config).unwrap(), before);
    assert!(f.proof.observer_hook_records().unwrap().is_empty());
    let preview = f.preview();
    fs::write(&f.program, "#!/bin/sh\nprintf 'codex-cli 99.0.0\\n'\n").unwrap();
    assert_eq!(
        f.manager.apply(&f.proof, &preview.id).unwrap_err().code,
        "OBSERVER_PROGRAM_CHANGED"
    );
    assert_eq!(fs::read(&f.config).unwrap(), before);
}

#[test]
fn configuration_conflict_keeps_a_recoverable_receipt_and_can_be_uninstalled() {
    let mut f = Fixture::new();
    let preview = f.preview();
    fs::write(&f.config, "{\"userAdded\":true}\n").unwrap();
    assert_eq!(
        f.manager.apply(&f.proof, &preview.id).unwrap_err().code,
        "OBSERVER_CONFIG_CHANGED"
    );
    assert_eq!(
        fs::read_to_string(&f.config).unwrap(),
        "{\"userAdded\":true}\n"
    );
    let rows = f.proof.observer_hook_records().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, "installing");
    let remove = f
        .manager
        .preview_uninstall(&f.proof, &rows[0].installation_id)
        .unwrap();
    f.manager.apply(&f.proof, &remove.id).unwrap();
    assert_eq!(
        fs::read_to_string(&f.config).unwrap(),
        "{\"userAdded\":true}\n"
    );
}

#[test]
fn an_uninstalled_receipt_cannot_publish_a_delayed_install() {
    let mut f = Fixture::new();
    let preview = f.preview();
    fs::write(&f.config, "{\"changed\":true}").unwrap();
    assert!(f.manager.apply(&f.proof, &preview.id).is_err());
    let id = f.proof.observer_hook_records().unwrap()[0]
        .installation_id
        .clone();
    let remove = f.manager.preview_uninstall(&f.proof, &id).unwrap();
    f.manager.apply(&f.proof, &remove.id).unwrap();
    let called = std::cell::Cell::new(false);
    assert_eq!(
        f.proof
            .change_observer_hook(&id, 0, "installed", || {
                called.set(true);
                Ok(())
            })
            .unwrap_err()
            .code,
        "OBSERVER_CONFIG_STATE_CHANGED"
    );
    assert!(!called.get());
}

#[test]
fn shared_hook_survives_one_repository_deletion_and_blocks_unsafe_final_deletion() {
    let mut f = Fixture::new();
    let preview = f.preview();
    let result = f.manager.apply(&f.proof, &preview.id).unwrap();
    assert!(result.observing_enabled, "{:?}", result.warning);
    let second = f.root.path().join("second");
    repository(&second);
    let workspace = f.proof.open_workspace(second.to_str().unwrap()).unwrap();
    f.proof.set_trust(&workspace.id, true).unwrap();
    f.proof
        .enable_installed_observer(
            &ObserverConsent {
                installation_id: result.installation_id.clone(),
                workspace_id: workspace.id,
                enabled: true,
                prompt: false,
                command: false,
                reply: false,
                output: false,
                background: false,
            },
            0,
            f.proof.observer_policy_revision().unwrap(),
        )
        .unwrap();
    let configured = fs::read(&f.config).unwrap();
    let preview = f
        .proof
        .prepare_data_deletion(DataScope::Repository {
            repository_id: f.workspace.repository_id.clone(),
        })
        .unwrap();
    f.proof.delete_local_data(&preview.id).unwrap();
    assert_eq!(fs::read(&f.config).unwrap(), configured);
    assert_eq!(f.proof.observer_hook_records().unwrap().len(), 1);
    let all = f.proof.prepare_data_deletion(DataScope::All).unwrap();
    assert_eq!(
        f.proof.delete_local_data(&all.id).unwrap_err().code,
        "OBSERVER_UNINSTALL_REQUIRED"
    );
    let remove = f
        .manager
        .preview_uninstall(&f.proof, &result.installation_id)
        .unwrap();
    f.manager.apply(&f.proof, &remove.id).unwrap();
    let all = f.proof.prepare_data_deletion(DataScope::All).unwrap();
    f.proof.delete_local_data(&all.id).unwrap();
    assert!(f.proof.observer_hook_records().unwrap().is_empty());
    assert_eq!(git(&second, &["status", "--porcelain"]), "");
}

#[test]
fn a_new_codex_version_can_preview_install_and_check_its_bridge() {
    let mut f = Fixture::new();
    fs::write(
        &f.program,
        "#!/bin/sh\nprintf 'codex-cli 99.0.0-preview.2\\n'\n",
    )
    .unwrap();
    let before = fs::read(&f.config).unwrap();
    let preview = f.preview();
    assert_eq!(preview.agent_version, "99.0.0-preview.2");
    assert_eq!(fs::read(&f.config).unwrap(), before);
    let result = f.manager.apply(&f.proof, &preview.id).unwrap();
    assert!(result.observing_enabled, "{:?}", result.warning);
    assert!(f
        .proof
        .observer_events(&f.workspace.id, None, 0)
        .unwrap()
        .is_empty());
    fs::write(&f.program, "#!/bin/sh\nprintf 'codex-cli 100.0.0\\n'\n").unwrap();
    f.manager.tick(&f.proof).unwrap();
    assert!(f
        .proof
        .observer_consents()
        .unwrap()
        .iter()
        .any(|consent| consent.enabled));
    fs::set_permissions(&f.program, fs::Permissions::from_mode(0o777)).unwrap();
    f.manager.tick(&f.proof).unwrap();
    assert!(f
        .proof
        .observer_consents()
        .unwrap()
        .iter()
        .all(|consent| !consent.enabled));
    let undo = f
        .manager
        .preview_uninstall(&f.proof, &result.installation_id)
        .unwrap();
    f.manager.apply(&f.proof, &undo.id).unwrap();
    assert_eq!(fs::read(&f.config).unwrap(), before);
}
