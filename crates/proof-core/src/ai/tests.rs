use super::*;
use serde_json::json;
use std::{fs, path::Path, process::Command};
fn git(path: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os().filter(|(key, _)| key.to_string_lossy().starts_with("GIT_"))
    {
        command.env_remove(key);
    }
    let out = command
        .arg("-C")
        .arg(path)
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
fn fixture() -> (tempfile::TempDir, Proof, crate::Workspace) {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.name", "Proof fixture"]);
    git(&repo, &["config", "user.email", "proof@example.invalid"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    git(&repo, &["config", "core.hooksPath", "/dev/null"]);
    fs::write(repo.join("auth.rs"), "fn auth() { allow(false); }\n").unwrap();
    fs::write(repo.join("pool.rs"), "fn pool() { close(); }\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "base"]);
    fs::write(repo.join("auth.rs"), "fn auth() { allow(true); }\n").unwrap();
    fs::write(repo.join("pool.rs"), "fn pool() { }\n").unwrap();
    let mut proof = Proof::open(temp.path().join("data")).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    proof.set_trust(&workspace.id, true).unwrap();
    (temp, proof, workspace)
}
fn request(proof: &Proof, workspace: &crate::Workspace, task: AiTask) -> AiRequest {
    AiRequest {
        amend: false,
        provider: AgentKind::Codex,
        task,
        scope: AiScope::Local {
            workspace_id: workspace.id.clone(),
            expected_token: proof.changes(&workspace.id).unwrap().token,
            files: None,
        },
    }
}
fn group() -> AiGroup {
    AiGroup {
        title: "Authentication and pool".into(),
        summary: "Two related changes".into(),
        files: vec!["auth.rs".into(), "pool.rs".into()],
        risk: AiRisk::High,
        review_priority: 1,
    }
}
fn review() -> serde_json::Value {
    json!({"analysisStatus":"completed","blockers":[],"summary":"Check access control", "overallRisk":"high", "findings":[{"severity":"high","title":"Unconditional access","description":"This grants access without validation.","file":"auth.rs","side":"unstaged","line":1,"lineSide":"new","suggestion":"Keep validation."}],"behaviorChanges":["Access granted"],"missingTests":["Unauthenticated access"],"reviewPriority":["auth.rs"]})
}

#[test]
#[ignore = "same-fixture comparison preparation benchmark; never starts an Agent"]
fn comparison_preparation_benchmark() {
    let (temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    git(repo, &["reset", "--hard", "HEAD"]);
    for i in 0..100 {
        fs::write(
            repo.join(format!("bench-{i:03}.txt")),
            "before\n".repeat(100),
        )
        .unwrap();
    }
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "benchmark base"]);
    let base = git(repo, &["rev-parse", "HEAD"]);
    for i in 0..100 {
        fs::write(
            repo.join(format!("bench-{i:03}.txt")),
            "after\n".repeat(100),
        )
        .unwrap();
    }
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "benchmark target"]);
    let target = git(repo, &["rev-parse", "HEAD"]);
    let trace = temp.path().join("comparison-trace.jsonl");
    let mut samples = Vec::new();
    let mut processes = Vec::new();
    let mut lists = Vec::new();
    for _ in 0..3 {
        fs::write(&trace, "").unwrap();
        std::env::set_var("GIT_TRACE2_EVENT", &trace);
        let start = std::time::Instant::now();
        let job = proof
            .prepare_ai_task(AiRequest {
                amend: false,
                provider: AgentKind::Codex,
                task: AiTask::Review,
                scope: AiScope::Comparison {
                    workspace_id: workspace.id.clone(),
                    base: base.clone(),
                    target: target.clone(),
                    path: None,
                    paths: None,
                },
            })
            .unwrap();
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
        std::env::remove_var("GIT_TRACE2_EVENT");
        assert_eq!(job.diffs.len(), 100);
        let entries: Vec<serde_json::Value> = fs::read_to_string(&trace)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        processes.push(
            entries
                .iter()
                .filter(|event| event["event"] == "start")
                .count(),
        );
        lists.push(
            entries
                .iter()
                .filter(|event| {
                    event["event"] == "start"
                        && event["argv"]
                            .as_array()
                            .is_some_and(|args| args.iter().any(|arg| arg == "--name-status"))
                })
                .count(),
        );
        println!(
            "BENCH comparison raw_patch_bytes={} retained_diff_bytes={}",
            job.diffs.iter().map(|d| d.patch.len()).sum::<usize>(),
            job.diffs.iter().map(|d| d.retained_bytes()).sum::<usize>()
        );
    }
    println!("BENCH comparison files=100 milliseconds={samples:?} git_processes={processes:?} file_list_queries={lists:?}");
}

#[test]
fn comparison_evidence_budget_counts_hunks_lines_and_allocated_capacity() {
    let (_temp, proof, workspace) = fixture();
    let base = git(Path::new(&workspace.path), &["rev-parse", "HEAD"]);
    let diff = proof
        .compare_file(&workspace.id, "empty", &base, "auth.rs")
        .unwrap();
    assert!(diff.retained_bytes() > diff.patch.len());
    let mut bytes = MAX_INPUT - diff.patch.len();
    let mut evidence = Vec::new();
    assert_eq!(
        add_diff(&mut evidence, &mut bytes, diff).unwrap_err().code,
        "AI_INPUT_LIMIT"
    );
    assert!(evidence.is_empty());
}

#[test]
fn batch_comparison_matches_standalone_canonical_evidence_with_rename_and_binary() {
    let (_temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    git(repo, &["reset", "--hard", "HEAD"]);
    fs::write(repo.join("before.txt"), "preserved context\n".repeat(30)).unwrap();
    fs::write(repo.join("binary.dat"), b"before\0binary").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "comparison base"]);
    let base = git(repo, &["rev-parse", "HEAD"]);
    git(repo, &["mv", "before.txt", "after [literal].txt"]);
    fs::write(
        repo.join("after [literal].txt"),
        format!("edited\n{}", "preserved context\n".repeat(29)),
    )
    .unwrap();
    fs::write(repo.join("binary.dat"), b"after\0binary").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "comparison target"]);
    let target = git(repo, &["rev-parse", "HEAD"]);
    let index = fs::read(repo.join(".git/index")).unwrap();
    let job = proof
        .prepare_ai_task(AiRequest {
            amend: false,
            provider: AgentKind::Codex,
            task: AiTask::Review,
            scope: AiScope::Comparison {
                workspace_id: workspace.id.clone(),
                base: base.clone(),
                target: target.clone(),
                path: None,
                paths: None,
            },
        })
        .unwrap();
    assert_eq!(job.diffs.len(), 2);
    assert!(job
        .diffs
        .iter()
        .any(|diff| diff.kind == crate::FileKind::Rename));
    assert!(
        job.retained_input_bytes() > job.diffs.iter().map(|diff| diff.patch.len()).sum::<usize>()
    );
    for captured in &job.diffs {
        let mut actual = captured.clone();
        actual.captured_at = 0;
        let mut standalone = proof
            .compare_file(&workspace.id, &base, &target, &actual.path)
            .unwrap();
        standalone.captured_at = 0;
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(standalone).unwrap()
        );
    }
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    assert_eq!(git(repo, &["rev-parse", "HEAD"]), target);
}

#[test]
fn codewiz_noisy_streams_preserve_grouping_and_review_validation() {
    let (_temp, mut proof, workspace) = fixture();
    let decode = |value: serde_json::Value| {
        let text = json!({"type": "text", "part": {"text": value.to_string()}});
        codewiz::decode(format!(
            "[INFO] Starting\n{{\"type\":\"step_start\"}}\n\x1b[36m{text}\x1b[0m\r\n[INFO] Finishing\n{{\"type\":\"step_finish\",\"part\":{{\"reason\":\"stop\"}}}}\n"
        ).as_bytes()).unwrap()
    };
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Grouping))
        .unwrap();
    let mut value = json!({"analysisStatus":"completed", "blockers":[], "groups":[group()]});
    assert!(job.validate(decode(value.clone())).is_ok());
    value["groups"][0]["files"] = json!(["auth.rs"]);
    assert_eq!(
        job.validate(decode(value.clone())).unwrap_err().code,
        "AI_INVALID_OUTPUT"
    );
    value["analysisStatus"] = json!("blocked");
    value["blockers"] = json!(["Unable to read a patch"]);
    value["groups"] = json!([]);
    assert_eq!(
        job.validate(decode(value)).unwrap_err().code,
        "AI_ANALYSIS_BLOCKED"
    );
    drop(job);
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    assert!(job.validate(decode(review())).is_ok());
    let mut invalid = review();
    invalid["findings"][0]["file"] = json!("outside-scope.rs");
    assert_eq!(
        job.validate(decode(invalid)).unwrap_err().code,
        "AI_INVALID_OUTPUT"
    );
}

#[test]
fn blocked_analysis_and_missing_status_cannot_become_empty_success_reports() {
    let (_temp, mut proof, workspace) = fixture();
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    let mut value = review();
    value["analysisStatus"] = json!("blocked");
    value["summary"] = json!("Unable to read manifest.json; review was not performed.");
    value["findings"] = json!([]);
    value["overallRisk"] = json!("unknown");
    value["blockers"] = json!(["code-mode host is disabled"]);
    assert_eq!(
        job.validate(value.clone()).unwrap_err().code,
        "AI_ANALYSIS_BLOCKED"
    );
    value["analysisStatus"] = json!("completed");
    assert!(job.validate(value.clone()).is_err());
    value.as_object_mut().unwrap().remove("analysisStatus");
    assert!(job.validate(value).is_err());
    assert!(proof
        .ai_review_reports(&workspace.id, "local")
        .unwrap()
        .is_empty());
    drop(job);
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Grouping))
        .unwrap();
    assert_eq!(
        job.validate(
            json!({"analysisStatus":"blocked","blockers":["Snapshot unavailable"],"groups":[]})
        )
        .unwrap_err()
        .code,
        "AI_ANALYSIS_BLOCKED"
    );
    assert!(proof
        .change_groups(&workspace.id)
        .unwrap()
        .groups
        .is_empty());
}
#[test]
fn exact_group_coverage_and_finding_anchors_are_validated_without_review_writes() {
    let (_temp, mut proof, workspace) = fixture();
    let head = git(Path::new(&workspace.path), &["rev-parse", "HEAD"]);
    let index = fs::read(Path::new(&workspace.path).join(".git/index")).unwrap();
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Grouping))
        .unwrap();
    assert!(job
        .validate(json!({"analysisStatus":"completed","blockers":[],"groups":[group()]}))
        .is_ok());
    let mut omitted = group();
    omitted.files.pop();
    assert!(job
        .validate(json!({"analysisStatus":"completed","blockers":[],"groups":[omitted]}))
        .is_err());
    let mut duplicate = group();
    duplicate.files.push("auth.rs".into());
    assert!(job
        .validate(json!({"analysisStatus":"completed","blockers":[],"groups":[duplicate]}))
        .is_err());
    let mut forged = group();
    forged.files[0] = "../../secret".into();
    assert!(job
        .validate(json!({"analysisStatus":"completed","blockers":[],"groups":[forged]}))
        .is_err());
    drop(job);
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    assert!(job.validate(review()).is_ok());
    let mut value = review();
    value["findings"][0]["line"] = json!(0);
    assert!(job.validate(value).is_err());
    let mut value = review();
    value["findings"][0]["line"] = json!(5);
    value["findings"][0]["endLine"] = json!(4);
    assert!(job.validate(value).is_err());
    let mut value = review();
    value["findings"][0]["endLine"] = json!(10_001);
    assert!(job.validate(value).is_err());
    let mut value = review();
    value["findings"][0]["side"] = json!("staged");
    assert!(job.validate(value).is_err());
    let mut value = review();
    value["findings"][0]["file"] = json!("missing.rs");
    assert!(job.validate(value).is_err());
    assert_eq!(
        proof
            .store
            .connection
            .query_row("SELECT count(*) FROM review_marks", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        git(Path::new(&workspace.path), &["rev-parse", "HEAD"]),
        head
    );
    assert_eq!(
        fs::read(Path::new(&workspace.path).join(".git/index")).unwrap(),
        index
    );
}
#[test]
fn grouping_edits_persist_and_reject_late_ai_replacement() {
    let (temp, proof, workspace) = fixture();
    let token = proof.changes(&workspace.id).unwrap().token;
    let one = proof
        .set_change_groups(&workspace.id, 0, &token, vec![group()])
        .unwrap();
    assert_eq!(one.revision, 1);
    let mut renamed = group();
    renamed.title = "My change".into();
    renamed.files = vec!["auth.rs".into()];
    proof
        .set_change_groups(&workspace.id, 1, &token, vec![renamed])
        .unwrap();
    assert_eq!(
        proof
            .set_change_groups(&workspace.id, 1, &token, vec![group()])
            .unwrap_err()
            .code,
        "GROUPS_CHANGED"
    );
    drop(proof);
    let proof = Proof::open(temp.path().join("data")).unwrap();
    let saved = proof.change_groups(&workspace.id).unwrap();
    assert_eq!(saved.groups[0].title, "My change");
    assert_eq!(saved.groups[0].files, vec!["auth.rs"]);
    proof
        .set_change_groups(&workspace.id, 2, &token, vec![])
        .unwrap();
    assert!(proof
        .change_groups(&workspace.id)
        .unwrap()
        .groups
        .is_empty());
}
#[test]
fn outdated_input_busy_and_data_invalidation_leave_git_usable() {
    let (_temp, mut proof, workspace) = fixture();
    let old = request(&proof, &workspace, AiTask::Review);
    fs::write(
        Path::new(&workspace.path).join("pool.rs"),
        "fn pool() { changed(); }\n",
    )
    .unwrap();
    // Live mode: an outdated expected token no longer blocks preparation;
    // the agent reviews whatever the live repository contains.
    assert!(proof.prepare_ai_task(old).is_ok());
    assert!(!proof.has_active_ai_task());
    let task = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    assert_eq!(
        proof
            .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
            .err()
            .unwrap()
            .code,
        "AI_BUSY"
    );
    proof.clear_reading_cache();
    assert!(task.cancellation.check().is_err());
    drop(task);
    assert!(!proof.changes(&workspace.id).unwrap().files.is_empty());
    let diff = proof
        .file_diff(&workspace.id, "auth.rs", Side::Unstaged)
        .unwrap();
    assert!(diff.hunks.iter().all(|h| h.review_state != "reviewed"));
}
#[test]
fn historical_review_uses_the_diff_tabs_frozen_commits() {
    let (_temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    let base = git(repo, &["rev-parse", "HEAD"]);
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "target"]);
    let target = git(repo, &["rev-parse", "HEAD"]);
    let input = AiRequest {
        amend: false,
        provider: AgentKind::ClaudeCode,
        task: AiTask::Review,
        scope: AiScope::Comparison {
            workspace_id: workspace.id.clone(),
            base: base.clone(),
            target: target.clone(),
            path: Some("auth.rs".into()),
            paths: None,
        },
    };
    let task = proof.prepare_ai_task(input).unwrap();
    assert_eq!(task.diffs.len(), 1);
    assert_eq!(
        task.diffs[0].id,
        proof
            .compare_file(&workspace.id, &base, &target, "auth.rs")
            .unwrap()
            .id
    );
    assert!(task.validate(review()).is_ok());
}

#[test]
fn current_review_selects_live_files_without_snapshot_tokens() {
    let (_temp, mut proof, workspace) = fixture();
    let token = proof.changes(&workspace.id).unwrap().token;
    let job = proof
        .prepare_ai_task(AiRequest {
            amend: false,
            provider: AgentKind::Codex,
            task: AiTask::Review,
            scope: AiScope::Local {
                workspace_id: workspace.id.clone(),
                expected_token: token,
                files: Some(vec![AiFileSelection {
                    path: "auth.rs".into(),
                    side: Side::Unstaged,
                    snapshot_token: None,
                }]),
            },
        })
        .unwrap();
    assert!(
        job.diffs.is_empty(),
        "live reviews capture no frozen patches"
    );
    assert_eq!(job.selected, vec![("auth.rs".to_string(), Side::Unstaged)]);
    let report = job.validate(review()).unwrap();
    assert_eq!(report.files.len(), 1);
    assert_eq!(report.files[0].path, "auth.rs");
    assert!(report.files[0].snapshot_token.is_empty());
    drop(job);
    // A stale snapshot token from an older display is ignored entirely.
    let mut input = request(&proof, &workspace, AiTask::Review);
    if let AiScope::Local { files, .. } = &mut input.scope {
        *files = Some(vec![AiFileSelection {
            path: "auth.rs".into(),
            side: Side::Unstaged,
            snapshot_token: Some("stale-fingerprint".into()),
        }]);
    }
    assert!(proof.prepare_ai_task(input).is_ok());
}

#[cfg(unix)]
#[test]
fn cli_symlink_origins_require_current_trust_and_data_epoch() {
    use std::os::unix::fs::symlink;
    let (temp, mut proof, workspace) = fixture();
    let executable = Path::new("/bin/bash");
    let inside = Path::new(&workspace.path).join("installed-agent");
    symlink(executable, &inside).unwrap();
    let alias = temp.path().join("agent-alias");
    symlink(&inside, &alias).unwrap();
    proof.set_trust(&workspace.id, false).unwrap();
    assert_eq!(
        provider::AgentProgram::at_path(
            AgentKind::Codex,
            &alias,
            &proof.data_dir,
            &workspace.id,
            0
        )
        .err()
        .unwrap()
        .code,
        "TRUST_REQUIRED"
    );
    proof.set_trust(&workspace.id, true).unwrap();
    let capability = provider::AgentProgram::at_path(
        AgentKind::Codex,
        &alias,
        &proof.data_dir,
        &workspace.id,
        0,
    )
    .unwrap();
    proof
        .store
        .connection
        .execute("UPDATE settings SET value='1' WHERE key='data_epoch'", [])
        .unwrap();
    proof.synchronize_data_epoch().unwrap();
    assert_eq!(
        capability.validate().unwrap_err().code,
        "DATA_EPOCH_CHANGED"
    );
}

#[test]
fn workspace_data_deletion_removes_saved_groups_and_cancels_prepared_analysis() {
    let (_temp, mut proof, workspace) = fixture();
    let token = proof.changes(&workspace.id).unwrap().token;
    proof
        .set_change_groups(&workspace.id, 0, &token, vec![group()])
        .unwrap();
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    proof
        .store
        .connection
        .execute("DELETE FROM workspaces WHERE id=?", [&workspace.id])
        .unwrap();
    proof
        .store
        .connection
        .execute("UPDATE settings SET value='1' WHERE key='data_epoch'", [])
        .unwrap();
    proof.synchronize_data_epoch().unwrap();
    assert!(job.cancellation.check().is_err());
    assert_eq!(
        proof
            .store
            .connection
            .query_row("SELECT count(*) FROM change_groups", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
    assert!(proof.change_groups(&workspace.id).is_err());
}

#[cfg(unix)]
#[test]
fn aliases_through_a_different_untrusted_repository_are_rejected() {
    use std::os::unix::fs::symlink;
    let (temp, mut proof, workspace) = fixture();
    let untrusted = temp.path().join("untrusted");
    fs::create_dir(&untrusted).unwrap();
    git(&untrusted, &["init", "-b", "main"]);
    let other = proof.open_workspace(untrusted.to_str().unwrap()).unwrap();
    let inside = untrusted.join("agent-link");
    symlink("/bin/bash", &inside).unwrap();
    let alias = temp.path().join("outside-link");
    symlink(&inside, &alias).unwrap();
    assert!(proof.store.workspace(&workspace.id).unwrap().trusted);
    assert_eq!(
        provider::AgentProgram::at_path(
            AgentKind::Codex,
            &alias,
            &proof.data_dir,
            &workspace.id,
            0
        )
        .err()
        .unwrap()
        .code,
        "TRUST_REQUIRED"
    );
    proof.set_trust(&other.id, true).unwrap();
    let cap = provider::AgentProgram::at_path(
        AgentKind::Codex,
        &alias,
        &proof.data_dir,
        &workspace.id,
        0,
    )
    .unwrap();
    proof.set_trust(&other.id, false).unwrap();
    assert_eq!(cap.validate().unwrap_err().code, "TRUST_REQUIRED");
}

#[test]
fn agent_settings_persist_defaults_paths_models_and_use_revision_cas() {
    let (temp, proof, _workspace) = fixture();
    let executable = std::env::current_exe()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let initial = proof.agent_settings().unwrap();
    assert_eq!(initial.revision, 0);
    let update = || AgentSettingsUpdate {
        prompts: None,
        expected_revision: 0,
        default_provider: AgentKind::ClaudeCode,
        codex: AgentOptions {
            executable_path: Some(executable.clone()),
            model: Some("gpt-6-astra".into()),
        },
        codewiz: None,
        ocr: None,
        claude_code: AgentOptions {
            executable_path: None,
            model: Some("sonnet".into()),
        },
    };
    let saved = proof.set_agent_settings(update()).unwrap();
    assert_eq!(saved.revision, 1);
    assert_eq!(
        proof.set_agent_settings(update()).unwrap_err().code,
        "AI_SETTINGS_CHANGED"
    );
    drop(proof);
    let proof = Proof::open(temp.path().join("data")).unwrap();
    let saved = proof.agent_settings().unwrap();
    assert_eq!(saved.default_provider, AgentKind::ClaudeCode);
    assert_eq!(
        saved.codex.executable_path.as_deref(),
        Some(executable.as_str())
    );
    assert_eq!(saved.claude_code.model.as_deref(), Some("sonnet"));
    let workspace = proof.recent_workspaces().unwrap().remove(0);
    let mut proof = proof;
    let task = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    assert_eq!(task.options.model.as_deref(), Some("gpt-6-astra"));
    drop(task);
    let providers = proof.agent_providers().unwrap();
    assert!(
        providers
            .iter()
            .find(|p| p.id == AgentKind::ClaudeCode)
            .unwrap()
            .is_default
    );
}

#[test]
fn legacy_agent_settings_migrate_and_older_clients_preserve_codewiz_options() {
    let (_, proof, _) = fixture();
    let legacy = serde_json::json!({"revision":0,"defaultProvider":"codex","codex":{"executablePath":null,"model":null},"claudeCode":{"executablePath":null,"model":null}});
    proof
        .store
        .connection
        .execute(
            "INSERT INTO settings(key,value) VALUES('ai:settings',?1)",
            [legacy.to_string()],
        )
        .unwrap();
    assert_eq!(
        proof.agent_settings().unwrap().codewiz,
        AgentOptions::default()
    );
    let mut update = legacy.clone();
    update.as_object_mut().unwrap().remove("revision");
    update["expectedRevision"] = 0.into();
    update["codewiz"] = serde_json::json!({"executablePath":null,"model":"company/model"});
    update["defaultProvider"] = "codewiz".into();
    let saved = proof
        .set_agent_settings(serde_json::from_value(update).unwrap())
        .unwrap();
    assert_eq!(saved.default_provider, AgentKind::Codewiz);
    let mut old_update = legacy;
    old_update.as_object_mut().unwrap().remove("revision");
    old_update["expectedRevision"] = 1.into();
    let saved = proof
        .set_agent_settings(serde_json::from_value(old_update).unwrap())
        .unwrap();
    assert_eq!(saved.codewiz.model.as_deref(), Some("company/model"));
}
#[test]
fn invalid_agent_paths_models_and_untrusted_sources_do_not_replace_settings() {
    let (_temp, proof, workspace) = fixture();
    let mut update = AgentSettingsUpdate {
        prompts: None,
        expected_revision: 0,
        default_provider: AgentKind::Codex,
        codex: AgentOptions {
            executable_path: Some("relative/codex".into()),
            model: None,
        },
        claude_code: AgentOptions::default(),
        codewiz: None,
        ocr: None,
    };
    assert_eq!(
        proof.set_agent_settings(update.clone()).unwrap_err().code,
        "AI_PROGRAM_PATH"
    );
    update.codex.executable_path = None;
    update.codex.model = Some("--bad-argument".into());
    assert_eq!(
        proof.set_agent_settings(update.clone()).unwrap_err().code,
        "AI_MODEL_INVALID"
    );
    let cli = Path::new(&workspace.path).join("fake-cli");
    fs::copy(std::env::current_exe().unwrap(), &cli).unwrap();
    proof.set_trust(&workspace.id, false).unwrap();
    update.codex.executable_path = Some(cli.to_string_lossy().into_owned());
    update.codex.model = None;
    assert_eq!(
        proof.set_agent_settings(update).unwrap_err().code,
        "TRUST_REQUIRED"
    );
    assert_eq!(proof.agent_settings().unwrap().revision, 0);
}

#[test]
fn comparison_grouping_is_frozen_editable_and_separate_from_local_groups() {
    let (temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    let local = proof
        .set_change_groups(
            &workspace.id,
            0,
            &proof.changes(&workspace.id).unwrap().token,
            vec![],
        )
        .unwrap();
    let base = git(repo, &["rev-parse", "HEAD"]);
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "comparison changes"]);
    let target = git(repo, &["rev-parse", "HEAD"]);
    fs::write(repo.join("local-only.rs"), "fn only_local() {}\n").unwrap();
    let job = proof
        .prepare_ai_task(AiRequest {
            amend: false,
            provider: AgentKind::Codex,
            task: AiTask::Grouping,
            scope: AiScope::Comparison {
                workspace_id: workspace.id.clone(),
                base: base.clone(),
                target: target.clone(),
                path: None,
                paths: None,
            },
        })
        .unwrap();
    assert_eq!(job.diffs.len(), 2);
    assert!(job.diffs.iter().all(|diff| diff.path != "local-only.rs"));
    let groups = vec![AiGroup {
        title: "Behavior change".into(),
        summary: "Authentication and pool".into(),
        files: vec!["auth.rs".into(), "pool.rs".into()],
        risk: AiRisk::Medium,
        review_priority: 1,
    }];
    assert!(job
        .validate(serde_json::json!({"analysisStatus":"completed","blockers":[],"groups":groups}))
        .is_ok());
    drop(job);
    let saved = proof
        .set_comparison_change_groups(&workspace.id, &base, &target, 0, groups.clone())
        .unwrap();
    assert_eq!(saved.source_token, format!("comparison:{base}:{target}"));
    assert_eq!(
        proof.change_groups(&workspace.id).unwrap().revision,
        local.revision
    );
    assert_eq!(
        proof
            .set_comparison_change_groups(&workspace.id, &base, &target, 0, groups.clone())
            .unwrap_err()
            .code,
        "GROUPS_CHANGED"
    );
    assert!(proof
        .comparison_change_groups(&workspace.id, &target, &base)
        .unwrap()
        .groups
        .is_empty());
    let mut invalid = groups.clone();
    invalid[0].files.push("local-only.rs".into());
    assert!(proof
        .set_comparison_change_groups(&workspace.id, &base, &target, saved.revision, invalid)
        .is_err());
    assert!(proof
        .comparison_change_groups(&workspace.id, &base, "HEAD")
        .is_err());
    drop(proof);
    let mut proof = Proof::open(temp.path().join("data")).unwrap();
    assert_eq!(
        proof
            .comparison_change_groups(&workspace.id, &base, &target)
            .unwrap()
            .groups[0]
            .title,
        "Behavior change"
    );
    let job = proof
        .prepare_ai_task(AiRequest {
            amend: false,
            provider: AgentKind::Codex,
            task: AiTask::Review,
            scope: AiScope::Comparison {
                workspace_id: workspace.id.clone(),
                base: base.clone(),
                target: target.clone(),
                path: None,
                paths: Some(vec!["auth.rs".into()]),
            },
        })
        .unwrap();
    assert_eq!(job.diffs.len(), 1);
    assert_eq!(job.diffs[0].path, "auth.rs");
    drop(job);
    let empty = proof
        .set_comparison_change_groups(&workspace.id, &base, &target, saved.revision, vec![])
        .unwrap();
    assert!(empty.groups.is_empty());
    let deletion = proof
        .prepare_data_deletion(crate::DataScope::Repository {
            repository_id: workspace.repository_id,
        })
        .unwrap();
    proof.delete_local_data(&deletion.id).unwrap();
    let db = rusqlite::Connection::open(temp.path().join("data/proof.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM comparison_change_groups", [], |row| {
            row.get::<_, u64>(0)
        })
        .unwrap(),
        0
    );
    assert_eq!(
        fs::read_to_string(repo.join("local-only.rs")).unwrap(),
        "fn only_local() {}\n"
    );
}

#[test]
fn review_ranges_validate_sanity_for_live_and_every_line_for_frozen_comparisons() {
    let (_temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    fs::write(repo.join("auth.rs"), "fn auth() {\n  allow(true);\n}\n").unwrap();
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    let mut value = review();
    value["findings"][0]["endLine"] = json!(3);
    let result = job.validate(value.clone()).unwrap();
    assert_eq!(result.review.unwrap().findings[0].end_line, Some(3));
    // Live findings are only sanity-bounded: the working tree may shift
    // while the agent diffs it, so line membership is not re-checked.
    for (start, end) in [(0, 1), (3, 2), (1, 10_001)] {
        value["findings"][0]["line"] = json!(start);
        value["findings"][0]["endLine"] = json!(end);
        assert!(job.validate(value.clone()).is_err(), "{start}-{end}");
    }
    value["findings"][0]["line"] = json!(1);
    value["findings"][0]["endLine"] = json!(200);
    assert!(
        job.validate(value.clone()).is_ok(),
        "live ranges may exceed any single hunk"
    );
    value["findings"][0]["lineSide"] = json!("old");
    assert!(job.validate(value).is_ok());
    assert_eq!(
        job.validate(review()).unwrap().review.unwrap().findings[0].end_line,
        Some(1)
    );
    assert_eq!(
        schema(AiTask::Review)["properties"]["findings"]["items"]["properties"]["endLine"]
            ["minimum"],
        1
    );
    drop(job);
    // Frozen comparisons keep the strict every-captured-line check.
    let original = (1..=40).map(|n| format!("line {n}\n")).collect::<String>();
    fs::write(repo.join("auth.rs"), &original).unwrap();
    git(repo, &["add", "auth.rs"]);
    git(repo, &["commit", "-m", "range fixture"]);
    let base = git(repo, &["rev-parse", "HEAD"]);
    fs::write(
        repo.join("auth.rs"),
        original
            .replace("line 1\n", "changed one\n")
            .replace("line 40\n", "changed last\n"),
    )
    .unwrap();
    git(repo, &["add", "auth.rs"]);
    git(repo, &["commit", "-m", "range target"]);
    let target = git(repo, &["rev-parse", "HEAD"]);
    let job = proof
        .prepare_ai_task(AiRequest {
            amend: false,
            provider: AgentKind::Codex,
            task: AiTask::Review,
            scope: AiScope::Comparison {
                workspace_id: workspace.id.clone(),
                base,
                target,
                path: Some("auth.rs".into()),
                paths: None,
            },
        })
        .unwrap();
    let mut value = review();
    value["findings"][0]["endLine"] = json!(40);
    assert!(
        job.validate(value.clone()).is_err(),
        "ranges cannot cross uncaptured gaps"
    );
    value["findings"][0]["endLine"] = json!(1);
    assert!(job.validate(value).is_ok());
}

#[test]
fn review_reports_and_decisions_survive_restart_without_git_or_review_mutations() {
    let (temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    let before = git(repo, &["status", "--porcelain=v2"]);
    let index = fs::read(repo.join(".git/index")).unwrap();
    let source = fs::read(repo.join("auth.rs")).unwrap();
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    let report = job.finish(&proof, job.validate(review()).unwrap()).unwrap();
    assert_eq!(report.decisions, vec![FindingDecision::Pending]);
    let accepted = proof
        .set_ai_finding_decision(&workspace.id, &report.id, 0, 0, FindingDecision::Accepted)
        .unwrap();
    assert_eq!(accepted.revision, 1);
    assert_eq!(
        proof
            .set_ai_finding_decision(&workspace.id, &report.id, 0, 0, FindingDecision::Dismissed)
            .unwrap_err()
            .code,
        "AI_REVIEW_CHANGED"
    );
    assert!(proof
        .set_ai_finding_decision(&workspace.id, &report.id, 1, 1, FindingDecision::Accepted)
        .is_err());
    assert!(proof
        .ai_review_report("different-workspace", &report.id)
        .is_err());
    drop(job);
    drop(proof);
    let mut proof = Proof::open(temp.path().join("data")).unwrap();
    let records = proof.ai_review_reports(&workspace.id, "local").unwrap();
    assert_eq!(records.len(), 1);
    let saved = proof.ai_review_report(&workspace.id, &report.id).unwrap();
    assert_eq!(saved.decisions, vec![FindingDecision::Accepted]);
    let capture = saved
        .files
        .iter()
        .find(|file| file.path == "auth.rs")
        .unwrap();
    assert!(
        capture.snapshot_token.is_empty(),
        "live local reports carry no frozen snapshot token"
    );
    let dismissed = proof
        .set_ai_finding_decision(&workspace.id, &report.id, 1, 0, FindingDecision::Dismissed)
        .unwrap();
    assert_eq!(dismissed.decisions, vec![FindingDecision::Dismissed]);
    assert_eq!(
        proof
            .set_ai_finding_decision(&workspace.id, &report.id, 2, 0, FindingDecision::Pending)
            .unwrap()
            .decisions,
        vec![FindingDecision::Pending]
    );
    assert_eq!(git(repo, &["status", "--porcelain=v2"]), before);
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(repo.join("auth.rs")).unwrap(), source);
    assert_eq!(
        proof
            .store
            .connection
            .query_row("SELECT COUNT(*) FROM review_marks", [], |row| row
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        proof
            .store
            .connection
            .query_row("SELECT COUNT(*) FROM observer_events", [], |row| row
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    let late = job.validate(review()).unwrap();
    let preview = proof
        .prepare_data_deletion(crate::DataScope::Repository {
            repository_id: workspace.repository_id.clone(),
        })
        .unwrap();
    assert_eq!(preview.counts.review_records, 1);
    proof.delete_local_data(&preview.id).unwrap();
    assert_eq!(job.finish(&proof, late).unwrap_err().code, "READ_CANCELLED");
    assert_eq!(
        proof
            .store
            .connection
            .query_row("SELECT COUNT(*) FROM ai_review_reports", [], |row| row
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn review_history_scopes_and_retention_keep_frozen_comparisons_separate() {
    let (_temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    let base = git(repo, &["rev-parse", "HEAD"]);
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "target"]);
    let target = git(repo, &["rev-parse", "HEAD"]);
    let job = proof
        .prepare_ai_task(AiRequest {
            amend: false,
            provider: AgentKind::Codex,
            task: AiTask::Review,
            scope: AiScope::Comparison {
                workspace_id: workspace.id.clone(),
                base: base.clone(),
                target: target.clone(),
                path: None,
                paths: None,
            },
        })
        .unwrap();
    let report = job.finish(&proof, job.validate(review()).unwrap()).unwrap();
    let key = format!("comparison:{base}:{target}");
    assert_eq!(
        proof.ai_review_reports(&workspace.id, &key).unwrap().len(),
        1
    );
    assert!(proof
        .ai_review_reports(&workspace.id, "local")
        .unwrap()
        .is_empty());
    assert!(proof
        .ai_review_reports(&workspace.id, &format!("comparison:{target}:{base}"))
        .unwrap()
        .is_empty());
    proof
        .store
        .connection
        .execute(
            "UPDATE ai_review_reports SET captured_at=0 WHERE id=?",
            [&report.id],
        )
        .unwrap();
    proof.maintain_local_data().unwrap();
    assert!(proof
        .ai_review_reports(&workspace.id, &key)
        .unwrap()
        .is_empty());
}

#[test]
fn active_tasks_capture_interface_language_without_rerunning_or_changing_diff() {
    let (_temp, mut proof, workspace) = fixture();
    proof.set_ui_language(crate::UiLanguage::English).unwrap();
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    assert!(job
        .prompt()
        .unwrap()
        .contains("Use concise English explanations"));
    assert!(job.validate(review()).unwrap().limitations[0].starts_with("The Agent could read"));
    proof.set_ui_language(crate::UiLanguage::Chinese).unwrap();
    assert!(job
        .prompt()
        .unwrap()
        .contains("Use concise English explanations"));
    drop(job);
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Grouping))
        .unwrap();
    assert!(job
        .prompt()
        .unwrap()
        .contains("Use concise Simplified Chinese explanations"));
}

#[test]
fn agent_reads_the_actual_project_including_ignored_context_without_copying_it() {
    let (_temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    let large = (0..20_000)
        .map(|n| format!("fn changed_{n}() {{ validate_request_with_context(); }}\n"))
        .collect::<String>();
    fs::write(repo.join("auth.rs"), &large).unwrap();
    git(repo, &["add", "auth.rs"]);
    fs::write(repo.join("auth.rs"), format!("{large}// still editing\n")).unwrap();
    fs::write(repo.join(".git/info/exclude"), "project-context/\n").unwrap();
    fs::create_dir(repo.join("project-context")).unwrap();
    fs::write(
        repo.join("project-context/design.txt"),
        "full project contract",
    )
    .unwrap();
    fs::write(
        repo.join("project-context/large.txt"),
        vec![b'x'; 5 * 1024 * 1024],
    )
    .unwrap();
    let head = git(repo, &["rev-parse", "HEAD"]);
    let index = fs::read(repo.join(".git/index")).unwrap();
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    // Live mode: no frozen patches are captured, regardless of size.
    assert!(job.diffs.is_empty());
    assert!(job.prompt().unwrap().len() < 8000);
    assert!(!job.prompt().unwrap().contains("fn changed_19999"));
    assert_eq!(job.input.project, fs::canonicalize(repo).unwrap());
    assert_eq!(
        fs::read_to_string(job.input.project.join("project-context/design.txt")).unwrap(),
        "full project contract"
    );
    assert_eq!(
        fs::metadata(job.input.project.join("project-context/large.txt"))
            .unwrap()
            .len(),
        5 * 1024 * 1024
    );
    assert_eq!(git(&job.input.project, &["show", ":auth.rs"]), large.trim());
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&job.input.manifest).unwrap()).unwrap();
    let entry = manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["path"] == "auth.rs" && file["side"] == "staged")
        .unwrap()
        .clone();
    assert!(
        entry.get("patchFile").is_none(),
        "live manifests list paths without frozen patch files"
    );
    fs::write(repo.join("auth.rs"), "new external version").unwrap();
    assert_eq!(
        fs::read_to_string(job.input.project.join("auth.rs")).unwrap(),
        "new external version"
    );
    assert_eq!(git(repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    let evidence = job.input.manifest.clone();
    drop(job);
    assert!(!evidence.exists());
    assert!(repo.join("project-context/design.txt").exists());
}

#[test]
fn historical_root_commit_and_unselected_context_are_available_without_checkout() {
    let (_temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    let head = git(repo, &["rev-parse", "HEAD"]);
    let job = proof
        .prepare_ai_task(AiRequest {
            amend: false,
            provider: AgentKind::Codex,
            task: AiTask::Review,
            scope: AiScope::Comparison {
                workspace_id: workspace.id.clone(),
                base: "empty".into(),
                target: head.clone(),
                path: Some("auth.rs".into()),
                paths: None,
            },
        })
        .unwrap();
    assert_eq!(job.diffs.len(), 1);
    assert!(job.input.project.join("pool.rs").is_file());
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&job.input.manifest).unwrap()).unwrap();
    assert_eq!(manifest["scope"]["base"], "empty");
    assert_eq!(manifest["scope"]["target"], head);
    assert!(
        git(&job.input.project, &["show", &format!("{head}:auth.rs")]).contains("allow(false)")
    );
    assert!(fs::read_to_string(repo.join("auth.rs"))
        .unwrap()
        .contains("allow(true)"));
    assert_eq!(git(repo, &["rev-parse", "HEAD"]), head);
}

#[test]
fn task_prompts_persist_migrate_and_are_captured_independently() {
    let (temp, mut proof, workspace) = fixture();
    let update = |revision, prompts| AgentSettingsUpdate {
        expected_revision: revision,
        default_provider: AgentKind::Codex,
        codex: Default::default(),
        claude_code: Default::default(),
        codewiz: None,
        ocr: None,
        prompts,
    };
    let prompts = AgentPrompts {
        grouping: "Group by business behavior".into(),
        review: "Focus on concurrency\nDo not invent tests".into(),
        commit: "Use Conventional Commits".into(),
    };
    proof
        .set_agent_settings(update(0, Some(prompts.clone())))
        .unwrap();
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Grouping))
        .unwrap();
    assert!(job.prompt().unwrap().contains(&prompts.grouping));
    assert!(!job.prompt().unwrap().contains(&prompts.review));
    proof
        .set_agent_settings(update(1, Some(AgentPrompts::default())))
        .unwrap();
    assert!(job.prompt().unwrap().contains(&prompts.grouping));
    drop(job);
    proof
        .set_agent_settings(update(2, Some(prompts.clone())))
        .unwrap();
    // An older settings client must not erase the new preferences.
    proof.set_agent_settings(update(3, None)).unwrap();
    for invalid in ["x".repeat(16_001), "private\0prompt".into()] {
        let mut value = prompts.clone();
        value.commit = invalid;
        assert_eq!(
            proof
                .set_agent_settings(update(4, Some(value)))
                .unwrap_err()
                .code,
            "AI_PROMPT_INVALID"
        );
    }
    drop(proof);
    let proof = Proof::open(temp.path().join("data")).unwrap();
    assert_eq!(proof.agent_settings().unwrap().prompts, prompts);
    assert_eq!(proof.agent_settings().unwrap().revision, 4);
}

#[test]
fn ai_commit_uses_only_index_supports_amend_and_never_changes_git() {
    let (_temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    assert_eq!(
        proof
            .prepare_ai_task(request(&proof, &workspace, AiTask::Commit))
            .err()
            .unwrap()
            .code,
        "AI_COMMIT_EMPTY"
    );
    git(repo, &["add", "auth.rs"]);
    fs::write(
        repo.join("auth.rs"),
        "fn auth() { different_unstaged_behavior(); }\n",
    )
    .unwrap();
    let index = fs::read(repo.join(".git/index")).unwrap();
    let head = git(repo, &["rev-parse", "HEAD"]);
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Commit))
        .unwrap();
    assert!(job.diffs.is_empty(), "commit drafting captures no patches");
    assert_eq!(
        job.selected,
        vec![("auth.rs".to_string(), Side::Staged)],
        "commit drafting is scoped to the staged side only"
    );
    assert!(
        job.prompt().unwrap().contains("git diff --cached"),
        "agent reads the live index itself"
    );
    let value =
        json!({"analysisStatus":"completed","blockers":[],"message":"fix(auth): validate access"});
    let report = job.validate(value.clone()).unwrap();
    assert_eq!(
        report.commit_message.as_deref(),
        Some("fix(auth): validate access")
    );
    assert!(job.finish(&proof, report).is_ok());
    assert!(proof
        .ai_review_reports(&workspace.id, "local")
        .unwrap()
        .is_empty());
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    assert_eq!(git(repo, &["rev-parse", "HEAD"]), head);
    // A late message must not be applied to a different index.
    git(repo, &["add", "pool.rs"]);
    assert_eq!(
        job.finish(&proof, job.validate(value).unwrap())
            .unwrap_err()
            .code,
        "STALE_CONTENT"
    );
    drop(job);
    git(repo, &["reset", "--mixed", "HEAD"]);
    let mut amend = request(&proof, &workspace, AiTask::Commit);
    amend.amend = true;
    let job = proof.prepare_ai_task(amend).unwrap();
    assert!(job.diffs.is_empty());
    assert_eq!(job.amend_head.as_deref(), Some(head.as_str()));
    assert!(job
        .prompt()
        .unwrap()
        .contains(&format!("AMEND message for commit {head}")));
}

#[cfg(unix)]
#[test]
fn live_selection_covers_mixed_file_kinds_without_capturing_content() {
    use std::os::unix::fs::symlink;
    let (temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    git(repo, &["reset", "--hard", "HEAD"]);
    fs::create_dir(repo.join("nested")).unwrap();
    let unusual = "nested/文件\tline\n[literal].txt";
    for path in ["rename-source.txt", "type.txt", unusual] {
        fs::write(repo.join(path), "before\n").unwrap();
    }
    fs::write(repo.join("binary.dat"), b"before\0binary\n").unwrap();
    let outside = temp.path().join("outside-secret");
    fs::write(&outside, "must not be read through a symlink\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "capture fixtures"]);

    fs::write(repo.join("auth.rs"), "fn auth() { staged(); }\n").unwrap();
    git(repo, &["add", "auth.rs"]);
    fs::write(repo.join("auth.rs"), "fn auth() { unstaged(); }\n").unwrap();
    fs::write(repo.join("pool.rs"), "fn pool() { changed(); }\n").unwrap();
    git(repo, &["mv", "rename-source.txt", "renamed.txt"]);
    fs::write(repo.join(unusual), "after\n").unwrap();
    fs::write(repo.join("untracked 文件.txt"), "new file\n").unwrap();
    fs::remove_file(repo.join("type.txt")).unwrap();
    symlink(&outside, repo.join("type.txt")).unwrap();
    symlink(&outside, repo.join("untracked-link")).unwrap();

    let changes = proof.changes(&workspace.id).unwrap();
    assert!(changes.files.iter().any(|file| file.old_path.is_some()));
    assert_eq!(
        changes
            .files
            .iter()
            .filter(|file| file.path == "auth.rs")
            .count(),
        2
    );
    let index = fs::read(repo.join(".git/index")).unwrap();
    let job = proof
        .prepare_ai_task(AiRequest {
            amend: false,
            provider: AgentKind::Codex,
            task: AiTask::Review,
            scope: AiScope::Local {
                workspace_id: workspace.id.clone(),
                expected_token: changes.token.clone(),
                files: None,
            },
        })
        .unwrap();
    // Live mode: selection mirrors the change list, nothing is captured,
    // and preparation never reads through symlinks or file contents.
    assert!(job.diffs.is_empty());
    assert_eq!(job.selected.len(), changes.files.len());
    for file in &changes.files {
        assert!(
            job.selected
                .iter()
                .any(|(path, side)| path == &file.path && *side == file.side),
            "{} {:?}",
            file.path,
            file.side
        );
    }
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read_to_string(outside).unwrap(),
        "must not be read through a symlink\n"
    );
}

#[test]
fn live_prepare_tolerates_mid_preparation_changes() {
    use std::cell::Cell;
    for mutation in ["earlier", "later", "config", "attributes", "index", "head"] {
        let (_temp, mut proof, workspace) = fixture();
        let repo = Path::new(&workspace.path);
        fs::write(
            repo.join(".git/capture-config"),
            "[diff]\n algorithm = patience\n",
        )
        .unwrap();
        git(repo, &["config", "include.path", "capture-config"]);
        fs::write(
            repo.join(".git/info/attributes"),
            "auth.rs proof-extra=before\n",
        )
        .unwrap();
        let head = git(repo, &["rev-parse", "HEAD"]);
        let tree = git(repo, &["rev-parse", "HEAD^{tree}"]);
        let next_head = git(
            repo,
            &["commit-tree", &tree, "-p", &head, "-m", "next head"],
        );
        let request = request(&proof, &workspace, AiTask::Review);
        let changed = Cell::new(false);
        let result = proof.prepare_ai_task_with_progress(request, &|progress| {
            if progress.completed != Some(1) || changed.replace(true) {
                return;
            }
            match mutation {
                "earlier" => {
                    fs::write(repo.join("auth.rs"), "fn auth() { external(); }\n").unwrap()
                }
                "later" => fs::write(repo.join("pool.rs"), "fn pool() { external(); }\n").unwrap(),
                "config" => fs::write(
                    repo.join(".git/capture-config"),
                    "[diff]\n algorithm = histogram\n",
                )
                .unwrap(),
                "attributes" => fs::write(
                    repo.join(".git/info/attributes"),
                    "auth.rs proof-extra=after\n",
                )
                .unwrap(),
                "index" => {
                    git(repo, &["add", "auth.rs"]);
                }
                "head" => {
                    git(repo, &["update-ref", "HEAD", &next_head]);
                }
                _ => unreachable!(),
            }
        });
        // Live mode: preparation only lists paths, so concurrent changes to
        // content, config, attributes, the index or HEAD no longer fail it.
        assert!(result.is_ok(), "{mutation}: {:?}", result.err());
        assert!(
            changed.get(),
            "{mutation}: fixture must interrupt preparation"
        );
        assert!(proof.has_active_ai_task());
        drop(result);
        assert!(!proof.has_active_ai_task());
        assert!(proof
            .ai_review_reports(&workspace.id, "local")
            .unwrap()
            .is_empty());
    }
}

#[cfg(unix)]
#[test]
fn live_selection_spawns_no_per_file_git_reads() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    for index in 0..100 {
        fs::write(repo.join(format!("capture-{index:03}.txt")), "before\n").unwrap();
    }
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "hundred files"]);
    for index in 0..100 {
        fs::write(repo.join(format!("capture-{index:03}.txt")), "after\n").unwrap();
    }
    let wrapper = temp.path().join("count-git");
    let calls = temp.path().join("count-git.calls");
    fs::write(
        &wrapper,
        r#"#!/bin/sh
kind=other
for arg in "$@"; do
 case "$arg" in
  rev-parse|symbolic-ref|status|config|check-attr|diff|--version)
   kind="$arg"
   break
   ;;
 esac
done
printf '%s\n' "$kind" >> "$0.calls"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1
exec /usr/bin/git -c core.attributesFile=/dev/null "$@"
"#,
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let mut preferences = proof.preferences().unwrap();
    preferences.git_path = wrapper.to_str().unwrap().into();
    proof.set_preferences(preferences).unwrap();
    let request = request(&proof, &workspace, AiTask::Review);
    fs::write(&calls, "").unwrap();
    let job = proof.prepare_ai_task(request).unwrap();
    let recorded = fs::read_to_string(calls).unwrap();
    let calls: Vec<_> = recorded.lines().collect();
    assert!(job.diffs.is_empty());
    assert_eq!(job.selected.len(), 100);
    assert_eq!(
        calls.iter().filter(|command| **command == "diff").count(),
        0,
        "live preparation captures no patches: {recorded}"
    );
    assert!(
        calls.len() <= 10,
        "100 selections spawned {} Git processes: {recorded}",
        calls.len()
    );
}

#[test]
fn batch_capture_cancellation_releases_task_capacity_and_keeps_git_unchanged() {
    let (_temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    let before = proof.changes(&workspace.id).unwrap().token;
    let index = fs::read(repo.join(".git/index")).unwrap();
    let cancellation = ReadCancellation::default();
    let input = request(&proof, &workspace, AiTask::Review);
    let result = cancellation.run(|| {
        proof.prepare_ai_task_with_progress(input, &|progress| {
            if progress.path.is_some() {
                cancellation.cancel();
            }
        })
    });
    assert_eq!(result.err().unwrap().code, "READ_CANCELLED");
    assert!(!proof.has_active_ai_task());
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    assert_eq!(proof.changes(&workspace.id).unwrap().token, before);
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    assert!(job.diffs.is_empty());
    assert_eq!(job.selected.len(), 2);
}

#[test]
fn live_selection_uses_the_linked_worktree_change_list() {
    let (temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    let linked = temp.path().join("linked");
    git(
        repo,
        &[
            "worktree",
            "add",
            "-b",
            "capture-linked",
            linked.to_str().unwrap(),
            "HEAD",
        ],
    );
    fs::write(linked.join("auth.rs"), "fn auth() { linked_only(); }\n").unwrap();
    let linked_workspace = proof.open_workspace(linked.to_str().unwrap()).unwrap();
    proof.set_trust(&linked_workspace.id, true).unwrap();
    let primary_index = fs::read(Path::new(&workspace.git_dir).join("index")).unwrap();
    let linked_index = fs::read(Path::new(&linked_workspace.git_dir).join("index")).unwrap();
    let primary_content = fs::read(repo.join("auth.rs")).unwrap();
    let job = proof
        .prepare_ai_task(request(&proof, &linked_workspace, AiTask::Review))
        .unwrap();
    assert!(job.diffs.is_empty());
    assert_eq!(job.selected, vec![("auth.rs".to_string(), Side::Unstaged)]);
    assert!(job.input.project.ends_with("linked"));
    assert_eq!(
        fs::read(Path::new(&workspace.git_dir).join("index")).unwrap(),
        primary_index
    );
    assert_eq!(
        fs::read(Path::new(&linked_workspace.git_dir).join("index")).unwrap(),
        linked_index
    );
    assert_eq!(fs::read(repo.join("auth.rs")).unwrap(), primary_content);
}

#[test]
fn live_selection_does_not_read_file_contents() {
    for limit in ["file_bytes", "diff_lines"] {
        let (_temp, mut proof, workspace) = fixture();
        let repo = Path::new(&workspace.path);
        let path = repo.join("auth.rs");
        if limit == "file_bytes" {
            fs::File::create(&path)
                .unwrap()
                .set_len(32 * 1024 * 1024 + 1)
                .unwrap();
        } else {
            fs::write(&path, "new line\n".repeat(100_001)).unwrap();
        }
        let index = fs::read(repo.join(".git/index")).unwrap();
        // Live mode captures nothing, so oversized files no longer block
        // preparation; the agent decides how much of the live file to read.
        let job = proof
            .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
            .unwrap_or_else(|error| panic!("{limit}: {error:?}"));
        assert!(job.diffs.is_empty(), "{limit}");
        drop(job);
        assert!(!proof.has_active_ai_task());
        assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    }
}

#[test]
fn ocr_review_output_maps_onto_the_shared_review_schema() {
    let selected = vec![
        ("main.rs".to_string(), Side::Unstaged),
        ("staged.rs".to_string(), Side::Staged),
    ];
    let raw = json!({
        "status": "complete",
        "message": "Review complete: 2 finding(s) across 2 selected item(s).",
        "summary": {"files_reviewed": 2, "comments": 2},
        "comments": [
            {"path":"main.rs","content":"Hardcoded credential.","suggestion_code":"let _p = env();","start_line":1,"end_line":1,"category":"security","severity":"high"},
            {"path":"staged.rs","content":"Line one\nLine two detail","start_line":0,"end_line":0,"category":"bug","severity":"critical"},
            {"path":"other.rs","content":"Out of scope","start_line":3,"end_line":4,"category":"style","severity":"low"},
            {"path":"main.rs","content":"","start_line":1,"end_line":1,"category":"style","severity":"low"}
        ]
    });
    let value = ocr::map_review(
        &serde_json::to_vec(&raw).unwrap(),
        &selected,
        crate::UiLanguage::English,
    )
    .unwrap();
    assert_eq!(value["analysisStatus"], "completed");
    assert_eq!(value["overallRisk"], "critical");
    let findings = value["findings"].as_array().unwrap();
    assert_eq!(
        findings.len(),
        2,
        "out-of-scope and empty comments drop out"
    );
    assert_eq!(findings[0]["file"], "main.rs");
    assert_eq!(findings[0]["side"], "unstaged");
    assert_eq!(findings[0]["line"], 1);
    assert_eq!(findings[0]["lineSide"], "new");
    assert_eq!(findings[1]["side"], "staged");
    assert_eq!(findings[1]["line"], 1, "zero OCR line numbers clamp to 1");
    assert!(findings[1]["title"].as_str().unwrap().contains("Line one"));
    assert!(value["summary"].as_str().unwrap().contains("2 finding(s)"));

    // The mapped value passes the standard review validation end to end.
    let (_temp, mut proof, workspace) = fixture();
    let job = proof
        .prepare_ai_task(AiRequest {
            amend: false,
            provider: AgentKind::Ocr,
            task: AiTask::Review,
            scope: AiScope::Local {
                workspace_id: workspace.id.clone(),
                expected_token: String::new(),
                files: None,
            },
        })
        .unwrap();
    let raw = json!({
        "status": "complete",
        "message": "Review complete: 1 finding(s).",
        "summary": {"files_reviewed": 2},
        "comments": [
            {"path":"auth.rs","content":"Unconditional access granted.","start_line":1,"end_line":1,"category":"security","severity":"high"}
        ]
    });
    let value = ocr::map_review(
        &serde_json::to_vec(&raw).unwrap(),
        &job.selected,
        crate::UiLanguage::English,
    )
    .unwrap();
    let report = job.validate(value).unwrap();
    assert_eq!(report.review.unwrap().findings[0].file, "auth.rs");
    drop(job);

    // Grouping/commit tasks are rejected for OCR before any CLI launch.
    let grouping = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Grouping))
        .map(|mut task| {
            task.request.provider = AgentKind::Ocr;
            task.run().unwrap_err()
        });
    assert_eq!(grouping.unwrap().code, "AI_ISOLATION_UNAVAILABLE");

    let incomplete = serde_json::to_vec(&json!({"status":"failed"})).unwrap();
    assert!(ocr::map_review(&incomplete, &selected, crate::UiLanguage::English).is_err());
    let empty = serde_json::to_vec(&json!({
        "status": "complete", "message": "Review complete: 0 finding(s).",
        "summary": {"files_reviewed": 1}, "comments": []
    }))
    .unwrap();
    let value = ocr::map_review(&empty, &selected, crate::UiLanguage::English).unwrap();
    assert_eq!(value["overallRisk"], "unknown");
    assert_eq!(value["findings"].as_array().unwrap().len(), 0);
    // A clean working tree makes OCR skip the review: still a valid,
    // completed report with zero findings.
    let skipped = serde_json::to_vec(&json!({
        "status": "skipped", "message": "Review skipped: no items were selected.",
        "summary": {"files_reviewed": 0}, "comments": []
    }))
    .unwrap();
    let value = ocr::map_review(&skipped, &selected, crate::UiLanguage::English).unwrap();
    assert_eq!(value["analysisStatus"], "completed");
    assert!(value["summary"].as_str().unwrap().contains("no items"));
    // Partial runs still surface the findings that did complete.
    let partial = serde_json::to_vec(&json!({
        "status": "partial",
        "message": "Review partially complete: 3 finding(s); 11 of 18 selected item(s) failed.",
        "summary": {"files_reviewed": 7},
        "comments": [
            {"path":"main.rs","content":"Real finding despite partial run.","start_line":1,"end_line":1,"category":"bug","severity":"high"}
        ]
    }))
    .unwrap();
    let value = ocr::map_review(&partial, &selected, crate::UiLanguage::Chinese).unwrap();
    assert_eq!(value["analysisStatus"], "completed");
    assert_eq!(value["findings"].as_array().unwrap().len(), 1);
    assert!(value["summary"].as_str().unwrap().contains("11 of 18"));
    // Chinese UI gets a localized, non-duplicated summary line.
    let value = ocr::map_review(
        &serde_json::to_vec(&json!({
            "status": "complete",
            "message": "Review complete: 6 finding(s) across 17 selected item(s).",
            "summary": {"files_reviewed": 17},
            "comments": []
        }))
        .unwrap(),
        &selected,
        crate::UiLanguage::Chinese,
    )
    .unwrap();
    assert_eq!(
        value["summary"].as_str().unwrap(),
        "OCR 审查完成：17 个文件，0 条发现。"
    );
    let skipped_cn = ocr::map_review(&skipped, &selected, crate::UiLanguage::Chinese).unwrap();
    assert!(skipped_cn["summary"]
        .as_str()
        .unwrap()
        .contains("没有可审查的变更"));
    // Long multi-byte (CJK) content must respect Proof's byte-based limits:
    // title ≤ 200 bytes, description ≤ 6000 bytes.
    let long = "这是一个硬编码凭证问题。".repeat(100);
    let raw = json!({
        "status": "complete",
        "message": "ok",
        "summary": {"files_reviewed": 1},
        "comments": [
            {"path":"main.rs","content":long,"suggestion_code":"修复\\u{000b}建议","start_line":1,"end_line":1,"category":"security","severity":"high"}
        ]
    });
    let value = ocr::map_review(
        &serde_json::to_vec(&raw).unwrap(),
        &selected,
        crate::UiLanguage::English,
    )
    .unwrap();
    let finding = &value["findings"][0];
    assert!(finding["title"].as_str().unwrap().len() <= 200);
    assert!(finding["description"].as_str().unwrap().len() <= 6000);
    assert!(finding["suggestion"].as_str().unwrap().len() <= 4000);
    assert!(
        !finding["suggestion"]
            .as_str()
            .unwrap()
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t' | '\r')),
        "control characters are stripped"
    );
}
