use proof_core::{Error, Proof};
use std::sync::{Arc, Mutex};
use tauri::Manager;

struct AppState(Arc<Mutex<Proof>>);
#[cfg(unix)]
mod observer;
mod watcher;

#[tauri::command]
async fn watch_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    watch: tauri::State<'_, Mutex<watcher::WorkspaceWatch>>,
    workspace_id: Option<String>,
    generation: u64,
) -> Result<bool, Error> {
    let paths = if let Some(id) = &workspace_id {
        let core = state.0.clone();
        let id = id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            core.lock()
                .map_err(|error| Error::new("CORE_UNAVAILABLE", "无法监听 Worktree。", error))?
                .workspace_watch_paths(&id)
        })
        .await
        .map_err(|error| {
            Error::new(
                "WATCH_UNAVAILABLE",
                "文件监听不可用，已改用定时刷新。",
                error,
            )
        })??
    } else {
        vec![]
    };
    let mut current = watch.lock().map_err(|error| {
        Error::new(
            "WATCH_UNAVAILABLE",
            "文件监听不可用，已改用定时刷新。",
            error,
        )
    })?;
    if generation < current.generation {
        return Ok(false);
    }
    current.generation = generation;
    current.watcher = None;
    if let Some(id) = workspace_id {
        current.watcher = Some(watcher::start(app, id, paths)?);
    }
    Ok(current.watcher.is_some())
}

#[tauri::command]
async fn proof_command(
    state: tauri::State<'_, AppState>,
    #[cfg(unix)] observer: tauri::State<'_, observer::ObserverState>,
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, Error> {
    let core = state.0.clone();
    #[cfg(unix)]
    let observer = observer.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(unix)]
        if observer::handles(&command) {
            return observer::dispatch(&core, &observer, &command, args);
        }
        dispatch(&core, &command, args)
    })
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
    fn session(core: &Mutex<Proof>, epoch: u64) -> Result<std::sync::MutexGuard<'_, Proof>, Error> {
        let mut proof = core.lock().map_err(|_| unavailable())?;
        proof.synchronize_data_epoch()?;
        proof.check_data_epoch(epoch)?;
        Ok(proof)
    }
    if command == "data_session" {
        let mut proof = core.lock().map_err(|_| unavailable())?;
        proof.synchronize_data_epoch()?;
        return serde_json::to_value(proof.data_session()?).map_err(Error::from);
    }
    let data_epoch = args["_dataEpoch"].as_u64().ok_or_else(|| {
        Error::new(
            "DATA_SESSION_REQUIRED",
            "请重新载入 Proof 后重试。",
            "Missing renderer data generation",
        )
    })?;
    if command == "observer_program_locations" {
        drop(session(core, data_epoch)?);
        return serde_json::to_value(proof_core::observer_program_locations()).map_err(Error::from);
    }
    if command == "editor_applications" {
        drop(session(core, data_epoch)?);
        return serde_json::to_value(proof_core::editor_applications()).map_err(Error::from);
    }
    if command == "open_in_editor" {
        let job = {
            let proof = session(core, data_epoch)?;
            proof.prepare_editor_open(string(&args, "snapshotId")?)?
        };
        return serde_json::to_value(job.run()?).map_err(Error::from);
    }
    if command == "probe_observer" {
        let job = {
            let proof = session(core, data_epoch)?;
            proof.prepare_observer_probe(
                serde_json::from_value(args["agent"].clone())?,
                string(&args, "executablePath")?,
            )?
        };
        return serde_json::to_value(job.run()?).map_err(Error::from);
    }
    let mut proof = session(core, data_epoch)?;
    let value = match command {
        "data_workspaces" => serde_json::to_value(proof.data_workspaces()?),
        "remove_recent_workspace" => {
            serde_json::to_value(proof.remove_recent_workspace(string(&args, "workspaceId")?)?)
        }
        "prepare_data_deletion" => serde_json::to_value(
            proof.prepare_data_deletion(serde_json::from_value(args["scope"].clone())?)?,
        ),
        "cancel_data_deletion" => {
            proof.cancel_data_deletion(string(&args, "previewId")?);
            Ok(serde_json::Value::Null)
        }
        "delete_local_data" => {
            serde_json::to_value(proof.delete_local_data(string(&args, "previewId")?)?)
        }
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
        "editor_settings" => {
            serde_json::to_value(proof.editor_settings(args["workspaceId"].as_str())?)
        }
        "set_editor_settings" => serde_json::to_value(proof.set_editor_settings(
            args["workspaceId"].as_str(),
            serde_json::from_value(args["update"].clone())?,
        )?),
        "repository_layout" => {
            serde_json::to_value(proof.repository_layout(string(&args, "workspaceId")?)?)
        }
        "set_repository_layout" => serde_json::to_value(proof.set_repository_layout(
            string(&args, "workspaceId")?,
            serde_json::from_value(args["layout"].clone())?,
        )?),
        "data_usage" => serde_json::to_value(proof.data_usage(args["workspaceId"].as_str())?),
        "maintain_local_data" => serde_json::to_value(proof.maintain_local_data()?),
        "clear_observer_data" => {
            serde_json::to_value(proof.clear_observer_data(string(&args, "workspaceId")?)?)
        }
        "pause_observer_scope" => {
            serde_json::to_value(proof.pause_observer_scope(args["workspaceId"].as_str())?)
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
        "diff_context" => serde_json::to_value(
            proof.diff_context(
                string(&args, "snapshotId")?,
                args["contextLines"]
                    .as_u64()
                    .and_then(|n| u16::try_from(n).ok())
                    .ok_or_else(|| {
                        Error::new(
                            "INVALID_CONTEXT_SIZE",
                            "上下文行数无效。",
                            "Expected an unsigned context size",
                        )
                    })?,
            )?,
        ),
        "stage" => serde_json::to_value(
            proof.stage(string(&args, "snapshotId")?, args["hunkId"].as_str())?,
        ),
        "stage_files" => serde_json::to_value(proof.stage_files(
            string(&args, "workspaceId")?,
            &serde_json::from_value::<Vec<String>>(args["paths"].clone())?,
            serde_json::from_value(args["side"].clone())?,
            string(&args, "expectedToken")?,
        )?),
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
        "commit_preview" => serde_json::to_value(proof.prepare_commit_checked(
            string(&args, "workspaceId")?,
            args["amend"].as_bool().unwrap_or(false),
            args["coverage"].as_bool().unwrap_or(true),
            args["expectedToken"].as_str(),
        )?),
        "commit" => serde_json::to_value(
            proof.commit(string(&args, "previewId")?, string(&args, "message")?)?,
        ),
        "history" => serde_json::to_value(proof.history(
            string(&args, "workspaceId")?,
            args["offset"].as_u64().unwrap_or(0) as usize,
            args["path"].as_str(),
        )?),
        "commit_graph" => serde_json::to_value(proof.commit_graph(
            string(&args, "workspaceId")?,
            args["snapshotId"].as_str(),
            args["offset"].as_u64().unwrap_or(0) as usize,
            args["scope"].as_str().unwrap_or("all"),
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
        "graph_commit_diff" => serde_json::to_value(proof.graph_commit_diff(
            string(&args, "workspaceId")?,
            string(&args, "snapshotId")?,
            string(&args, "oid")?,
            args["parent"].as_u64().unwrap_or(0) as usize,
        )?),
        "compare_commit" => serde_json::to_value(proof.compare_commit(
            string(&args, "workspaceId")?,
            string(&args, "oid")?,
            args["parent"].as_u64().unwrap_or(0) as usize,
        )?),
        "compare_refs" => serde_json::to_value(proof.compare_refs(
            string(&args, "workspaceId")?,
            string(&args, "base")?,
            string(&args, "target")?,
        )?),
        "compare_file" => serde_json::to_value(proof.compare_file(
            string(&args, "workspaceId")?,
            string(&args, "base")?,
            string(&args, "target")?,
            string(&args, "path")?,
        )?),
        "observer_file_context" => serde_json::to_value(
            proof.observer_file_context(string(&args, "workspaceId")?, string(&args, "path")?)?,
        ),
        "observer_events" => serde_json::to_value(proof.observer_events(
            string(&args, "workspaceId")?,
            args["path"].as_str(),
            args["offset"].as_u64().unwrap_or(0) as usize,
        )?),
        "branches" => serde_json::to_value(proof.branches(string(&args, "workspaceId")?)?),
        "worktrees" => serde_json::to_value(proof.worktrees(string(&args, "workspaceId")?)?),
        "switch_branch" => serde_json::to_value(proof.switch_branch_from(
            string(&args, "workspaceId")?,
            string(&args, "name")?,
            args["create"].as_bool().unwrap_or(false),
            string(&args, "expectedToken")?,
            args["remote"].as_str(),
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
            let core = Arc::new(Mutex::new(Proof::open(&data_dir)?));
            #[cfg(unix)]
            {
                let observer = observer::ObserverState::new(data_dir, app.path().home_dir()?)?;
                observer.start(core.clone());
                app.manage(observer);
            }
            app.manage(AppState(core));
            app.manage(Mutex::new(watcher::WorkspaceWatch::default()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                #[cfg(unix)]
                window
                    .state::<observer::ObserverState>()
                    .running
                    .store(false, std::sync::atomic::Ordering::Release);
            }
        })
        .invoke_handler(tauri::generate_handler![proof_command, watch_workspace])
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
    fn deletion_epoch_rejects_stale_renderer_settings_including_delayed_writes() {
        let temp = tempfile::tempdir().unwrap();
        let core = Mutex::new(Proof::open(temp.path()).unwrap());
        let preview = dispatch(
            &core,
            "prepare_data_deletion",
            serde_json::json!({"_dataEpoch":0,"scope":{"kind":"all"}}),
        )
        .unwrap();
        let deleted = dispatch(
            &core,
            "delete_local_data",
            serde_json::json!({"_dataEpoch":0,"previewId":preview["id"]}),
        )
        .unwrap();
        let preferences = proof_core::Preferences {
            font_size: 25,
            ..proof_core::Preferences::default()
        };
        let stale = dispatch(
            &core,
            "set_preferences",
            serde_json::json!({"_dataEpoch":0,"preferences":preferences}),
        )
        .unwrap_err();
        assert_eq!(stale.code, "DATA_EPOCH_CHANGED");
        assert_eq!(
            core.lock().unwrap().preferences().unwrap().font_size,
            proof_core::Preferences::default().font_size
        );
        assert!(dispatch(&core, "preferences", serde_json::json!({})).is_err());
        assert!(dispatch(
            &core,
            "set_preferences",
            serde_json::json!({"_dataEpoch":deleted["session"]["epoch"],"preferences":preferences})
        )
        .is_ok());
    }

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
                serde_json::json!({"agent":"codex","executablePath":executable,"_dataEpoch":0}),
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
        assert!(dispatch(&core, "preferences", serde_json::json!({"_dataEpoch":0})).is_ok());
    }
}
