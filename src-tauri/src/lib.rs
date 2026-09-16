use proof_core::{Error, Proof};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

struct AppState(Result<Arc<Mutex<Proof>>, Error>);
fn lock_core(core: &Mutex<Proof>) -> Result<std::sync::MutexGuard<'_, Proof>, Error> {
    let unavailable = || {
        Error::new(
            "CORE_UNAVAILABLE",
            "本地核心暂时不可用，请重启应用。",
            "Mutex poisoned",
        )
    };
    if proof_core::read_cancellation_active() {
        loop {
            proof_core::check_read_cancellation()?;
            match core.try_lock() {
                Ok(proof) => return Ok(proof),
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(std::time::Duration::from_millis(2))
                }
                Err(_) => return Err(unavailable()),
            }
        }
    }
    core.lock().map_err(|_| unavailable())
}
fn session(core: &Mutex<Proof>, epoch: u64) -> Result<std::sync::MutexGuard<'_, Proof>, Error> {
    let mut proof = lock_core(core)?;
    proof.synchronize_data_epoch()?;
    proof.check_data_epoch(epoch)?;
    Ok(proof)
}

mod diagnostics;
mod diff_windows;
#[cfg(unix)]
mod observer;
mod read_requests;
mod review_export;
mod updater;
mod watcher;
#[cfg(target_os = "macos")]
mod window_menu;

#[tauri::command]
async fn watch_workspace(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    watch: tauri::State<'_, Mutex<std::collections::HashMap<String, watcher::WorkspaceWatch>>>,
    workspace_id: Option<String>,
    generation: u64,
) -> Result<bool, Error> {
    let paths = if let Some(id) = &workspace_id {
        let core = state.0.clone()?;
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
    let mut owners = watch.lock().map_err(|error| {
        Error::new(
            "WATCH_UNAVAILABLE",
            "文件监听不可用，已改用定时刷新。",
            error,
        )
    })?;
    let current = owners.entry(window.label().to_owned()).or_default();
    if generation < current.generation {
        return Ok(false);
    }
    current.generation = generation;
    current.watcher = None;
    if let Some(id) = workspace_id {
        current.watcher = Some(watcher::start(app, id, generation, paths)?);
    }
    Ok(current.watcher.is_some())
}

#[tauri::command]
fn prepare_read_request(
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, read_requests::ReadRequests>,
) -> Result<String, Error> {
    reads.prepare(window.label())
}
#[tauri::command]
fn cancel_read_request(
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, read_requests::ReadRequests>,
    ticket: String,
) -> bool {
    reads.cancel(window.label(), &ticket)
}

#[tauri::command]
async fn proof_command(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    diagnostics: tauri::State<'_, diagnostics::DiagnosticState>,
    application_diagnostics: tauri::State<'_, diagnostics::ApplicationDiagnosticState>,
    #[cfg(unix)] observer: tauri::State<'_, observer::ObserverState>,
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, Error> {
    let app = window.app_handle().clone();
    let owner = window.label().to_owned();
    let core = state.0.clone()?;
    let metrics = diagnostics.0.clone();
    let application_information = application_diagnostics.0.clone();
    let started = std::time::Instant::now();
    let request_epoch = args["_dataEpoch"].as_u64();
    let read_ticket = if let Some(ticket) = args.get("_readTicket") {
        Some(window.state::<read_requests::ReadRequests>().claim(
            window.label(),
            ticket.as_str().ok_or_else(|| {
                Error::new(
                    "INVALID_READ_REQUEST",
                    "读取请求已失效。",
                    "Invalid read ticket",
                )
            })?,
            &command,
        )?)
    } else {
        None
    };
    #[cfg(unix)]
    let observer = observer.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let work = || {
            if diff_windows::handles(&command) {
                return diff_windows::dispatch(&app, &core, &owner, &command, &args);
            }
            if command == "save_review_instructions" {
                return review_export::dispatch(&app, &core, &args);
            }
            if diagnostics::handles(&command) {
                let result = diagnostics::dispatch(&app, &core, &metrics, &command, &args);
                if let Err(error) = &result {
                    if let Ok(mut information) = application_information.lock() {
                        information.note_failure(&error.code);
                    }
                }
                return result;
            }
            // Capture the generation before execution. Never wait for the Git mutex
            // after an operation has completed merely to record its measurements.
            let measurement_generation = if proof_core::DiagnosticMetrics::tracks(&command) {
                lock_core(&core)?.diagnostic_generation().ok()
            } else {
                None
            };
            let progress_ticket = args["_readTicket"].as_str().unwrap_or_default().to_owned();
            let last_preparation =
                std::cell::RefCell::new(None::<(&'static str, std::time::Instant)>);
            let progress = |event: proof_core::AiProgress| {
                if matches!(event.phase, "preparing" | "snapshot") {
                    let now = std::time::Instant::now();
                    if last_preparation.borrow().is_some_and(|(phase, at)| {
                        phase == event.phase && now.duration_since(at).as_millis() < 100
                    }) {
                        return;
                    }
                    *last_preparation.borrow_mut() = Some((event.phase, now));
                }
                let _ = app.emit_to(
                    &owner,
                    "proof://ai-progress",
                    serde_json::json!({"ticket":progress_ticket,"event":event}),
                );
            };
            let result = {
                #[cfg(unix)]
                if observer::handles(&command) {
                    observer::dispatch(&core, &observer, &command, args)
                } else {
                    dispatch_with_progress(&core, &command, args, &progress)
                }
                #[cfg(not(unix))]
                dispatch_with_progress(&core, &command, args, &progress)
            };
            #[cfg(target_os = "macos")]
            if result.is_ok() && matches!(command.as_str(), "set_ui_language" | "delete_local_data")
            {
                window_menu::refresh(&app);
            }
            if let Some(generation) = measurement_generation {
                if let Ok(mut metrics) = metrics.lock() {
                    metrics.record(
                        generation,
                        request_epoch,
                        &command,
                        started.elapsed(),
                        result.as_ref().err().map(|e| e.code.as_str()),
                        result.as_ref().ok(),
                    );
                }
            }
            result
        };
        if let Some(ticket) = read_ticket {
            ticket.cancellation.run(work)
        } else {
            work()
        }
    })
    .await
    .map_err(|e| Error::new("CORE_UNAVAILABLE", "本地核心任务未完成。", e))?
}

#[cfg(test)]
fn dispatch(
    core: &Mutex<Proof>,
    command: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, Error> {
    dispatch_with_progress(core, command, args, &|_| {})
}
fn dispatch_with_progress(
    core: &Mutex<Proof>,
    command: &str,
    args: serde_json::Value,
    progress: &dyn Fn(proof_core::AiProgress),
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
    fn context_range(args: &serde_json::Value) -> Result<Option<u16>, Error> {
        if args["fullFile"].as_bool() == Some(true) {
            return Ok(None);
        }
        args["contextLines"]
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| {
                Error::new(
                    "INVALID_CONTEXT_SIZE",
                    "上下文行数无效。",
                    "Expected an unsigned context size",
                )
            })
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
    if command == "history_auto_fetch" {
        let job =
            session(core, data_epoch)?.prepare_history_fetch(string(&args, "workspaceId")?)?;
        if let Some(job) = job {
            job.execute()?;
            drop(session(core, data_epoch)?);
            return Ok(serde_json::json!(true));
        }
        return Ok(serde_json::json!(false));
    }
    if command == "agent_providers" {
        return serde_json::to_value(session(core, data_epoch)?.agent_providers()?)
            .map_err(Error::from);
    }
    if command == "probe_ai_agent" {
        if !proof_core::read_cancellation_active() {
            return Err(Error::new(
                "INVALID_READ_REQUEST",
                "检测缺少取消句柄。",
                "Agent probe requires a read ticket",
            ));
        }
        let probe = session(core, data_epoch)?.prepare_agent_probe(
            serde_json::from_value(args["provider"].clone())?,
            serde_json::from_value(args["options"].clone())?,
        )?;
        let result = probe.run()?;
        drop(session(core, data_epoch)?);
        return serde_json::to_value(result).map_err(Error::from);
    }
    if command == "run_ai_task" {
        if !proof_core::read_cancellation_active() {
            return Err(Error::new(
                "INVALID_READ_REQUEST",
                "AI 任务缺少取消句柄。",
                "AI requires an owned read ticket",
            ));
        }
        let job = session(core, data_epoch)?.prepare_ai_task_with_progress(
            serde_json::from_value(args["request"].clone())?,
            progress,
        )?;
        // Capture under the core lock; inference never holds the Git mutex.
        let result = job.run_with_progress(progress)?;
        let result = job.finish(&*session(core, data_epoch)?, result)?;
        return serde_json::to_value(result).map_err(Error::from);
    }
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
        "ui_language" => serde_json::to_value(proof.ui_language()?),
        "set_ui_language" => serde_json::to_value(
            proof.set_ui_language(serde_json::from_value(args["language"].clone())?)?,
        ),
        "agent_settings" => serde_json::to_value(proof.agent_settings()?),
        "set_agent_settings" => serde_json::to_value(
            proof.set_agent_settings(serde_json::from_value(args["update"].clone())?)?,
        ),
        "ai_review_reports" => serde_json::to_value(
            proof.ai_review_reports(string(&args, "workspaceId")?, string(&args, "scope")?)?,
        ),
        "ai_review_report" => serde_json::to_value(
            proof.ai_review_report(string(&args, "workspaceId")?, string(&args, "reportId")?)?,
        ),
        "set_ai_finding_decision" => serde_json::to_value(proof.set_ai_finding_decision(
            string(&args, "workspaceId")?,
            string(&args, "reportId")?,
            serde_json::from_value(args["expectedRevision"].clone())?,
            serde_json::from_value(args["findingIndex"].clone())?,
            serde_json::from_value(args["decision"].clone())?,
        )?),
        "change_groups" => {
            serde_json::to_value(proof.change_groups(string(&args, "workspaceId")?)?)
        }
        "comparison_change_groups" => serde_json::to_value(proof.comparison_change_groups(
            string(&args, "workspaceId")?,
            string(&args, "base")?,
            string(&args, "target")?,
        )?),
        "set_comparison_change_groups" => {
            serde_json::to_value(proof.set_comparison_change_groups(
                string(&args, "workspaceId")?,
                string(&args, "base")?,
                string(&args, "target")?,
                args["expectedRevision"].as_u64().ok_or_else(|| {
                    Error::new("INVALID_REQUEST", "分组版本缺失。", "Missing revision")
                })?,
                serde_json::from_value(args["groups"].clone())?,
            )?)
        }
        "set_change_groups" => serde_json::to_value(proof.set_change_groups(
            string(&args, "workspaceId")?,
            args["expectedRevision"].as_u64().ok_or_else(|| {
                Error::new("INVALID_REQUEST", "分组版本缺失。", "Missing revision")
            })?,
            string(&args, "expectedToken")?,
            serde_json::from_value(args["groups"].clone())?,
        )?),
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
        "read_file_diff" => serde_json::to_value(proof.read_file_diff(
            string(&args, "workspaceId")?,
            string(&args, "path")?,
            serde_json::from_value(args["side"].clone())?,
            args["loadLarge"].as_bool().unwrap_or(false),
        )?),
        "read_compare_file" => serde_json::to_value(proof.read_compare_file(
            string(&args, "workspaceId")?,
            string(&args, "base")?,
            string(&args, "target")?,
            string(&args, "path")?,
            args["loadLarge"].as_bool().unwrap_or(false),
        )?),
        "mark_reviewed" => serde_json::to_value(proof.mark_reviewed(
            string(&args, "snapshotId")?,
            args["hunkId"].as_str(),
            args["reviewed"].as_bool().unwrap_or(false),
        )?),
        "diff_context" => serde_json::to_value(
            proof.read_diff_context(string(&args, "snapshotId")?, context_range(&args)?)?,
        ),
        "compare_context" => serde_json::to_value(proof.compare_context(
            string(&args, "workspaceId")?,
            string(&args, "base")?,
            string(&args, "target")?,
            string(&args, "path")?,
            string(&args, "snapshotId")?,
            context_range(&args)?,
        )?),
        "mark_comparison_reviewed" => serde_json::to_value(
            proof.mark_comparison_reviewed(serde_json::from_value(args.clone())?)?,
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
        "context_overview" => serde_json::to_value(
            proof.context_overview(string(&args, "workspaceId")?, string(&args, "path")?)?,
        ),
        "context_candidates" => serde_json::to_value(proof.context_candidates(
            string(&args, "workspaceId")?,
            string(&args, "path")?,
            args["search"].as_str().unwrap_or(""),
            serde_json::from_value(args["before"].clone())?,
        )?),
        "context_session_events" => serde_json::to_value(proof.context_session_events_for_file(
            string(&args, "workspaceId")?,
            string(&args, "sessionId")?,
            args["path"].as_str(),
            serde_json::from_value(args["before"].clone())?,
        )?),
        "context_history" => serde_json::to_value(proof.context_history(
            string(&args, "workspaceId")?,
            string(&args, "path")?,
            args["offset"].as_u64().unwrap_or(0) as usize,
        )?),
        "update_context_association" => serde_json::to_value(proof.update_context_association(
            string(&args, "workspaceId")?,
            string(&args, "path")?,
            string(&args, "sessionId")?,
            serde_json::from_value(args["action"].clone())?,
            string(&args, "note")?,
            string(&args, "expectedRevision")?,
        )?),
        "undo_context_association" => serde_json::to_value(proof.undo_context_association(
            string(&args, "workspaceId")?,
            string(&args, "path")?,
            string(&args, "changeId")?,
            string(&args, "expectedRevision")?,
        )?),
        "observer_file_context" => serde_json::to_value(
            proof.observer_file_context(string(&args, "workspaceId")?, string(&args, "path")?)?,
        ),
        "observer_events" => serde_json::to_value(proof.observer_events(
            string(&args, "workspaceId")?,
            args["path"].as_str(),
            args["offset"].as_u64().unwrap_or(0) as usize,
        )?),
        "history_repository_state" => {
            serde_json::to_value(proof.history_repository_state(string(&args, "workspaceId")?)?)
        }
        "history_commit_message" => serde_json::to_value(
            proof.history_commit_message(string(&args, "workspaceId")?, string(&args, "oid")?)?,
        ),
        "prepare_history_action" => serde_json::to_value(proof.prepare_history_action(
            string(&args, "workspaceId")?,
            serde_json::from_value(args["request"].clone())?,
            string(&args, "expectedToken")?,
        )?),
        "execute_history_action" => {
            serde_json::to_value(proof.execute_history_action(
                string(&args, "workspaceId")?,
                string(&args, "previewId")?,
            )?)
        }
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::UpdateState::default());
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(window_menu::create)
        .on_menu_event(window_menu::handle);
    builder
        .setup(|app| {
            let data_dir = std::env::var_os("PROOF_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let core = Proof::open(&data_dir).map(|proof| Arc::new(Mutex::new(proof)));
            app.manage(diagnostics::ApplicationDiagnosticState(Arc::new(
                Mutex::new(proof_core::ApplicationDiagnostics::new(
                    data_dir.clone(),
                    core.as_ref().err().map(|e| e.code.as_str()),
                )),
            )));
            #[cfg(unix)]
            {
                let observer = observer::ObserverState::new(data_dir, app.path().home_dir()?)?;
                if let Ok(core) = &core {
                    observer.start(core.clone());
                }
                app.manage(observer);
            }
            app.manage(AppState(core.map_err(|error| {
                Error::new(
                    "CORE_STARTUP_FAILED",
                    "无法打开本地数据。你可以导出应用诊断，检查目录权限后重新启动。",
                    format!("{}: {}", error.code, error.detail),
                )
            })));
            #[cfg(target_os = "macos")]
            window_menu::refresh(app.handle());
            app.manage(diagnostics::DiagnosticState::default());
            app.manage(read_requests::ReadRequests::default());
            app.manage(diff_windows::DiffWindows::default());
            app.manage(Mutex::new(std::collections::HashMap::<
                String,
                watcher::WorkspaceWatch,
            >::new()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(reads) = window.try_state::<read_requests::ReadRequests>() {
                    reads.cancel_owner(window.label());
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<diff_windows::DiffWindows>()
                    .remove(window.label());
                if let Ok(mut owners) = window
                    .state::<Mutex<std::collections::HashMap<String, watcher::WorkspaceWatch>>>()
                    .lock()
                {
                    owners.remove(window.label());
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed)
                && window
                    .app_handle()
                    .webview_windows()
                    .keys()
                    .all(|label| label == window.label())
            {
                #[cfg(unix)]
                window
                    .state::<observer::ObserverState>()
                    .running
                    .store(false, std::sync::atomic::Ordering::Release);
            }
        })
        .invoke_handler(tauri::generate_handler![
            proof_command,
            prepare_read_request,
            cancel_read_request,
            watch_workspace,
            diagnostics::application_diagnostic,
            updater::check_app_update,
            updater::download_app_update,
            updater::install_app_update
        ])
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
    fn a_cancelled_read_does_not_wait_for_another_operation_to_release_core() {
        let temp = tempfile::tempdir().unwrap();
        let core = Arc::new(Mutex::new(Proof::open(temp.path()).unwrap()));
        let locked = core.lock().unwrap();
        let cancellation = proof_core::ReadCancellation::default();
        let read_core = core.clone();
        let read_cancel = cancellation.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let (start, started) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = read_cancel.run(|| {
                start.send(()).unwrap();
                dispatch(&read_core, "read_file_diff", serde_json::json!({"_dataEpoch":0,"workspaceId":"unused","path":"unused","side":"unstaged"}))
            });
            send.send(result).unwrap();
        });
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        cancellation.cancel();
        let result = receive.recv_timeout(Duration::from_secs(1));
        drop(locked);
        worker.join().unwrap();
        assert_eq!(result.unwrap().unwrap_err().code, "READ_CANCELLED");
    }

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
