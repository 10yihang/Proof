use crate::{fingerprint, now, Error, Proof, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path},
};

pub const OBSERVER_ADAPTER_VERSION: &str = "1";
pub const OBSERVER_INPUT_LIMIT: usize = 2 * 1024 * 1024;
pub const OBSERVER_TEXT_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObserverAgent {
    Codex,
    Claude,
}
impl ObserverAgent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverInstallation {
    pub id: String,
    pub agent: ObserverAgent,
    pub agent_version: String,
    pub adapter_version: String,
    pub state: String,
    pub created_at: u64,
    pub last_event_at: Option<u64>,
}
/// Deliberately not Serialize: only the native installer may write this value to
/// its mode-0600 registration file. It is not a frontend or diagnostics object.
pub struct ObserverRegistrationSecret {
    pub installation: ObserverInstallation,
    pub token: String,
}

pub struct ObserverInput<'a> {
    pub installation_id: &'a str,
    pub token: &'a str,
    pub agent: ObserverAgent,
    pub agent_version: &'a str,
    pub payload: &'a [u8],
    pub bridge_started_at: u64,
    /// Supplied by the native collector from its private GUI lease, never from
    /// hook input. Background-authorized workspaces do not require this lease.
    pub foreground_lease_until: Option<u64>,
    pub received_policy_revision: u64,
    pub received_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverConsent {
    pub installation_id: String,
    pub workspace_id: String,
    pub enabled: bool,
    pub prompt: bool,
    pub command: bool,
    pub reply: bool,
    pub output: bool,
    pub background: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverEvent {
    pub id: String,
    pub id_origin: String,
    pub workspace_id: String,
    pub installation_id: String,
    pub session_id: String,
    pub native_session_id: Option<String>,
    pub native_agent_id: Option<String>,
    pub native_event_key: Option<String>,
    pub turn_id: Option<String>,
    pub agent: ObserverAgent,
    pub kind: String,
    pub source_at: Option<u64>,
    pub received_at: u64,
    pub bridge_started_at: u64,
    pub tool_name: Option<String>,
    pub tool_ref: Option<String>,
    pub paths: Vec<String>,
    pub prompt: Option<String>,
    pub command: Option<String>,
    pub reply: Option<String>,
    pub output: Option<String>,
    pub exit_code: Option<i32>,
    pub command_state: String,
    pub validation_state: String,
    pub version_relation: String,
    pub matched_content_hashes: BTreeMap<String, String>,
    pub field_status: BTreeMap<String, String>,
    pub possibly_duplicate: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverGap {
    pub id: String,
    pub installation_id: Option<String>,
    pub workspace_id: Option<String>,
    pub code: String,
    pub count: Option<u64>,
    pub started_at: u64,
    pub ended_at: Option<u64>,
}

impl Proof {
    pub fn observer_policy_revision(&self) -> Result<u64> {
        Ok(self.store.connection.query_row(
            "SELECT CAST(value AS INTEGER) FROM settings WHERE key='observer_revision'",
            [],
            |r| r.get(0),
        )?)
    }
    /// Creates transport identity only. It does not install hooks, grant a
    /// workspace, launch an Agent, or mark a CLI combination as runtime-verified.
    pub fn create_observer_registration(
        &self,
        agent: ObserverAgent,
        version: &str,
    ) -> Result<ObserverRegistrationSecret> {
        let secret = Self::new_observer_registration(agent, version)?;
        let installation = &secret.installation;
        let token = &secret.token;
        self.store.connection.execute(
            "INSERT INTO observer_installations VALUES(?,?,?,?,?,?,?,NULL)",
            params![
                installation.id,
                agent.as_str(),
                version,
                OBSERVER_ADAPTER_VERSION,
                fingerprint(&[token.as_bytes()]),
                installation.state,
                installation.created_at
            ],
        )?;
        Ok(secret)
    }
    /// Prepare a transport identity without writing settings or permissions.
    pub fn new_observer_registration(
        agent: ObserverAgent,
        version: &str,
    ) -> Result<ObserverRegistrationSecret> {
        if version.is_empty() || version.len() > 64 || version.chars().any(char::is_control) {
            return Err(Error::new(
                "OBSERVER_VERSION",
                "Agent 版本无法识别。",
                "Invalid version string",
            ));
        }
        let installation = ObserverInstallation {
            id: uuid::Uuid::new_v4().to_string(),
            agent,
            agent_version: version.into(),
            adapter_version: OBSERVER_ADAPTER_VERSION.into(),
            state: "configured_pending".into(),
            created_at: now(),
            last_event_at: None,
        };
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        Ok(ObserverRegistrationSecret {
            installation,
            token,
        })
    }
    pub fn observer_installations(&self) -> Result<Vec<ObserverInstallation>> {
        let mut statement = self.store.connection.prepare("SELECT id,agent,agent_version,adapter_version,state,created_at,last_event_at FROM observer_installations ORDER BY created_at DESC")?;
        let rows = statement
            .query_map([], |row| {
                let agent: String = row.get(1)?;
                Ok(ObserverInstallation {
                    id: row.get(0)?,
                    agent: if agent == "codex" {
                        ObserverAgent::Codex
                    } else {
                        ObserverAgent::Claude
                    },
                    agent_version: row.get(2)?,
                    adapter_version: row.get(3)?,
                    state: row.get(4)?,
                    created_at: row.get(5)?,
                    last_event_at: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    pub fn observer_consents(&self) -> Result<Vec<ObserverConsent>> {
        let mut statement = self.store.connection.prepare("SELECT installation_id,workspace_id,enabled,prompt,command,reply,output,background FROM observer_permissions")?;
        let rows = statement
            .query_map([], read_consent)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    pub fn set_observer_consent(&self, consent: &ObserverConsent) -> Result<()> {
        if consent.enabled && !self.store.workspace(&consent.workspace_id)?.trusted {
            return Err(Error::new(
                "TRUST_REQUIRED",
                "请先信任仓库，再授权观察。",
                "Untrusted workspace",
            ));
        }
        let installed: bool = self.store.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM observer_installations WHERE id=?)",
            [&consent.installation_id],
            |r| r.get(0),
        )?;
        if !installed {
            return Err(Error::new(
                "OBSERVER_MISSING",
                "观察注册不存在，请重新检测 Agent。",
                "Unknown installation",
            ));
        }
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        transaction.execute("INSERT INTO observer_permissions VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(installation_id,workspace_id) DO UPDATE SET
            enabled=excluded.enabled,prompt=excluded.prompt,command=excluded.command,reply=excluded.reply,output=excluded.output,background=excluded.background,generation=generation+1",
            params![consent.installation_id, consent.workspace_id, consent.enabled, consent.prompt, consent.command, consent.reply, consent.output, consent.background])?;
        transaction.execute(
            "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='observer_revision'",
            [],
        )?;
        transaction.execute(
            "INSERT INTO observer_gaps VALUES(?,?,?,?,?,?,?)",
            params![
                uuid::Uuid::new_v4().to_string(),
                consent.installation_id,
                consent.workspace_id,
                if consent.enabled {
                    "observation_enabled_no_prior_history"
                } else {
                    "workspace_paused"
                },
                Option::<u64>::None,
                now(),
                Option::<u64>::None
            ],
        )?;
        crate::data::trim_observer_gaps(&transaction)?;
        transaction.commit()?;
        Ok(())
    }
    pub fn pause_all_observers(&self) -> Result<()> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        transaction.execute(
            "UPDATE observer_permissions SET enabled=0,generation=generation+1",
            [],
        )?;
        transaction.execute(
            "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='observer_revision'",
            [],
        )?;
        transaction.execute(
            "INSERT INTO observer_gaps VALUES(?,NULL,NULL,'all_paused',NULL,?,NULL)",
            params![uuid::Uuid::new_v4().to_string(), now()],
        )?;
        crate::data::trim_observer_gaps(&transaction)?;
        transaction.commit()?;
        Ok(())
    }
    pub fn observer_transport_authorized(
        &self,
        installation_id: &str,
        token: &str,
        agent: ObserverAgent,
        version: &str,
    ) -> Result<bool> {
        let hash: Option<String> = self.store.connection.query_row("SELECT token_hash FROM observer_installations WHERE id=? AND agent=? AND agent_version=? AND state!='revoked'",
            params![installation_id,agent.as_str(),version], |r| r.get(0)).optional()?;
        Ok(hash.is_some_and(|hash| equal_secret(&hash, &fingerprint(&[token.as_bytes()]))))
    }
    pub fn record_observer_gap(
        &self,
        installation_id: Option<&str>,
        code: &str,
        count: Option<u64>,
    ) -> Result<()> {
        if ![
            "collector_started",
            "collector_restart_integrity_unknown",
            "collector_stopped",
            "transport_queue_full",
            "transport_invalid",
            "transport_expired",
            "transport_input_limit",
            "storage_rejected",
        ]
        .contains(&code)
        {
            return Err(observer_error("OBSERVER_GAP_CODE"));
        }
        self.store.connection.execute(
            "INSERT INTO observer_gaps VALUES(?,?,NULL,?,?,?,?)",
            params![
                uuid::Uuid::new_v4().to_string(),
                installation_id,
                code,
                count,
                now(),
                now()
            ],
        )?;
        crate::data::trim_observer_gaps(&self.store.connection)?;
        Ok(())
    }
    pub fn observer_gaps(&self, workspace_id: Option<&str>) -> Result<Vec<ObserverGap>> {
        let mut query=self.store.connection.prepare("SELECT id,installation_id,workspace_id,code,count,started_at,ended_at FROM observer_gaps WHERE workspace_id IS NULL OR workspace_id=? ORDER BY started_at DESC LIMIT 100")?;
        let rows = query
            .query_map([workspace_id], |r| {
                Ok(ObserverGap {
                    id: r.get(0)?,
                    installation_id: r.get(1)?,
                    workspace_id: r.get(2)?,
                    code: r.get(3)?,
                    count: r.get(4)?,
                    started_at: r.get(5)?,
                    ended_at: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    pub fn observer_events(
        &self,
        workspace_id: &str,
        path: Option<&str>,
        offset: usize,
    ) -> Result<Vec<ObserverEvent>> {
        self.store.workspace(workspace_id)?;
        self.maintain_local_data()?;
        let mut statement = self.store.connection.prepare("SELECT payload FROM observer_events WHERE workspace_id=? AND expires_at>?
            AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(observer_events.payload,'$.paths') WHERE value=?)) ORDER BY received_at DESC LIMIT 100 OFFSET ?")?;
        let values = statement
            .query_map(
                params![workspace_id, now(), path, path, offset.min(1_000_000)],
                |r| r.get::<_, String>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let events = values
            .into_iter()
            .map(|s| serde_json::from_str::<ObserverEvent>(&s).map_err(Error::from))
            .collect::<Result<Vec<_>>>()?;
        Ok(events)
    }

    pub fn observer_file_context(
        &self,
        workspace_id: &str,
        path: &str,
    ) -> Result<Vec<ObserverEvent>> {
        self.store.workspace(workspace_id)?;
        self.maintain_local_data()?;
        let mut statement = self.store.connection.prepare("SELECT payload FROM observer_events WHERE workspace_id=?1 AND expires_at>?2 AND session_id IN (SELECT session_id FROM observer_events WHERE workspace_id=?1 AND expires_at>?2 AND EXISTS(SELECT 1 FROM json_each(observer_events.payload,'$.paths') WHERE value=?3) ORDER BY received_at DESC LIMIT 20) ORDER BY received_at DESC LIMIT 100")?;
        let rows = statement
            .query_map(params![workspace_id, now(), path], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|s| serde_json::from_str(&s).map_err(Error::from))
            .collect()
    }

    /// Native collector entry point. This is intentionally absent from Tauri's
    /// frontend command dispatcher. Raw hook input is never stored as a blob.
    pub fn ingest_observer_event(&self, input: ObserverInput<'_>) -> Result<bool> {
        let ObserverInput {
            installation_id,
            token,
            agent,
            agent_version,
            payload: input,
            bridge_started_at,
            foreground_lease_until,
            received_policy_revision,
            received_at,
        } = input;
        if self.observer_policy_revision()? != received_policy_revision {
            return Ok(false);
        }
        if input.len() > OBSERVER_INPUT_LIMIT {
            return Err(observer_error("OBSERVER_INPUT_LIMIT"));
        }
        let auth: Option<(String, String, String, String)> = self.store.connection.query_row(
            "SELECT token_hash,agent,agent_version,state FROM observer_installations WHERE id=?", [installation_id],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((secret_hash, stored_agent, stored_version, state)) = auth else {
            return Ok(false);
        };
        let expected_hash = fingerprint(&[token.as_bytes()]);
        if !equal_secret(&secret_hash, &expected_hash)
            || stored_agent != agent.as_str()
            || stored_version != agent_version
            || state == "revoked"
        {
            return Ok(false);
        }
        let raw: serde_json::Value =
            serde_json::from_slice(input).map_err(|_| observer_error("OBSERVER_SCHEMA"))?;
        if !raw.is_object() {
            return Err(observer_error("OBSERVER_SCHEMA"));
        }
        let kind =
            identifier(&raw, "hook_event_name").ok_or_else(|| observer_error("OBSERVER_SCHEMA"))?;
        if kind == "ProofConnectionCheck" {
            return self.record_observer_transport_probe(
                installation_id,
                token,
                raw["nonce"].as_str().unwrap_or(""),
                received_policy_revision,
            );
        }
        if !self.check_observer_hook_program(installation_id)? {
            return Ok(false);
        }
        if ![
            "SessionStart",
            "UserPromptSubmit",
            "PostToolUse",
            "PostToolUseFailure",
            "Stop",
            "SubagentStart",
            "SubagentStop",
            "SessionEnd",
            "Interrupt",
            "StopFailure",
        ]
        .contains(&kind.as_str())
        {
            return Err(observer_error("OBSERVER_EVENT_UNSUPPORTED"));
        }
        let cwd = raw["cwd"]
            .as_str()
            .filter(|p| p.len() <= 32768 && Path::new(p).is_absolute())
            .ok_or_else(|| observer_error("OBSERVER_SCOPE"))?;
        let canonical_cwd = fs::canonicalize(cwd).map_err(|_| observer_error("OBSERVER_SCOPE"))?;
        let consents = self.observer_consents()?;
        let workspaces = self.store.workspaces()?;
        let candidates: Vec<_> = workspaces
            .into_iter()
            .filter(|w| {
                canonical_cwd.starts_with(&w.path)
                    && consents.iter().any(|c| {
                        c.installation_id == installation_id && c.workspace_id == w.id && c.enabled
                    })
            })
            .collect();
        if candidates.is_empty() {
            return Ok(false);
        }
        let actual = self.git()?.discover(cwd)?.0;
        let Some(workspace) = candidates.into_iter().find(|w| {
            w.path == actual.path
                && w.git_dir == actual.git_dir
                && w.common_dir == actual.common_dir
        }) else {
            return Ok(false);
        };
        let workspace = self.store.workspace(&workspace.id)?;
        if !workspace.trusted {
            return Ok(false);
        }
        let (consent, generation): (ObserverConsent, u64) = self.store.connection.query_row(
            "SELECT installation_id,workspace_id,enabled,prompt,command,reply,output,background,generation FROM observer_permissions WHERE installation_id=? AND workspace_id=?",
            params![installation_id, workspace.id], |r| Ok((read_consent(r)?, r.get(8)?)))?;
        if !consent.enabled || (!consent.background && foreground_lease_until.unwrap_or(0) <= now())
        {
            return Ok(false);
        }
        let native_session = identifier(&raw, "session_id");
        let native_agent = identifier(&raw, "agent_id");
        let tool_ref = identifier(&raw, "tool_use_id");
        let native_key = native_session.as_ref().and_then(|session| {
            identifier(&raw, "event_id")
                .map(|id| ("event_id", id))
                .or_else(|| {
                    ["PostToolUse", "PostToolUseFailure"]
                        .contains(&kind.as_str())
                        .then(|| tool_ref.clone().map(|id| ("tool_use_id", id)))
                        .flatten()
                })
                .map(|(source, id)| {
                    format!(
                        "{source}:{}",
                        fingerprint(&[
                            workspace.id.as_bytes(),
                            session.as_bytes(),
                            native_agent.as_deref().unwrap_or("").as_bytes(),
                            kind.as_bytes(),
                            id.as_bytes()
                        ])
                    )
                })
        });
        let session_id = native_session.as_ref().map_or_else(
            || uuid::Uuid::new_v4().to_string(),
            |id| {
                fingerprint(&[
                    workspace.id.as_bytes(),
                    installation_id.as_bytes(),
                    id.as_bytes(),
                    native_agent.as_deref().unwrap_or("").as_bytes(),
                ])
            },
        );
        let mut fields = BTreeMap::new();
        let mut budget = TextBudget {
            remaining: OBSERVER_TEXT_LIMIT,
            truncated: false,
        };
        let prompt = budget.field(
            "prompt",
            raw["prompt"].as_str(),
            consent.prompt,
            &mut fields,
        );
        let tool_name = identifier(&raw, "tool_name");
        let shell = tool_name.as_deref() == Some("Bash");
        let command = budget.field(
            "command",
            shell
                .then(|| raw["tool_input"]["command"].as_str())
                .flatten(),
            consent.command,
            &mut fields,
        );
        let reply = budget.field(
            "reply",
            raw["last_assistant_message"].as_str(),
            consent.reply,
            &mut fields,
        );
        let output = if consent.output {
            let stdout = raw["tool_response"]["stdout"].as_str();
            let stderr = raw["tool_response"]["stderr"].as_str();
            let value = match (stdout, stderr) {
                (None, None) => raw["tool_response"].as_str().map(String::from),
                (a, b) => Some(format!(
                    "{}{}{}",
                    a.unwrap_or(""),
                    if a.is_some() && b.is_some() { "\n" } else { "" },
                    b.unwrap_or("")
                )),
            };
            budget.field("output", value.as_deref(), true, &mut fields)
        } else {
            budget.field("output", None, false, &mut fields)
        };
        // A post-tool callback is not a start snapshot or a structured test
        // report. Never synthesize subcommand success, test counts or timing.
        let exit_code = if shell {
            raw["tool_response"]["exit_code"]
                .as_i64()
                .and_then(|v| i32::try_from(v).ok())
        } else {
            None
        };
        let command_state = if !shell {
            "not_applicable"
        } else if kind == "PostToolUseFailure" {
            "tool_failed_exit_unknown"
        } else {
            match exit_code {
                Some(0) => "command_succeeded",
                Some(_) => "command_failed",
                None => "result_unknown",
            }
        };
        fields.insert("sourceTime".into(), "not_provided".into());
        fields.insert("commandStart".into(), "not_observed".into());
        fields.insert("transcript".into(), "not_collected".into());
        let (paths, matched_content_hashes, path_limited) = observed_paths(
            &workspace,
            &canonical_cwd,
            agent,
            &kind,
            tool_name.as_deref(),
            &raw,
        )?;
        if path_limited {
            fields.insert("paths".into(), "limited_or_outside_scope".into());
        }
        let event = ObserverEvent {
            id: uuid::Uuid::new_v4().to_string(),
            id_origin: "local".into(),
            workspace_id: workspace.id.clone(),
            installation_id: installation_id.into(),
            session_id: session_id.clone(),
            native_session_id: native_session.clone(),
            native_agent_id: native_agent.clone(),
            native_event_key: native_key.clone(),
            turn_id: identifier(&raw, "turn_id"),
            agent,
            kind,
            source_at: None,
            received_at,
            bridge_started_at,
            tool_name,
            tool_ref,
            paths,
            prompt,
            command,
            reply,
            output,
            exit_code,
            command_state: command_state.into(),
            validation_state: "no_structured_report".into(),
            version_relation: "unconfirmed_post_only".into(),
            matched_content_hashes,
            field_status: fields,
            possibly_duplicate: native_key.is_none(),
            truncated: budget.truncated || path_limited,
        };
        // Recheck authorization under the same write transaction as persistence.
        // Pause/revoke cannot complete and then be followed by a stale queued write.
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let permitted: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM observer_permissions p JOIN observer_installations i ON i.id=p.installation_id JOIN workspaces w ON w.id=p.workspace_id
            WHERE p.installation_id=? AND p.workspace_id=? AND p.enabled=1 AND w.trusted=1 AND p.generation=? AND i.token_hash=? AND i.state!='revoked'
                AND (p.background=1 OR ?>?) AND (SELECT CAST(value AS INTEGER) FROM settings WHERE key='observer_revision')=?)",
            params![installation_id, workspace.id, generation, secret_hash, foreground_lease_until.unwrap_or(0),now(),received_policy_revision], |r| r.get(0))?;
        if !permitted {
            return Ok(false);
        }
        let payload = serde_json::to_string(&event)?;
        self.check_observer_capacity(payload.len())?;
        tx.execute("INSERT INTO observer_sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_received_at=excluded.last_received_at",
            params![session_id, workspace.id, installation_id, native_session, native_agent, received_at, received_at])?;
        let inserted = tx.execute("INSERT INTO observer_events VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(installation_id,native_key) DO NOTHING",
            params![event.id, workspace.id, installation_id, session_id, native_key, received_at, payload, received_at.saturating_add(crate::OUTPUT_RETENTION_MS), received_at.saturating_add(crate::OBSERVATION_RETENTION_MS)])?;
        tx.execute("UPDATE observer_installations SET state='receiving_unverified',last_event_at=? WHERE id=?", params![received_at, installation_id])?;
        tx.commit()?;
        Ok(inserted > 0)
    }
}

fn observer_error(code: &str) -> Error {
    Error::new(
        code,
        "观察事件无法按当前授权与格式处理。",
        "No raw hook payload was stored",
    )
}
fn equal_secret(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |v, (a, b)| v | (a ^ b)) == 0
}
fn identifier(value: &serde_json::Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
        .map(String::from)
}
struct TextBudget {
    remaining: usize,
    truncated: bool,
}
impl TextBudget {
    fn field(
        &mut self,
        name: &str,
        value: Option<&str>,
        allowed: bool,
        status: &mut BTreeMap<String, String>,
    ) -> Option<String> {
        if !allowed {
            status.insert(name.into(), "not_authorized".into());
            return None;
        }
        let Some(value) = value else {
            status.insert(name.into(), "not_provided".into());
            return None;
        };
        let mut length = value.len().min(self.remaining);
        while !value.is_char_boundary(length) {
            length -= 1;
        }
        let limited = length < value.len();
        self.truncated |= limited;
        self.remaining -= length;
        status.insert(
            name.into(),
            if limited { "truncated" } else { "recorded" }.into(),
        );
        Some(value[..length].into())
    }
}

fn observed_paths(
    workspace: &crate::Workspace,
    cwd: &Path,
    agent: ObserverAgent,
    kind: &str,
    tool: Option<&str>,
    raw: &serde_json::Value,
) -> Result<(Vec<String>, BTreeMap<String, String>, bool)> {
    let mut requested = Vec::new();
    if let Some(path) = raw["tool_input"]["file_path"]
        .as_str()
        .or(raw["tool_input"]["path"].as_str())
    {
        requested.push(path.to_string());
    }
    if let Some(path) = raw["tool_response"]["filePath"].as_str() {
        requested.push(path.to_string());
    }
    if agent == ObserverAgent::Codex && tool == Some("apply_patch") {
        if let Some(patch) = raw["tool_input"]["command"].as_str() {
            for line in patch.lines() {
                if let Some(path) = line
                    .strip_prefix("*** Update File: ")
                    .or_else(|| line.strip_prefix("*** Add File: "))
                    .or_else(|| line.strip_prefix("*** Delete File: "))
                    .or_else(|| line.strip_prefix("*** Move to: "))
                {
                    requested.push(path.to_string());
                    if requested.len() > 100 {
                        break;
                    }
                }
            }
        }
    }
    let mut paths = Vec::new();
    let mut hashes = BTreeMap::new();
    let mut limited = requested.len() > 100;
    for requested in requested.iter().take(100) {
        let requested = Path::new(requested);
        let absolute = if requested.is_absolute() {
            requested.to_path_buf()
        } else {
            cwd.join(requested)
        };
        let Some(name) = absolute.file_name() else {
            limited = true;
            continue;
        };
        let Some(parent) = absolute.parent().and_then(|p| fs::canonicalize(p).ok()) else {
            limited = true;
            continue;
        };
        let resolved = parent.join(name);
        let relative = {
            match resolved.strip_prefix(&workspace.path) {
                Ok(path) => path,
                Err(_) => {
                    limited = true;
                    continue;
                }
            }
        };
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            limited = true;
            continue;
        }
        let Some(path) = relative
            .to_str()
            .filter(|p| !p.is_empty() && p.len() < 32768)
        else {
            limited = true;
            continue;
        };
        if relative.components().any(|part| {
            part.as_os_str()
                .as_encoded_bytes()
                .eq_ignore_ascii_case(b".git")
        }) || resolved.starts_with(&workspace.git_dir)
            || resolved.starts_with(&workspace.common_dir)
            || crosses_git_boundary(&parent, Path::new(&workspace.path))
        {
            limited = true;
            continue;
        }
        let full = match crate::git::checked_path(workspace, path) {
            Ok(path) => path,
            Err(_) => {
                limited = true;
                continue;
            }
        };
        if paths.iter().any(|p| p == path) {
            continue;
        }
        paths.push(path.to_string());
        if agent == ObserverAgent::Claude
            && kind == "PostToolUse"
            && tool == Some("Write")
            && raw["tool_response"]["success"].as_bool() == Some(true)
        {
            if let Some(content) = raw["tool_input"]["content"].as_str() {
                if let Ok(meta) = fs::symlink_metadata(&full) {
                    if meta.is_file()
                        && !meta.file_type().is_symlink()
                        && meta.len() <= OBSERVER_INPUT_LIMIT as u64
                    {
                        // A matching payload is evidence about this captured file,
                        // never ownership of the whole working-tree diff.
                        #[cfg(unix)]
                        {
                            if crate::guarded_file::BoundFile::open(
                                Path::new(&workspace.path),
                                path,
                            )
                            .and_then(|file| file.matches_bytes(content.as_bytes()))
                            .unwrap_or(false)
                            {
                                hashes.insert(path.into(), fingerprint(&[content.as_bytes()]));
                            }
                        }
                    }
                }
            }
        }
    }
    Ok((paths, hashes, limited))
}

fn crosses_git_boundary(mut directory: &Path, root: &Path) -> bool {
    while directory != root {
        match fs::symlink_metadata(directory.join(".git")) {
            Ok(_) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return true,
        }
        let Some(parent) = directory.parent() else {
            return true;
        };
        directory = parent;
    }
    false
}

fn read_consent(row: &rusqlite::Row<'_>) -> rusqlite::Result<ObserverConsent> {
    Ok(ObserverConsent {
        installation_id: row.get(0)?,
        workspace_id: row.get(1)?,
        enabled: row.get(2)?,
        prompt: row.get(3)?,
        command: row.get(4)?,
        reply: row.get(5)?,
        output: row.get(6)?,
        background: row.get(7)?,
    })
}
