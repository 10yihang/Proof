//! Codewiz's OpenCode-compatible CLI. Its runtime is private to one Proof task;
//! only model configuration and a copy of existing login credentials are reused.
use super::{invalid, provider::unsupported};
use crate::{Error, Result};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

const CONFIG_LIMIT: u64 = 2 * 1024 * 1024;

pub(super) fn config_directory() -> Option<PathBuf> {
    xdg("XDG_CONFIG_HOME", ".config").map(|p| p.join("codewiz"))
}
fn xdg(key: &str, fallback: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(fallback)))
}

/// npm's JS launcher needs Node and starts a separate process monitor. Resolve
/// only the platform binary of that exact @xhs/codewiz installation instead.
pub(super) fn native_program(wrapper: &Path) -> Result<Option<PathBuf>> {
    if wrapper.file_name().and_then(|s| s.to_str()) != Some("codewiz") {
        return Ok(None);
    }
    let Some(package) = wrapper.parent().and_then(Path::parent) else {
        return Ok(None);
    };
    let manifest = package.join("package.json");
    let Some(bytes) = read_optional(&manifest)? else {
        return Ok(None);
    };
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if value["name"] != "@xhs/codewiz" {
        return Ok(None);
    }
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    let name = format!("codewiz-{platform}-{arch}");
    for parent in package.ancestors() {
        for candidate in [&name, &format!("{name}-baseline")] {
            let path = parent
                .join("node_modules/@xhs")
                .join(candidate)
                .join(if cfg!(windows) {
                    "bin/opencode.exe"
                } else {
                    "bin/opencode"
                });
            if path.is_file() {
                return Ok(Some(path));
            }
        }
    }
    Err(unsupported(
        "Codewiz 安装不完整，请重新安装 CLI 或选择其原生可执行文件。",
    ))
}

/// Discover stable Node-manager installations, never transient shell PATHs or
/// repository-local node_modules. Explicit settings still take precedence.
pub(super) fn installation_roots(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for (parent, suffix) in [
        (
            home.join(".local/share/fnm/node-versions"),
            "installation/bin",
        ),
        (
            home.join("Library/Application Support/fnm/node-versions"),
            "installation/bin",
        ),
        (home.join(".nvm/versions/node"), "bin"),
    ] {
        let mut versions: Vec<_> = fs::read_dir(parent)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|p| p.is_dir())
            .collect();
        versions.sort_by_key(|p| {
            p.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .trim_start_matches('v')
                .split('.')
                .map(|v| v.parse::<u64>().unwrap_or(0))
                .collect::<Vec<_>>()
        });
        roots.extend(versions.into_iter().rev().map(|path| path.join(suffix)));
    }
    roots.push(home.join(".volta/bin"));
    roots
}

fn config_error() -> Error {
    Error::new(
        "AI_CLI_CONFIGURATION",
        "无法读取 Codewiz 配置，请检查 ~/.config/codewiz 中的 JSON / JSONC 文件。",
        "Invalid Codewiz configuration; file contents are withheld",
    )
}
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(config_error()),
    };
    let metadata = file.metadata().map_err(|_| config_error())?;
    if !metadata.is_file() || metadata.len() > CONFIG_LIMIT {
        return Err(config_error());
    }
    let mut bytes = Vec::new();
    file.take(CONFIG_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| config_error())?;
    if bytes.len() as u64 > CONFIG_LIMIT {
        return Err(config_error());
    }
    Ok(Some(bytes))
}
fn merge(target: &mut Value, source: Value) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        for (key, value) in source {
            merge(
                target.entry(key.clone()).or_insert(Value::Null),
                value.clone(),
            );
        }
    } else {
        *target = source;
    }
}

fn model_config(directory: &Path) -> Result<Value> {
    let mut config = json!({});
    for name in ["config.json", "codewiz.json", "codewiz.jsonc"] {
        if let Some(bytes) = read_optional(&directory.join(name))? {
            let text = std::str::from_utf8(&bytes).map_err(|_| config_error())?;
            let value: Value = jsonc_parser::parse_to_serde_value(text, &Default::default())
                .map_err(|_| config_error())?;
            if !value.is_object() {
                return Err(config_error());
            }
            // Do not import MCP servers, plugins, hooks, custom agents, commands,
            // instructions, permissions or tools into an active read-only task.
            for key in [
                "provider",
                "model",
                "small_model",
                "enabled_providers",
                "disabled_providers",
            ] {
                if let Some(value) = value.get(key) {
                    merge(&mut config[key], value.clone());
                }
            }
        }
    }
    // Keep CLI-supported {file:...} references relative to their original config.
    fn rebase(value: &mut Value, directory: &Path) {
        match value {
            Value::String(text) => {
                let pattern = regex::Regex::new(r"\{file:([^}]+)\}").unwrap();
                *text = pattern
                    .replace_all(text, |captures: &regex::Captures| {
                        let path = &captures[1];
                        if Path::new(path).is_absolute() || path.starts_with("~/") {
                            captures[0].to_owned()
                        } else {
                            format!("{{file:{}}}", directory.join(path).display())
                        }
                    })
                    .into_owned();
            }
            Value::Array(values) => {
                for value in values {
                    rebase(value, directory);
                }
            }
            Value::Object(values) => {
                for value in values.values_mut() {
                    rebase(value, directory);
                }
            }
            _ => (),
        }
    }
    rebase(&mut config, directory);
    Ok(config)
}

fn policy(reading: bool) -> Value {
    let access = if reading { "allow" } else { "deny" };
    json!({"*":"deny", "read": access, "glob": access, "grep": access, "list": access, "bash": access})
}

/// Permit only this task's auxiliary evidence outside the project. Writes
/// remain forbidden by the OS sandbox, including inside the evidence directory.
pub(super) fn allow_evidence(command: &mut Command, runtime: &Path, evidence: &Path) -> Result<()> {
    let evidence = fs::canonicalize(evidence)?;
    let pattern = format!("{}/**", evidence.display());
    if evidence
        .to_string_lossy()
        .contains(['*', '?', '[', ']', '{', '}'])
    {
        return Err(unsupported("分析范围目录无法安全授权。"));
    }
    let mut permission = policy(true);
    permission["external_directory"] = json!({"*":"deny", pattern: "allow"});
    let path = runtime.join("config/codewiz/codewiz.json");
    let mut settings: Value =
        serde_json::from_slice(&fs::read(&path)?).map_err(|_| config_error())?;
    settings["permission"] = permission.clone();
    settings["agent"]["proof"]["permission"] = permission.clone();
    write_private(&path, &serde_json::to_vec(&settings)?)?;
    command.env("OPENCODE_PERMISSION", permission.to_string());
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn configure(command: &mut Command, runtime: &Path, reading: bool) -> Result<()> {
    configure_from(
        command,
        runtime,
        reading,
        config_directory().as_deref(),
        xdg("XDG_DATA_HOME", ".local/share")
            .map(|p| p.join("codewiz"))
            .as_deref(),
        xdg("XDG_STATE_HOME", ".local/state")
            .map(|p| p.join("codewiz"))
            .as_deref(),
    )
}

#[cfg(any(test, target_os = "macos"))]
pub(super) fn configure_from(
    command: &mut Command,
    runtime: &Path,
    reading: bool,
    config: Option<&Path>,
    login: Option<&Path>,
    state: Option<&Path>,
) -> Result<()> {
    let mut settings = config
        .map(model_config)
        .transpose()?
        .unwrap_or_else(|| json!({}));
    // Copy only environment variables explicitly used by model configuration.
    // Runtime controls and executable search paths always remain Proof-owned.
    let pattern = regex::Regex::new(r"\{env:([A-Za-z_][A-Za-z0-9_]*)\}").unwrap();
    for captures in pattern.captures_iter(&settings.to_string()) {
        let key = &captures[1];
        if !["OPENCODE_", "CODEX_", "CLAUDE_", "XDG_", "DYLD_", "LD_"]
            .iter()
            .any(|prefix| key.starts_with(prefix))
            && ![
                "HOME",
                "PATH",
                "TMPDIR",
                "APP_NAME",
                "NODE_OPTIONS",
                "BUN_OPTIONS",
            ]
            .contains(&key)
        {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    merge(
        &mut settings,
        json!({
            "$schema": "https://opencode.ai/config.json",
            "autoupdate": false, "share": "disabled", "snapshot": false,
            "plugin": [], "mcp": {}, "instructions": [], "lsp": false, "formatter": false,
            "permission": policy(reading),
            "agent": {"proof": {"description":"Read-only Proof analysis", "mode":"primary", "permission": policy(reading)}},
            "default_agent": "proof"
        }),
    );
    for part in ["config", "data", "state", "cache", "home"] {
        fs::create_dir_all(runtime.join(part).join("codewiz"))?;
    }
    for (source, destination) in [
        (
            login.map(|p| p.join("auth.json")),
            runtime.join("data/codewiz/auth.json"),
        ),
        (
            state.map(|p| p.join("model.json")),
            runtime.join("state/codewiz/model.json"),
        ),
    ] {
        if !destination.exists() {
            if let Some(source) = source {
                if let Some(bytes) = read_optional(&source)? {
                    // Validate without ever rendering credential values in errors.
                    let value: Value =
                        serde_json::from_slice(&bytes).map_err(|_| config_error())?;
                    if !value.is_object() {
                        return Err(config_error());
                    }
                    write_private(&destination, &bytes)?;
                }
            }
        }
    }
    // Codewiz scans and kills orphaned MCP processes at startup even with
    // --no-mcp. Proof owns no MCP children: expose that empty inventory only for
    // this exact cleanup query. macOS refuses setuid /bin/ps inside Seatbelt.
    // All other process-enumeration requests fail explicitly. Signal denials
    // remain in force even if a future CLI changes its cleanup implementation.
    fs::create_dir_all(runtime.join("bin"))?;
    let ps = runtime.join("bin/ps");
    write_private(&ps, b"#!/bin/sh\nif [ \"$#\" -eq 2 ] && [ \"$1\" = '-eo' ] && [ \"$2\" = 'pid,ppid,etime,command' ]; then\n  printf 'PID PPID ELAPSED COMMAND\\n'\nelse\n  printf 'Process enumeration is unavailable in Proof analysis.\\n' >&2\n  exit 1\nfi\n")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&ps, fs::Permissions::from_mode(0o700))?;
    }
    write_private(
        &runtime.join("config/codewiz/codewiz.json"),
        &serde_json::to_vec(&settings)?,
    )?;
    for part in ["CONFIG", "DATA", "STATE", "CACHE"] {
        command.env(
            format!("XDG_{part}_HOME"),
            runtime.join(part.to_lowercase()),
        );
    }
    command
        .env("APP_NAME", "codewiz")
        .env("PATH", format!("{}:/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Applications/Codex.app/Contents/Resources:/Applications/ChatGPT.app/Contents/Resources", runtime.join("bin").display()))
        .env("OPENCODE_TEST_HOME", runtime.join("home"))
        .env("OPENCODE_CONFIG_CONTENT", "{}")
        .env("OPENCODE_PERMISSION", policy(reading).to_string());
    for flag in [
        "OPENCODE_PURE",
        "OPENCODE_DISABLE_DEFAULT_PLUGINS",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_AUTOUPDATE",
        "OPENCODE_DISABLE_SHARE",
        "OPENCODE_DISABLE_MODELS_FETCH",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS",
        "OPENCODE_DISABLE_CLAUDE_CODE",
        "OPENCODE_DISABLE_LSP_DOWNLOAD",
        "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER",
        "OPENCODE_DISABLE_FFF",
    ] {
        command.env(flag, "true");
    }
    Ok(())
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)?.write_all(bytes)?;
    Ok(())
}

pub(super) fn arguments() -> Vec<String> {
    [
        "run",
        "--format",
        "json",
        "--pure",
        "--no-mcp",
        "--agent",
        "proof",
        "--title",
        "Proof analysis",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

#[cfg(target_os = "macos")]
pub(super) fn startup_profile(runtime: &Path) -> Result<String> {
    Ok(format!(
        "(allow process-exec (literal {})(literal \"/bin/sh\")(literal \"/bin/bash\"))",
        serde_json::to_string(&runtime.join("bin/ps").to_string_lossy())?
    ))
}
pub(super) fn prompt(prompt: &str, schema: &Value) -> String {
    format!("{prompt}\n\nReturn exactly one JSON object matching the following schema in your FINAL text response. No Markdown fences or prose outside JSON. Never represent a blocked analysis as a successful empty result.\n{schema}")
}
pub(super) fn decode(bytes: &[u8]) -> Result<Value> {
    let mut text = None;
    let mut finished = false;
    for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
        let event: Value =
            serde_json::from_slice(line).map_err(|_| invalid("Invalid Codewiz event"))?;
        match event["type"].as_str() {
            Some("error") => return Err(invalid("Codewiz analysis failed")),
            Some("step_start") => {
                finished = false;
                text = None;
            }
            Some("text") => text = event["part"]["text"].as_str().map(str::to_owned),
            Some("step_finish") => finished = event["part"]["reason"] == "stop",
            _ => (),
        }
    }
    if !finished {
        return Err(invalid("Incomplete Codewiz stream"));
    }
    let text = text.ok_or_else(|| invalid("Missing Codewiz structured result"))?;
    let text = text.trim();
    let text = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .and_then(|s| s.strip_suffix("```"))
        .unwrap_or(text)
        .trim();
    serde_json::from_str(text).map_err(|_| invalid("Invalid Codewiz structured result"))
}

pub(super) fn authenticated(runtime: &Path) -> Option<bool> {
    let bytes = fs::read(runtime.join("data/codewiz/auth.json")).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    // Local credential presence only; no auth command that might start a login
    // flow, contact the company gateway, or refresh a user's shared session.
    Some(
        value
            .as_object()?
            .values()
            .any(|entry| match entry["type"].as_str() {
                Some("wellknown") => entry["token"].as_str().is_some_and(|s| !s.is_empty()),
                Some("api") => entry["key"].as_str().is_some_and(|s| !s.is_empty()),
                Some("oauth") => entry["access"].as_str().is_some_and(|s| !s.is_empty()),
                _ => false,
            }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copies_only_model_configuration_and_isolates_login_and_session_state() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config");
        let login = root.path().join("login");
        let runtime = root.path().join("runtime");
        for path in [&config, &login, &runtime] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(config.join("codewiz.jsonc"), r#"{
          // User extensions must never run in Proof.
          "model": "company/model",
          "provider": {"company":{"options":{"apiKey":"{env:CODEWIZ_API_TOKEN}","baseURL":"https://example.invalid/v1"}}},
          "mcp":{"private":{"command":["sh","-c","touch outside"],"token":"private-mcp-token"}},
          "plugin":["private-plugin"], "instructions":["private-instructions"],
          "agent":{"build":{"permission":"allow"}},
        }"#).unwrap();
        let auth = br#"{"company":{"type":"wellknown","key":"CODEWIZ_API_TOKEN","token":"synthetic-login"}}"#;
        fs::write(login.join("auth.json"), auth).unwrap();
        let mut command = Command::new("unused");
        configure_from(
            &mut command,
            &runtime,
            true,
            Some(&config),
            Some(&login),
            None,
        )
        .unwrap();
        let private = fs::read_to_string(runtime.join("config/codewiz/codewiz.json")).unwrap();
        let value: Value = serde_json::from_str(&private).unwrap();
        assert_eq!(value["model"], "company/model");
        assert_eq!(value["permission"]["*"], "deny");
        assert_eq!(value["permission"]["read"], "allow");
        assert!(
            !private.contains("private-mcp-token")
                && !private.contains("private-plugin")
                && !private.contains("private-instructions")
        );
        assert_eq!(authenticated(&runtime), Some(true));
        fs::write(runtime.join("data/codewiz/auth.json"), b"{}").unwrap();
        assert_eq!(fs::read(login.join("auth.json")).unwrap(), auth);
        assert!(!login.join("opencode.db").exists());
    }
    #[test]
    fn rejects_incomplete_failed_and_nonfinal_json() {
        let complete = b"{\"type\":\"step_start\"}\n{\"type\":\"text\",\"part\":{\"text\":\"{\\\"ok\\\":true}\"}}\n{\"type\":\"step_finish\",\"part\":{\"reason\":\"stop\"}}\n";
        assert_eq!(decode(complete).unwrap()["ok"], true);
        for reason in ["tool-calls", "length", "error"] {
            assert!(decode(
                String::from_utf8_lossy(complete)
                    .replace("stop", reason)
                    .as_bytes()
            )
            .is_err());
        }
        let mut failed = complete.to_vec();
        failed.extend_from_slice(b"{\"type\":\"error\"}\n");
        assert!(decode(&failed).is_err());
        assert!(decode(b"{\"type\":\"text\",\"part\":{\"text\":\"{}\"}}\n").is_err());
    }
    #[test]
    fn configuration_errors_do_not_echo_credentials() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("codewiz.jsonc"),
            "{\"apiKey\":\"private-token\" oops}",
        )
        .unwrap();
        let error = model_config(root.path()).unwrap_err();
        assert!(!error.detail.contains("private-token"));
    }
}
