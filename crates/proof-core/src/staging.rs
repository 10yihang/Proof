use crate::{
    git::{self, Git},
    process,
    service::IndexLock,
    BatchStageResult, Changes, Error, OperationResult, Proof, Result, Side, Workspace,
};
use std::{collections::BTreeSet, fs, path::Path, time::Duration};

impl Proof {
    /// One explicit file selection, one private index, one atomic publication.
    /// Worktree bytes and unselected index entries are never rewritten.
    pub fn stage_files(
        &mut self,
        workspace_id: &str,
        paths: &[String],
        side: Side,
        expected_token: &str,
    ) -> Result<BatchStageResult> {
        let workspace = self.store.workspace(workspace_id)?;
        self.require_write(&workspace)?;
        let git = self.git()?;
        let lock = IndexLock::acquire(Path::new(&workspace.git_dir))?;
        let before = git.changes(&workspace)?;
        if before.token != expected_token {
            return Err(Error::stale());
        }
        let selected: BTreeSet<_> = paths.iter().collect();
        if selected.is_empty() || selected.len() != paths.len() || selected.len() > 10000 {
            return Err(Error::new(
                "INVALID_SELECTION",
                "请选择需要 Stage 的文件。",
                "Empty, duplicate or oversized file selection",
            ));
        }
        let mut targets = BTreeSet::new();
        for path in selected {
            let file = before
                .files
                .iter()
                .find(|file| file.path == *path && file.side == side)
                .ok_or_else(Error::stale)?;
            if file.conflicted {
                return Err(Error::new(
                    "UNRESOLVED_CONFLICT",
                    "请先解决所选文件的冲突。",
                    path,
                ));
            }
            let full = git::checked_path(&workspace, path)?;
            // A status entry that is a directory is a submodule; do not update
            // it or descend into another repository as part of a file batch.
            if fs::symlink_metadata(&full).is_ok_and(|m| m.is_dir()) {
                return Err(Error::new(
                    "SUBMODULE_ACTION",
                    "请在 Submodule 中完成 Git 操作。",
                    path,
                ));
            }
            targets.insert(path.clone());
            if file.status == "R" {
                if let Some(old) = &file.old_path {
                    let old_full = git::checked_path(&workspace, old)?;
                    if side == Side::Unstaged && fs::symlink_metadata(&old_full).is_ok() {
                        return Err(Error::new(
                            "RENAME_SOURCE_CHANGED",
                            "原路径已有新内容，请分别选择需要 Stage 的文件。",
                            old,
                        ));
                    }
                    targets.insert(old.clone());
                }
            }
        }
        let guard = selection_guard(&git, &workspace, &targets)?;
        let untouched = unselected_entries(&git, &workspace, None, &targets)?;
        let private = self.temporary_index(&workspace.id)?;
        let index_path = private.path().join("index");
        let bytes = git.index_bytes(&workspace)?;
        if !bytes.is_empty() {
            // Keep Git's racy-stat cutoff. A newly dated copy can make an
            // equal-size edit with the cached timestamp look falsely clean.
            let modified = fs::metadata(Path::new(&workspace.git_dir).join("index"))?.modified()?;
            fs::write(&index_path, &bytes)?;
            fs::File::open(&index_path)?.set_modified(modified)?;
        }
        let mut command = git.command(&workspace)?;
        git::index_override(&mut command, &index_path);
        if side == Side::Unstaged {
            command.args([
                "add",
                "--all",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ]);
        } else if before.head.is_some() {
            command.args([
                "restore",
                "--staged",
                "--source=HEAD",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ]);
        } else {
            command.args(["update-index", "--force-remove", "-z", "--stdin"]);
        }
        let mut input = Vec::new();
        for path in &targets {
            input.extend_from_slice(path.as_bytes());
            input.push(0);
        }
        process::checked(process::run(
            command,
            Some(&input),
            Duration::from_secs(60),
        )?)?;
        if untouched != unselected_entries(&git, &workspace, Some(&index_path), &targets)? {
            return Err(Error::new(
                "INDEX_SCOPE_CHANGED",
                "所选操作会影响其他 Staged 文件，请分别处理这些路径。",
                "Private index changed an entry outside the exact selected paths",
            ));
        }
        if selection_guard(&git, &workspace, &targets)? != guard
            || git.changes(&workspace)?.token != before.token
        {
            return Err(Error::stale());
        }
        self.require_write(&self.store.workspace(workspace_id)?)?;
        let index = fs::read(&index_path)?;
        lock.publish(&index)?;
        let actual: Changes = git.changes(&workspace).map_err(|error| {
            Error::new(
                "GIT_APPLIED_REFRESH_REQUIRED",
                "Stage 已执行，请刷新查看结果。",
                error,
            )
        })?;
        let matches = git.index_bytes(&workspace)? == index
            && actual.head == before.head
            && actual.branch == before.branch;
        let mut result = OperationResult {
            ok: matches,
            message: if side == Side::Staged {
                format!("已 Unstage {} 个文件", paths.len())
            } else {
                format!("已 Stage {} 个文件", paths.len())
            },
            actual_head: actual.head,
            actual_branch: actual.branch,
            warning: (!matches).then(|| "Git 状态在操作后发生变化，请检查 Index。".into()),
        };
        if let Err(error) = self.store.record_operation(
            workspace_id,
            if side == Side::Staged {
                "unstage_files"
            } else {
                "stage_files"
            },
            &serde_json::to_string(&result)?,
        ) {
            result.warning = Some(format!("Git 操作已完成，但操作记录未保存：{error}"));
        }
        Ok(BatchStageResult {
            result,
            token: actual.token,
        })
    }
}

fn unselected_entries(
    git: &Git,
    workspace: &Workspace,
    index: Option<&Path>,
    selected: &BTreeSet<String>,
) -> Result<Vec<Vec<u8>>> {
    let mut command = git.command(workspace)?;
    if let Some(index) = index {
        git::index_override(&mut command, index);
    }
    command.args(["ls-files", "--stage", "-z"]);
    let bytes = process::checked(process::run(command, None, Duration::from_secs(20))?)?;
    let mut entries = Vec::new();
    for entry in bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let path = entry
            .splitn(2, |byte| *byte == b'\t')
            .nth(1)
            .ok_or_else(|| {
                Error::new(
                    "GIT_PARSE",
                    "无法核对 Index 中的文件。",
                    "Invalid ls-files record",
                )
            })?;
        let path = std::str::from_utf8(path)
            .map_err(|error| Error::new("PATH_ENCODING", "文件名无法读取。", error))?;
        if !selected.contains(path) {
            entries.push(entry.to_vec());
        }
    }
    entries.sort();
    Ok(entries)
}

fn selection_guard(git: &Git, workspace: &Workspace, paths: &BTreeSet<String>) -> Result<String> {
    let mut identities = vec![git.context_guard(workspace)?];
    for path in paths {
        identities.push(crate::fingerprint(&[
            path.as_bytes(),
            &git::worktree_bytes(workspace, path)?,
        ]));
    }
    Ok(crate::fingerprint(
        &identities.iter().map(String::as_bytes).collect::<Vec<_>>(),
    ))
}
