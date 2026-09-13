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
