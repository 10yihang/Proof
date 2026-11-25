use crate::{dispatch_with_progress, session};
use proof_core::{
    AgentKind, AiProgress, AiRequest, AiScope, AiTask, Error, Proof, ReadCancellation,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    cell::Cell,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const EVENT: &str = "proof://ocr-review";

#[derive(Clone, Default)]
pub(crate) struct OcrReviews(Arc<Mutex<Vec<Entry>>>);

struct Entry {
    run: ReviewRun,
    cancellation: ReadCancellation,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewRun {
    id: String,
    epoch: u64,
    revision: u64,
    workspace_id: String,
    scope: String,
    comparison: Option<Comparison>,
    label: String,
    started_at: u64,
    status: Status,
    activity: Vec<TimedActivity>,
    coverage: Option<AiProgress>,
    recent_path: Option<String>,
    error: Option<Error>,
}

#[derive(Clone, Serialize)]
struct Comparison {
    base: String,
    target: String,
}

#[derive(Clone, Serialize)]
struct TimedActivity {
    at: u64,
    event: AiProgress,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Running,
    Cancelling,
    Finished,
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn invalid() -> Error {
    Error::new(
        "INVALID_REQUEST",
        "OCR 审查请求无效。",
        "Expected an OCR review in the current data session",
    )
}

fn unavailable() -> Error {
    Error::new(
        "CORE_UNAVAILABLE",
        "无法读取 OCR 审查状态。",
        "OCR review registry unavailable",
    )
}

pub(crate) fn handles(command: &str) -> bool {
    matches!(
        command,
        "start_ocr_review" | "ocr_review_runs" | "cancel_ocr_review"
    )
}

impl OcrReviews {
    pub(crate) fn cancel_all(&self) {
        if let Ok(entries) = self.0.lock() {
            for entry in entries
                .iter()
                .filter(|entry| entry.run.status != Status::Finished)
            {
                entry.cancellation.cancel();
            }
        }
    }

    pub(crate) fn invalidate(&self, epoch: u64) {
        if let Ok(mut entries) = self.0.lock() {
            entries.retain(|entry| {
                if entry.run.epoch >= epoch {
                    return true;
                }
                entry.cancellation.cancel();
                false
            });
        }
    }

    fn update(&self, id: &str, epoch: u64, edit: impl FnOnce(&mut Entry)) -> Option<ReviewRun> {
        let mut entries = self.0.lock().ok()?;
        let entry = entries
            .iter_mut()
            .find(|entry| entry.run.id == id && entry.run.epoch == epoch)?;
        edit(entry);
        entry.run.revision += 1;
        Some(entry.run.clone())
    }
}

pub(crate) fn dispatch(
    app: &AppHandle,
    core: &Arc<Mutex<Proof>>,
    command: &str,
    args: Value,
) -> Result<Value, Error> {
    let epoch = args["_dataEpoch"].as_u64().ok_or_else(invalid)?;
    let reviews = app.state::<OcrReviews>().inner().clone();
    if command == "cancel_ocr_review" {
        let id = args["id"].as_str().ok_or_else(invalid)?;
        let run = reviews.update(id, epoch, |entry| {
            if entry.run.status == Status::Running {
                entry.run.status = Status::Cancelling;
                entry.cancellation.cancel();
            }
        });
        if let Some(run) = &run {
            let _ = app.emit(EVENT, run);
        }
        return serde_json::to_value(run).map_err(Error::from);
    }
    let _guard = session(core, epoch)?;
    reviews.invalidate(epoch);
    match command {
        "ocr_review_runs" => {
            let entries = reviews.0.lock().map_err(|_| unavailable())?;
            serde_json::to_value(
                entries
                    .iter()
                    .filter(|e| e.run.epoch == epoch)
                    .map(|e| &e.run)
                    .collect::<Vec<_>>(),
            )
            .map_err(Error::from)
        }
        "start_ocr_review" => start(app, core, reviews, epoch, args),
        _ => Err(invalid()),
    }
}

fn start(
    app: &AppHandle,
    core: &Arc<Mutex<Proof>>,
    reviews: OcrReviews,
    epoch: u64,
    args: Value,
) -> Result<Value, Error> {
    let request: AiRequest = serde_json::from_value(args["request"].clone())?;
    if request.provider != AgentKind::Ocr || request.task != AiTask::Review {
        return Err(invalid());
    }
    let workspace_id = request.scope.workspace_id().to_owned();
    let (scope, comparison) = match request.scope {
        AiScope::Local { .. } => ("local".into(), None),
        AiScope::Comparison { base, target, .. } => (
            format!("comparison:{base}:{target}"),
            Some(Comparison { base, target }),
        ),
    };
    let run = ReviewRun {
        id: uuid::Uuid::new_v4().to_string(),
        epoch,
        revision: 0,
        workspace_id,
        scope,
        comparison,
        label: args["label"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(4096)
            .collect(),
        started_at: unix_ms(),
        status: Status::Running,
        activity: Vec::new(),
        coverage: None,
        recent_path: None,
        error: None,
    };
    let cancellation = ReadCancellation::default();
    {
        let mut entries = reviews.0.lock().map_err(|_| unavailable())?;
        if let Some(entry) = entries.iter().find(|entry| {
            entry.run.epoch == epoch
                && entry.run.workspace_id == run.workspace_id
                && entry.run.scope == run.scope
                && entry.run.status != Status::Finished
        }) {
            return serde_json::to_value(&entry.run).map_err(Error::from);
        }
        entries.retain(|entry| {
            entry.run.workspace_id != run.workspace_id || entry.run.scope != run.scope
        });
        while entries
            .iter()
            .filter(|entry| entry.run.status == Status::Finished)
            .count()
            >= 24
        {
            if let Some(index) = entries
                .iter()
                .position(|entry| entry.run.status == Status::Finished)
            {
                entries.remove(index);
            }
        }
        entries.push(Entry {
            run: run.clone(),
            cancellation: cancellation.clone(),
        });
    }
    let _ = app.emit(EVENT, &run);
    let app = app.clone();
    let core = core.clone();
    let id = run.id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let last_update = Cell::new(Instant::now());
        let progress = |event: AiProgress| {
            let phase = event.phase;
            let next = reviews.update(&id, epoch, |entry| {
                let run = &mut entry.run;
                if let Some(path) = &event.path {
                    if phase.starts_with("ocr_") {
                        run.recent_path = Some(path.clone());
                    }
                }
                if phase == "ocr_scope" {
                    run.coverage = Some(event.clone());
                }
                run.activity.push(TimedActivity {
                    event,
                    at: unix_ms(),
                });
                if run.activity.len() > 40 {
                    run.activity.remove(0);
                }
            });
            if matches!(phase, "ocr_scope" | "ocr_filtering" | "ocr_subtask_failed")
                || last_update.get().elapsed() >= Duration::from_millis(125)
            {
                if let Some(next) = next {
                    let _ = app.emit(EVENT, next);
                }
                last_update.set(Instant::now());
            }
        };
        let result =
            cancellation.run(|| dispatch_with_progress(&core, "run_ai_task", args, &progress));
        if let Some(finished) = reviews.update(&id, epoch, |entry| {
            entry.run.status = Status::Finished;
            entry.run.error = result.as_ref().err().cloned();
        }) {
            let _ = app.emit(EVENT, &finished);
            if let Ok(report) = result {
                let _ = app.emit(
                    "proof:ai-review-updated",
                    json!({
                        "origin":"native",
                        "detail": {
                            "workspaceId": finished.workspace_id,
                            "scope": finished.scope,
                            "reportId": report["id"],
                            "revision": report["revision"],
                        "select": true,
                        }
                    }),
                );
            }
        }
    });
    serde_json::to_value(run).map_err(Error::from)
}
