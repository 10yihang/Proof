use super::{validate_groups, AiGroup};
use crate::{Error, Proof, Result};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeGroups {
    pub revision: u64,
    pub groups: Vec<AiGroup>,
    pub source_token: String,
}
impl Proof {
    pub fn comparison_change_groups(
        &self,
        workspace: &str,
        base: &str,
        target: &str,
    ) -> Result<ChangeGroups> {
        self.frozen_comparison(workspace, base, target)?;
        read_comparison(&self.store.connection, workspace, base, target)
    }
    pub fn set_comparison_change_groups(
        &self,
        workspace: &str,
        base: &str,
        target: &str,
        expected_revision: u64,
        groups: Vec<AiGroup>,
    ) -> Result<ChangeGroups> {
        let comparison = self.frozen_comparison(workspace, base, target)?;
        let known = comparison
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        validate_groups(&groups, &known, false)?;
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        if read_comparison(&tx, workspace, base, target)?.revision != expected_revision {
            return Err(Error::new(
                "GROUPS_CHANGED",
                "分组已更新，请重新读取后再操作。",
                "Comparison grouping revision mismatch",
            ));
        }
        let next = ChangeGroups {
            revision: expected_revision
                .checked_add(1)
                .ok_or_else(|| super::invalid("Group revision overflow"))?,
            groups,
            source_token: format!("comparison:{base}:{target}"),
        };
        tx.execute("INSERT INTO comparison_change_groups(workspace_id,base_oid,target_oid,revision,value) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(workspace_id,base_oid,target_oid) DO UPDATE SET revision=excluded.revision,value=excluded.value", rusqlite::params![workspace,base,target,next.revision,serde_json::to_string(&next)?])?;
        tx.commit()?;
        Ok(next)
    }
    pub fn change_groups(&self, workspace_id: &str) -> Result<ChangeGroups> {
        self.store.workspace(workspace_id)?;
        read(&self.store.connection, workspace_id)
    }
    /// A full replacement from an explicit user action. Late AI output cannot
    /// overwrite a newer manual edit (including an explicit Ungroup all).
    pub fn set_change_groups(
        &self,
        workspace_id: &str,
        expected_revision: u64,
        expected_token: &str,
        groups: Vec<AiGroup>,
    ) -> Result<ChangeGroups> {
        let changes = self.changes(workspace_id)?;
        if changes.token != expected_token {
            return Err(Error::stale());
        }
        let known = changes.files.iter().map(|f| f.path.as_str()).collect();
        validate_groups(&groups, &known, false)?;
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        if read(&tx, workspace_id)?.revision != expected_revision {
            return Err(Error::new(
                "GROUPS_CHANGED",
                "分组已更新，请重新读取后再操作。",
                "Grouping revision mismatch",
            ));
        }
        let next = ChangeGroups {
            revision: expected_revision
                .checked_add(1)
                .ok_or_else(|| super::invalid("Group revision overflow"))?,
            groups,
            source_token: expected_token.into(),
        };
        tx.execute("INSERT INTO change_groups(workspace_id,revision,value) VALUES(?1,?2,?3) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,value=excluded.value", rusqlite::params![workspace_id,next.revision,serde_json::to_string(&next)?])?;
        tx.commit()?;
        Ok(next)
    }
}
fn read_comparison(
    connection: &rusqlite::Connection,
    workspace: &str,
    base: &str,
    target: &str,
) -> Result<ChangeGroups> {
    let raw: Option<String> = connection.query_row("SELECT value FROM comparison_change_groups WHERE workspace_id=? AND base_oid=? AND target_oid=?", [workspace,base,target], |row| row.get(0)).optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Error::from))
        .transpose()
        .map(Option::unwrap_or_default)
}
fn read(connection: &rusqlite::Connection, workspace: &str) -> Result<ChangeGroups> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT value FROM change_groups WHERE workspace_id=?",
            [workspace],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Error::from))
        .transpose()
        .map(Option::unwrap_or_default)
}
