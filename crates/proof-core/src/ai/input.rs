//! Small, immutable task evidence beside a live, read-only project directory.
//! Project files are never copied or filtered into a partial working tree.
use super::{AiProgress, AiScope};
use crate::{Error, FileDiff, Proof, Result, Workspace};
use serde_json::json;
use std::{collections::BTreeSet, fs, path::PathBuf};

pub(super) struct AnalysisInput {
    _directory: tempfile::TempDir,
    pub project: PathBuf,
    pub manifest: PathBuf,
    pub paths: Vec<String>,
}

pub(super) fn prepare(
    proof: &Proof,
    workspace: &Workspace,
    scope: &AiScope,
    diffs: &[FileDiff],
    emit: &dyn Fn(AiProgress),
) -> Result<AnalysisInput> {
    proof.workspace_watch_paths(&workspace.id)?;
    let project = fs::canonicalize(&workspace.path)?;
    let head_oid = if let AiScope::Local { expected_token, .. } = scope {
        let changes = proof.changes(&workspace.id)?;
        if changes.token != *expected_token {
            return Err(Error::stale());
        }
        changes.head
    } else {
        None
    };
    let directory = tempfile::Builder::new()
        .prefix("proof-analysis-input-")
        .tempdir()?;
    let root = fs::canonicalize(directory.path())?;
    fs::create_dir(root.join("diffs"))?;
    emit(AiProgress::phase("context"));
    let mut files = Vec::new();
    let mut paths = BTreeSet::new();
    for (index, diff) in diffs.iter().enumerate() {
        crate::check_read_cancellation()?;
        let patch = root.join("diffs").join(format!("{index}.patch"));
        fs::write(&patch, &diff.patch)?;
        files.push(json!({
            "path": diff.path, "oldPath": diff.old_path, "side": diff.side,
            "kind": diff.kind, "patchFile": patch, "notice": diff.notice,
            "contentToken": diff.token,
        }));
        paths.insert(diff.path.clone());
    }
    let manifest = root.join("manifest.json");
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&json!({
            "schemaVersion": 2,
            "scope": scope,
            "headOid": head_oid,
            "projectDirectory": project,
            "contextSource": "live-project-directory",
            "files": files,
            "instructions": "Read the real project directory for full context. These patches only freeze the selected Git Diff and its line numbers. For staged or historical versions, query Git objects; the current working files may differ."
        }))?,
    )?;
    Ok(AnalysisInput {
        _directory: directory,
        project,
        manifest,
        paths: paths.into_iter().collect(),
    })
}
