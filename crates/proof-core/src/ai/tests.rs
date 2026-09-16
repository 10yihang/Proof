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
    value["findings"][0]["line"] = json!(999);
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
fn stale_input_busy_and_data_invalidation_leave_git_usable() {
    let (_temp, mut proof, workspace) = fixture();
    let old = request(&proof, &workspace, AiTask::Review);
    fs::write(
        Path::new(&workspace.path).join("pool.rs"),
        "fn pool() { changed(); }\n",
    )
    .unwrap();
    assert_eq!(
        proof.prepare_ai_task(old).err().unwrap().code,
        "STALE_CONTENT"
    );
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
fn current_review_accepts_unchanged_content_across_new_snapshot_ids() {
    let (_temp, mut proof, workspace) = fixture();
    let displayed = proof
        .file_diff(&workspace.id, "auth.rs", Side::Unstaged)
        .unwrap();
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
                    path: displayed.path.clone(),
                    side: displayed.side,
                    snapshot_token: Some(displayed.token.clone()),
                }]),
            },
        })
        .unwrap();
    assert_ne!(job.diffs[0].id, displayed.id);
    let report = job.validate(review()).unwrap();
    assert_eq!(report.files[0].snapshot_token, displayed.token);
    let refreshed = proof
        .file_diff(&workspace.id, "auth.rs", Side::Unstaged)
        .unwrap();
    assert_eq!(refreshed.token, report.files[0].snapshot_token);
    drop(job);
    let mut input = request(&proof, &workspace, AiTask::Review);
    if let AiScope::Local { files, .. } = &mut input.scope {
        *files = Some(vec![AiFileSelection {
            path: "auth.rs".into(),
            side: Side::Unstaged,
            snapshot_token: Some("stale-fingerprint".into()),
        }]);
    }
    assert_eq!(
        proof.prepare_ai_task(input).err().unwrap().code,
        "STALE_CONTENT"
    );
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
fn review_ranges_validate_every_captured_line_and_legacy_single_lines() {
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
    for (start, end) in [(0, 1), (3, 2), (1, 4), (1, u32::MAX)] {
        value["findings"][0]["line"] = json!(start);
        value["findings"][0]["endLine"] = json!(end);
        assert!(job.validate(value.clone()).is_err());
    }
    value["findings"][0]["line"] = json!(1);
    value["findings"][0]["endLine"] = json!(2);
    value["findings"][0]["lineSide"] = json!("old");
    assert!(job.validate(value).is_err());
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
    let original = (1..=40).map(|n| format!("line {n}\n")).collect::<String>();
    fs::write(repo.join("auth.rs"), &original).unwrap();
    git(repo, &["add", "auth.rs"]);
    git(repo, &["commit", "-m", "range fixture"]);
    fs::write(
        repo.join("auth.rs"),
        original
            .replace("line 1\n", "changed one\n")
            .replace("line 40\n", "changed last\n"),
    )
    .unwrap();
    let job = proof
        .prepare_ai_task(request(&proof, &workspace, AiTask::Review))
        .unwrap();
    let mut value = review();
    value["findings"][0]["endLine"] = json!(40);
    assert!(
        job.validate(value).is_err(),
        "ranges cannot cross uncaptured gaps"
    );
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
    assert_eq!(
        proof
            .file_diff(&workspace.id, "auth.rs", Side::Unstaged)
            .unwrap()
            .token,
        capture.snapshot_token
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
    assert!(job.diffs.iter().map(|d| d.patch.len()).sum::<usize>() > 1024 * 1024);
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
    let patch_path = manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["path"] == "auth.rs" && file["side"] == "staged")
        .unwrap()["patchFile"]
        .as_str()
        .unwrap();
    let patch = fs::read_to_string(patch_path).unwrap();
    assert!(patch.contains("fn changed_19999"));
    fs::write(repo.join("auth.rs"), "new external version").unwrap();
    assert_eq!(
        fs::read_to_string(job.input.project.join("auth.rs")).unwrap(),
        "new external version"
    );
    assert_eq!(fs::read_to_string(patch_path).unwrap(), patch);
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
    assert_eq!(job.diffs.len(), 1);
    assert_eq!(job.diffs[0].path, "auth.rs");
    assert_eq!(job.diffs[0].side, Side::Staged);
    assert!(job.diffs[0].patch.contains("allow(true)"));
    assert!(!job.diffs[0].patch.contains("different_unstaged_behavior"));
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
