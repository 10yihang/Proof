//! Optional native OpenCodeReview regression against the installed CLI.
//! Probing never calls a model; the review test uses whatever provider the
//! user configured under ~/.opencodereview.
use super::*;
use crate::{ai::OcrComparison, Side};

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
#[ignore = "Exercises the installed OCR preview in Proof's sandbox without any model calls"]
fn installed_ocr_preview_confirms_scope_and_exact_comparison() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let data = temp.path().join("data");
    let runtime = temp.path().join("runtime");
    fs::create_dir(&repo).unwrap();
    fs::create_dir(&runtime).unwrap();
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .current_dir(&repo)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output);
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    git(&["init", "-b", "main"]);
    git(&["config", "user.name", "Proof OCR test"]);
    git(&["config", "user.email", "proof@example.invalid"]);
    fs::write(repo.join("chosen.rs"), "const X: i32 = 0;\n").unwrap();
    fs::write(repo.join("other,[1].rs"), "const Y: i32 = 0;\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-m", "base"]);
    let base = git(&["rev-parse", "HEAD"]);
    git(&["switch", "-c", "left"]);
    fs::write(repo.join("other,[1].rs"), "const Y: i32 = 1;\n").unwrap();
    git(&["commit", "-am", "left"]);
    let left = git(&["rev-parse", "HEAD"]);
    git(&["switch", "-c", "right", &base]);
    fs::write(repo.join("chosen.rs"), "const X: i32 = 1;\n").unwrap();
    git(&["commit", "-am", "right"]);
    let right = git(&["rev-parse", "HEAD"]);
    fs::write(repo.join("chosen.rs"), "const X: i32 = 2;\n").unwrap();
    fs::write(repo.join("other,[1].rs"), "const Y: i32 = 2;\n").unwrap();

    let mut proof = crate::Proof::open(&data).unwrap();
    let providers = proof.prepare_ocr_connection().unwrap().providers().unwrap();
    assert!(providers.iter().any(|provider| provider == "chatgpt"));
    assert!(providers.iter().any(|provider| provider == "openai"));
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    proof.set_trust(&workspace.id, true).unwrap();
    let rules = proof.ocr_rules(&workspace.id).unwrap();
    let saved = proof
        .set_ocr_rules(
            &workspace.id,
            r#"{"include":["*.rs"],"exclude":[".opencodereview/**"],"rules":[{"path":"chosen.rs","rule":"Check the constant."}]}"#,
            &rules.fingerprint,
        )
        .unwrap();
    assert_ne!(saved.fingerprint, rules.fingerprint);
    let matched = proof
        .prepare_ocr_preview(&workspace.id, None, None)
        .unwrap()
        .inspect_rule("chosen.rs")
        .unwrap();
    assert_eq!(matched.pattern.as_deref(), Some("chosen.rs"));
    assert_eq!(
        proof
            .set_ocr_rules(&workspace.id, "{}", &rules.fingerprint)
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
    let preview = proof
        .prepare_ocr_preview(&workspace.id, None, None)
        .unwrap()
        .run()
        .unwrap();
    assert_eq!(
        preview.files.iter().filter(|file| file.will_review).count(),
        2
    );
    let exact = proof
        .prepare_ocr_preview(
            &workspace.id,
            None,
            Some(OcrComparison {
                base: left,
                target: right,
            }),
        )
        .unwrap()
        .run()
        .unwrap();
    assert_eq!(
        exact.files.iter().filter(|file| file.will_review).count(),
        2
    );
    let scope = ["chosen.rs".to_owned()];
    let selection = runtime.join("scope.json");
    fs::write(
        &selection,
        serde_json::to_vec(&ocr::selection_rule(&preview, &scope).unwrap()).unwrap(),
    )
    .unwrap();
    let program = AgentProgram::configured(
        AgentKind::Ocr,
        &data,
        Some(&workspace.id),
        proof.cached_data_epoch,
        &AgentOptions::default(),
    )
    .unwrap();
    let scoped = preview_ocr(&program, &repo, &runtime, &[], Some(&selection), None).unwrap();
    let eligible: Vec<_> = scoped
        .files
        .iter()
        .filter(|file| file.will_review)
        .map(|file| &file.path)
        .collect();
    assert_eq!(eligible, vec![&scope[0]]);
    let root = preview_ocr(&program, &repo, &runtime, &["--commit", &base], None, None).unwrap();
    assert_eq!(
        root.files
            .iter()
            .filter(|file| file.will_review && file.path.ends_with(".rs"))
            .count(),
        2
    );

    let linked = temp.path().join("linked");
    let linked_path = linked.to_str().unwrap();
    git(&["worktree", "add", "-b", "linked", linked_path, &base]);
    fs::write(linked.join("chosen.rs"), "const X: i32 = 1;\n").unwrap();
    git(&["-C", linked_path, "add", "chosen.rs"]);
    fs::write(linked.join("chosen.rs"), "const X: i32 = 0;\n").unwrap();
    let workspace = proof.open_workspace(linked_path).unwrap();
    proof.set_trust(&workspace.id, true).unwrap();
    let live = proof
        .prepare_ocr_preview(&workspace.id, None, None)
        .unwrap()
        .run()
        .unwrap();
    assert!(live.files.is_empty());
    let changes = proof.changes(&workspace.id).unwrap();
    assert_eq!(changes.files.len(), 2, "{:?}", changes.files);
    let git_impl = proof.git().unwrap();
    let view = crate::ai::ocr_git::OcrGitPlan::local(git_impl, changes)
        .capture(&[("chosen.rs".into(), Side::Unstaged)])
        .unwrap();
    let range = &view.ranges[0];
    assert_eq!(
        git(&[
            "-C",
            linked_path,
            "--git-dir",
            view.git_dir.to_str().unwrap(),
            "diff",
            "--name-only",
            &range.base,
            &range.target,
        ]),
        "chosen.rs"
    );
    for side in [Side::Staged, Side::Unstaged] {
        let pinned = proof
            .prepare_ocr_preview_with_side(&workspace.id, None, None, Some(side))
            .unwrap()
            .run()
            .unwrap();
        assert_eq!(pinned.files.len(), 1, "{side:?}: {pinned:?}");
        assert_eq!(pinned.files[0].path, "chosen.rs");
        assert!(pinned.files[0].will_review);
    }
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
