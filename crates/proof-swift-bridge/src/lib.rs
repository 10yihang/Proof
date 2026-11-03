//! Private, versioned transport for the native macOS client. Explicit Git and read-only AI commands; never arbitrary shell dispatch.
use proof_core::{
    AgentKind, AgentOptions, AgentSettingsUpdate, AiRequest, AiScope, AiTask, Error,
    HistoryActionKind, HistoryActionRequest, Proof, Result, Side,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u64,
    pub command: Command,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Hello {},
    Recent {},
    Open {
        path: String,
    },
    Trust {
        workspace: String,
        trusted: bool,
    },
    Changes {
        workspace: String,
    },
    Diff {
        workspace: String,
        path: String,
        side: Side,
    },
    Branches {
        workspace: String,
    },
    HistoryState {
        workspace: String,
    },
    PrepareHistoryAction {
        workspace: String,
        token: String,
        request: HistoryActionRequest,
    },
    ExecuteHistoryAction {
        workspace: String,
        preview: String,
    },
    AgentSettings {},
    AgentProviders {},
    SetAgentSettings {
        update: AgentSettingsUpdate,
    },
    ProbeAiAgent {
        provider: AgentKind,
        options: AgentOptions,
    },
    RunAiTask {
        request: AiRequest,
    },
    History {
        workspace: String,
        offset: usize,
    },
    CommitDiff {
        workspace: String,
        oid: String,
        parent: usize,
    },
    Review {
        snapshot: String,
        reviewed: bool,
        hunk: Option<String>,
    },
    Stage {
        snapshot: String,
        hunk: Option<String>,
    },
    PrepareCommit {
        workspace: String,
        token: String,
    },
    Commit {
        preview: String,
        message: String,
    },
}
impl Command {
    pub fn cancellable(&self) -> bool {
        matches!(
            self,
            Self::Hello {}
                | Self::Recent {}
                | Self::Open { .. }
                | Self::Changes { .. }
                | Self::Diff { .. }
                | Self::Branches { .. }
                | Self::History { .. }
                | Self::CommitDiff { .. }
                | Self::PrepareCommit { .. }
                | Self::HistoryState { .. }
                | Self::PrepareHistoryAction { .. }
                | Self::AgentSettings {}
                | Self::AgentProviders {}
                | Self::ProbeAiAgent { .. }
                | Self::RunAiTask { .. }
        )
    }
}

#[derive(Serialize)]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Error>,
}
impl Response {
    pub fn new(id: u64, result: Result<Value>) -> Self {
        match result {
            Ok(result) => Self {
                id,
                result: Some(result),
                error: None,
            },
            Err(error) => Self {
                id,
                result: None,
                error: Some(error),
            },
        }
    }
}
fn value(value: impl Serialize) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}

pub fn dispatch(core: &mut Proof, command: Command) -> Result<Value> {
    match command {
        Command::Hello {} => Ok(json!({ "protocol": PROTOCOL_VERSION })),
        Command::Recent {} => value(core.recent_workspaces()?),
        Command::Open { path } => value(core.open_workspace(&path)?),
        Command::Trust { workspace, trusted } => {
            core.set_trust(&workspace, trusted)?;
            Ok(Value::Null)
        }
        Command::Changes { workspace } => value(core.changes(&workspace)?),
        Command::Diff {
            workspace,
            path,
            side,
        } => value(core.file_diff(&workspace, &path, side)?),
        Command::Branches { workspace } => value(core.branches(&workspace)?),
        Command::HistoryState { workspace } => value(core.history_repository_state(&workspace)?),
        Command::PrepareHistoryAction {
            workspace,
            token,
            request,
        } => {
            if !matches!(
                request.kind,
                HistoryActionKind::Switch
                    | HistoryActionKind::Fetch
                    | HistoryActionKind::Pull
                    | HistoryActionKind::Push
            ) || request.mode.is_some()
                || request.mainline.is_some()
            {
                return Err(Error::new(
                    "INVALID_REQUEST",
                    "Unsupported history action",
                    "Native supports switch, fetch, normal pull and push only",
                ));
            }
            value(core.prepare_history_action(&workspace, request, &token)?)
        }
        // Writes are deliberately not read-cancellable: a timeout/disconnect can
        // mean a remote already accepted the write. Never retry automatically.
        Command::ExecuteHistoryAction { workspace, preview } => {
            value(core.execute_history_action(&workspace, &preview)?)
        }
        Command::AgentSettings {} => value(core.agent_settings()?),
        Command::AgentProviders {} => value(core.agent_providers()?),
        Command::SetAgentSettings { update } => value(core.set_agent_settings(update)?),
        Command::ProbeAiAgent { provider, options } => {
            require_owned_read()?;
            value(core.prepare_agent_probe(provider, options)?.run()?)
        }
        Command::RunAiTask { request } => {
            require_owned_read()?;
            if !matches!(request.task, AiTask::Review | AiTask::Commit)
                || !matches!(request.scope, AiScope::Local { .. })
                || request.amend
            {
                return Err(Error::new(
                    "INVALID_REQUEST",
                    "Unsupported AI task",
                    "Native supports explicit local review and commit drafts only",
                ));
            }
            let AiScope::Local {
                workspace_id,
                expected_token,
                ..
            } = &request.scope
            else {
                unreachable!()
            };
            let workspace = workspace_id.clone();
            let token = expected_token.clone();
            // Core AI intentionally reads live project context. Bind native
            // requests/results to the displayed changes, without claiming the
            // repository is frozen while the Agent is running.
            if core.changes(&workspace)?.token != token {
                return Err(Error::stale());
            }
            let job = core.prepare_ai_task(request)?;
            let report = job.run()?;
            if core.changes(&workspace)?.token != token {
                return Err(Error::stale());
            }
            value(job.finish(core, report)?)
        }
        Command::History { workspace, offset } => value(core.history(&workspace, offset, None)?),
        Command::CommitDiff {
            workspace,
            oid,
            parent,
        } => value(core.commit_diff(&workspace, &oid, parent)?),
        Command::Review {
            snapshot,
            reviewed,
            hunk,
        } => {
            core.mark_reviewed(&snapshot, hunk.as_deref(), reviewed)?;
            Ok(Value::Null)
        }
        Command::Stage { snapshot, hunk } => value(core.stage(&snapshot, hunk.as_deref())?),
        Command::PrepareCommit { workspace, token } => {
            value(core.prepare_commit_checked(&workspace, false, true, Some(&token))?)
        }
        Command::Commit { preview, message } => value(core.commit(&preview, &message)?),
    }
}

fn require_owned_read() -> Result<()> {
    if proof_core::read_cancellation_active() {
        Ok(())
    } else {
        Err(Error::new(
            "INVALID_READ_REQUEST",
            "AI requires a cancellation handle",
            "Use an owned read scope",
        ))
    }
}
