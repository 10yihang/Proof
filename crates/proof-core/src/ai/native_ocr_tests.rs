//! Optional native OpenCodeReview regression against the installed CLI.
//! Probing never calls a model; the review test uses whatever provider the
//! user configured under ~/.opencodereview.
use super::*;

#[test]
#[ignore = "Installed OCR version/capability/config detection only; no model calls"]
fn installed_ocr_probe_detects_the_existing_installation() {
    let temp = tempfile::tempdir().unwrap();
    let proof = crate::Proof::open(temp.path()).unwrap();
    let result = proof
        .prepare_agent_probe(AgentKind::Ocr, AgentOptions::default())
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
        "OCR {} compatible={} configured={:?}",
        result.version, result.compatible, result.authenticated
    );
}

#[test]
#[ignore = "Installed OCR against the user-configured model; small fixture review"]
fn installed_ocr_reviews_a_live_workspace_inside_the_sandbox() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    let git = |args: &[&str]| -> String {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output);
        String::from_utf8(output.stdout).unwrap()
    };
    git(&["init", "-b", "main"]);
    git(&["config", "user.name", "Proof fixture"]);
    git(&["config", "user.email", "proof@example.invalid"]);
    fs::write(repo.join("main.rs"), "fn main() {}\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-m", "base"]);
    fs::write(repo.join("main.rs"), "fn main() { let p = \"123\"; }\n").unwrap();
    let mut proof = crate::Proof::open(temp.path().join("data")).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    proof.set_trust(&workspace.id, true).unwrap();
    let changes = proof.changes(&workspace.id).unwrap();
    let task = proof
        .prepare_ai_task(super::super::AiRequest {
            amend: false,
            provider: AgentKind::Ocr,
            task: super::super::AiTask::Review,
            scope: super::super::AiScope::Local {
                workspace_id: workspace.id.clone(),
                expected_token: changes.token,
                files: None,
            },
        })
        .unwrap();
    let report = task.run().unwrap();
    let review = report.review.expect("OCR review payload");
    assert!(!review.summary.is_empty());
    for finding in &review.findings {
        assert_eq!(finding.file, "main.rs");
    }
    assert_eq!(git(&["status", "--porcelain"]), " M main.rs\n");
    println!("OCR findings: {}", review.findings.len());
}
