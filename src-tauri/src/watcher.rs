use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use proof_core::Error;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct WorkspaceWatch {
    pub generation: u64,
    pub watcher: Option<WorkspaceWatcher>,
}

pub struct WorkspaceWatcher {
    watcher: Option<RecommendedWatcher>,
    worker: Option<JoinHandle<()>>,
    stopped: Arc<AtomicBool>,
    wakeup: SyncSender<()>,
}
impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        let _ = self.wakeup.try_send(());
        self.watcher.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchFailure {
    workspace_id: String,
    generation: u64,
}

pub fn start(
    app: AppHandle,
    workspace_id: String,
    generation: u64,
    paths: Vec<PathBuf>,
) -> Result<WorkspaceWatcher, Error> {
    start_paths(paths, move |failed| {
        if failed {
            let _ = app.emit(
                "workspace-watch-failed",
                WatchFailure {
                    workspace_id: workspace_id.clone(),
                    generation,
                },
            );
        } else {
            let _ = app.emit("workspace-invalidated", &workspace_id);
        }
    })
}

fn start_paths(
    paths: Vec<PathBuf>,
    changed: impl FnMut(bool) + Send + 'static,
) -> Result<WorkspaceWatcher, Error> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let wakeup = sender.clone();
    let failed = Arc::new(AtomicBool::new(false));
    let failure = failed.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event
            .as_ref()
            .is_ok_and(|event| matches!(event.kind, notify::EventKind::Access(_)))
        {
            return;
        }
        if event.is_err() {
            failure.store(true, Ordering::Release);
        }
        // Only a dirty signal crosses the queue. Failure remains latched even
        // if a normal event already occupies its single slot.
        let _ = sender.try_send(());
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
    let stopped = Arc::new(AtomicBool::new(false));
    let stopping = stopped.clone();
    let worker = std::thread::spawn(move || coalesce(receiver, failed, stopping, changed));
    Ok(WorkspaceWatcher {
        watcher: Some(watcher),
        worker: Some(worker),
        stopped,
        wakeup,
    })
}

fn coalesce(
    receiver: Receiver<()>,
    failed: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    mut changed: impl FnMut(bool),
) {
    while receiver.recv().is_ok() {
        if stopped.load(Ordering::Acquire) {
            break;
        }
        // Use a fixed window, rather than dropping a trailing event or waiting
        // for an indefinitely quiet period during continuous writes.
        let deadline = Instant::now() + Duration::from_millis(100);
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            if stopped.load(Ordering::Acquire) {
                break;
            }
            if receiver.recv_timeout(remaining).is_err() {
                break;
            }
        }
        if stopped.load(Ordering::Acquire) {
            break;
        }
        changed(failed.swap(false, Ordering::AcqRel));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filesystem_save_and_atomic_rename_notify_the_active_watch() {
        let temp = tempfile::tempdir().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let watcher = start_paths(vec![temp.path().to_path_buf()], move |_| {
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

    #[test]
    fn continuous_writes_are_bounded_and_the_last_change_is_delivered() {
        use std::sync::atomic::AtomicUsize;
        let (sender, receiver) = mpsc::sync_channel(1);
        let (observed, results) = mpsc::channel();
        let revision = Arc::new(AtomicUsize::new(0));
        let current = revision.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let stopping = stopped.clone();
        let worker = std::thread::spawn(move || {
            coalesce(
                receiver,
                Arc::new(AtomicBool::new(false)),
                stopping,
                move |_| {
                    let _ = observed.send(current.load(Ordering::Acquire));
                },
            )
        });
        let finished = Arc::new(AtomicBool::new(false));
        let finish = finished.clone();
        let writer = std::thread::spawn(move || {
            let mut index = 0;
            while !finish.load(Ordering::Acquire) {
                index += 1;
                revision.store(index, Ordering::Release);
                let _ = sender.try_send(());
                std::thread::sleep(Duration::from_millis(40));
            }
            revision.store(10_000, Ordering::Release);
            let _ = sender.try_send(());
        });
        let first = results.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            first < 10_000,
            "Continuous events starved refresh until writing ended"
        );
        finished.store(true, Ordering::Release);
        writer.join().unwrap();
        let mut latest = first;
        while latest < 10_000 {
            latest = results.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        stopped.store(true, Ordering::Release);
        worker.join().unwrap();
    }

    #[test]
    fn a_queued_error_is_not_lost_when_the_dirty_signal_slot_is_full() {
        let (sender, receiver) = mpsc::sync_channel(1);
        sender.try_send(()).unwrap();
        let failed = Arc::new(AtomicBool::new(true));
        assert!(sender.try_send(()).is_err());
        drop(sender);
        let mut errors = Vec::new();
        coalesce(
            receiver,
            failed,
            Arc::new(AtomicBool::new(false)),
            |failed| errors.push(failed),
        );
        assert_eq!(errors, [true]);
    }
}
