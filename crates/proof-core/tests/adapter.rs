#![cfg(unix)]
use proof_core::{ObserverAgent, Proof};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

struct Fixture {
    _temp: tempfile::TempDir,
    program: PathBuf,
    proof: Proof,
}
impl Fixture {
    fn new(script: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let program = temp.path().join("agent-script");
        fs::write(&program, script).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let proof = Proof::open(temp.path().join("data")).unwrap();
        Self {
            _temp: temp,
            program,
            proof,
        }
    }
}

#[test]
fn a_version_string_never_promotes_runtime_compatibility_or_grants_collection() {
    for (agent, output) in [
        (ObserverAgent::Codex, "codex-cli 0.153.4"),
        (ObserverAgent::Claude, "2.1.236 (Claude Code)"),
        (ObserverAgent::Codex, "codex-cli 9.9.9-alpha.2"),
        (ObserverAgent::Claude, "3.1.0 (Claude Code)"),
        (ObserverAgent::Codewiz, "0.1.99"),
        (ObserverAgent::Codewiz, "codewiz 9.9.0-preview.2"),
    ] {
        let f = Fixture::new(&format!(
            "#!/bin/sh\n[ \"$1\" = --version ] || exit 91\nprintf '%s\\n' '{output}'\n"
        ));
        let result = f
            .proof
            .probe_observer(agent, f.program.to_str().unwrap())
            .unwrap();
        assert_eq!(result.status, "candidate_unverified");
        let profile = result.profile.unwrap();
        assert!(!profile.runtime_verified);
        assert_eq!(profile.fixture_status, "local_protocol_only");
        assert_eq!(result.executable_identity.len(), 64);
        assert!(f.proof.observer_installations().unwrap().is_empty());
        assert!(f.proof.observer_consents().unwrap().is_empty());
    }
    let f = Fixture::new("#!/bin/sh\nprintf 'codex-cli 9.9.9\\n'\n");
    let result = f
        .proof
        .probe_observer(ObserverAgent::Codex, f.program.to_str().unwrap())
        .unwrap();
    assert_eq!(result.version, "9.9.9");
    assert_eq!(result.status, "candidate_unverified");
    assert!(!result.profile.unwrap().runtime_verified);
}

#[test]
fn every_registered_agent_exposes_active_and_passive_capabilities_from_one_adapter() {
    for adapter in proof_core::AGENT_ADAPTERS {
        assert_eq!(adapter.provider().kind(), adapter.kind);
        assert_eq!(adapter.kind.adapter().observer, adapter.observer);
        assert_eq!(adapter.observer.adapter().kind, adapter.kind);
        assert!(!proof_core::observer_hook_events_v1(adapter.observer).is_empty());
        assert_eq!(
            adapter.hook_installation_available(),
            adapter.hook_unavailable_reason().is_none()
        );
    }
    let f = Fixture::new("#!/bin/sh\nprintf '0.1.99\\n'\n");
    f.proof
        .set_agent_settings(proof_core::AgentSettingsUpdate {
            prompts: None,
            expected_revision: 0,
            default_provider: proof_core::AgentKind::Codewiz,
            codex: Default::default(),
            claude_code: Default::default(),
            codewiz: Some(proof_core::AgentOptions {
                executable_path: Some(f.program.to_str().unwrap().into()),
                model: None,
            }),
        })
        .unwrap();
    let active = f.proof.agent_providers().unwrap();
    let hook = f.proof.observer_program_locations().unwrap();
    let active = active
        .iter()
        .find(|item| item.id == proof_core::AgentKind::Codewiz)
        .unwrap();
    let hook = hook
        .iter()
        .find(|item| item.agent == ObserverAgent::Codewiz)
        .unwrap();
    assert_eq!(active.path, hook.executable_path);
    assert_eq!(active.name, hook.name);
}

#[test]
fn probe_rejects_wrong_program_permissions_and_never_returns_private_output() {
    let f = Fixture::new(
        "#!/bin/sh\nprintf 'PRIVATE_UNKNOWN_OUTPUT\\n'\nprintf 'PRIVATE_ERROR_OUTPUT\\n' >&2\n",
    );
    let error = f
        .proof
        .probe_observer(ObserverAgent::Codex, f.program.to_str().unwrap())
        .unwrap_err();
    assert_eq!(error.code, "OBSERVER_VERSION_FORMAT");
    assert!(!serde_json::to_string(&error).unwrap().contains("PRIVATE_"));
    fs::set_permissions(&f.program, fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(
        f.proof
            .probe_observer(ObserverAgent::Codex, f.program.to_str().unwrap())
            .unwrap_err()
            .code,
        "OBSERVER_PROGRAM_PERMISSION"
    );
    assert_eq!(
        f.proof
            .probe_observer(ObserverAgent::Codex, "codex")
            .unwrap_err()
            .code,
        "OBSERVER_PROGRAM_PATH"
    );
}

#[test]
fn version_process_that_never_returns_is_cancelled() {
    let f = Fixture::new("#!/bin/sh\nexec /bin/sleep 30\n");
    let started = std::time::Instant::now();
    let error = f
        .proof
        .probe_observer(ObserverAgent::Codex, f.program.to_str().unwrap())
        .unwrap_err();
    assert_eq!(error.code, "PROCESS_TIMEOUT");
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
}

fn init_repository(path: &std::path::Path) {
    fs::create_dir_all(path).unwrap();
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["init", "-b", "main"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn replaced_workspace_cannot_authorize_a_program_and_old_rows_do_not_block_new_trust() {
    let mut f = Fixture::new(
        "#!/bin/sh\nprintf 'codex-cli 0.153.4\\n'\nprintf executed > executed-marker\n",
    );
    let repo = f._temp.path().join("repo");
    init_repository(&repo);
    let program = repo.join("agent-script");
    fs::rename(&f.program, &program).unwrap();
    let old = f.proof.open_workspace(repo.to_str().unwrap()).unwrap();
    f.proof.set_trust(&old.id, true).unwrap();
    fs::remove_dir_all(repo.join(".git")).unwrap();
    init_repository(&repo);
    assert_eq!(
        f.proof.changes(&old.id).unwrap_err().code,
        "WORKSPACE_REPLACED"
    );
    assert_eq!(
        f.proof
            .probe_observer(ObserverAgent::Codex, program.to_str().unwrap())
            .unwrap_err()
            .code,
        "WORKSPACE_REPLACED"
    );
    assert!(!f._temp.path().join("data/executed-marker").exists());
    let new = f.proof.open_workspace(repo.to_str().unwrap()).unwrap();
    assert_ne!(old.id, new.id);
    f.proof.set_trust(&new.id, true).unwrap();
    assert_eq!(
        f.proof
            .probe_observer(ObserverAgent::Codex, program.to_str().unwrap())
            .unwrap()
            .status,
        "candidate_unverified"
    );
    assert!(f._temp.path().join("data/executed-marker").exists());
}

#[test]
fn prepared_probe_checks_later_revocation_and_untrusted_symlink_origin() {
    let mut f = Fixture::new(
        "#!/bin/sh\nprintf 'codex-cli 0.153.4\\n'\nprintf executed > executed-marker\n",
    );
    let repo = f._temp.path().join("repo");
    init_repository(&repo);
    let link = repo.join("agent-link");
    std::os::unix::fs::symlink(&f.program, &link).unwrap();
    let workspace = f.proof.open_workspace(repo.to_str().unwrap()).unwrap();
    assert_eq!(
        f.proof
            .probe_observer(ObserverAgent::Codex, link.to_str().unwrap())
            .unwrap_err()
            .code,
        "TRUST_REQUIRED"
    );
    f.proof.set_trust(&workspace.id, true).unwrap();
    let job = f
        .proof
        .prepare_observer_probe(ObserverAgent::Codex, link.to_str().unwrap())
        .unwrap();
    f.proof.set_trust(&workspace.id, false).unwrap();
    assert_eq!(job.run().unwrap_err().code, "TRUST_REQUIRED");
    assert!(!f._temp.path().join("data/executed-marker").exists());
}

#[test]
fn directory_links_and_chained_links_preserve_workspace_authority() {
    let mut f = Fixture::new(
        "#!/bin/sh\nprintf 'codex-cli 0.153.4\\n'\nprintf executed > executed-marker\n",
    );
    let repo = f._temp.path().join("repo");
    init_repository(&repo);
    let link = repo.join("agent-folder");
    std::os::unix::fs::symlink("..", &link).unwrap();
    let alias = f._temp.path().join("external-alias");
    std::os::unix::fs::symlink("repo/agent-folder", &alias).unwrap();
    let workspace = f.proof.open_workspace(repo.to_str().unwrap()).unwrap();
    for parent in [&link, &alias] {
        let result = f.proof.probe_observer(
            ObserverAgent::Codex,
            parent.join("agent-script").to_str().unwrap(),
        );
        assert!(!f._temp.path().join("data/executed-marker").exists());
        assert_eq!(result.unwrap_err().code, "TRUST_REQUIRED");
    }
    f.proof.set_trust(&workspace.id, true).unwrap();
    let job = f
        .proof
        .prepare_observer_probe(
            ObserverAgent::Codex,
            alias.join("agent-script").to_str().unwrap(),
        )
        .unwrap();
    f.proof.set_trust(&workspace.id, false).unwrap();
    assert_eq!(job.run().unwrap_err().code, "TRUST_REQUIRED");
    assert!(!f._temp.path().join("data/executed-marker").exists());
    f.proof.set_trust(&workspace.id, true).unwrap();
    assert_eq!(
        f.proof
            .probe_observer(
                ObserverAgent::Codex,
                alias.join("agent-script").to_str().unwrap()
            )
            .unwrap()
            .status,
        "candidate_unverified"
    );
}

#[test]
fn prepared_probe_rejects_program_replacement_and_cyclic_links() {
    let f = Fixture::new(
        "#!/bin/sh\nprintf 'codex-cli 0.153.4\\n'\nprintf executed > executed-marker\n",
    );
    let job = f
        .proof
        .prepare_observer_probe(ObserverAgent::Codex, f.program.to_str().unwrap())
        .unwrap();
    let old = f._temp.path().join("previous-program");
    fs::rename(&f.program, &old).unwrap();
    fs::copy(&old, &f.program).unwrap();
    assert_eq!(job.run().unwrap_err().code, "OBSERVER_PROGRAM_CHANGED");
    assert!(!f._temp.path().join("data/executed-marker").exists());
    let cycle = f._temp.path().join("cyclic-program");
    std::os::unix::fs::symlink("cyclic-program", &cycle).unwrap();
    assert!(f
        .proof
        .probe_observer(ObserverAgent::Codex, cycle.to_str().unwrap())
        .is_err());
}

#[test]
#[ignore = "Opt-in local CLI --version query; no model or hook installation"]
fn installed_agents_remain_unverified_after_version_detection() {
    let temp = tempfile::tempdir().unwrap();
    let proof = Proof::open(temp.path()).unwrap();
    for (agent, variable) in [
        (ObserverAgent::Codex, "PROOF_TEST_CODEX_PROGRAM"),
        (ObserverAgent::Claude, "PROOF_TEST_CLAUDE_PROGRAM"),
    ] {
        let path = std::env::var(variable).expect("explicit executable required");
        let result = proof.probe_observer(agent, &path).unwrap();
        assert!(!result.profile.as_ref().is_some_and(|p| p.runtime_verified));
        println!("{} {} {}", agent.as_str(), result.version, result.status);
    }
    assert!(proof.observer_installations().unwrap().is_empty());
}
