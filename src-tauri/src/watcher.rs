use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use proof_core::Error;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct WorkspaceWatch {
    pub generation: u64,
    pub watcher: Option<RecommendedWatcher>,
}

pub fn start(
    app: AppHandle,
    workspace_id: String,
    paths: Vec<PathBuf>,
) -> Result<RecommendedWatcher, Error> {
    start_paths(paths, move || {
        let _ = app.emit("workspace-invalidated", &workspace_id);
    })
}

fn start_paths(
    paths: Vec<PathBuf>,
    mut changed: impl FnMut() + Send + 'static,
) -> Result<RecommendedWatcher, Error> {
    // Coalesce event bursts before IPC. Polling also reconciles dropped events,
    // atomic saves, watcher errors and changes made while Proof is hidden.
    let mut last = Instant::now() - Duration::from_secs(1);
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event
            .as_ref()
            .is_ok_and(|event| matches!(event.kind, notify::EventKind::Access(_)))
        {
            return;
        }
        if last.elapsed() < Duration::from_millis(100) {
            return;
        }
        last = Instant::now();
        changed();
    })
    .map_err(|error| {
        Error::new(
            "WATCH_UNAVAILABLE",
            "文件监听不可用，已改用定时刷新。",
            error,
        )
    })?;
    for path in paths {
        watcher
            .watch(&path, RecursiveMode::Recursive)
            .map_err(|error| {
                Error::new(
                    "WATCH_UNAVAILABLE",
                    "文件监听不可用，已改用定时刷新。",
                    error,
                )
            })?;
    }
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filesystem_save_and_atomic_rename_notify_the_active_watch() {
        let temp = tempfile::tempdir().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let watcher = start_paths(vec![temp.path().to_path_buf()], move || {
            let _ = tx.send(());
        })
        .unwrap();
        std::fs::write(temp.path().join("file.txt"), "first").unwrap();
        rx.recv_timeout(Duration::from_secs(3))
            .expect("file save notification");
        std::thread::sleep(Duration::from_millis(200));
        while rx.try_recv().is_ok() {}
        std::fs::write(temp.path().join("temporary"), "replacement").unwrap();
        std::fs::rename(temp.path().join("temporary"), temp.path().join("file.txt")).unwrap();
        rx.recv_timeout(Duration::from_secs(3))
            .expect("atomic save notification");
        drop(watcher);
    }
}
