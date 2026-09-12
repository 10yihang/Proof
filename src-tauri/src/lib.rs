use proof_core::{Error, Proof};
use std::sync::{Arc, Mutex};
use tauri::Manager;

struct AppState(Arc<Mutex<Proof>>);

#[tauri::command]
async fn proof_command(
    state: tauri::State<'_, AppState>,
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, Error> {
    let core = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || dispatch(&core, &command, args))
        .await
        .map_err(|e| Error::new("CORE_UNAVAILABLE", "本地核心任务未完成。", e))?
}

fn dispatch(
    core: &Mutex<Proof>,
    command: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, Error> {
    fn unavailable() -> Error {
        Error::new(
            "CORE_UNAVAILABLE",
            "本地核心暂时不可用，请重启应用。",
            "Mutex poisoned",
        )
    }
    fn string<'a>(args: &'a serde_json::Value, key: &str) -> Result<&'a str, Error> {
        args.get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| Error::new("INVALID_REQUEST", "请求字段缺失。", key))
    }
    if command == "observer_program_locations" {
        return serde_json::to_value(proof_core::observer_program_locations()).map_err(Error::from);
    }
    if command == "probe_observer" {
        let job = core
            .lock()
            .map_err(|_| unavailable())?
            .prepare_observer_probe(
                serde_json::from_value(args["agent"].clone())?,
                string(&args, "executablePath")?,
            )?;
        return serde_json::to_value(job.run()?).map_err(Error::from);
    }
    let mut proof = core.lock().map_err(|_| unavailable())?;
    let value = match command {
        "recent_workspaces" => serde_json::to_value(proof.recent_workspaces()?),
        "open_workspace" => serde_json::to_value(proof.open_workspace(string(&args, "path")?)?),
        "set_trust" => serde_json::to_value(proof.set_trust(
            string(&args, "workspaceId")?,
            args["trusted"].as_bool().unwrap_or(false),
        )?),
        "preferences" => serde_json::to_value(proof.preferences()?),
        "set_preferences" => serde_json::to_value(
            proof.set_preferences(serde_json::from_value(args["preferences"].clone())?)?,
        ),
        "data_usage" => serde_json::to_value(proof.data_usage(args["workspaceId"].as_str())?),
        "maintain_local_data" => serde_json::to_value(proof.maintain_local_data()?),
        "clear_observer_data" => {
            serde_json::to_value(proof.clear_observer_data(string(&args, "workspaceId")?)?)
        }
        "changes" => serde_json::to_value(proof.changes(string(&args, "workspaceId")?)?),
        "file_diff" => serde_json::to_value(proof.file_diff(
            string(&args, "workspaceId")?,
            string(&args, "path")?,
            serde_json::from_value(args["side"].clone())?,
        )?),
        "mark_reviewed" => serde_json::to_value(proof.mark_reviewed(
            string(&args, "snapshotId")?,
            args["hunkId"].as_str(),
            args["reviewed"].as_bool().unwrap_or(false),
        )?),
        "stage" => serde_json::to_value(
            proof.stage(string(&args, "snapshotId")?, args["hunkId"].as_str())?,
        ),
        "discard_preview" => serde_json::to_value(
            proof.discard_preview(string(&args, "snapshotId")?, args["hunkId"].as_str())?,
        ),
        "cancel_discard_preview" => {
            serde_json::to_value(proof.cancel_discard_preview(string(&args, "recoveryId")?)?)
        }
        "discard" => serde_json::to_value(proof.discard(string(&args, "recoveryId")?)?),
        "undo_discard" => serde_json::to_value(proof.undo_discard(string(&args, "recoveryId")?)?),
        "restore_missing_recovery" => {
            serde_json::to_value(proof.restore_missing_recovery(string(&args, "recoveryId")?)?)
        }
        "recovery_points" => {
            serde_json::to_value(proof.recovery_points(string(&args, "workspaceId")?)?)
        }
        "recovery_content" => {
            serde_json::to_value(proof.recovery_content(string(&args, "recoveryId")?)?)
        }
        "commit_preview" => {
            serde_json::to_value(proof.commit_preview(string(&args, "workspaceId")?)?)
        }
        "commit" => serde_json::to_value(
            proof.commit(string(&args, "previewId")?, string(&args, "message")?)?,
        ),
        "history" => serde_json::to_value(proof.history(
            string(&args, "workspaceId")?,
            args["offset"].as_u64().unwrap_or(0) as usize,
            args["path"].as_str(),
        )?),
        "file_blame" => serde_json::to_value(proof.file_blame(
            string(&args, "workspaceId")?,
            string(&args, "path")?,
            args["revision"].as_str(),
            args["offset"].as_u64().unwrap_or(0) as usize,
        )?),
        "commit_diff" => serde_json::to_value(proof.commit_diff(
            string(&args, "workspaceId")?,
            string(&args, "oid")?,
            args["parent"].as_u64().unwrap_or(0) as usize,
        )?),
        "branches" => serde_json::to_value(proof.branches(string(&args, "workspaceId")?)?),
        "worktrees" => serde_json::to_value(proof.worktrees(string(&args, "workspaceId")?)?),
        "switch_branch" => serde_json::to_value(proof.switch_branch(
            string(&args, "workspaceId")?,
            string(&args, "name")?,
            args["create"].as_bool().unwrap_or(false),
            string(&args, "expectedToken")?,
        )?),
        _ => return Err(Error::new("UNKNOWN_COMMAND", "此操作尚不支持。", command)),
    }?;
    Ok(value)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = std::env::var_os("PROOF_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            app.manage(AppState(Arc::new(Mutex::new(Proof::open(data_dir)?))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![proof_command])
        .run(tauri::generate_context!())
        .expect("Proof could not start");
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        time::{Duration, Instant},
    };

    #[test]
    fn slow_version_query_does_not_hold_the_git_core_mutex() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let executable = temp.path().join("slow-agent");
        fs::write(
            &executable,
            b"#!/bin/sh\nprintf started > probe-started\nexec /bin/sleep 30\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let core = Arc::new(Mutex::new(Proof::open(&data).unwrap()));
        let worker = core.clone();
        let query = std::thread::spawn(move || {
            dispatch(
                &worker,
                "probe_observer",
                serde_json::json!({"agent":"codex","executablePath":executable}),
            )
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while !data.join("probe-started").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        let started = data.join("probe-started").exists();
        let available = core.try_lock().is_ok();
        let result = query.join().unwrap();
        assert!(started, "version fixture was not started");
        assert!(available, "version process kept the Git mutex");
        assert_eq!(result.unwrap_err().code, "PROCESS_TIMEOUT");
        assert!(dispatch(&core, "preferences", serde_json::json!({})).is_ok());
    }
}
