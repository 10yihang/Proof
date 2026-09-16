//! Publish only the newly-created native session, never attach to another one.
use super::{events, provider, AgentKind};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub resume_command: String,
}

fn home(variable: &str, fallback: &str) -> Option<PathBuf> {
    std::env::var_os(variable)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(fallback)))
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn files(root: &Path, result: &mut Vec<PathBuf>) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            files(&entry.path(), result)?;
        } else if ty.is_file() && entry.path().extension().is_some_and(|s| s == "jsonl") {
            result.push(entry.path());
        }
    }
    Ok(())
}

/// Atomic, no-clobber publication. An existing session must never be replaced.
fn publish_file(source: &Path, destination: &Path, codex: bool) -> Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| super::invalid("Invalid session destination"))?;
    fs::create_dir_all(parent)?;
    let mut output = tempfile::NamedTempFile::new_in(parent)?;
    if codex {
        // The active run uses our outer read-only sandbox. A future ordinary
        // CLI resume must not inherit the inner sandbox bypass used by that run.
        for line in fs::read(source)?
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
        {
            let mut value: Value = serde_json::from_slice(line)?;
            if value["type"] == "turn_context" {
                value["payload"]["sandbox_policy"] = serde_json::json!({"type":"read-only"});
                value["payload"]["approval_policy"] = Value::String("on-request".into());
            }
            serde_json::to_writer(&mut output, &value)?;
            output.write_all(b"\n")?;
        }
    } else {
        std::io::copy(&mut fs::File::open(source)?, &mut output)?;
    }
    output.as_file().sync_all()?;
    output
        .persist_noclobber(destination)
        .map_err(|e| Error::from(e.error))?;
    Ok(())
}

fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
/// Codex's native list is indexed in SQLite. Copy only new thread rows using
/// columns present in both installed schemas; never update an existing ID.
fn index_codex(source: &Path, target: &Path, paths: &[(PathBuf, PathBuf)]) -> Result<()> {
    if !source.is_file() || !target.is_file() {
        return Ok(());
    }
    let mut db = rusqlite::Connection::open(target)?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute(
        "ATTACH DATABASE ? AS proof_session_source",
        [format!("file:{}?mode=ro", source.display())],
    )?;
    let source_columns = db
        .prepare("PRAGMA proof_session_source.table_info(threads)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let columns = db
        .prepare("PRAGMA main.table_info(threads)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|c| source_columns.contains(c))
        .collect::<Vec<_>>();
    if !["id", "rollout_path"]
        .iter()
        .all(|c| columns.iter().any(|v| v == c))
    {
        return Err(super::invalid("Unrecognized Codex session index"));
    }
    let names = columns
        .iter()
        .map(|c| ident(c))
        .collect::<Vec<_>>()
        .join(",");
    let values = columns
        .iter()
        .map(|c| match c.as_str() {
            "rollout_path" => "?2".into(),
            "sandbox_policy" => "'{\"type\":\"read-only\"}'".into(),
            "approval_mode" => "'on-request'".into(),
            // Sidebar/project IDs belong to the private runtime's database.
            "project_id" | "thread_section_id" | "section_position" | "section_entered_at_ms" => {
                "NULL".into()
            }
            _ => ident(c),
        })
        .collect::<Vec<_>>()
        .join(",");
    let tx = db.transaction()?;
    for (from, to) in paths {
        tx.execute(&format!("INSERT OR IGNORE INTO main.threads ({names}) SELECT {values} FROM proof_session_source.threads WHERE rollout_path=?1"), [from.to_string_lossy().as_ref(), to.to_string_lossy().as_ref()])?;
    }
    tx.commit()?;
    Ok(())
}

fn native_command(template: &Command, executable: &Path, extra_profile: &str) -> Command {
    let args = template.get_args().collect::<Vec<_>>();
    let mut command = Command::new(template.get_program());
    command
        .args([
            args[0].to_owned(),
            format!(
                "{}(deny network*){extra_profile}",
                args[1].to_string_lossy()
            )
            .into(),
        ])
        .arg(executable)
        .env_clear()
        .envs(template.get_envs().filter_map(|(k, v)| v.map(|v| (k, v))));
    if let Some(cwd) = template.get_current_dir() {
        command.current_dir(cwd);
    }
    command
}

pub(super) fn publish(
    kind: AgentKind,
    root: &Path,
    executable: &Path,
    project: &Path,
    template: &Command,
    stdout: &[u8],
) -> Result<Option<AgentSession>> {
    let id = stdout
        .split(|b| *b == b'\n')
        .filter_map(|line| events::parse_line(line).ok().flatten())
        .find_map(|value| {
            match kind {
                AgentKind::Codex if value["type"] == "thread.started" => {
                    value["thread_id"].as_str()
                }
                AgentKind::ClaudeCode => value["session_id"].as_str(),
                AgentKind::Codewiz => value["sessionID"].as_str(),
                _ => None,
            }
            .filter(|id| session_id(id))
            .map(str::to_owned)
        });
    let Some(id) = id else {
        return Ok(None);
    };
    match kind {
        AgentKind::Codex | AgentKind::ClaudeCode => {
            let (source, destination) = if kind == AgentKind::Codex {
                (
                    root.join("codex/sessions"),
                    home("CODEX_HOME", ".codex").map(|p| p.join("sessions")),
                )
            } else {
                (
                    root.join("claude/projects"),
                    home("CLAUDE_CONFIG_DIR", ".claude").map(|p| p.join("projects")),
                )
            };
            let destination =
                destination.ok_or_else(|| super::invalid("Missing Agent session directory"))?;
            publish_transcripts(kind, root, &source, &destination, &id)?;
        }
        AgentKind::Codewiz => {
            let target = home("XDG_DATA_HOME", ".local/share")
                .ok_or_else(|| super::invalid("Missing Codewiz data directory"))?;
            publish_codewiz(root, executable, template, &target, &id)?;
        }
    }
    let executable = quote(&executable.to_string_lossy());
    let resume = match kind {
        AgentKind::Codex => format!(
            "env CODEX_HOME={} {executable} --sandbox read-only --ask-for-approval on-request resume {}",
            quote(&home("CODEX_HOME", ".codex").ok_or_else(|| super::invalid("Missing Codex home"))?.to_string_lossy()), quote(&id)
        ),
        AgentKind::ClaudeCode => format!("env CLAUDE_CONFIG_DIR={} CLAUDE_SECURESTORAGE_CONFIG_DIR={} {executable} --resume {}",
            quote(&home("CLAUDE_CONFIG_DIR", ".claude").ok_or_else(|| super::invalid("Missing Claude home"))?.to_string_lossy()),
            quote(&std::env::var_os("CLAUDE_SECURESTORAGE_CONFIG_DIR").or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR")).unwrap_or_default().to_string_lossy()), quote(&id)),
        AgentKind::Codewiz => format!("env APP_NAME=codewiz XDG_DATA_HOME={} XDG_CONFIG_HOME={} {executable} --session {}",
            quote(&home("XDG_DATA_HOME", ".local/share").ok_or_else(|| super::invalid("Missing Codewiz data directory"))?.to_string_lossy()),
            quote(&home("XDG_CONFIG_HOME", ".config").ok_or_else(|| super::invalid("Missing Codewiz config directory"))?.to_string_lossy()), quote(&id)),
    };
    Ok(Some(AgentSession {
        id,
        resume_command: format!("cd {} && {resume}", quote(&project.to_string_lossy())),
    }))
}

pub(super) fn publish_transcripts(
    kind: AgentKind,
    root: &Path,
    source: &Path,
    destination: &Path,
    id: &str,
) -> Result<()> {
    let mut transcripts = Vec::new();
    files(source, &mut transcripts)?;
    let mut paths = Vec::new();
    for file in transcripts {
        if !file
            .file_name()
            .is_some_and(|name| name.to_string_lossy().contains(id))
        {
            continue;
        }
        let target = destination.join(file.strip_prefix(source).map_err(super::invalid)?);
        publish_file(&file, &target, kind == AgentKind::Codex)?;
        paths.push((file, target));
    }
    if paths.is_empty() {
        return Err(super::invalid(
            "Native Agent did not persist a session transcript",
        ));
    }
    if kind == AgentKind::Codex && root.join("state").is_dir() {
        for entry in fs::read_dir(root.join("state"))? {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && entry.file_name().to_string_lossy().starts_with("state_")
                && entry.path().extension().is_some_and(|v| v == "sqlite")
            {
                index_codex(
                    &entry.path(),
                    &destination.parent().unwrap().join(entry.file_name()),
                    &paths,
                )?;
            }
        }
    }
    Ok(())
}

pub(super) fn publish_codewiz(
    root: &Path,
    executable: &Path,
    template: &Command,
    data: &Path,
    id: &str,
) -> Result<()> {
    let mut export = native_command(template, executable, "");
    export.args(["export", id]);
    let output = crate::process::run_file_observed(
        export,
        None,
        Some(Duration::from_secs(15)),
        32 * 1024 * 1024,
        None,
        &root.join(format!("session-export-{}.json", uuid::Uuid::new_v4())),
    )?;
    if output.code != 0 {
        return Err(super::invalid("Codewiz session export failed"));
    }
    let mut value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| super::invalid("Invalid Codewiz session export"))?;
    if value["info"]["id"] != id {
        return Err(super::invalid("Codewiz exported a different session"));
    }
    // Proof's Bash permission relies on the outer read-only sandbox. Ordinary
    // CLI continuation must use the user's normal permission rules instead.
    value["info"]["permission"] = serde_json::json!([]);
    let file = root.join("session-export.json");
    fs::write(&file, serde_json::to_vec(&value)?)?;
    let directory = data.join("codewiz");
    fs::create_dir_all(&directory)?;
    let db_path = directory.join("opencode.db");
    if db_path.exists() {
        let db = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let has_sessions: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='session')",
            [],
            |r| r.get(0),
        )?;
        let exists = has_sessions
            && db.query_row(
                "SELECT EXISTS(SELECT 1 FROM session WHERE id=?)",
                [id],
                |r| r.get::<_, bool>(0),
            )?;
        if exists {
            return Err(super::invalid(
                "Refusing to replace an existing Codewiz session",
            ));
        }
    }
    let mut allowed = String::from("(allow file-write*");
    for name in [
        "opencode.db",
        "opencode.db-wal",
        "opencode.db-shm",
        "opencode.db-journal",
    ] {
        allowed.push_str(&format!(
            " (literal {})",
            serde_json::to_string(&directory.join(name).to_string_lossy())?
        ));
    }
    allowed.push(')');
    // Initialization logs/cache stay private; only the CLI's session database
    // is shared. SQLite handles concurrent terminal writers transactionally.
    if !db_path.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&db_path)?;
        }
    }
    let import_data = root.join(format!("session-import-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(import_data.join("codewiz"))?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(&db_path, import_data.join("codewiz/opencode.db"))?;
    let mut import = native_command(template, executable, &allowed);
    import
        .args(["import"])
        .arg(&file)
        .env("XDG_DATA_HOME", &import_data);
    let output = crate::process::run_diff(import, None, Duration::from_secs(15), 256 * 1024)?;
    if output.code != 0 {
        return Err(super::invalid(format!(
            "Codewiz session import failed: {}",
            provider::redact(&String::from_utf8_lossy(&output.stderr))
        )));
    }
    let db =
        rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if !db.query_row(
        "SELECT EXISTS(SELECT 1 FROM session WHERE id=?)",
        [id],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(super::invalid("Codewiz session import was not persisted"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transcripts_publish_without_replacing_existing_sessions_or_copying_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("claude/projects/repo");
        let target = temp.path().join("user/projects");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(target.join("repo")).unwrap();
        fs::write(
            source.join("new-session.jsonl"),
            "{\"sessionId\":\"new-session\"}\n",
        )
        .unwrap();
        fs::write(source.join(".credentials.json"), "private-token").unwrap();
        fs::write(target.join("repo/existing.jsonl"), "unchanged").unwrap();
        publish_transcripts(
            AgentKind::ClaudeCode,
            temp.path(),
            source.parent().unwrap(),
            &target,
            "new-session",
        )
        .unwrap();
        assert!(target.join("repo/new-session.jsonl").is_file());
        assert!(!target.join("repo/.credentials.json").exists());
        assert_eq!(
            fs::read_to_string(target.join("repo/existing.jsonl")).unwrap(),
            "unchanged"
        );
        assert!(publish_transcripts(
            AgentKind::ClaudeCode,
            temp.path(),
            source.parent().unwrap(),
            &target,
            "new-session"
        )
        .is_err());
    }
}
