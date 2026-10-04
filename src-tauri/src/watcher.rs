use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use proof_core::{Error, WorkspaceWatchSpec};
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
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
    watcher: Option<Arc<Mutex<RecommendedWatcher>>>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum WatchReason {
    Index,
    Refs,
    Config,
    Source,
}

#[derive(Clone, Default, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Changes {
    reasons: BTreeSet<WatchReason>,
    paths: Vec<String>,
    ignored_paths: Vec<String>,
    overflow: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Invalidation<'a> {
    workspace_id: &'a str,
    generation: u64,
    #[serde(flatten)]
    changes: Changes,
}

const MAX_PATHS: usize = 256;
#[derive(Default)]
struct Pending {
    paths: BTreeSet<PathBuf>,
    overflow: bool,
}
impl Pending {
    fn add(&mut self, paths: Vec<PathBuf>) {
        for path in paths {
            if self.paths.contains(&path) {
                continue;
            }
            if self.paths.len() < MAX_PATHS {
                self.paths.insert(path);
            } else {
                self.overflow = true;
            }
        }
    }
}

struct Scope {
    git: WorkspaceWatchSpec,
    root: PathBuf,
    metadata: Vec<PathBuf>,
    config: BTreeSet<PathBuf>,
}
impl Scope {
    fn new(git: WorkspaceWatchSpec) -> Self {
        let paths = git.paths();
        let root = paths
            .first()
            .map(|path| path.canonicalize().unwrap_or_else(|_| path.clone()))
            .unwrap_or_default();
        let mut metadata = paths
            .iter()
            .skip(1)
            .map(|path| path.canonicalize().unwrap_or_else(|_| path.clone()))
            .collect::<Vec<_>>();
        metadata.push(root.join(".git"));
        Self {
            config: config_paths(&git),
            root,
            metadata,
            git,
        }
    }
    fn reason(&self, path: &Path) -> Option<WatchReason> {
        if self
            .config
            .iter()
            .any(|config| path == config || config.starts_with(path))
        {
            return Some(WatchReason::Config);
        }
        for metadata in &self.metadata {
            if let Ok(relative) = path.strip_prefix(metadata) {
                let first = relative.components().next().map(|c| c.as_os_str());
                return Some(match first.and_then(|c| c.to_str()) {
                    Some(name)
                        if name == "index"
                            || name == "index.lock"
                            || name.starts_with("sharedindex.") =>
                    {
                        WatchReason::Index
                    }
                    Some("config" | "config.worktree" | "attributes" | "info") => {
                        WatchReason::Config
                    }
                    _ => WatchReason::Refs,
                });
            }
        }
        if path
            .file_name()
            .is_some_and(|name| name == ".gitignore" || name == ".gitattributes" || name == ".git")
        {
            return Some(WatchReason::Config);
        }
        None
    }
    fn classify(&self, pending: Pending) -> Changes {
        let mut changed = Changes {
            overflow: pending.overflow,
            ..Changes::default()
        };
        let mut source = Vec::new();
        for path in pending.paths {
            if let Some(reason) = self.reason(&path) {
                changed.reasons.insert(reason);
                changed.paths.push(self.display(&path));
            } else if path.starts_with(&self.root) {
                source.push(path);
            }
        }
        // Metadata never goes through ignore filtering. check-ignore's default
        // tracked-file handling ensures a tracked target/dist file still refreshes.
        let ignored = ignored_paths(&self.git, &source).unwrap_or_default();
        for path in source {
            if ignored.contains(&path) {
                changed.ignored_paths.push(self.display(&path));
            } else {
                changed.reasons.insert(WatchReason::Source);
                changed.paths.push(self.display(&path));
            }
        }
        if changed.overflow {
            changed.reasons.insert(WatchReason::Source);
        }
        changed
    }
    fn display(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned()
    }
}

// Git work runs in the coalescer, never the notify callback or the shared core.
// File-backed pipes bound input/output and avoid a stalled child blocking pipe IO.
fn git_output(git: &WorkspaceWatchSpec, args: &[&str], input: &[u8]) -> Option<(bool, Vec<u8>)> {
    let mut stdin = tempfile::tempfile().ok()?;
    stdin.write_all(input).ok()?;
    use std::io::{Seek, SeekFrom};
    stdin.seek(SeekFrom::Start(0)).ok()?;
    let mut output = tempfile::tempfile().ok()?;
    let mut child = git
        .command()
        .args(args)
        .stdin(stdin)
        .stdout(output.try_clone().ok()?)
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_millis(200);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    output.seek(SeekFrom::Start(0)).ok()?;
    let mut bytes = Vec::new();
    output.take(256 * 1024 + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() <= 256 * 1024).then_some((status.success(), bytes))
}
fn ignored_paths(git: &WorkspaceWatchSpec, paths: &[PathBuf]) -> Option<BTreeSet<PathBuf>> {
    if paths.is_empty() {
        return Some(BTreeSet::new());
    }
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.to_str()?.as_bytes());
        input.push(0);
    }
    if input.len() > 64 * 1024 {
        return None;
    }
    let (success, output) = git_output(git, &["check-ignore", "-z", "--stdin"], &input)?;
    if !success && !output.is_empty() {
        return None;
    }
    Some(
        output
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| PathBuf::from(String::from_utf8_lossy(p).as_ref()))
            .collect(),
    )
}
fn config_paths(git: &WorkspaceWatchSpec) -> BTreeSet<PathBuf> {
    let root = &git.paths()[0];
    let mut paths = BTreeSet::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        paths.insert(home.join(".gitconfig"));
        let xdg = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".config"));
        for name in ["config", "ignore", "attributes"] {
            paths.insert(xdg.join("git").join(name));
        }
    }
    paths.insert(PathBuf::from("/etc/gitconfig"));
    for name in ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] {
        if let Some(path) = std::env::var_os(name) {
            paths.insert(PathBuf::from(path));
        }
    }
    if let Some((true, output)) = git_output(
        git,
        &[
            "config",
            "--includes",
            "--show-origin",
            "--name-only",
            "--null",
            "--list",
        ],
        &[],
    ) {
        for origin in output.split(|b| *b == 0).step_by(2) {
            if let Some(path) = origin.strip_prefix(b"file:") {
                let path = PathBuf::from(String::from_utf8_lossy(path).as_ref());
                paths.insert(if path.is_absolute() {
                    path
                } else {
                    root.join(path)
                });
            }
        }
    }
    for key in ["core.excludesFile", "core.attributesFile"] {
        if let Some((true, output)) = git_output(git, &["config", "--path", "--get", key], &[]) {
            let path = PathBuf::from(String::from_utf8_lossy(&output).trim());
            paths.insert(if path.is_absolute() {
                path
            } else {
                root.join(path)
            });
        }
    }
    // FSEvents can report canonical paths, including a symlinked config target.
    // Keep the declared path as well, so replacing the symlink is still visible.
    let resolved = paths
        .iter()
        .filter_map(|path| path.canonicalize().ok())
        .collect::<Vec<_>>();
    paths.extend(resolved);
    paths
}

fn watch_config(watcher: &mut RecommendedWatcher, scope: &Scope) -> Result<(), notify::Error> {
    let mut parents = BTreeSet::new();
    for config in &scope.config {
        if config.starts_with(&scope.root) || scope.metadata.iter().any(|p| config.starts_with(p)) {
            continue;
        }
        let mut parent = config.parent();
        while parent.is_some_and(|p| !p.is_dir()) {
            parent = parent.and_then(Path::parent);
        }
        if let Some(parent) = parent {
            parents.insert(parent.to_owned());
        }
    }
    for parent in parents {
        watcher.watch(&parent, RecursiveMode::NonRecursive)?;
    }
    Ok(())
}

pub fn start(
    app: AppHandle,
    workspace_id: String,
    generation: u64,
    spec: WorkspaceWatchSpec,
) -> Result<WorkspaceWatcher, Error> {
    start_paths(spec, true, move |failed, changes| {
        if failed {
            let _ = app.emit(
                "workspace-watch-failed",
                WatchFailure {
                    workspace_id: workspace_id.clone(),
                    generation,
                },
            );
        } else {
            let event = if changes.reasons.is_empty() {
                "workspace-watch-ignored"
            } else {
                "workspace-invalidated"
            };
            let _ = app.emit(
                event,
                Invalidation {
                    workspace_id: &workspace_id,
                    generation,
                    changes,
                },
            );
        }
    })
}

fn start_paths(
    spec: WorkspaceWatchSpec,
    global_config: bool,
    mut changed: impl FnMut(bool, Changes) + Send + 'static,
) -> Result<WorkspaceWatcher, Error> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let wakeup = sender.clone();
    let failed = Arc::new(AtomicBool::new(false));
    let failure = failed.clone();
    let pending = Arc::new(Mutex::new(Pending::default()));
    let queued = pending.clone();
    let mut paths = spec.paths().to_vec();
    let mut scope = Scope::new(spec);
    if !global_config {
        scope.config.clear();
    }
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.as_ref().is_ok_and(|event| {
            matches!(event.kind, notify::EventKind::Access(_)) && !event.need_rescan()
        }) {
            return;
        }
        if event.is_err() {
            failure.store(true, Ordering::Release);
        } else if let Ok(event) = event {
            if let Ok(mut pending) = queued.lock() {
                pending.overflow |= event.need_rescan() || event.paths.is_empty();
                pending.add(event.paths);
            } else {
                failure.store(true, Ordering::Release);
            }
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
    let mut registered = Vec::<PathBuf>::new();
    paths.sort_by_key(|path| path.components().count());
    for path in paths {
        if registered.iter().any(|parent| path.starts_with(parent)) {
            continue;
        }
        registered.push(path.clone());
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
    watch_config(&mut watcher, &scope).map_err(|error| {
        Error::new(
            "WATCH_UNAVAILABLE",
            "文件监听不可用，已改用定时刷新。",
            error,
        )
    })?;
    let watcher = Arc::new(Mutex::new(watcher));
    let watching = watcher.clone();
    let stopped = Arc::new(AtomicBool::new(false));
    let stopping = stopped.clone();
    let worker = std::thread::spawn(move || {
        coalesce(receiver, failed, stopping, move |failed| {
            let pending = pending.lock().map(|mut paths| std::mem::take(&mut *paths));
            let Ok(pending) = pending else {
                changed(true, Changes::default());
                return;
            };
            let changes = scope.classify(pending);
            let mut watch_failed = failed;
            if global_config
                && changes
                    .reasons
                    .iter()
                    .any(|reason| matches!(reason, WatchReason::Refs | WatchReason::Config))
            {
                scope.config = config_paths(&scope.git);
                watch_failed |= watching.lock().map_or(true, |mut watcher| {
                    watch_config(&mut watcher, &scope).is_err()
                });
            }
            if watch_failed || !changes.reasons.is_empty() || !changes.ignored_paths.is_empty() {
                changed(watch_failed, changes);
            }
        });
    });
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
    use std::process::Command;

    fn watch_spec(root: &Path) -> WorkspaceWatchSpec {
        let data = tempfile::tempdir_in("/private/tmp").unwrap();
        let mut proof = proof_core::Proof::open(data.path()).unwrap();
        let workspace = proof.open_workspace(root.to_str().unwrap()).unwrap();
        proof.workspace_watch_spec(&workspace.id).unwrap()
    }

    fn git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn repository() -> tempfile::TempDir {
        let temp = tempfile::tempdir_in("/private/tmp").unwrap();
        git(temp.path(), &["init", "-b", "main"]);
        std::fs::create_dir(temp.path().join("target")).unwrap();
        std::fs::create_dir(temp.path().join("dist")).unwrap();
        std::fs::write(temp.path().join("target/tracked.rs"), "tracked source").unwrap();
        std::fs::write(temp.path().join("dist/tracked.js"), "tracked distribution").unwrap();
        git(
            temp.path(),
            &["add", "target/tracked.rs", "dist/tracked.js"],
        );
        std::fs::write(temp.path().join(".gitignore"), "target/\ndist/\n").unwrap();
        temp
    }
    fn batch(paths: impl IntoIterator<Item = PathBuf>) -> Pending {
        let mut pending = Pending::default();
        pending.add(paths.into_iter().collect());
        pending
    }

    #[test]
    fn ignored_separate_git_directory_inside_root_keeps_metadata_invalidation() {
        let temp = tempfile::tempdir_in("/private/tmp").unwrap();
        let metadata = temp.path().join("private-meta");
        git(
            temp.path(),
            &[
                "init",
                "-b",
                "main",
                "--separate-git-dir",
                metadata.to_str().unwrap(),
            ],
        );
        std::fs::write(temp.path().join(".gitignore"), "private-meta/\n").unwrap();
        let spec = watch_spec(temp.path());
        assert!(spec.paths().contains(&metadata));
        let scope = Scope::new(spec);
        let changed = scope.classify(batch([
            metadata.join("index"),
            metadata.join("refs/heads/main"),
            metadata.join("config"),
        ]));
        assert_eq!(
            changed.reasons,
            BTreeSet::from([WatchReason::Index, WatchReason::Refs, WatchReason::Config])
        );
        assert_eq!(changed.paths.len(), 3);
        assert!(changed.ignored_paths.is_empty());
    }

    #[test]
    fn inherited_temporary_index_and_repository_environment_cannot_hide_tracked_outputs() {
        const FIXTURE_ROOT: &str = "PROOF_WATCH_ROUTING_FIXTURE";
        if let Some(root) = std::env::var_os(FIXTURE_ROOT) {
            let root = PathBuf::from(root);
            let scope = Scope::new(watch_spec(&root));
            let command = scope.git.command();
            for name in [
                "GIT_INDEX_FILE",
                "GIT_DIR",
                "GIT_WORK_TREE",
                "GIT_COMMON_DIR",
                "GIT_OBJECT_DIRECTORY",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            ] {
                assert!(
                    command
                        .get_envs()
                        .any(|(key, value)| key == name && value.is_none()),
                    "routing variable {name} was not removed"
                );
            }
            let changed = scope.classify(batch([
                root.join("target/tracked.rs"),
                root.join("dist/tracked.js"),
                root.join("target/generated.o"),
            ]));
            assert_eq!(changed.reasons, BTreeSet::from([WatchReason::Source]));
            assert_eq!(changed.ignored_paths, ["target/generated.o"]);
            assert_eq!(changed.paths.len(), 2);
            return;
        }
        let temp = repository();
        let empty_index = temp.path().join("temporary-index");
        let output = Command::new("git")
            .arg("-C")
            .arg(temp.path())
            .args(["read-tree", "--empty"])
            .env("GIT_INDEX_FILE", &empty_index)
            .output()
            .unwrap();
        assert!(output.status.success());
        // Pollution is restricted to a child test process; parallel fixture
        // creation in this test binary never inherits its temporary index.
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "watcher::tests::inherited_temporary_index_and_repository_environment_cannot_hide_tracked_outputs", "--nocapture"])
            .env(FIXTURE_ROOT, temp.path())
            .env("GIT_INDEX_FILE", empty_index)
            .env("GIT_DIR", temp.path().join(".git"))
            .env("GIT_WORK_TREE", temp.path())
            .env("GIT_COMMON_DIR", temp.path().join(".git"))
            .env("GIT_OBJECT_DIRECTORY", temp.path().join(".git/objects"))
            .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", temp.path().join(".git/objects"))
            .env("GIT_LITERAL_PATHSPECS", "1")
            .output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn configured_core_git_is_used_and_filter_failure_refreshes_conservatively() {
        use std::os::unix::fs::PermissionsExt;
        let temp = repository();
        let fixture = tempfile::tempdir_in("/private/tmp").unwrap();
        let wrapper = fixture.path().join("configured-git");
        let calls = fixture.path().join("calls");
        let fail = fixture.path().join("fail-check-ignore");
        std::fs::write(&wrapper, format!(
            "#!/bin/sh\nprintf call >> '{}'\ncase \"$*\" in *check-ignore*) if [ -e '{}' ]; then exit 2; fi ;; esac\nexec /usr/bin/git \"$@\"\n",
            calls.display(), fail.display()
        )).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut proof = proof_core::Proof::open(fixture.path().join("data")).unwrap();
        let mut preferences = proof.preferences().unwrap();
        preferences.git_path = wrapper.to_str().unwrap().into();
        proof.set_preferences(preferences).unwrap();
        let workspace = proof.open_workspace(temp.path().to_str().unwrap()).unwrap();
        let scope = Scope::new(proof.workspace_watch_spec(&workspace.id).unwrap());
        std::fs::write(&calls, "").unwrap();
        let ignored = scope.classify(batch([temp.path().join("target/generated.o")]));
        assert!(ignored.reasons.is_empty());
        assert_eq!(std::fs::read_to_string(&calls).unwrap(), "call");
        std::fs::write(fail, "fail fixture ignore query").unwrap();
        let failed = scope.classify(batch([temp.path().join("target/generated.o")]));
        assert_eq!(failed.reasons, BTreeSet::from([WatchReason::Source]));
        assert!(failed.ignored_paths.is_empty());
    }

    #[test]
    fn ignored_output_flood_is_filtered_but_tracked_target_and_dist_still_invalidate() {
        let temp = repository();
        let scope = Scope::new(watch_spec(temp.path()));
        let paths = (0..200).map(|i| temp.path().join(format!("target/generated-{i}.o")));
        let started = Instant::now();
        let ignored = scope.classify(batch(paths));
        assert!(ignored.reasons.is_empty());
        assert_eq!(ignored.ignored_paths.len(), 200);
        eprintln!("watcher fixture: ignored_paths=200, invalidating_batches_before=1, after=0, classification_us={}", started.elapsed().as_micros());
        let tracked = scope.classify(batch([
            temp.path().join("target/tracked.rs"),
            temp.path().join("dist/tracked.js"),
            temp.path().join("target/untracked.o"),
        ]));
        assert_eq!(tracked.reasons, BTreeSet::from([WatchReason::Source]));
        assert_eq!(tracked.paths, ["dist/tracked.js", "target/tracked.rs"]);
        assert_eq!(tracked.ignored_paths, ["target/untracked.o"]);
    }

    #[test]
    fn git_metadata_ignore_and_attributes_paths_never_depend_on_ignore_filtering() {
        let temp = repository();
        let external_git = temp.path().join("common-git");
        let global = temp.path().join("global.config");
        let mut scope = Scope::new(watch_spec(temp.path()));
        scope.metadata.push(external_git.clone());
        scope.config = BTreeSet::from([global.clone()]);
        let changed = scope.classify(batch([
            temp.path().join(".git/index"),
            temp.path().join(".git/sharedindex.fixture"),
            temp.path().join(".git/HEAD"),
            external_git.join("refs/heads/main"),
            external_git.join("packed-refs"),
            temp.path().join(".git/info/attributes"),
            temp.path().join("target/.gitattributes"),
            temp.path().join("target/.gitignore"),
            global,
        ]));
        assert_eq!(
            changed.reasons,
            BTreeSet::from([WatchReason::Index, WatchReason::Refs, WatchReason::Config])
        );
        assert_eq!(changed.paths.len(), 9);
        assert!(changed.ignored_paths.is_empty());
    }

    #[test]
    fn rename_with_an_ignored_old_path_preserves_the_new_source_path() {
        let temp = repository();
        let scope = Scope::new(watch_spec(temp.path()));
        let changed = scope.classify(batch([
            temp.path().join("target/old.rs"),
            temp.path().join("new.rs"),
        ]));
        assert_eq!(changed.paths, ["new.rs"]);
        assert_eq!(changed.ignored_paths, ["target/old.rs"]);
        assert!(changed.reasons.contains(&WatchReason::Source));
    }

    #[test]
    fn invalid_repository_and_bounded_queue_overflow_refresh_conservatively() {
        let temp = repository();
        let scope = Scope::new(watch_spec(temp.path()));
        std::fs::remove_dir_all(temp.path().join(".git")).unwrap();
        let changed = scope.classify(batch([temp.path().join("target/file.rs")]));
        assert!(changed.reasons.contains(&WatchReason::Source));
        let pending = batch((0..MAX_PATHS + 1).map(|i| temp.path().join(format!("file-{i}"))));
        assert!(pending.overflow);
        let changed = scope.classify(pending);
        assert!(changed.overflow && changed.reasons.contains(&WatchReason::Source));
    }

    #[test]
    fn included_external_config_and_attribute_inputs_are_discovered() {
        let temp = repository();
        let config = temp.path().join("external-config");
        let attributes = temp.path().join("external-attributes");
        let excludes = temp.path().join("external-excludes");
        std::fs::write(
            &config,
            format!(
                "[core]\n attributesFile = {}\n excludesFile = {}\n",
                attributes.display(),
                excludes.display()
            ),
        )
        .unwrap();
        git(
            temp.path(),
            &["config", "include.path", config.to_str().unwrap()],
        );
        let paths = config_paths(&watch_spec(temp.path()));
        assert!(paths.contains(&config));
        assert!(paths.contains(&attributes));
        assert!(paths.contains(&excludes));
        let scope = Scope {
            git: watch_spec(temp.path()),
            root: temp.path().to_owned(),
            metadata: vec![temp.path().join(".git")],
            config: paths,
        };
        assert_eq!(scope.reason(&attributes), Some(WatchReason::Config));
        assert_eq!(scope.reason(&excludes), Some(WatchReason::Config));
    }

    #[test]
    fn external_config_parent_watch_survives_atomic_replacement() {
        let temp = tempfile::tempdir_in("/private/tmp").unwrap();
        let root = repository();
        let external = temp.path().join("global");
        std::fs::create_dir(&external).unwrap();
        let config = external.join("config");
        std::fs::write(&config, "[core]\n").unwrap();
        let scope = Scope {
            git: watch_spec(root.path()),
            root: root.path().to_owned(),
            metadata: vec![],
            config: BTreeSet::from([config.clone()]),
        };
        let (sender, receiver) = mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    let _ = sender.send(event.paths);
                }
            })
            .unwrap();
        watch_config(&mut watcher, &scope).unwrap();
        let replacement = external.join("replacement");
        std::fs::write(&replacement, "[core]\n autocrlf = false\n").unwrap();
        std::fs::rename(&replacement, &config).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut config_seen = false;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            let Ok(paths) = receiver.recv_timeout(remaining) else {
                break;
            };
            if paths
                .iter()
                .any(|path| scope.reason(path) == Some(WatchReason::Config))
            {
                config_seen = true;
                break;
            }
        }
        assert!(
            config_seen,
            "atomic external config replacement was not observed"
        );
    }

    #[test]
    fn filesystem_save_and_atomic_rename_notify_the_active_watch() {
        let temp = repository();
        let (tx, rx) = std::sync::mpsc::channel();
        let watcher = start_paths(watch_spec(temp.path()), false, move |_, _| {
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
