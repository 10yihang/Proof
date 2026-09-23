//! Background refresh of remote refs, separate from mutations to HEAD/index.
use crate::{git::Git, process, Error, Proof, Result, Workspace};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const FETCH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(crate) struct HistoryFetchGate {
    last_attempt: Option<Instant>,
    running: Arc<AtomicBool>,
}
struct FetchPermit(Arc<AtomicBool>);
impl Drop for FetchPermit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl HistoryFetchGate {
    fn reserve(&mut self, now: Instant) -> Option<FetchPermit> {
        if self.running.load(Ordering::Acquire)
            || self
                .last_attempt
                .is_some_and(|last| now.duration_since(last) < FETCH_INTERVAL)
        {
            return None;
        }
        self.last_attempt = Some(now);
        self.running.store(true, Ordering::Release);
        Some(FetchPermit(self.running.clone()))
    }
    pub(crate) fn note_manual_fetch(&mut self) {
        self.last_attempt = Some(Instant::now());
    }
}

/// Runs outside the core mutex so opening files is not blocked by network I/O.
/// A private permit prevents overlapping automatic fetches across windows and
/// Worktrees, including a slow fetch that lasts beyond the minimum interval.
pub struct HistoryFetch {
    git: Git,
    workspace: Workspace,
    remotes: Vec<String>,
    _permit: FetchPermit,
}
impl HistoryFetch {
    /// Returns whether the refs changed, not merely whether Fetch ran. A
    /// partial fetch can move refs before another remote fails; the graph must
    /// still invalidate in that case. Automatic Fetch has no error UI.
    pub fn execute(self) -> Result<bool> {
        let refs = || {
            self.git.query(
                &self.workspace,
                &["for-each-ref", "--format=%(refname)%00%(objectname)"],
            )
        };
        let before = refs()?;
        let mut first_error = None;
        for remote in &self.remotes {
            let mut command = self.git.command(&self.workspace)?;
            command
                .args([
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "credential.interactive=false",
                    "fetch",
                    "--no-tags",
                    "--no-recurse-submodules",
                    "--no-write-fetch-head",
                    "--no-auto-maintenance",
                    "--no-prune",
                    "--refmap=",
                    "--",
                    remote,
                    &format!("+refs/heads/*:refs/remotes/{remote}/*"),
                ])
                .env("GIT_ASKPASS", "/usr/bin/false")
                .env("SSH_ASKPASS", "/usr/bin/false")
                .env("SSH_ASKPASS_REQUIRE", "never")
                .env("GCM_INTERACTIVE", "never");
            // Keep configured SSH transports; default OpenSSH must not prompt.
            let ssh_config = self
                .git
                .query(&self.workspace, &["config", "--get", "core.sshCommand"]);
            if std::env::var_os("GIT_SSH_COMMAND").is_none()
                && std::env::var_os("GIT_SSH").is_none()
                && ssh_config.is_err()
            {
                command.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
            }
            let result =
                process::run(command, None, Duration::from_secs(30)).and_then(process::checked);
            if let Err(error) = result {
                first_error.get_or_insert(error);
            }
        }
        if before != refs()? {
            Ok(true)
        } else {
            first_error.map_or(Ok(false), Err)
        }
    }
}

impl Proof {
    pub fn prepare_history_fetch(&mut self, workspace_id: &str) -> Result<Option<HistoryFetch>> {
        let workspace = self.store.workspace(workspace_id)?;
        if !workspace.trusted {
            return Ok(None);
        }
        let git = self.git()?;
        let remotes = git.query(&workspace, &["remote"])?;
        let remotes: Vec<_> = std::str::from_utf8(&remotes)
            .map_err(|error| Error::new("CONFIG_ENCODING", "无法读取 Git remote 配置。", error))?
            .lines()
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect();
        if remotes.is_empty() {
            return Ok(None);
        }
        // repository_id identifies the shared Git directory, not a UI window.
        let gate = self
            .history_fetches
            .entry(workspace.repository_id.clone())
            .or_default();
        let Some(permit) = gate.reserve(Instant::now()) else {
            return Ok(None);
        };
        Ok(Some(HistoryFetch {
            git,
            workspace,
            remotes,
            _permit: permit,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attempts_are_one_minute_apart_even_after_failure_and_never_overlap() {
        let mut gate = HistoryFetchGate::default();
        let now = Instant::now();
        let first = gate.reserve(now).unwrap();
        assert!(gate.reserve(now + Duration::from_secs(120)).is_none());
        drop(first); // Error / success / abandonment all release ownership.
        assert!(gate.reserve(now + Duration::from_secs(59)).is_none());
        let second = gate.reserve(now + Duration::from_secs(60)).unwrap();
        drop(second);
        assert!(gate.reserve(now + Duration::from_secs(119)).is_none());
        assert!(gate.reserve(now + Duration::from_secs(120)).is_some());
    }
}
