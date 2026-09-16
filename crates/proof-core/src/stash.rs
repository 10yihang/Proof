use crate::{git::Git, Error, Proof, Result, Workspace};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub selector: String,
    pub oid: String,
    pub subject: String,
    pub created_at: u64,
}

pub(crate) fn entries(git: &Git, workspace: &Workspace) -> Result<Vec<StashEntry>> {
    let bytes = git.query(
        workspace,
        &["stash", "list", "--format=%H%x00%gd%x00%gs%x00%ct"],
    )?;
    String::from_utf8_lossy(&bytes)
        .lines()
        .map(|line| {
            let parts: Vec<_> = line.split('\0').collect();
            if parts.len() != 4 || !parts[0].bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(Error::new(
                    "STASH_FORMAT",
                    "无法读取 Stash 列表。",
                    "Invalid stash entry",
                ));
            }
            Ok(StashEntry {
                oid: parts[0].into(),
                selector: parts[1].into(),
                subject: parts[2].into(),
                created_at: parts[3].parse::<u64>().unwrap_or(0).saturating_mul(1000),
            })
        })
        .collect()
}

impl Proof {
    pub fn stashes(&self, workspace_id: &str) -> Result<Vec<StashEntry>> {
        entries(&self.git()?, &self.store.workspace(workspace_id)?)
    }
}
