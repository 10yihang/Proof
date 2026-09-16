//! Proof's active Agent preferences. Never edits the CLI's own configuration.
use super::{provider, AgentKind, AgentProgram, AgentProviderInfo};
use crate::{Error, Proof, Result};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
const KEY: &str = "ai:settings";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct AgentPrompts {
    pub grouping: String,
    pub review: String,
    pub commit: String,
}
impl AgentPrompts {
    pub(super) fn for_task(&self, task: super::AiTask) -> &str {
        match task {
            super::AiTask::Grouping => &self.grouping,
            super::AiTask::Review => &self.review,
            super::AiTask::Commit => &self.commit,
        }
    }
    fn clean(&mut self) -> Result<()> {
        for value in [&mut self.grouping, &mut self.review, &mut self.commit] {
            *value = value.trim().to_owned();
            if value.len() > 16_000
                || value
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            {
                return Err(Error::new(
                    "AI_PROMPT_INVALID",
                    "自定义 Prompt 过长或包含无效字符。",
                    "Prompts support up to 16,000 UTF-8 bytes per task",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentOptions {
    pub executable_path: Option<String>,
    pub model: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSettings {
    pub revision: u64,
    pub default_provider: AgentKind,
    pub codex: AgentOptions,
    pub claude_code: AgentOptions,
    #[serde(default)]
    pub codewiz: AgentOptions,
    #[serde(default)]
    pub prompts: AgentPrompts,
}
impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            revision: 0,
            default_provider: AgentKind::Codex,
            codex: AgentOptions::default(),
            claude_code: AgentOptions::default(),
            codewiz: AgentOptions::default(),
            prompts: AgentPrompts::default(),
        }
    }
}
impl AgentSettings {
    pub fn options(&self, kind: AgentKind) -> &AgentOptions {
        match kind {
            AgentKind::Codex => &self.codex,
            AgentKind::ClaudeCode => &self.claude_code,
            AgentKind::Codewiz => &self.codewiz,
        }
    }
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSettingsUpdate {
    pub expected_revision: u64,
    pub default_provider: AgentKind,
    pub codex: AgentOptions,
    pub claude_code: AgentOptions,
    #[serde(default)]
    pub codewiz: Option<AgentOptions>,
    #[serde(default)]
    pub prompts: Option<AgentPrompts>,
}
pub(super) fn read(store: &crate::store::Store) -> Result<AgentSettings> {
    read_connection(&store.connection)
}
fn read_connection(connection: &rusqlite::Connection) -> Result<AgentSettings> {
    let raw: Option<String> = connection
        .query_row("SELECT value FROM settings WHERE key=?", [KEY], |row| {
            row.get(0)
        })
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Error::from))
        .transpose()
        .map(Option::unwrap_or_default)
}
fn clean(options: &mut AgentOptions) -> Result<()> {
    for value in [&mut options.executable_path, &mut options.model] {
        *value = value
            .take()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
    }
    if options.model.as_ref().is_some_and(|s| {
        s.len() > 160
            || s.starts_with('-')
            || s.chars().any(char::is_whitespace)
            || s.chars().any(char::is_control)
    }) {
        return Err(Error::new(
            "AI_MODEL_INVALID",
            "请输入 CLI 支持的模型名称，或留空使用默认模型。",
            "Invalid model identifier",
        ));
    }
    if let Some(path) = &options.executable_path {
        if path.len() > 4096 || !Path::new(path).is_absolute() || path.chars().any(char::is_control)
        {
            return Err(Error::new(
                "AI_PROGRAM_PATH",
                "请填写 CLI 程序的完整路径。",
                "Expected an absolute executable path",
            ));
        }
    }
    Ok(())
}
impl Proof {
    pub fn agent_settings(&self) -> Result<AgentSettings> {
        read(&self.store)
    }
    pub fn agent_providers(&self) -> Result<Vec<AgentProviderInfo>> {
        let settings = self.agent_settings()?;
        Ok(provider::provider_information(&settings))
    }
    pub fn set_agent_settings(&self, mut update: AgentSettingsUpdate) -> Result<AgentSettings> {
        if let Some(prompts) = &mut update.prompts {
            prompts.clean()?;
        }
        clean(&mut update.codex)?;
        clean(&mut update.claude_code)?;
        if let Some(options) = &mut update.codewiz {
            clean(options)?;
        }
        for kind in [AgentKind::Codex, AgentKind::ClaudeCode, AgentKind::Codewiz] {
            let options = match kind {
                AgentKind::Codex => &update.codex,
                AgentKind::ClaudeCode => &update.claude_code,
                AgentKind::Codewiz => match &update.codewiz {
                    Some(options) => options,
                    None => continue,
                },
            };
            if options.executable_path.is_some() {
                AgentProgram::configured(
                    kind,
                    &self.data_dir,
                    None,
                    self.cached_data_epoch,
                    options,
                )?;
            }
        }
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        let previous = read_connection(&tx)?;
        if previous.revision != update.expected_revision {
            return Err(Error::new(
                "AI_SETTINGS_CHANGED",
                "Agent 设置已在其他窗口更新，请重新读取。",
                "Agent settings revision mismatch",
            ));
        }
        let value = AgentSettings {
            revision: update.expected_revision.checked_add(1).ok_or_else(|| {
                Error::new("AI_SETTINGS_CHANGED", "设置版本无效。", "Revision overflow")
            })?,
            default_provider: update.default_provider,
            codex: update.codex,
            claude_code: update.claude_code,
            codewiz: update.codewiz.unwrap_or(previous.codewiz),
            prompts: update.prompts.unwrap_or(previous.prompts),
        };
        tx.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[KEY,&serde_json::to_string(&value)?])?;
        tx.commit()?;
        Ok(value)
    }
    pub fn prepare_agent_probe(
        &self,
        kind: AgentKind,
        mut options: AgentOptions,
    ) -> Result<AgentProbe> {
        clean(&mut options)?;
        let program =
            AgentProgram::configured(kind, &self.data_dir, None, self.cached_data_epoch, &options)?;
        Ok(AgentProbe { program })
    }
}
pub struct AgentProbe {
    pub(super) program: AgentProgram,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProbeResult {
    pub provider: AgentKind,
    pub executable_path: PathBuf,
    pub version: String,
    pub compatible: bool,
    pub authenticated: Option<bool>,
    pub message: String,
    pub detail: String,
}
impl AgentProbe {
    pub fn run(self) -> Result<AgentProbeResult> {
        provider::probe_program(&self.program)
    }
}
