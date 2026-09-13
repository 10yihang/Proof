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
        "changes" => json!(proof.changes(s("workspaceId"))?),
        "file_diff" => json!(proof.file_diff(
            s("workspaceId"),
            s("path"),
            serde_json::from_value(a["side"].clone())?
        )?),
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
