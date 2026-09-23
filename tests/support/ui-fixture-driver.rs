//! Test-only NDJSON transport. The production app uses Tauri dispatch.
use proof_core::{Error, Proof};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn dispatch(proof: &mut Proof, command: &str, a: &Value) -> Result<Value, Error> {
    proof.synchronize_data_epoch()?;
    let s = |name: &str| a[name].as_str().unwrap_or("");
    if command != "data_session" {
        proof.check_data_epoch(a["_dataEpoch"].as_u64().unwrap_or(0))?;
    }
    Ok(match command {
        "ui_language" => json!(proof.ui_language()?),
        "set_ui_language" => {
            json!(proof.set_ui_language(serde_json::from_value(a["language"].clone())?)?)
        }
        "agent_settings" => json!(proof.agent_settings()?),
        "set_agent_settings" => {
            json!(proof.set_agent_settings(serde_json::from_value(a["update"].clone())?)?)
        }
        "agent_providers" => json!([]), // Never start a real Coding Agent from the UI fixture.
        "ai_review_reports" => json!(proof.ai_review_reports(s("workspaceId"), s("scope"))?),
        "ai_review_report" => json!(proof.ai_review_report(s("workspaceId"), s("reportId"))?),
        "set_ai_finding_decision" => json!(proof.set_ai_finding_decision(
            s("workspaceId"),
            s("reportId"),
            serde_json::from_value(a["expectedRevision"].clone())?,
            serde_json::from_value(a["findingIndex"].clone())?,
            serde_json::from_value(a["decision"].clone())?
        )?),
        "change_groups" => json!(proof.change_groups(s("workspaceId"))?),
        "comparison_change_groups" => {
            json!(proof.comparison_change_groups(s("workspaceId"), s("base"), s("target"))?)
        }
        "set_comparison_change_groups" => json!(proof.set_comparison_change_groups(
            s("workspaceId"),
            s("base"),
            s("target"),
            a["expectedRevision"].as_u64().unwrap_or(0),
            serde_json::from_value(a["groups"].clone())?
        )?),
        "set_change_groups" => json!(proof.set_change_groups(
            s("workspaceId"),
            a["expectedRevision"].as_u64().unwrap_or(0),
            s("expectedToken"),
            serde_json::from_value(a["groups"].clone())?
        )?),
        "mark_comparison_reviewed" => {
            json!(proof.mark_comparison_reviewed(serde_json::from_value(a.clone())?)?)
        }
        "diff_context" => json!(proof.read_diff_context(
            s("snapshotId"),
            if a["fullFile"].as_bool() == Some(true) {
                None
            } else {
                Some(a["contextLines"].as_u64().unwrap_or(3).try_into().unwrap())
            }
        )?),
        "compare_context" => json!(proof.compare_context(
            s("workspaceId"),
            s("base"),
            s("target"),
            s("path"),
            s("snapshotId"),
            if a["fullFile"].as_bool() == Some(true) {
                None
            } else {
                Some(a["contextLines"].as_u64().unwrap_or(3).try_into().unwrap())
            }
        )?),
        "data_session" => json!(proof.data_session()?),
        "data_workspaces" => json!(proof.data_workspaces()?),
        "data_usage" => json!(proof.data_usage(a["workspaceId"].as_str())?),
        "clear_observer_data" => json!(proof.clear_observer_data(s("workspaceId"))?),
        "pause_observer_scope" => json!(proof.pause_observer_scope(a["workspaceId"].as_str())?),
        "maintain_local_data" => json!(proof.maintain_local_data()?),
        "remove_recent_workspace" => json!(proof.remove_recent_workspace(s("workspaceId"))?),
        "prepare_data_deletion" => {
            json!(proof.prepare_data_deletion(serde_json::from_value(a["scope"].clone())?)?)
        }
        "cancel_data_deletion" => {
            proof.cancel_data_deletion(s("previewId"));
            Value::Null
        }
        "delete_local_data" => json!(proof.delete_local_data(s("previewId"))?),
        "open_workspace" => json!(proof.open_workspace(s("path"))?),
        "recent_workspaces" => json!(proof.recent_workspaces()?),
        "preferences" => json!(proof.preferences()?),
        "editor_applications" => json!(proof_core::editor_applications()),
        "editor_settings" => json!(proof.editor_settings(a["workspaceId"].as_str())?),
        "set_editor_settings" => json!(proof.set_editor_settings(
            a["workspaceId"].as_str(),
            serde_json::from_value(a["update"].clone())?
        )?),
        "set_preferences" => {
            json!(proof.set_preferences(serde_json::from_value(a["preferences"].clone())?)?)
        }
        "repository_layout" => json!(proof.repository_layout(s("workspaceId"))?),
        "set_repository_layout" => json!(proof.set_repository_layout(
            s("workspaceId"),
            serde_json::from_value(a["layout"].clone())?
        )?),
        "set_trust" => {
            json!(proof.set_trust(s("workspaceId"), a["trusted"].as_bool().unwrap_or(false))?)
        }
        "fixture_context_session" => {
            // Test-only adapter input. This command is deliberately absent from native dispatch.
            let installation =
                proof.create_observer_registration(proof_core::ObserverAgent::Claude, "2.1.236")?;
            proof.set_observer_consent(&proof_core::ObserverConsent {
                installation_id: installation.installation.id.clone(),
                workspace_id: s("workspaceId").into(),
                enabled: true,
                prompt: true,
                command: false,
                output: false,
                reply: false,
                background: false,
            })?;
            let workspace = proof
                .recent_workspaces()?
                .into_iter()
                .find(|w| w.id == s("workspaceId"))
                .unwrap();
            let at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            let payload = json!({"hook_event_name":"PostToolUse", "session_id":s("session"), "cwd":workspace.path,
                "tool_use_id":"test-call", "tool_name":"Write", "tool_input":{"file_path":s("path")},
                "prompt":format!("Context fixture {}",s("session")), "tool_response":{"success":true}});
            json!(proof.ingest_observer_event(proof_core::ObserverInput {
                installation_id: &installation.installation.id,
                token: &installation.token,
                agent: proof_core::ObserverAgent::Claude,
                agent_version: "2.1.236",
                payload: &serde_json::to_vec(&payload)?,
                bridge_started_at: at,
                received_at: at,
                foreground_lease_until: Some(at + 5000),
                received_policy_revision: proof.observer_policy_revision()?,
            })?)
        }
        "context_overview" => json!(proof.context_overview(s("workspaceId"), s("path"))?),
        "context_candidates" => json!(proof.context_candidates(
            s("workspaceId"),
            s("path"),
            s("search"),
            serde_json::from_value(a["before"].clone())?
        )?),
        "context_session_events" => json!(proof.context_session_events_for_file(
            s("workspaceId"),
            s("sessionId"),
            a["path"].as_str(),
            serde_json::from_value(a["before"].clone())?
        )?),
        "context_history" => json!(proof.context_history(
            s("workspaceId"),
            s("path"),
            a["offset"].as_u64().unwrap_or(0) as usize
        )?),
        "update_context_association" => json!(proof.update_context_association(
            s("workspaceId"),
            s("path"),
            s("sessionId"),
            serde_json::from_value(a["action"].clone())?,
            s("note"),
            s("expectedRevision")
        )?),
        "undo_context_association" => json!(proof.undo_context_association(
            s("workspaceId"),
            s("path"),
            s("changeId"),
            s("expectedRevision")
        )?),
        "observer_file_context" => json!(proof.observer_file_context(s("workspaceId"), s("path"))?),
        "history_graph_version" => json!(proof.history_graph_version(s("workspaceId"))?),
        "commit_graph" => json!(proof.commit_graph(
            s("workspaceId"),
            a["snapshotId"].as_str(),
            a["offset"].as_u64().unwrap_or(0) as usize,
            s("scope")
        )?),
        "compare_commit" => json!(proof.compare_commit(
            s("workspaceId"),
            s("oid"),
            a["parent"].as_u64().unwrap_or(0) as usize
        )?),
        "compare_refs" => json!(proof.compare_refs(s("workspaceId"), s("base"), s("target"))?),
        "compare_file" => {
            json!(proof.compare_file(s("workspaceId"), s("base"), s("target"), s("path"))?)
        }
        "changes" => json!(proof.changes(s("workspaceId"))?),
        "file_diff" => json!(proof.file_diff(
            s("workspaceId"),
            s("path"),
            serde_json::from_value(a["side"].clone())?
        )?),
        "read_file_diff" => json!(proof.read_file_diff(
            s("workspaceId"),
            s("path"),
            serde_json::from_value(a["side"].clone())?,
            a["loadLarge"].as_bool().unwrap_or(false)
        )?),
        "read_compare_file" => json!(proof.read_compare_file(
            s("workspaceId"),
            s("base"),
            s("target"),
            s("path"),
            a["loadLarge"].as_bool().unwrap_or(false)
        )?),
        "list_files" => json!(proof.list_files(s("workspaceId"))?),
        "history" => json!(proof.history(
            s("workspaceId"),
            a["offset"].as_u64().unwrap_or(0) as usize,
            a["path"].as_str()
        )?),
        "read_text_file" => json!(proof.read_text_file(
            s("workspaceId"),
            s("path"),
            a["revision"].as_str()
        )?),
        "save_text_file" => json!(proof.save_text_file(
            s("workspaceId"),
            s("path"),
            s("content"),
            a["expectedFingerprint"].as_str()
        )?),
        "create_text_file" => json!(proof.create_text_file(s("workspaceId"), s("path"))?),
        "rename_text_file" => json!(proof.rename_text_file(
            s("workspaceId"),
            s("from"),
            s("to")
        )?),
        "delete_text_file" => json!(proof.delete_text_file(s("workspaceId"), s("path"))?),
        "stage_files" => json!(proof.stage_files(
            s("workspaceId"),
            &serde_json::from_value::<Vec<String>>(a["paths"].clone())?,
            serde_json::from_value(a["side"].clone())?,
            s("expectedToken")
        )?),
        "stage" => json!(proof.stage(s("snapshotId"), a["hunkId"].as_str())?),
        "mark_reviewed" => json!(proof.mark_reviewed(
            s("snapshotId"),
            a["hunkId"].as_str(),
            a["reviewed"].as_bool().unwrap_or(false)
        )?),
        "commit_preview" => json!(proof.prepare_commit_checked(
            s("workspaceId"),
            a["amend"].as_bool().unwrap_or(false),
            a["coverage"].as_bool().unwrap_or(true),
            a["expectedToken"].as_str()
        )?),
        "commit" => json!(proof.commit(s("previewId"), s("message"))?),
        "history_repository_state" => json!(proof.history_repository_state(s("workspaceId"))?),
        "recovery_points" => json!(proof.recovery_points(s("workspaceId"))?),
        "recovery_content" => json!(proof.recovery_content(s("recoveryId"))?),
        "cancel_discard_preview" => {
            proof.cancel_discard_preview(s("recoveryId"))?;
            json!(null)
        }
        "undo_discard" => json!(proof.undo_discard(s("recoveryId"))?),
        "history_branch_state" => {
            json!(proof.history_branch_state(s("workspaceId"), Some(s("branch")))?)
        }
        "stashes" => json!(proof.stashes(s("workspaceId"))?),
        "discard_files_preview" => json!(proof.discard_files_preview(
            s("workspaceId"),
            &serde_json::from_value::<Vec<String>>(a["paths"].clone())?,
            s("expectedToken")
        )?),
        "discard_files" => json!(proof.discard_files(
            s("workspaceId"),
            &serde_json::from_value::<Vec<String>>(a["recoveryIds"].clone())?,
            s("expectedToken")
        )?),
        "history_auto_fetch" => {
            if let Some(job) = proof.prepare_history_fetch(s("workspaceId"))? {
                json!(job.execute()?)
            } else {
                json!(false)
            }
        }
        "history_commit_message" => {
            json!(proof.history_commit_message(s("workspaceId"), s("oid"))?)
        }
        "prepare_history_action" => json!(proof.prepare_history_action(
            s("workspaceId"),
            serde_json::from_value(a["request"].clone())?,
            s("expectedToken")
        )?),
        "execute_history_action" => {
            json!(proof.execute_history_action(s("workspaceId"), s("previewId"))?)
        }
        "branches" => json!(proof.branches(s("workspaceId"))?),
        "worktrees" => json!(proof.worktrees(s("workspaceId"))?),
        "switch_branch" => json!(proof.switch_branch_from(
            s("workspaceId"),
            s("name"),
            a["create"].as_bool().unwrap_or(false),
            s("expectedToken"),
            a["remote"].as_str()
        )?),
        _ => {
            return Err(Error::new(
                "FIXTURE_UNSUPPORTED",
                "Unsupported test command",
                command,
            ))
        }
    })
}
fn main() {
    let data = std::env::args().nth(1).expect("fixture data directory");
    let mut proof = Proof::open(data).expect("fixture store");
    for line in io::stdin().lock().lines() {
        let line = line.expect("fixture request");
        let request: Value = serde_json::from_str(&line).expect("fixture JSON");
        let response = match dispatch(
            &mut proof,
            request["command"].as_str().unwrap_or(""),
            &request["args"],
        ) {
            Ok(value) => json!({"value":value}),
            Err(error) => json!({"error":error}),
        };
        println!("{response}");
        io::stdout().flush().unwrap();
    }
}
