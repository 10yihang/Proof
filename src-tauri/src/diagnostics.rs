use proof_core::{DiagnosticMetrics, Error, Proof};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct DiagnosticState(pub Arc<Mutex<DiagnosticMetrics>>);
pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "prepare_diagnostic" | "cancel_diagnostic" | "export_diagnostic" | "validate_diagnostic"
    )
}
fn unavailable() -> Error {
    Error::new(
        "CORE_UNAVAILABLE",
        "诊断暂时不可用，请重试。",
        "Diagnostics mutex unavailable",
    )
}
fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str, Error> {
    args[key]
        .as_str()
        .ok_or_else(|| Error::new("INVALID_REQUEST", "请求字段缺失。", key))
}
fn session<'a>(
    core: &'a Mutex<Proof>,
    args: &Value,
) -> Result<std::sync::MutexGuard<'a, Proof>, Error> {
    let mut proof = core.lock().map_err(|_| unavailable())?;
    proof.synchronize_data_epoch()?;
    proof.check_data_epoch(args["_dataEpoch"].as_u64().ok_or_else(|| {
        Error::new(
            "DATA_SESSION_REQUIRED",
            "请重新载入 Proof 后重试。",
            "Missing data generation",
        )
    })?)?;
    Ok(proof)
}
pub fn dispatch(
    app: &tauri::AppHandle,
    core: &Mutex<Proof>,
    metrics: &Mutex<DiagnosticMetrics>,
    command: &str,
    args: &Value,
) -> Result<Value, Error> {
    match command {
        "prepare_diagnostic" => {
            let mut proof = session(core, args)?;
            let summary = metrics
                .lock()
                .map_err(|_| unavailable())?
                .snapshot(proof.diagnostic_generation()?);
            Ok(serde_json::to_value(proof.prepare_diagnostic(
                serde_json::from_value(args["options"].clone())?,
                summary,
            )?)?)
        }
        "validate_diagnostic" => {
            session(core, args)?
                .validate_diagnostic(string(args, "previewId")?, string(args, "sha256")?)?;
            Ok(Value::Null)
        }
        "cancel_diagnostic" => {
            session(core, args)?.cancel_diagnostic(string(args, "previewId")?);
            Ok(Value::Null)
        }
        "export_diagnostic" => {
            let id = string(args, "previewId")?;
            let digest = string(args, "sha256")?;
            let preview = session(core, args)?.validate_diagnostic(id, digest)?;
            // This wrapper runs on a blocking worker, never on the Tauri UI thread.
            // Only a native Save dialog can choose the destination; IPC accepts no output path.
            let destination = app
                .dialog()
                .file()
                .set_title("保存诊断")
                .set_file_name(&preview.file_name)
                .add_filter("JSON", &["json"])
                .blocking_save_file();
            let Some(destination) = destination else {
                return Ok(Value::Null);
            };
            let destination = destination.into_path().map_err(|_| {
                Error::new(
                    "DIAGNOSTIC_WRITE_FAILED",
                    "请选择本地文件位置。",
                    "Non-local save destination",
                )
            })?;
            let job = session(core, args)?.prepare_diagnostic_export(id, digest)?;
            Ok(serde_json::to_value(job.run(&destination)?)?)
        }
        _ => Err(Error::new("UNKNOWN_COMMAND", "此操作尚不支持。", command)),
    }
}

pub struct ApplicationDiagnosticState(pub Arc<Mutex<proof_core::ApplicationDiagnostics>>);
#[tauri::command]
pub async fn application_diagnostic(
    app: tauri::AppHandle,
    state: tauri::State<'_, ApplicationDiagnosticState>,
    command: String,
    args: Value,
) -> Result<Value, Error> {
    // This deliberately does not require a data session or a functioning Proof core.
    // Its closed report contains only public build/platform information.
    if command == "prepare" {
        return Ok(serde_json::to_value(
            state.0.lock().map_err(|_| unavailable())?.prepare()?,
        )?);
    }
    let id = string(&args, "previewId")?.to_owned();
    if command == "cancel" {
        state.0.lock().map_err(|_| unavailable())?.cancel(&id);
        return Ok(Value::Null);
    }
    let digest = string(&args, "sha256")?.to_owned();
    let preview = state
        .0
        .lock()
        .map_err(|_| unavailable())?
        .validate(&id, &digest)?;
    if command == "validate" {
        return Ok(Value::Null);
    }
    if command != "export" {
        return Err(Error::new("UNKNOWN_COMMAND", "此操作尚不支持。", command));
    }
    let dialog_app = app.clone();
    let destination = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("保存应用诊断")
            .set_file_name(&preview.file_name)
            .add_filter("JSON", &["json"])
            .blocking_save_file()
    })
    .await
    .map_err(|_| unavailable())?;
    let Some(destination) = destination else {
        return Ok(Value::Null);
    };
    let destination = destination.into_path().map_err(|_| {
        Error::new(
            "DIAGNOSTIC_WRITE_FAILED",
            "请选择本地文件位置。",
            "Non-local save destination",
        )
    })?;
    let job = state
        .0
        .lock()
        .map_err(|_| unavailable())?
        .take_export(&id, &digest)?;
    tauri::async_runtime::spawn_blocking(move || Ok(serde_json::to_value(job.run(&destination)?)?))
        .await
        .map_err(|_| unavailable())?
}
