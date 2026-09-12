use crate::{fingerprint, now, process, Error, ObserverAgent, Proof, Result};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const CODEX_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "SessionEnd",
    "Interrupt",
];
const CLAUDE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "SessionEnd",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverAdapterProfile {
    pub adapter_version: String,
    pub registered_events: &'static [&'static str],
    pub async_handlers: bool,
    pub fixture_status: String,
    pub runtime_verified: bool,
    pub trust_review_required: bool,
}

pub fn observer_adapter_profile(
    agent: ObserverAgent,
    version: &str,
) -> Option<ObserverAdapterProfile> {
    let events = match (agent, version) {
        (ObserverAgent::Codex, "0.153.4") => CODEX_EVENTS,
        (ObserverAgent::Claude, "2.1.236") => CLAUDE_EVENTS,
        _ => return None,
    };
    Some(ObserverAdapterProfile {
        adapter_version: crate::OBSERVER_ADAPTER_VERSION.into(),
        registered_events: events,
        async_handlers: true,
        fixture_status: "local_protocol_only".into(),
        runtime_verified: false,
        trust_review_required: agent == ObserverAgent::Codex,
    })
}

pub fn observer_hook_events_v1(agent: ObserverAgent) -> &'static [&'static str] {
    match agent {
        ObserverAgent::Codex => CODEX_EVENTS,
        ObserverAgent::Claude => CLAUDE_EVENTS,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverProbe {
    pub agent: ObserverAgent,
    pub executable_path: String,
    pub executable_identity: String,
    pub version: String,
    pub status: String,
    pub checked_at: u64,
    pub profile: Option<ObserverAdapterProfile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverProgramLocation {
    pub agent: ObserverAgent,
    pub executable_path: Option<String>,
}

pub fn observer_program_locations() -> Vec<ObserverProgramLocation> {
    let mut folders = vec![
        std::path::PathBuf::from("/opt/homebrew/bin"),
        std::path::PathBuf::from("/usr/local/bin"),
        std::path::PathBuf::from("/usr/bin"),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        folders.extend(std::env::split_paths(&path).filter(|p| p.is_absolute()));
    }
    [ObserverAgent::Claude, ObserverAgent::Codex]
        .into_iter()
        .map(|agent| {
            let name = if cfg!(windows) {
                format!("{}.exe", agent.as_str())
            } else {
                agent.as_str().into()
            };
            let executable_path = folders
                .iter()
                .map(|dir| dir.join(&name))
                .find(|path| path.is_file())
                .and_then(|path| path.to_str().map(String::from));
            ObserverProgramLocation {
                agent,
                executable_path,
            }
        })
        .collect()
}

impl Proof {
    /// A fixed --version query. This does not create a registration, grant a
    /// workspace, run a model, or write a hook configuration.
    pub fn probe_observer(&self, agent: ObserverAgent, path: &str) -> Result<ObserverProbe> {
        self.prepare_observer_probe(agent, path)?.run()
    }
    pub fn prepare_observer_probe(
        &self,
        agent: ObserverAgent,
        path: &str,
    ) -> Result<ObserverProbeRequest> {
        let requested = Path::new(path);
        if !requested.is_absolute() {
            return Err(Error::new(
                "OBSERVER_PROGRAM_PATH",
                "请选择 Agent 程序的绝对路径。",
                "Executable path must be absolute",
            ));
        }
        let (executable, mut origins) = resolve_program_path(requested).map_err(|_| {
            Error::new(
                "OBSERVER_PROGRAM_MISSING",
                "找不到所选 Agent 程序。",
                "Executable is unavailable",
            )
        })?;
        if executable.to_str().is_none() {
            return Err(Error::new(
                "OBSERVER_PROGRAM_PATH",
                "程序路径不是 UTF-8。",
                "Non-UTF8 executable path",
            ));
        }
        let workspaces = self.store.workspaces()?;
        let actual_parent = executable.parent().ok_or_else(|| {
            Error::new("OBSERVER_PROGRAM_PATH", "程序路径无效。", "Missing parent")
        })?;
        origins.push(actual_parent.to_owned());
        origins.sort();
        origins.dedup();
        let mut workspace_ids = Vec::new();
        for parent in origins {
            if let Some(id) = self.trusted_program_workspace(&parent, &workspaces)? {
                if !workspace_ids.contains(&id) {
                    workspace_ids.push(id);
                }
            }
        }
        let before = program_identity(&executable)?;
        Ok(ObserverProbeRequest {
            agent,
            executable,
            working_directory: self.data_dir.clone(),
            before,
            workspace_ids,
        })
    }
    fn trusted_program_workspace(
        &self,
        parent: &Path,
        workspaces: &[crate::Workspace],
    ) -> Result<Option<String>> {
        let candidates: Vec<_> = workspaces
            .iter()
            .filter(|w| parent.starts_with(&w.path))
            .collect();
        if candidates.is_empty() {
            return Ok(None);
        }
        let actual = self
            .git()?
            .discover(parent.to_str().ok_or_else(|| {
                Error::new(
                    "OBSERVER_PROGRAM_PATH",
                    "程序路径不是 UTF-8。",
                    "Non-UTF8 executable parent",
                )
            })?)?
            .0;
        for workspace in candidates.into_iter().filter(|w| {
            w.path == actual.path
                && w.git_dir == actual.git_dir
                && w.common_dir == actual.common_dir
        }) {
            match self.store.workspace(&workspace.id) {
                Ok(current) if current.trusted => return Ok(Some(current.id)),
                Ok(_) => {
                    return Err(Error::new(
                        "TRUST_REQUIRED",
                        "所选程序位于未信任的工作区，请先核对程序来源。",
                        "Untrusted workspace executable",
                    ))
                }
                Err(error) if error.code == "WORKSPACE_REPLACED" => continue,
                Err(error) => return Err(error),
            }
        }
        Err(Error::new(
            "WORKSPACE_REPLACED",
            "程序所在仓库身份已变化，请重新打开并确认信任。",
            "No currently trusted workspace matches the executable",
        ))
    }
}

/// Keep every link's physical parent before following it. Resolving the whole
/// path first would lose a repository that supplies a directory link, including
/// when that link is reached through another alias outside the repository.
fn resolve_program_path(path: &Path) -> std::io::Result<(PathBuf, Vec<PathBuf>)> {
    let mut pending = path.to_owned();
    let mut origins = Vec::new();
    loop {
        let mut cursor = PathBuf::new();
        let mut components = pending.components();
        let mut redirect = None;
        while let Some(component) = components.next() {
            cursor.push(component);
            if !matches!(component, std::path::Component::Normal(_))
                || !fs::symlink_metadata(&cursor)?.file_type().is_symlink()
            {
                continue;
            }
            if origins.len() == 40 {
                return Err(std::io::Error::other("Too many symbolic links"));
            }
            let parent = fs::canonicalize(
                cursor
                    .parent()
                    .ok_or_else(|| std::io::Error::other("Symbolic link has no parent"))?,
            )?;
            let target = fs::read_link(&cursor)?;
            let target = if target.is_absolute() {
                target
            } else {
                parent.join(target)
            };
            origins.push(parent);
            redirect = Some(target.join(components.as_path()));
            break;
        }
        match redirect {
            Some(target) => pending = target,
            None => return Ok((fs::canonicalize(cursor)?, origins)),
        }
    }
}

/// Native-only prepared work. Owns its inputs so running the CLI never holds
/// the GUI's Git mutex. File identity is a change guard, not a binary signature.
pub struct ObserverProbeRequest {
    agent: ObserverAgent,
    executable: PathBuf,
    working_directory: PathBuf,
    before: String,
    workspace_ids: Vec<String>,
}
impl ObserverProbeRequest {
    pub fn run(self) -> Result<ObserverProbe> {
        let Self {
            agent,
            executable,
            working_directory,
            before,
            workspace_ids,
        } = self;
        if !workspace_ids.is_empty() {
            let store = crate::store::Store::open(&working_directory)?;
            for id in workspace_ids {
                if !store.workspace(&id)?.trusted {
                    return Err(Error::new(
                        "TRUST_REQUIRED",
                        "仓库信任已撤销，未启动版本查询。",
                        "Workspace trust changed before query",
                    ));
                }
            }
        }
        if before != program_identity(&executable)? {
            return Err(Error::new(
                "OBSERVER_PROGRAM_CHANGED",
                "所选程序已变化，请重新检测。",
                "Executable changed before query",
            ));
        }
        let mut command = Command::new(&executable);
        command.arg("--version").current_dir(&working_directory);
        let output = process::run(command, None, Duration::from_secs(2))?;
        if output.code != 0 || output.stdout.len() > 8192 {
            return Err(Error::new(
                "OBSERVER_VERSION_QUERY",
                "Agent 版本查询未成功。",
                "Version command failed or output exceeded 8 KiB",
            ));
        }
        let version = parse_version(agent, &output.stdout).ok_or_else(|| {
            Error::new(
                "OBSERVER_VERSION_FORMAT",
                "输出不是所选 Agent 的版本格式，请核对程序路径。",
                "Version output was not recognized",
            )
        })?;
        if before != program_identity(&executable)? {
            return Err(Error::new(
                "OBSERVER_PROGRAM_CHANGED",
                "检测期间 Agent 程序发生变化，请重新检测。",
                "Executable identity changed during version query",
            ));
        }
        let profile = observer_adapter_profile(agent, &version);
        Ok(ObserverProbe {
            agent,
            executable_path: executable.to_string_lossy().into_owned(),
            executable_identity: before,
            version,
            status: if profile.is_some() {
                "candidate_unverified"
            } else {
                "unsupported_version"
            }
            .into(),
            checked_at: now(),
            profile,
        })
    }
}

fn parse_version(agent: ObserverAgent, bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?.trim();
    let version = match agent {
        ObserverAgent::Codex => text.strip_prefix("codex-cli ")?,
        ObserverAgent::Claude => text.strip_suffix(" (Claude Code)")?,
    };
    if version.is_empty()
        || version.len() > 64
        || !version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
        || !version.bytes().next()?.is_ascii_digit()
    {
        return None;
    }
    Some(version.into())
}

fn program_identity(path: &Path) -> Result<String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(Error::new(
            "OBSERVER_PROGRAM_TYPE",
            "所选程序不是可检测的普通文件。",
            "Executable is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.mode() & 0o111 == 0 || before.mode() & 0o022 != 0 {
            return Err(Error::new(
                "OBSERVER_PROGRAM_PERMISSION",
                "所选程序的执行权限不符合要求。",
                "Executable must be executable and not group/world writable",
            ));
        }
    }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
            before.dev(),
            before.ino(),
            before.len(),
            before.mode(),
            before.uid(),
            before.gid(),
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec()
        )
    };
    #[cfg(not(unix))]
    let identity = format!(
        "{}:{:?}:{:?}",
        before.len(),
        before.modified()?,
        before.created()?
    );
    Ok(fingerprint(&[
        path.as_os_str().as_encoded_bytes(),
        identity.as_bytes(),
    ]))
}
