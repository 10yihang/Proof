use super::{codewiz, invalid, AgentKind, AgentOptions, AgentProbeResult, AgentSettings};
use crate::{process, program, Error, Result};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

#[cfg(all(test, target_os = "macos"))]
#[path = "native_codewiz_tests.rs"]
mod native_codewiz_tests;
#[cfg(all(test, target_os = "macos"))]
#[path = "native_codex_tests.rs"]
mod native_codex_tests;

/// The actual project and this task's fixed Git evidence have separate paths.
#[derive(Clone, Copy)]
pub struct AgentReadContext<'a> {
    pub project: &'a Path,
    pub evidence: &'a Path,
    pub paths: &'a [String],
}

/// Active inference only. Passive Observer consent and sessions are separate.
pub trait AgentProvider: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn analyze_workspace(
        &self,
        program: &AgentProgram,
        prompt: &str,
        schema: &Value,
        context: AgentReadContext<'_>,
        emit: &dyn Fn(super::AiProgress),
    ) -> Result<Value> {
        if program.kind != self.kind() {
            return Err(unsupported("Agent 类型不匹配。"));
        }
        run_workspace(
            self.kind(),
            &program.executable,
            prompt,
            schema,
            program.model.as_deref(),
            || program.validate(),
            Some((context, emit)),
        )
    }
    fn analyze(&self, program: &AgentProgram, prompt: &str, schema: &Value) -> Result<Value> {
        if program.kind != self.kind() {
            return Err(unsupported("Agent 类型不匹配。"));
        }
        run(
            self.kind(),
            &program.executable,
            prompt,
            schema,
            program.model.as_deref(),
            || program.validate(),
        )
    }
}
/// A sealed launch capability, checked against current Proof trust and data epoch.
/// Opening this read-only connection cannot recreate a deleted database.
pub struct AgentProgram {
    kind: AgentKind,
    source: PathBuf,
    executable: PathBuf,
    identity: String,
    code_mode_host: Option<(PathBuf, String)>,
    store: crate::store::Store,
    workspace_id: Option<String>,
    model: Option<String>,
    epoch: u64,
}
impl AgentProgram {
    pub(super) fn configured(
        kind: AgentKind,
        data: &Path,
        workspace: Option<&str>,
        epoch: u64,
        options: &AgentOptions,
    ) -> Result<Self> {
        let source = options
            .executable_path
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| locate(kind))
            .ok_or_else(|| {
                Error::new(
                    "AI_AGENT_MISSING",
                    "未找到本机 CLI，请在 Agent 设置中指定程序路径。",
                    "No local executable",
                )
            })?;
        Self::inspect(kind, &source, data, workspace, epoch, options.model.clone())
    }
    #[cfg(test)]
    pub(super) fn at_path(
        kind: AgentKind,
        source: &Path,
        data: &Path,
        workspace: &str,
        epoch: u64,
    ) -> Result<Self> {
        Self::inspect(kind, source, data, Some(workspace), epoch, None)
    }
    fn inspect(
        kind: AgentKind,
        source: &Path,
        data: &Path,
        workspace: Option<&str>,
        epoch: u64,
        model: Option<String>,
    ) -> Result<Self> {
        let connection = rusqlite::Connection::open_with_flags(
            data.join("proof.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let (executable, _, identity) = resolve_executable(kind, source)?;
        let code_mode_host = if kind == AgentKind::Codex {
            companion_host(&executable)?
                .map(|path| program::program_identity(&path).map(|identity| (path, identity)))
                .transpose()?
        } else {
            None
        };
        let program = Self {
            kind,
            source: source.into(),
            executable,
            identity,
            code_mode_host,
            store: crate::store::Store { connection },
            workspace_id: workspace.map(str::to_owned),
            model,
            epoch,
        };
        program.validate()?;
        Ok(program)
    }
    pub(super) fn validate(&self) -> Result<()> {
        let epoch: u64 = self.store.connection.query_row(
            "SELECT value FROM settings WHERE key='data_epoch'",
            [],
            |row| {
                let text: String = row.get(0)?;
                Ok(text.parse().unwrap_or(u64::MAX))
            },
        )?;
        if epoch != self.epoch {
            return Err(Error::new(
                "DATA_EPOCH_CHANGED",
                "本地记录已更新，旧 AI 任务已取消。",
                "AI launch generation changed",
            ));
        }
        if self
            .workspace_id
            .as_ref()
            .map(|id| self.store.workspace(id).map(|workspace| !workspace.trusted))
            .transpose()?
            .unwrap_or(false)
        {
            return Err(Error::new(
                "TRUST_REQUIRED",
                "仓库信任已撤销，AI 任务已取消。",
                "Workspace trust revoked",
            ));
        }
        let (path, mut origins, identity) = resolve_executable(self.kind, &self.source)?;
        if path != self.executable || identity != self.identity {
            return Err(unsupported("CLI 已变化，请重新开始分析。"));
        }
        if self.kind == AgentKind::Codex {
            let host = companion_host(&path)?
                .map(|path| program::program_identity(&path).map(|identity| (path, identity)))
                .transpose()?;
            if host != self.code_mode_host {
                return Err(unsupported("CLI 已变化，请重新开始分析。"));
            }
        }
        origins.push(
            path.parent()
                .ok_or_else(|| unsupported("CLI 路径无效。"))?
                .into(),
        );
        let workspaces = self.store.workspaces()?;
        for origin in origins {
            program::trusted_program_workspace(&self.store, &origin, &workspaces)?;
        }
        Ok(())
    }
}
pub struct CodexProvider;
pub struct ClaudeCodeProvider;
pub struct CodewizProvider;
impl AgentProvider for CodewizProvider {
    fn kind(&self) -> AgentKind {
        AgentKind::Codewiz
    }
}
impl AgentProvider for CodexProvider {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }
}
impl AgentProvider for ClaudeCodeProvider {
    fn kind(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderInfo {
    pub id: AgentKind,
    pub name: &'static str,
    pub available: bool,
    pub path: Option<String>,
    pub reason: Option<String>,
    pub model: Option<String>,
    pub is_default: bool,
}
pub fn agent_providers() -> Vec<AgentProviderInfo> {
    provider_information(&AgentSettings::default())
}
pub(super) fn provider_information(settings: &AgentSettings) -> Vec<AgentProviderInfo> {
    crate::AGENT_ADAPTERS
        .iter()
        .map(|adapter| adapter.kind)
        .filter(|id| {
            !id.adapter().installed_only
                || locate(*id).is_some()
                || settings
                    .options(*id)
                    .executable_path
                    .as_ref()
                    .is_some_and(|p| resolve_executable(*id, Path::new(p)).is_ok())
        })
        .map(|id| {
            let options = settings.options(id);
            let path = options
                .executable_path
                .as_ref()
                .map(PathBuf::from)
                .or_else(|| locate(id));
            let reason = if !cfg!(target_os = "macos") {
                Some("此平台尚无经过验证的只读 Agent 沙箱。".into())
            } else if managed_configuration(id) {
                Some("检测到受管理的 Agent 配置，暂不支持隔离调用。".into())
            } else if path
                .as_ref()
                .is_none_or(|path| resolve_executable(id, path).is_err())
            {
                Some("未找到本机 CLI。".into())
            } else {
                None
            };
            AgentProviderInfo {
                id,
                name: provider_name(id),
                available: reason.is_none(),
                path: path.map(|p| p.to_string_lossy().into_owned()),
                reason,
                model: options.model.clone(),
                is_default: settings.default_provider == id,
            }
        })
        .collect()
}
pub(crate) fn locate(kind: AgentKind) -> Option<PathBuf> {
    let name = kind.adapter().executable;
    let mut roots = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(user_directory) = std::env::var_os("HOME") {
        for suffix in [".local/bin", ".cargo/bin", ".npm-global/bin"] {
            roots.push(PathBuf::from(&user_directory).join(suffix));
        }
        if kind == AgentKind::Codewiz {
            roots.extend(codewiz::installation_roots(Path::new(&user_directory)));
        }
    }
    if kind == AgentKind::Codewiz {
        if let Some(path) = std::env::var_os("PATH") {
            // Only absolute, non-project PATH entries; final launch still uses
            // the shared executable-identity and repository-trust checks.
            let cwd = std::env::current_dir().ok();
            let mut inherited: Vec<_> = std::env::split_paths(&path)
                .filter(|p| {
                    p.is_absolute()
                        && !cwd.as_ref().is_some_and(|cwd| p.starts_with(cwd))
                        && !p.components().any(|c| c.as_os_str() == "node_modules")
                })
                .collect();
            inherited.extend(roots);
            roots = inherited;
        }
    }
    // Do not execute repository-local PATH entries, shell aliases or functions.
    roots.into_iter().find_map(|root| {
        resolve_executable(kind, &root.join(name)).ok()?;
        Some(root.join(name))
    })
}
fn managed_configuration(kind: AgentKind) -> bool {
    if kind == AgentKind::Codewiz
        && fs::read_dir("/Library/Managed Preferences")
            .into_iter()
            .flatten()
            .flatten()
            .any(|entry| entry.path().join("ai.opencode.managed.plist").exists())
    {
        return true;
    }
    let paths: &[&str] = match kind {
        AgentKind::Codex => &[
            "/etc/codex/config.toml",
            "/etc/codex/requirements.toml",
            "/Library/Managed Preferences/com.openai.codex.plist",
        ],
        AgentKind::ClaudeCode => &[
            "/Library/Application Support/ClaudeCode/managed-settings.json",
            "/etc/claude-code/managed-settings.json",
            "/Library/Managed Preferences/com.anthropic.claudecode.plist",
        ],
        AgentKind::Codewiz => &[
            "/Library/Application Support/opencode/codewiz.json",
            "/Library/Application Support/opencode/codewiz.jsonc",
            "/Library/Managed Preferences/ai.opencode.managed.plist",
            "/etc/opencode/codewiz.json",
            "/etc/opencode/codewiz.jsonc",
        ],
    };
    paths.iter().any(|path| fs::symlink_metadata(path).is_ok())
}
pub(super) fn unsupported(message: &str) -> Error {
    Error::new(
        "AI_ISOLATION_UNAVAILABLE",
        message,
        "Required read-only CLI capabilities unavailable; no model task started",
    )
}

pub(crate) fn resolve_executable(
    kind: AgentKind,
    source: &Path,
) -> Result<(PathBuf, Vec<PathBuf>, String)> {
    let (mut path, mut origins) = program::resolve_program_path(source)?;
    let mut identity = program::program_identity(&path)?;
    if kind == AgentKind::Codewiz {
        if let Some(native) = codewiz::native_program(&path)? {
            origins.push(
                path.parent()
                    .ok_or_else(|| unsupported("CLI 路径无效。"))?
                    .into(),
            );
            let (resolved, links) = program::resolve_program_path(&native)?;
            identity.push_str(&program::program_identity(&resolved)?);
            origins.extend(links);
            path = resolved;
        }
    }
    Ok((path, origins, identity))
}

/// Only the installed CLI's sibling executable is eligible. Never discover a
/// runtime through repository PATH entries or permit an escaping helper symlink.
fn companion_host(executable: &Path) -> Result<Option<PathBuf>> {
    let parent = executable
        .parent()
        .ok_or_else(|| unsupported("CLI 路径无效。"))?;
    let source = parent.join("codex-code-mode-host");
    match fs::symlink_metadata(&source) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(_) => (),
    }
    let (path, _) = program::resolve_program_path(&source)?;
    if path.parent() != Some(parent) {
        return Err(unsupported("Code Mode host 必须来自所选 CLI 的安装目录。"));
    }
    program::program_identity(&path)?;
    Ok(Some(path))
}
#[cfg(target_os = "macos")]
fn codex_runtime(directory: &Path, login_directory: Option<&Path>) -> Result<PathBuf> {
    let runtime = directory.join("codex");
    fs::create_dir_all(&runtime)?;
    // Keep CLI runtime metadata (including installation_id) out of the shared
    // Agent home. Only the CLI reads its existing login, through a symlink.
    // The sandbox resolves that link to a target outside the writable job, so
    // auth refresh/replacement cannot change the user's credentials or sessions.
    // Proof never reads, copies, serializes or logs credential contents.
    if let Some(source) = login_directory.map(|path| path.join("auth.json")) {
        let target = runtime.join("auth.json");
        if !target.exists() {
            match fs::canonicalize(&source) {
                Ok(source) if source.is_file() => {
                    std::os::unix::fs::symlink(source, target)?;
                }
                Ok(_) => return Err(unsupported("Codex 登录文件路径无效。")),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err(unsupported("无法读取 Codex 登录文件，请检查 CLI 登录。")),
            }
        }
    }
    Ok(runtime)
}
#[cfg(target_os = "macos")]
fn isolated_command(kind: AgentKind, executable: &Path, directory: &Path) -> Result<Command> {
    let login_directory = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".codex")));
    isolated_command_with_login(kind, executable, directory, login_directory.as_deref())
}
#[cfg(target_os = "macos")]
fn isolated_command_with_login(
    kind: AgentKind,
    executable: &Path,
    directory: &Path,
    login_directory: Option<&Path>,
) -> Result<Command> {
    isolated_command_options(kind, executable, directory, login_directory, None)
}
#[cfg(target_os = "macos")]
fn reading_command(
    kind: AgentKind,
    executable: &Path,
    runtime: &Path,
    workspace: &Path,
) -> Result<Command> {
    let login = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".codex")));
    isolated_command_options(kind, executable, runtime, login.as_deref(), Some(workspace))
}
#[cfg(not(target_os = "macos"))]
fn reading_command(_: AgentKind, _: &Path, _: &Path, _: &Path) -> Result<Command> {
    Err(unsupported("此平台尚无经过验证的只读 Agent 沙箱。"))
}
#[cfg(target_os = "macos")]
fn isolated_command_options(
    kind: AgentKind,
    executable: &Path,
    directory: &Path,
    login_directory: Option<&Path>,
    workspace: Option<&Path>,
) -> Result<Command> {
    // A process-level boundary, not a prompt. Even startup hooks / in-process
    // patch tools cannot write a repo, index, Agent session, or user config.
    // Probes allow CLI self-exec only; analysis additionally enables bounded read tools.
    let quote = |path: &Path| -> Result<String> {
        let path = path
            .to_str()
            .ok_or_else(|| unsupported("CLI 路径无法识别。"))?;
        if path.chars().any(char::is_control) {
            return Err(unsupported("CLI 路径无法识别。"));
        }
        Ok(format!(
            "\"{}\"",
            path.replace('\\', "\\\\").replace('"', "\\\"")
        ))
    };
    let mut profile = format!("(version 1)(allow default)(deny file-write*)(allow file-write* (subpath {}) (literal \"/dev/null\"))(deny process-exec)(allow process-exec (literal {}))(deny signal)", quote(directory)?, quote(executable)?);
    // Claude's login reader uses the system Keychain CLI.
    if kind == AgentKind::ClaudeCode {
        profile.push_str("(allow process-exec (literal \"/usr/bin/security\"))");
    }
    // Codewiz cleanup sees only the empty, Proof-owned MCP inventory.
    if kind == AgentKind::Codewiz {
        profile.push_str(&codewiz::startup_profile(directory)?);
    }
    if let Some(workspace) = workspace {
        if workspace.starts_with(directory) {
            return Err(unsupported("项目目录不能位于可写运行目录内。"));
        }
        if kind == AgentKind::Codex {
            if let Some(host) = companion_host(executable)? {
                profile.push_str(&format!("(allow process-exec (literal {}))", quote(&host)?));
            }
        }
        // Search/read executables only. The process-level write/signal denials
        // also apply to shell builtins and every descendant process.
        for path in [
            "/bin/sh",
            "/bin/bash",
            "/bin/zsh",
            "/bin/cat",
            "/bin/ls",
            "/usr/bin/env",
            "/usr/bin/sandbox-exec",
            "/usr/bin/git",
            "/opt/homebrew/bin/git",
            "/usr/local/bin/git",
            "/usr/bin/grep",
            "/usr/bin/find",
            "/usr/bin/sed",
            "/usr/bin/head",
            "/usr/bin/tail",
            "/usr/bin/wc",
            "/usr/bin/sort",
            "/usr/bin/uniq",
            "/usr/bin/cut",
            "/usr/bin/tr",
            "/usr/bin/awk",
            "/usr/bin/diff",
            "/usr/bin/stat",
            "/usr/bin/dirname",
            "/usr/bin/basename",
            "/usr/bin/xcrun",
            "/Library/Developer/CommandLineTools/usr/bin/git",
            "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
            "/Applications/Xcode-beta.app/Contents/Developer/usr/bin/git",
            "/usr/bin/readlink",
            "/opt/homebrew/bin/rg",
            "/usr/local/bin/rg",
            "/Applications/Codex.app/Contents/Resources/rg",
            "/Applications/ChatGPT.app/Contents/Resources/rg",
        ] {
            if let Ok(path) = fs::canonicalize(path) {
                profile.push_str(&format!("(allow process-exec (literal {}))", quote(&path)?));
            }
        }
    }
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .args(["-p", &profile])
        .arg(executable)
        .current_dir(workspace.unwrap_or(directory))
        .env_clear();
    for key in [
        "HOME",
        "USER",
        "LOGNAME",
        "CLAUDE_CONFIG_DIR",
        "LANG",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Applications/Codex.app/Contents/Resources:/Applications/ChatGPT.app/Contents/Resources")
        .env("TMPDIR", directory)
        .env("CLAUDE_CODE_TMPDIR", directory)
        .env("TERM", "dumb")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_COUNT", "3")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_0", "/dev/null")
        .env("GIT_CONFIG_KEY_1", "core.fsmonitor")
        .env("GIT_CONFIG_VALUE_1", "false")
        .env("GIT_CONFIG_KEY_2", "core.pager")
        .env("GIT_CONFIG_VALUE_2", "cat")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0");
    if kind == AgentKind::Codex {
        // Configure only this child process's Codex runtime. The parent env and
        // user's CLI configuration are untouched.
        command.env("CODEX_HOME", codex_runtime(directory, login_directory)?);
    }
    if kind == AgentKind::Codewiz {
        codewiz::configure(&mut command, directory, workspace.is_some())?;
    }
    Ok(command)
}
#[cfg(not(target_os = "macos"))]
fn isolated_command(_: AgentKind, _: &Path, _: &Path) -> Result<Command> {
    Err(unsupported("此平台尚无经过验证的只读 Agent 沙箱。"))
}

fn run(
    kind: AgentKind,
    executable: &Path,
    prompt: &str,
    schema: &Value,
    model: Option<&str>,
    validate: impl Fn() -> Result<()>,
) -> Result<Value> {
    run_workspace(kind, executable, prompt, schema, model, validate, None)
}

fn help_output(kind: AgentKind, executable: &Path, root: &Path) -> Result<process::Output> {
    let mut command = isolated_command(kind, executable, root)?;
    if kind == AgentKind::Codewiz {
        // Bun/yargs may exit before its long stderr help has flushed to a pipe.
        // A private regular file makes the capability probe deterministic.
        let setup = command;
        let args: Vec<_> = setup.get_args().collect();
        command = Command::new(setup.get_program());
        command
            .args(&args[..args.len() - 1])
            .arg("/bin/sh")
            .args([
                "-c",
                "exec \"$@\" > \"$PROOF_HELP_OUTPUT\" 2>&1",
                "proof-cli-help",
            ])
            .arg(executable)
            .args(["run", "--help"])
            .env_clear()
            .envs(setup.get_envs().filter_map(|(k, v)| v.map(|v| (k, v))))
            .env("PROOF_HELP_OUTPUT", root.join("codewiz-help.txt"))
            .current_dir(root);
        let mut output = process::run_diff(command, None, Duration::from_secs(10), 256 * 1024)?;
        if output.code == 0 {
            use std::io::Read;
            let mut bytes = Vec::new();
            fs::File::open(root.join("codewiz-help.txt"))?
                .take(256 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 256 * 1024 {
                return Err(unsupported("CLI 帮助输出超出限制。"));
            }
            output.stdout = bytes;
        }
        Ok(output)
    } else {
        if kind == AgentKind::Codex {
            command.arg("exec");
        }
        command.arg("--help");
        process::run_diff(command, None, Duration::from_secs(10), 256 * 1024)
    }
}
type ReadingWorkspace<'a> = (AgentReadContext<'a>, &'a dyn Fn(super::AiProgress));

#[allow(clippy::too_many_arguments)]
fn run_workspace(
    kind: AgentKind,
    executable: &Path,
    prompt: &str,
    schema: &Value,
    model: Option<&str>,
    validate: impl Fn() -> Result<()>,
    workspace: Option<ReadingWorkspace<'_>>,
) -> Result<Value> {
    if managed_configuration(kind) {
        return Err(unsupported("受管理的 Agent 配置暂不支持隔离调用。"));
    }
    validate()?;
    let identity = program::program_identity(executable)?;
    let directory = tempfile::Builder::new().prefix("proof-ai-").tempdir()?;
    let root = fs::canonicalize(directory.path())?;
    let output = help_output(kind, executable, &root)?;
    if output.code != 0 {
        return Err(agent_failure(kind, "capability check", &output));
    }
    let help = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let missing = missing_capabilities(kind, &help);
    if !missing.is_empty() {
        return Err(Error::new(
            "AI_ISOLATION_UNAVAILABLE",
            "CLI 缺少只读分析所需的能力，请查看失败详情。",
            format!("Missing CLI options: {}", missing.join(", ")),
        ));
    }
    if program::program_identity(executable)? != identity {
        return Err(unsupported("CLI 已更新，请重新开始分析。"));
    }
    fs::write(root.join("schema.json"), serde_json::to_vec(schema)?)?;
    let mut command = match workspace {
        Some((context, _)) => reading_command(kind, executable, &root, context.project)?,
        None => isolated_command(kind, executable, &root)?,
    };
    command.args(if workspace.is_some() {
        externally_sandboxed_arguments(kind, &root, schema)?
    } else {
        arguments(kind, &root, schema)?
    });
    if let Some((context, _)) = workspace {
        match kind {
            AgentKind::Codewiz => codewiz::allow_evidence(&mut command, &root, context.evidence)?,
            AgentKind::ClaudeCode => {
                command.arg("--add-dir").arg(context.evidence);
            }
            AgentKind::Codex => (),
        }
    }
    if let Some(model) = model {
        command.args(["--model", model]);
    }
    let input = if kind == AgentKind::Codewiz {
        codewiz::prompt(prompt, schema)
    } else {
        prompt.to_owned()
    };
    validate()?;
    let output = (if let Some((context, emit)) = workspace {
        let mut activity =
            super::progress::ActivityStream::in_project(context.paths, context.project, emit);
        process::run_until_cancelled(
            command,
            Some(input.as_bytes()),
            32 * 1024 * 1024,
            Some(&mut |bytes| activity.feed(bytes)),
        )
    } else {
        process::run_until_cancelled(command, Some(input.as_bytes()), 2 * 1024 * 1024, None)
    })
    .map_err(|error| match error.code.as_str() {
        "READ_CANCELLED" => Error::new(
            "AI_CANCELLED",
            "AI 分析已取消。",
            "Only the owned process group was cancelled",
        ),
        "DIFF_OUTPUT_LIMIT" | "OUTPUT_LIMIT" => invalid("Agent output exceeded 2 MiB"),
        _ => Error::new("AI_PROCESS", "无法启动只读 Agent 分析。", error.code),
    })?;
    if output.code != 0 {
        return Err(agent_failure(kind, "analysis", &output));
    }
    validate()?;
    decode(kind, &output.stdout)
}
fn arguments(kind: AgentKind, root: &Path, schema: &Value) -> Result<Vec<String>> {
    let args: Vec<String> = match kind {
        AgentKind::Codewiz => codewiz::arguments(),
        AgentKind::Codex => {
            let mut args: Vec<String> = [
                "exec",
                "--ignore-user-config",
                "--ignore-rules",
                "--ephemeral",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "--json",
                "--color",
                "never",
                "--output-schema",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect();
            args.push(root.join("schema.json").to_string_lossy().into_owned());
            for flag in [
                "shell_snapshot",
                "hooks",
                "plugins",
                "apps",
                "multi_agent",
                "multi_agent_v2",
                "memories",
                "chronicle",
                "browser_use",
                "browser_use_external",
                "computer_use",
                "image_generation",
                "in_app_browser",
                "in_app_local_automation",
                "workspace_dependencies",
                "skill_mcp_dependency_install",
                "skill_search",
            ] {
                // Config keys tolerate features absent in another CLI release;
                // --disable instead rejects an unknown feature name outright.
                args.extend(["-c".into(), format!("features.{flag}=false")]);
            }
            for config in [
                "approval_policy=\"never\"",
                "web_search=\"disabled\"",
                "mcp_servers={}",
                "project_doc_max_bytes=0",
                "history.persistence=\"none\"",
                "notify=[]",
                "analytics.enabled=false",
            ] {
                args.extend(["-c".into(), config.into()]);
            }
            for (key, path) in [
                ("sqlite_home", root.join("state")),
                ("log_dir", root.join("logs")),
            ] {
                args.extend([
                    "-c".into(),
                    format!("{key}={}", serde_json::to_string(&path.to_string_lossy())?),
                ]);
            }
            args.push("-".into());
            args
        }
        AgentKind::ClaudeCode => [
            "--print",
            "--safe-mode",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--tools",
            "Read,Grep,Glob,Bash",
            "--allowedTools",
            "Read,Grep,Glob,Bash",
            "--permission-mode",
            "plan",
            "--disable-slash-commands",
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\":{}}",
            "--setting-sources",
            "",
            "--settings",
            "{\"disableAllHooks\":true}",
            "--no-chrome",
            "--json-schema",
            &serde_json::to_string(schema)?,
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
    };
    Ok(args)
}
/// macOS cannot apply Codex's child sandbox inside our existing Seatbelt profile.
/// Only use these arguments with reading_command: that mandatory outer profile
/// denies file writes outside the private runtime and denies foreign signals for
/// the CLI and ALL descendants. This does not grant filesystem write access.
fn externally_sandboxed_arguments(
    kind: AgentKind,
    root: &Path,
    schema: &Value,
) -> Result<Vec<String>> {
    let mut args = arguments(kind, root, schema)?;
    if kind == AgentKind::Codex {
        let index = args
            .iter()
            .position(|arg| arg == "--sandbox")
            .ok_or_else(|| unsupported("缺少执行隔离参数。"))?;
        args[index + 1] = "danger-full-access".into();
    }
    Ok(args)
}

fn decode(kind: AgentKind, bytes: &[u8]) -> Result<Value> {
    if kind == AgentKind::Codewiz {
        return codewiz::decode(bytes);
    }
    if kind == AgentKind::ClaudeCode {
        let envelope: Value = match serde_json::from_slice(bytes) {
            Ok(value) => value,
            Err(_) => {
                let mut result = None;
                for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
                    let event: Value = serde_json::from_slice(line).map_err(invalid)?;
                    if event["type"] == "result" {
                        result = Some(event);
                    }
                }
                result.ok_or_else(|| invalid("Incomplete Claude stream"))?
            }
        };
        if envelope["is_error"].as_bool() == Some(true)
            || envelope["subtype"].as_str().is_some_and(|s| s != "success")
        {
            return Err(invalid("Claude did not return a successful result"));
        }
        if let Some(value) = envelope.get("structured_output") {
            return Ok(value.clone());
        }
        return envelope["result"]
            .as_str()
            .ok_or_else(|| invalid("Missing Claude structured result"))
            .and_then(|s| serde_json::from_str(s).map_err(invalid));
    }
    let mut result = None;
    let mut complete = false;
    for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
        let event: Value = serde_json::from_slice(line).map_err(invalid)?;
        match event["type"].as_str() {
            Some("turn.failed" | "error") => return Err(invalid("Codex analysis failed")),
            Some("turn.completed") => complete = true,
            Some("item.completed")
                if event["item"]["type"] == "error"
                    && event["item"]["message"].as_str().is_some_and(|message| {
                        message.contains("Code Mode is unavailable")
                            || message.contains("code-mode host")
                    }) =>
            {
                return Err(Error::new(
                    "AI_TOOL_UNAVAILABLE",
                    "Agent 读取工具不可用，请查看失败详情后重试。",
                    redact(event["item"]["message"].as_str().unwrap()),
                ));
            }
            Some("item.completed") if event["item"]["type"] == "agent_message" => {
                result = Some(
                    event["item"]["text"]
                        .as_str()
                        .ok_or_else(|| invalid("Missing final text"))?
                        .to_owned(),
                );
            }
            _ => (),
        }
    }
    if !complete {
        return Err(invalid("Incomplete Codex stream"));
    }
    serde_json::from_str(&result.ok_or_else(|| invalid("Missing Codex structured result"))?)
        .map_err(invalid)
}

fn missing_capabilities(kind: AgentKind, help: &str) -> Vec<&'static str> {
    let flags: &[&str] = match kind {
        AgentKind::Codewiz => &[
            "--format", "--pure", "--mcp", "--agent", "--model", "--title",
        ],
        AgentKind::Codex => &[
            "--ignore-user-config",
            "--ignore-rules",
            "--ephemeral",
            "--output-schema",
        ],
        AgentKind::ClaudeCode => &[
            "--safe-mode",
            "--tools",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--json-schema",
        ],
    };
    flags
        .iter()
        .copied()
        .filter(|flag| !help.contains(flag))
        .collect()
}
fn provider_name(kind: AgentKind) -> &'static str {
    kind.adapter().name
}

fn safe_failure_text(output: &process::Output) -> String {
    let mut lines = Vec::new();
    for line in output.stdout.split(|c| *c == b'\n') {
        if let Ok(value) = serde_json::from_slice::<Value>(line) {
            let message = if value["type"] == "result" {
                value["result"].as_str()
            } else if value["type"] == "turn.failed" {
                value["error"]["message"].as_str()
            } else if value["type"] == "error" {
                value["message"]
                    .as_str()
                    .or_else(|| value["error"]["data"]["message"].as_str())
                    .or_else(|| value["error"]["message"].as_str())
            } else {
                None
            };
            if let Some(message) = message {
                lines.extend(message.lines().map(str::to_owned));
            }
        }
    }
    lines.extend(
        String::from_utf8_lossy(&output.stderr)
            .lines()
            .filter(|line| {
                line.len() < 650
                    && !line.starts_with("WARNING: proceeding")
                    && !line.contains(" | ")
                    && !line.trim_start().starts_with("at ")
            })
            .map(str::to_owned),
    );
    let value = lines
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    redact(&value).chars().take(2000).collect()
}
pub(super) fn redact(text: &str) -> String {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    let patterns=PATTERNS.get_or_init(|| [
        r"\x1b\[[0-9;]*[A-Za-z]",
        r"sk-[A-Za-z0-9_-]+",
        r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
        r#"(?i)bearer\s+[^\s\"',;]+"#,
        r#"(?i)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie)[\"']?\s*[:=]\s*[\"']?[^\s\"',;}]+"#,
        r#"https?://[^\s/@]+:[^\s/@]+@[^\s]+"#,
    ].into_iter().map(|p|regex::Regex::new(p).expect("static redaction pattern")).collect());
    let mut safe = text.to_owned();
    for pattern in patterns {
        safe = pattern.replace_all(&safe, "[redacted]").into_owned();
    }
    safe.chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect()
}
fn agent_failure(kind: AgentKind, phase: &str, output: &process::Output) -> Error {
    let text = safe_failure_text(output);
    let lower = text.to_lowercase();
    let (code, message) = if lower.contains("not logged in")
        || lower.contains("authentication")
        || lower.contains("unauthorized")
        || lower.contains("401")
        || lower.contains("token expired")
        || lower.contains("invalid api key")
        || lower.contains("尚未登录")
        || lower.contains("登录已过期")
    {
        (
            "AI_AUTH_REQUIRED",
            "CLI 登录不可用，请在 Agent 设置中检查登录状态。",
        )
    } else if lower.contains("usage limit")
        || lower.contains("rate limit")
        || lower.contains("quota")
        || lower.contains("429")
        || lower.contains("credit balance")
    {
        (
            "AI_USAGE_LIMIT",
            "所选 Agent 的额度或速率已受限，请稍后重试或切换 Agent。",
        )
    } else if lower.contains("eperm")
        || lower.contains("permission denied")
        || lower.contains("operation not permitted")
    {
        (
            "AI_STARTUP_PERMISSION",
            "CLI 启动所需的文件或系统能力受限，请查看失败详情。",
        )
    } else if lower.contains("unknown feature")
        || lower.contains("unexpected argument")
        || lower.contains("unknown option")
        || lower.contains("unrecognized")
        || lower.contains("unknown model")
    {
        (
            "AI_CLI_CONFIGURATION",
            "CLI 参数或模型配置不兼容，请打开 Agent 设置检查。",
        )
    } else if lower.contains("connect")
        || lower.contains("network")
        || lower.contains("dns")
        || lower.contains("certificate")
    {
        ("AI_NETWORK", "CLI 无法连接服务，请检查网络或本机代理。")
    } else {
        (
            "AI_AGENT_FAILED",
            "Agent 未完成本次分析，请查看失败详情或打开 Agent 设置。",
        )
    };
    Error::new(
        code,
        message,
        format!(
            "Provider: {}\nPhase: {phase}\nExit code: {}\n{}",
            provider_name(kind),
            output.code,
            if text.is_empty() {
                "CLI 未返回可显示的错误信息。"
            } else {
                &text
            }
        ),
    )
}
pub(super) fn probe_program(program: &AgentProgram) -> Result<AgentProbeResult> {
    program.validate()?;
    let directory = tempfile::Builder::new()
        .prefix("proof-agent-check-")
        .tempdir()?;
    let root = fs::canonicalize(directory.path())?;
    let kind = program.kind;
    let execute = |args: &[&str]| -> Result<process::Output> {
        program.validate()?;
        let mut command = isolated_command(kind, &program.executable, &root)?;
        command.args(args);
        process::run_diff(command, None, Duration::from_secs(10), 256 * 1024)
    };
    let version = execute(&["--version"])?;
    if version.code != 0 {
        return Err(agent_failure(kind, "version check", &version));
    }
    let version = redact(&String::from_utf8_lossy(&version.stdout))
        .lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(120)
        .collect::<String>();
    let expected = match kind {
        AgentKind::Codex => version.starts_with("codex-cli "),
        AgentKind::ClaudeCode => version.contains("Claude Code"),
        AgentKind::Codewiz => {
            version.chars().next().is_some_and(|c| c.is_ascii_digit()) && version.contains('.')
        }
    };
    if !expected {
        return Err(unsupported(
            "所选程序没有返回预期的 Coding Agent 版本，请核对路径。",
        ));
    }
    program.validate()?;
    let help = help_output(kind, &program.executable, &root)?;
    if help.code != 0 {
        return Err(agent_failure(kind, "capability check", &help));
    }
    let missing = missing_capabilities(
        kind,
        &format!(
            "{}\n{}",
            String::from_utf8_lossy(&help.stdout),
            String::from_utf8_lossy(&help.stderr)
        ),
    );
    let compatible = missing.is_empty();
    if !compatible {
        return Ok(AgentProbeResult {
            provider: kind,
            executable_path: program.executable.clone(),
            version,
            compatible: false,
            authenticated: None,
            message: "CLI 缺少只读分析所需的能力。".into(),
            detail: format!(
                "Missing CLI options: {}。未发起模型请求。",
                missing.join(", ")
            ),
        });
    }
    if kind == AgentKind::Codewiz {
        program.validate()?;
        return Ok(AgentProbeResult {
            provider: kind, executable_path: program.executable.clone(), version, compatible,
            authenticated: codewiz::authenticated(&root),
            message: "Codewiz CLI 已找到。".into(),
            detail: "已检查 CLI 参数和本地登录文件。使用 ~/.config/codewiz 的模型配置；未调用模型或验证登录有效期。".into(),
        });
    }
    let login = execute(match kind {
        AgentKind::Codex => &["login", "status"],
        AgentKind::ClaudeCode => &["auth", "status", "--json"],
        AgentKind::Codewiz => unreachable!(),
    })?;
    let authenticated = match kind {
        AgentKind::Codex => {
            let all = format!(
                "{} {}",
                String::from_utf8_lossy(&login.stdout),
                String::from_utf8_lossy(&login.stderr)
            )
            .to_lowercase();
            if all.contains("logged in") && !all.contains("not logged in") {
                Some(true)
            } else if all.contains("not logged in") {
                Some(false)
            } else {
                None
            }
        }
        AgentKind::ClaudeCode => serde_json::from_slice::<Value>(&login.stdout)
            .ok()
            .and_then(|v| v["loggedIn"].as_bool()),
        AgentKind::Codewiz => unreachable!(),
    };
    let (message, detail) = match authenticated {
        Some(true) => (
            "CLI 已就绪，已检测到现有登录。".into(),
            "只检查程序、只读参数和本地登录状态；未调用模型，也未验证服务端额度。".into(),
        ),
        Some(false) => (
            "CLI 已找到，但当前没有可用登录。".into(),
            format!(
                "请在终端运行 {} login 后重新检测。",
                if kind == AgentKind::Codex {
                    "codex"
                } else {
                    "claude auth"
                }
            ),
        ),
        None => {
            let error = agent_failure(kind, "login check", &login);
            ("CLI 已找到，登录状态未能确认。".into(), error.detail)
        }
    };
    program.validate()?;
    Ok(AgentProbeResult {
        provider: kind,
        executable_path: program.executable.clone(),
        version,
        compatible,
        authenticated,
        message,
        detail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_retain_useful_details_without_tokens_and_do_not_blame_login_for_permissions() {
        let output=process::Output {code:1,stdout:Vec::new(),stderr:b"WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted\nError: failed to initialize in-process app-server client: Operation not permitted\nAuthorization: Bearer sk-secret-test\nrefresh_token=private-refresh\n".to_vec()};
        let error = agent_failure(AgentKind::Codex, "analysis", &output);
        assert_eq!(error.code, "AI_STARTUP_PERMISSION");
        assert!(error.detail.contains("initialize in-process app-server"));
        assert!(!error.detail.contains("sk-secret-test"));
        assert!(!error.detail.contains("private-refresh"));
        let quota=process::Output{code:1,stdout:b"{\"type\":\"turn.failed\",\"error\":{\"message\":\"You've hit your usage limit\"}}\n".to_vec(),stderr:Vec::new()};
        assert_eq!(
            agent_failure(AgentKind::Codex, "analysis", &quota).code,
            "AI_USAGE_LIMIT"
        );
        let login=process::Output{code:1,stdout:b"{\"type\":\"result\",\"is_error\":true,\"result\":\"Not logged in. Please run /login\"}\n".to_vec(),stderr:Vec::new()};
        assert_eq!(
            agent_failure(AgentKind::ClaudeCode, "analysis", &login).code,
            "AI_AUTH_REQUIRED"
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn codex_state_and_logs_are_owned_by_the_job_not_the_existing_session() {
        let root = Path::new("/tmp/proof runtime test");
        let args = arguments(AgentKind::Codex, root, &serde_json::json!({})).unwrap();
        assert!(args.contains(&"sqlite_home=\"/tmp/proof runtime test/state\"".to_owned()));
        assert!(args.contains(&"log_dir=\"/tmp/proof runtime test/logs\"".to_owned()));
        let command =
            isolated_command(AgentKind::ClaudeCode, Path::new("/bin/bash"), root).unwrap();
        assert!(command
            .get_envs()
            .any(|(k, v)| k == "CLAUDE_CODE_TMPDIR" && v == Some(root.as_os_str())));
    }
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Opt-in installed CLI capability/login check; no model inference"]
    fn installed_cli_login_probes_do_not_start_model_tasks() {
        let temp = tempfile::tempdir().unwrap();
        let proof = crate::Proof::open(temp.path()).unwrap();
        for kind in [AgentKind::Codex, AgentKind::ClaudeCode] {
            let result = proof
                .prepare_agent_probe(kind, AgentOptions::default())
                .unwrap()
                .run()
                .unwrap();
            assert!(result.compatible);
            assert!(!result.version.is_empty());
            println!(
                "{} {} authenticated={:?}",
                provider_name(kind),
                result.version,
                result.authenticated
            );
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Opt-in real Codex startup with OS-blocked IP networking; no inference"]
    fn installed_codex_initializes_its_runtime_inside_the_private_job_directory() {
        let executable = fs::canonicalize(locate(AgentKind::Codex).unwrap()).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let schema = serde_json::json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false});
        fs::write(
            root.join("schema.json"),
            serde_json::to_vec(&schema).unwrap(),
        )
        .unwrap();
        let base = isolated_command(AgentKind::Codex, &executable, &root).unwrap();
        let mut command = Command::new(base.get_program());
        command.env_clear().current_dir(&root);
        for (i, arg) in base.get_args().enumerate() {
            if i == 1 {
                command.arg(format!(
                    "{}(deny network-outbound (remote ip))",
                    arg.to_string_lossy()
                ));
            } else {
                command.arg(arg);
            }
        }
        for (key, value) in base.get_envs() {
            if let Some(value) = value {
                command.env(key, value);
            }
        }
        command.args(arguments(AgentKind::Codex, &root, &schema).unwrap());
        let output = process::run_diff(
            command,
            Some(b"Return JSON with ok true. No files to analyze."),
            Duration::from_secs(5),
            256 * 1024,
        );
        // The old implementation exited immediately before creating a runtime DB.
        if let Ok(output) = &output {
            assert!(!String::from_utf8_lossy(&output.stderr)
                .contains("failed to initialize in-process app-server client"));
        }
        assert!(
            root.join("state").is_dir(),
            "Real Codex never initialized the private state directory"
        );
        assert!(
            fs::read_dir(root.join("state"))
                .unwrap()
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().contains(".sqlite")),
            "No private state database was created"
        );
    }
    #[test]
    fn protocols_require_successful_completion_and_keep_only_the_final_message() {
        let stream = b"{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"I will review the patch\"}}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"ok\\\":true}\"}}\n{\"type\":\"turn.completed\"}\n";
        assert_eq!(decode(AgentKind::Codex, stream).unwrap()["ok"], true);
        assert!(decode(AgentKind::Codex, b"{\"type\":\"turn.failed\"}\n").is_err());
        assert!(decode(AgentKind::Codex, b"{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{}\"}}\n").is_err());
        assert!(decode(
            AgentKind::ClaudeCode,
            b"{\"is_error\":true,\"structured_output\":{}}"
        )
        .is_err());
        assert_eq!(decode(AgentKind::ClaudeCode, b"{\"type\":\"result\",\"subtype\":\"success\",\"structured_output\":{\"ok\":true}}").unwrap()["ok"], true);
    }
    #[test]
    fn invocation_enables_reading_without_resuming_sessions() {
        let root = Path::new("/tmp/proof-test");
        let schema = serde_json::json!({"type":"object"});
        let codex = arguments(AgentKind::Codex, root, &schema).unwrap();
        assert!(codex.windows(2).any(|p| p == ["--sandbox", "read-only"]));
        assert!(codex
            .windows(2)
            .any(|p| p == ["-c", "features.hooks=false"]));
        assert!(!codex.contains(&"--disable".into()));
        assert!(codex.contains(&"--ignore-user-config".into()));
        let claude = arguments(AgentKind::ClaudeCode, root, &schema).unwrap();
        assert!(claude
            .windows(2)
            .any(|p| p == ["--tools", "Read,Grep,Glob,Bash"]));
        assert!(!codex
            .iter()
            .any(|p| p == "features.shell_tool=false" || p == "features.unified_exec=false"));
        assert!(!codex
            .iter()
            .any(|p| p == "features.code_mode=false" || p == "features.code_mode_host=false"));
        assert!(claude.contains(&"--safe-mode".into()));
        assert!(claude.contains(&"--no-session-persistence".into()));
        for arg in codex.iter().chain(&claude) {
            assert!(![
                "resume",
                "--resume",
                "--continue",
                "--dangerously-skip-permissions",
                "--dangerously-bypass-approvals-and-sandbox"
            ]
            .contains(&arg.as_str()));
        }
    }

    #[test]
    fn code_mode_startup_failure_is_not_hidden_by_a_successful_turn() {
        let stream = b"{\"type\":\"item.completed\",\"item\":{\"type\":\"error\",\"message\":\"Code Mode is unavailable because code-mode host is disabled\"}}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"findings\\\":[]}\"}}\n{\"type\":\"turn.completed\"}\n";
        assert_eq!(
            decode(AgentKind::Codex, stream).unwrap_err().code,
            "AI_TOOL_UNAVAILABLE"
        );
    }

    #[cfg(unix)]
    #[test]
    fn companion_host_rejects_an_escaping_installation_link() {
        let temp = tempfile::tempdir().unwrap();
        let install = temp.path().join("install");
        fs::create_dir(&install).unwrap();
        let cli = install.join("codex");
        assert!(companion_host(&cli).unwrap().is_none());
        std::os::unix::fs::symlink("/bin/bash", install.join("codex-code-mode-host")).unwrap();
        assert!(companion_host(&cli).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn private_codex_runtime_links_login_but_cannot_write_shared_agent_data() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let shared = root.join("existing-agent");
        let job = root.join("job");
        fs::create_dir_all(shared.join("sessions")).unwrap();
        fs::create_dir(&job).unwrap();
        for name in [
            "auth.json",
            "installation_id",
            "config.toml",
            "sessions/existing.jsonl",
        ] {
            fs::write(shared.join(name), "fixture unchanged").unwrap();
        }
        let runtime = codex_runtime(&job, Some(&shared)).unwrap();
        assert!(fs::symlink_metadata(runtime.join("auth.json"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!runtime.join("installation_id").exists());
        let mut command = isolated_command(AgentKind::Codex, Path::new("/bin/bash"), &job).unwrap();
        command
            .arg("-c")
            .arg(
                r#"
            read -r login < "$CODEX_HOME/auth.json" || [ -n "$login" ] || exit 10
            [ "$login" = "fixture unchanged" ] || exit 11
            if printf changed > "$CODEX_HOME/auth.json"; then exit 12; fi
            for path in "$1/installation_id" "$1/config.toml" "$1/sessions/existing.jsonl"; do
                if printf changed > "$path"; then exit 13; fi
            done
            printf 'job identity' > "$CODEX_HOME/installation_id" || exit 14
        "#,
            )
            .arg("proof-runtime-check")
            .arg(&shared);
        let output = process::run_diff(command, None, Duration::from_secs(3), 4096).unwrap();
        assert_eq!(
            output.code,
            0,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read_to_string(runtime.join("installation_id")).unwrap(),
            "job identity"
        );
        for name in [
            "auth.json",
            "installation_id",
            "config.toml",
            "sessions/existing.jsonl",
        ] {
            assert_eq!(
                fs::read_to_string(shared.join(name)).unwrap(),
                "fixture unchanged"
            );
        }
        fs::remove_dir_all(&job).unwrap();
        assert!(shared.join("auth.json").is_file());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn both_providers_run_fresh_native_fixture_processes_with_stdin_and_json() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("agent.c");
        let binary = temp.path().join("agent");
        fs::write(&source, r#"
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
    for(int i=1;i<argc;i++) if(strcmp(argv[i],"--help")==0) {
        puts("--ignore-user-config --ignore-rules --ephemeral --output-schema --safe-mode --tools --strict-mcp-config --no-session-persistence --json-schema");return 0;
    }
    char input[4096]={0}; size_t n=fread(input,1,sizeof(input)-1,stdin); input[n]=0;
    if(strcmp(input,"failure")==0) {fputs("Authorization: Bearer sk-test-private-token",stderr);return 2;}
    if(strcmp(input,"read-only fixture request")!=0)return 4;
    if(strcmp(argv[1],"exec")==0) {
        puts("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"ok\\\":true}\"}}");
        puts("{\"type\":\"turn.completed\"}");
    } else puts("{\"type\":\"result\",\"subtype\":\"success\",\"structured_output\":{\"ok\":true}}");
    return 0;
}
"#).unwrap();
        assert!(Command::new("/usr/bin/cc")
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .status()
            .unwrap()
            .success());
        let binary = fs::canonicalize(binary).unwrap();
        for kind in [AgentKind::Codex, AgentKind::ClaudeCode] {
            let schema = serde_json::json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false});
            assert_eq!(
                run(
                    kind,
                    &binary,
                    "read-only fixture request",
                    &schema,
                    None,
                    || Ok(())
                )
                .unwrap()["ok"],
                true
            );
            let error = run(kind, &binary, "failure", &schema, None, || Ok(())).unwrap_err();
            assert_eq!(error.code, "AI_AGENT_FAILED");
            assert!(!format!("{error:?}").contains("sk-test-private-token"));
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_boundary_blocks_file_git_and_session_writes_and_foreign_signals() {
        let temp = tempfile::tempdir().unwrap();
        let protected = temp.path().join("protected");
        fs::create_dir_all(protected.join(".git")).unwrap();
        for name in ["code.txt", ".git/index", ".git/HEAD", "other-session.jsonl"] {
            fs::write(protected.join(name), "preserve").unwrap();
        }
        let output_root = temp.path().join("job");
        fs::create_dir(&output_root).unwrap();
        let output_root = fs::canonicalize(output_root).unwrap();
        let mut foreign = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut command =
            isolated_command(AgentKind::Codex, Path::new("/bin/bash"), &output_root).unwrap();
        command.args(["-c", "for name in code.txt .git/index .git/HEAD other-session.jsonl; do if (printf altered > \"$1/$name\"); then exit 9; fi; done; if kill -TERM \"$2\"; then exit 8; fi; printf safe", "proof-test"]).arg(&protected).arg(foreign.id().to_string());
        let result = process::run(command, None, Duration::from_secs(3)).unwrap();
        let still_alive = foreign.try_wait().unwrap().is_none();
        let _ = foreign.kill();
        let _ = foreign.wait();
        assert_eq!(
            result.code,
            0,
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(result.stdout, b"safe");
        assert!(still_alive);
        for name in ["code.txt", ".git/index", ".git/HEAD", "other-session.jsonl"] {
            assert_eq!(fs::read(protected.join(name)).unwrap(), b"preserve");
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn reading_tools_read_a_live_git_project_but_cannot_change_files_or_git() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let runtime = root.join("runtime");
        let snapshot = root.join("snapshot");
        fs::create_dir(&runtime).unwrap();
        fs::create_dir(&snapshot).unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("/usr/bin/git")
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .arg("-C")
                .arg(&snapshot)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        };
        git(&["init", "-b", "main"]);
        for path in ["code.txt", "other-session.jsonl"] {
            fs::write(snapshot.join(path), "preserve").unwrap();
        }
        git(&["add", "code.txt"]);
        git(&[
            "-c",
            "user.name=Proof",
            "-c",
            "user.email=proof@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "base",
        ]);
        fs::write(snapshot.join(".git/info/exclude"), "ignored-context.txt\n").unwrap();
        fs::write(
            snapshot.join("ignored-context.txt"),
            "complete project context",
        )
        .unwrap();
        let head = fs::read(snapshot.join(".git/HEAD")).unwrap();
        let index = fs::read(snapshot.join(".git/index")).unwrap();
        let mut command = reading_command(
            AgentKind::Codex,
            Path::new("/bin/bash"),
            &runtime,
            &snapshot,
        )
        .unwrap();
        command.args(["-c", "cat ignored-context.txt; git show HEAD:code.txt || exit 8; git status --short || exit 7; for path in code.txt .git/index .git/HEAD other-session.jsonl; do if printf changed > \"$path\"; then exit 9; fi; done; printf '\\nstream-ready\\n'; while :; do :; done"]);
        let cancel = crate::ReadCancellation::default();
        let mut streamed = Vec::new();
        let result = cancel.run(|| {
            process::run_observed(command, None, Duration::from_secs(3), &mut |bytes| {
                streamed.extend_from_slice(bytes);
                if String::from_utf8_lossy(&streamed).contains("stream-ready") {
                    cancel.cancel();
                }
            })
        });
        if let Ok(output) = &result {
            panic!(
                "Reading command exited before cancellation: {} {} {}",
                output.code,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        assert_eq!(result.err().unwrap().code, "READ_CANCELLED");
        assert!(String::from_utf8_lossy(&streamed).contains("preserve"));
        assert!(String::from_utf8_lossy(&streamed).contains("complete project context"));
        assert_eq!(fs::read(snapshot.join(".git/HEAD")).unwrap(), head);
        assert_eq!(fs::read(snapshot.join(".git/index")).unwrap(), index);
        for path in ["code.txt", "other-session.jsonl"] {
            assert_eq!(fs::read_to_string(snapshot.join(path)).unwrap(), "preserve");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn isolated_process_timeout_and_cancellation_do_not_hang() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let mut command =
            isolated_command(AgentKind::Codex, Path::new("/bin/bash"), &root).unwrap();
        command.args(["-c", "while :; do :; done"]);
        assert_eq!(
            process::run(command, None, Duration::from_millis(100))
                .err()
                .unwrap()
                .code,
            "PROCESS_TIMEOUT"
        );
        let cancellation = crate::ReadCancellation::default();
        let other = cancellation.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            other.cancel();
        });
        let mut command =
            isolated_command(AgentKind::Codex, Path::new("/bin/bash"), &root).unwrap();
        command.args(["-c", "while :; do :; done"]);
        let result = cancellation.run(|| process::run(command, None, Duration::from_secs(3)));
        worker.join().unwrap();
        assert_eq!(result.err().unwrap().code, "READ_CANCELLED");
    }
}
