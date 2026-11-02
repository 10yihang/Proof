//! Private, versioned transport for the native macOS client. No shell/AI dispatch.
use proof_core::{Error, Proof, Result, Side};
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
    },
    Stage {
        snapshot: String,
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
                | Self::History { .. }
                | Self::CommitDiff { .. }
                | Self::PrepareCommit { .. }
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
        Command::History { workspace, offset } => value(core.history(&workspace, offset, None)?),
        Command::CommitDiff {
            workspace,
            oid,
            parent,
        } => value(core.commit_diff(&workspace, &oid, parent)?),
        Command::Review { snapshot, reviewed } => {
            core.mark_reviewed(&snapshot, None, reviewed)?;
            Ok(Value::Null)
        }
        Command::Stage { snapshot } => value(core.stage(&snapshot, None)?),
        Command::PrepareCommit { workspace, token } => {
            value(core.prepare_commit_checked(&workspace, false, true, Some(&token))?)
        }
        Command::Commit { preview, message } => value(core.commit(&preview, &message)?),
    }
}
