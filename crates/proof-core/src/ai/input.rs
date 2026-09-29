//! Small task descriptor beside a live, read-only project directory.
//! Project files are never copied or filtered into a partial working tree.
//!
//! Local scopes carry no frozen evidence: the manifest lists the selected
//! paths and sides, and the agent diffs the live repository itself.
//! Historical comparisons still ship canonical patches because their Git
//! objects are immutable and the working tree does not contain that state.
use super::{AiProgress, AiScope};
use crate::{Proof, Result, Side, Workspace};
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
    diffs: &[crate::FileDiff],
    selected: &[(String, Side)],
    head_oid: Option<String>,
    emit: &dyn Fn(AiProgress),
) -> Result<AnalysisInput> {
    proof.workspace_watch_paths(&workspace.id)?;
    let project = fs::canonicalize(&workspace.path)?;
    let live = matches!(scope, AiScope::Local { .. });
    let directory = tempfile::Builder::new()
        .prefix("proof-analysis-input-")
        .tempdir()?;
    let root = fs::canonicalize(directory.path())?;
    emit(AiProgress::phase("context"));
    let mut files = Vec::new();
    let mut paths = BTreeSet::new();
    if live {
        for (path, side) in selected {
            crate::check_read_cancellation()?;
            files.push(json!({ "path": path, "side": side }));
            paths.insert(path.clone());
        }
    } else {
        fs::create_dir(root.join("diffs"))?;
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
    }
    let instructions = if live {
        "Read the real project directory for full context. No patches are frozen: run git status and git diff yourself against the live repository to inspect the selected files (git diff for unstaged, git diff --cached for staged; git show <headOid>:path and git show :path give the HEAD and index versions). Working files may change while you analyze; review the live state you observe."
    } else {
        "Read the real project directory for full context. These patches only freeze the selected Git Diff and its line numbers. For staged or historical versions, query Git objects; the current working files may differ."
    };
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
            "instructions": instructions,
        }))?,
    )?;
    Ok(AnalysisInput {
        _directory: directory,
        project,
        manifest,
        paths: paths.into_iter().collect(),
    })
}
