#[cfg(unix)]
mod unix {
    // Creates a fresh, isolated repository and Proof transport for an opt-in real
    // Codex run. It never reads or modifies the user's Agent configuration.
    use proof_core::{ObserverAgent, Proof};
    use proof_observer::manager::{AgentConfigPaths, CaptureFields, ObserverManager};
    use std::{fs, path::Path, process::Command};

    pub fn run() {
        let args: Vec<_> = std::env::args().collect();
        assert_eq!(
            args.len(),
            4,
            "codex_hook_fixture NEW_DIRECTORY HELPER_BINARY CODEX_BINARY"
        );
        let root = Path::new(&args[1]);
        fs::create_dir(root).expect("Fixture directory must be new");
        let root = fs::canonicalize(root).unwrap();
        let repo = root.join("repo");
        fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            let result = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.name", "Proof Hook Fixture"]);
        git(&["config", "user.email", "hook@example.invalid"]);
        git(&["config", "commit.gpgsign", "false"]);
        git(&[
            "config",
            "core.hooksPath",
            repo.join(".git/hooks").to_str().unwrap(),
        ]);
        fs::write(repo.join("answer.py"), "def answer():\n    return 41\n").unwrap();
        git(&["add", "answer.py"]);
        git(&["commit", "-m", "Initial hook fixture"]);
        fs::write(repo.join(".git/info/exclude"), ".codex/\n").unwrap();
        let data = root.join("data");
        let mut proof = Proof::open(&data).unwrap();
        let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
        proof.set_trust(&workspace.id, true).unwrap();
        let config_dir = root.join("codex-config");
        let mut manager = ObserverManager::new(
            data.clone(),
            args[2].clone().into(),
            AgentConfigPaths {
                codex: config_dir.clone(),
                claude: root.join("claude-config"),
                codewiz: root.join("claude-config"),
            },
        );
        let probe = proof
            .probe_observer(ObserverAgent::Codex, &args[3])
            .unwrap();
        let preview = manager
            .preview_install(
                &proof,
                &workspace.id,
                &args[3],
                probe,
                CaptureFields {
                    prompt: true,
                    command: true,
                    reply: true,
                    output: true,
                    background: false,
                },
            )
            .unwrap();
        let installed = manager.apply(&proof, &preview.id).unwrap();
        assert!(installed.observing_enabled, "{:?}", installed.warning);
        manager.stop_owned_runtime(&proof).unwrap();
        let record = proof
            .observer_hook_records()
            .unwrap()
            .into_iter()
            .find(|r| r.installation_id == installed.installation_id)
            .unwrap();
        let helper = record.ownership["config"]["spec"]["helperPath"]
            .as_str()
            .unwrap();
        fs::write(root.join("fixture.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "workspace": workspace, "dataDirectory": data, "helper": helper, "hookConfiguration": config_dir.join("hooks.json"), "installationId": installed.installation_id,
        "sourceBaseline": "def answer():\n    return 41\n", "expectedSource": "def answer():\n    return 42\n"
    })).unwrap()).unwrap();
        println!("{}", root.display());
    }
}
#[cfg(unix)]
fn main() {
    unix::run()
}
#[cfg(not(unix))]
fn main() {
    eprintln!("This fixture is available on Unix only");
    std::process::exit(1);
}
