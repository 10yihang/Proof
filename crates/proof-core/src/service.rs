use crate::{
    error::{Error, Result},
    fingerprint,
    git::{self, Git},
    model::*,
    now, patch, process,
    store::Store,
};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

pub struct Proof {
    pub(crate) store: Store,
    pub(crate) data_dir: PathBuf,
    snapshots: HashMap<String, FileDiff>,
    snapshot_order: VecDeque<String>,
    previews: HashMap<String, CommitPreview>,
}
impl Proof {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self> {
        let core = Self {
            store: Store::open(data_dir.as_ref())?,
            data_dir: data_dir.as_ref().to_path_buf(),
            snapshots: HashMap::new(),
            snapshot_order: VecDeque::new(),
            previews: HashMap::new(),
        };
        core.maintain_local_data()?;
        Ok(core)
    }
    pub(crate) fn git(&self) -> Result<Git> {
        Ok(Git {
            executable: self.store.preferences()?.git_path,
        })
    }
    pub fn open_workspace(&mut self, path: &str) -> Result<Workspace> {
        let (workspace, repo_key, key) = self.git()?.discover(path)?;
        self.store.register(&repo_key, &key, workspace)
    }
    pub fn recent_workspaces(&self) -> Result<Vec<Workspace>> {
        self.store.workspaces()
    }
    pub fn set_trust(&self, id: &str, trusted: bool) -> Result<()> {
        self.store.trust(id, trusted)
    }
    pub fn preferences(&self) -> Result<Preferences> {
        self.store.preferences()
    }
    pub fn set_preferences(&self, preferences: Preferences) -> Result<()> {
        self.store.set_preferences(&preferences)
    }
    pub fn changes(&self, workspace_id: &str) -> Result<Changes> {
        self.git()?.changes(&self.store.workspace(workspace_id)?)
    }

    pub fn file_diff(&mut self, workspace_id: &str, path: &str, side: Side) -> Result<FileDiff> {
        let workspace = self.store.workspace(workspace_id)?;
        let git = self.git()?;
        let changes = git.changes(&workspace)?;
        let file = changes
            .files
            .iter()
            .find(|f| f.path == path && f.side == side)
            .ok_or_else(|| {
                Error::new(
                    "CHANGE_MISSING",
                    "此文件在当前比较范围内已无变化，请刷新列表。",
                    path,
                )
            })?;
        let before = git.guard(&workspace, path, file.old_path.as_deref())?;
        let raw_patch = git.patch(&workspace, file)?;
        let after = git.guard(&workspace, path, file.old_path.as_deref())?;
        if before != after {
            return Err(Error::stale());
        }
        let base = format!(
            "{}:{}",
            changes.head.as_deref().unwrap_or("unborn"),
            changes.branch.as_deref().unwrap_or("detached")
        );
        let identity = fingerprint(&[
            workspace_id.as_bytes(),
            side.as_str().as_bytes(),
            base.as_bytes(),
            path.as_bytes(),
            patch::content_identity(&raw_patch).as_bytes(),
        ]);
        let mut hunks = patch::hunks(&raw_patch, &identity);
        let metadata = patch::metadata(&raw_patch);
        // Type changes can be encoded as delete/add sections for the same path.
        // They are one file action, never independent text hunks.
        if metadata.sections > 1 || file.status == "T" {
            hunks.clear();
        }
        let kind = if file.conflicted {
            FileKind::Conflict
        } else if metadata.has_mode("160000") {
            FileKind::Submodule
        } else if metadata.has_mode("120000") || raw_patch.starts_with("Untracked symbolic link") {
            FileKind::Symlink
        } else if metadata.binary {
            FileKind::Binary
        } else if file.old_path.is_some() {
            FileKind::Rename
        } else if hunks.is_empty() {
            FileKind::Metadata
        } else {
            FileKind::Text
        };
        if hunks.is_empty() || metadata.mode_changed() {
            hunks.push(Hunk {
                id: fingerprint(&[identity.as_bytes(), raw_patch.as_bytes()]),
                header: if metadata.mode_changed() {
                    format!(
                        "文件权限 {} → {}",
                        metadata.old_mode.as_deref().unwrap_or(""),
                        metadata.new_mode.as_deref().unwrap_or("")
                    )
                } else {
                    "文件属性与内容变化".into()
                },
                old_start: 0,
                new_start: 0,
                lines: vec![],
                review_state: "unreviewed".into(),
                patch: String::new(),
            });
        }
        for hunk in &mut hunks {
            hunk.review_state =
                self.store
                    .review_state(workspace_id, path, side.as_str(), &hunk.id)?;
        }
        let additions = hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|line| line.kind == "add")
            .count();
        let deletions = hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|line| line.kind == "delete")
            .count();
        let notice = if file.conflicted {
            Some("此文件存在冲突。请在外部编辑器解决后刷新。".into())
        } else if !workspace.trusted {
            Some("受限查看：已禁用配置中的外部过滤器。信任仓库后可执行 Git 写操作。".into())
        } else if metadata.sections > 1 || file.status == "T" {
            Some(
                "文件类型发生变化。请核对原始 patch，使用文件级暂存；此变化不提供局部文本操作。"
                    .into(),
            )
        } else if metadata.mode_changed() {
            Some("文件执行权限也发生了变化。局部暂存仅处理文本，文件级动作包含权限变化。".into())
        } else if kind != FileKind::Text {
            Some("此变化使用专用摘要。可查看原始 patch；不支持局部文本操作。".into())
        } else {
            None
        };
        let can_stage = workspace.trusted
            && !file.conflicted
            && kind != FileKind::Submodule
            && !raw_patch.starts_with("Untracked symbolic link")
            && changes.operation.is_none();
        let can_discard = can_stage
            && side == Side::Unstaged
            && kind == FileKind::Text
            && ["M", "D"].contains(&file.status.as_str())
            && !metadata.mode_changed()
            && cfg!(any(target_os = "macos", target_os = "linux"));
        let diff = FileDiff {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: workspace_id.into(),
            path: path.into(),
            old_path: file.old_path.clone(),
            side,
            base,
            captured_at: now(),
            token: fingerprint(&[raw_patch.as_bytes(), before.as_bytes()]),
            patch: raw_patch,
            hunks,
            additions,
            deletions,
            kind,
            notice,
            can_stage,
            can_stage_hunks: can_stage
                && metadata.sections == 1
                && file.status != "T"
                && kind == FileKind::Text
                && file.status != "?"
                && file.status != "A"
                && file.status != "D",
            can_discard,
            can_discard_hunks: can_discard && file.status == "M",
            discard_reason: (!can_discard).then(|| "仅支持已信任仓库中，已跟踪的普通文本变化；暂存、重命名和属性变化不在丢弃范围内。".into()),
            guard: before,
        };
        self.snapshot_order.push_back(diff.id.clone());
        self.snapshots.insert(diff.id.clone(), diff.clone());
        while self.snapshot_order.len() > 64 {
            if let Some(old) = self.snapshot_order.pop_front() {
                self.snapshots.remove(&old);
            }
        }
        Ok(diff)
    }
    pub(crate) fn snapshot(&self, id: &str) -> Result<FileDiff> {
        self.snapshots
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new("SNAPSHOT_EXPIRED", "阅读快照已释放，请重新打开文件。", id))
    }
    pub(crate) fn validate(&self, diff: &FileDiff) -> Result<Workspace> {
        let workspace = self.store.workspace(&diff.workspace_id)?;
        if self
            .git()?
            .guard(&workspace, &diff.path, diff.old_path.as_deref())?
            != diff.guard
        {
            return Err(Error::stale());
        }
        Ok(workspace)
    }
    pub fn mark_reviewed(
        &mut self,
        snapshot_id: &str,
        hunk_id: Option<&str>,
        reviewed: bool,
    ) -> Result<()> {
        let diff = self.snapshot(snapshot_id)?;
        self.validate(&diff)?;
        let ids = selected_units(&diff, hunk_id)?;
        self.store.mark(
            &diff.workspace_id,
            &diff.path,
            diff.side.as_str(),
            &ids,
            reviewed,
        )
    }
    pub fn stage(&mut self, snapshot_id: &str, hunk_id: Option<&str>) -> Result<OperationResult> {
        let diff = self.snapshot(snapshot_id)?;
        let workspace = self.validate(&diff)?;
        self.require_write(&workspace)?;
        if !diff.can_stage || (hunk_id.is_some() && !diff.can_stage_hunks) {
            return Err(Error::new(
                "UNSUPPORTED_PATCH",
                "此变化不支持所选暂存操作，请使用文件级动作或外部 Git。",
                diff.kind,
            ));
        }
        let patch = if let Some(id) = hunk_id {
            let hunk = diff
                .hunks
                .iter()
                .find(|h| h.id == id)
                .ok_or_else(|| Error::new("HUNK_MISSING", "所选变化块已失效。", id))?;
            if hunk.patch.is_empty() {
                return Err(Error::new(
                    "METADATA_REQUIRES_FILE_ACTION",
                    "文件属性变化请使用文件级暂存动作。",
                    &hunk.header,
                ));
            }
            patch::select(&diff.patch, hunk)
        } else {
            diff.patch.clone()
        };
        let git = self.git()?;
        let lock = IndexLock::acquire(Path::new(&workspace.git_dir))?;
        self.validate(&diff)?;
        let bytes = git.index_bytes(&workspace)?;
        let private = tempfile::TempDir::new_in(&self.data_dir)?;
        let private_index = private.path().join("index");
        if !bytes.is_empty() {
            fs::write(&private_index, &bytes)?;
        }
        git.apply(
            &workspace,
            &patch,
            diff.side == Side::Staged,
            &private_index,
        )?;
        let expected_index = fs::read(&private_index)?;
        self.validate(&diff)?;
        lock.publish(&expected_index)?;
        let matches_index = git.index_bytes(&workspace)? == expected_index;
        // Explicitly re-read index and HEAD after the mutation. UI always refreshes
        // from this actual state rather than assuming an optimistic update succeeded.
        let after = git.changes(&workspace).map_err(|e| {
            Error::new(
                "GIT_APPLIED_REFRESH_REQUIRED",
                "Git 已执行暂存操作，但核对结果失败。请刷新后检查实际索引。",
                e,
            )
        })?;
        let migration_warning = self
            .migrate_after_stage(&diff, hunk_id)
            .err()
            .map(|e| format!("Git 操作已完成，但审查记录未能迁移，请重新核对：{e}"));
        let matches_base = diff.base
            == format!(
                "{}:{}",
                after.head.as_deref().unwrap_or("unborn"),
                after.branch.as_deref().unwrap_or("detached")
            );
        let mut result = OperationResult {
            ok: matches_index && matches_base,
            message: if !matches_index || !matches_base {
                "暂存已执行，但核对结果不一致，请检查实际索引"
            } else if diff.side == Side::Staged {
                "已撤销所选暂存"
            } else {
                "已暂存所选变化"
            }
            .into(),
            actual_head: after.head,
            actual_branch: after.branch,
            warning: if matches_index && matches_base {
                migration_warning
            } else {
                Some("暂存后检测到外部索引或分支更新，请核对实际状态。Proof 没有自动回退。".into())
            },
        };
        if let Err(error) = self.store.record_operation(
            &workspace.id,
            if diff.side == Side::Staged {
                "unstage"
            } else {
                "stage"
            },
            &serde_json::to_string(&result)?,
        ) {
            result.warning = Some(format!("Git 操作已完成，但本地操作记录保存失败：{error}"));
        }
        Ok(result)
    }
    fn migrate_after_stage(&mut self, source: &FileDiff, selected: Option<&str>) -> Result<()> {
        if source.kind != FileKind::Text {
            return Ok(());
        }
        let target_side = if source.side == Side::Staged {
            Side::Unstaged
        } else {
            Side::Staged
        };
        let changes = self.changes(&source.workspace_id)?;
        if !changes
            .files
            .iter()
            .any(|f| f.path == source.path && f.side == target_side)
        {
            return Ok(());
        }
        let target = self.file_diff(&source.workspace_id, &source.path, target_side)?;
        // A successful operation alone is insufficient. Both complete base blob
        // identities and exact hunk patches must agree across the comparison sides.
        if source.base != target.base
            || patch::content_identity(&source.patch) != patch::content_identity(&target.patch)
        {
            return Ok(());
        }
        for old in source
            .hunks
            .iter()
            .filter(|h| selected.is_none() || selected == Some(h.id.as_str()))
        {
            let candidates: Vec<&Hunk> = target
                .hunks
                .iter()
                .filter(|h| h.patch == old.patch)
                .collect();
            if candidates.len() == 1 && !old.patch.is_empty() {
                self.store.migrate_mark(
                    &source.workspace_id,
                    &source.path,
                    target_side.as_str(),
                    &old.id,
                    &candidates[0].id,
                )?;
            }
        }
        Ok(())
    }
    pub(crate) fn require_write(&self, workspace: &Workspace) -> Result<()> {
        if !workspace.trusted {
            return Err(Error::new(
                "TRUST_REQUIRED",
                "请先确认信任此仓库，再执行 Git 写操作。",
                "Git hooks, signing and configured filters may execute",
            ));
        }
        if let Some(state) = self.git()?.state(workspace) {
            return Err(Error::new(
                "GIT_IN_PROGRESS",
                "仓库正在执行其他 Git 流程，请在外部完成后重试。",
                state,
            ));
        }
        Ok(())
    }
    pub fn commit_preview(&mut self, workspace_id: &str) -> Result<CommitPreview> {
        let workspace = self.store.workspace(workspace_id)?;
        self.require_write(&workspace)?;
        let git = self.git()?;
        let before = git.index_bytes(&workspace)?;
        let changes = git.changes(&workspace)?;
        let files: Vec<ChangedFile> = changes
            .files
            .into_iter()
            .filter(|f| f.side == Side::Staged)
            .collect();
        if files.is_empty() {
            return Err(Error::new(
                "NOTHING_STAGED",
                "请先暂存需要提交的变化。",
                "Index has no changes",
            ));
        }
        let (mut reviewed, mut total) = (0, 0);
        for file in &files {
            let diff = self.file_diff(workspace_id, &file.path, Side::Staged)?;
            total += diff.hunks.len();
            reviewed += diff
                .hunks
                .iter()
                .filter(|h| h.review_state == "reviewed")
                .count();
        }
        if before != git.index_bytes(&workspace)? || changes.head != git.head(&workspace)? {
            return Err(Error::stale());
        }
        let preview = CommitPreview {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: workspace_id.into(),
            branch: changes.branch,
            head: changes.head,
            files,
            reviewed,
            total,
            index_fingerprint: fingerprint(&[&before]),
            captured_at: now(),
        };
        if self.previews.len() > 16 {
            self.previews.clear();
        }
        self.previews.insert(preview.id.clone(), preview.clone());
        Ok(preview)
    }
    pub fn commit(&mut self, preview_id: &str, message: &str) -> Result<OperationResult> {
        if message.trim().is_empty() || message.len() > 65536 || message.contains('\0') {
            return Err(Error::new(
                "COMMIT_MESSAGE",
                "请输入有效的提交说明。",
                "Message must be nonempty and at most 64 KiB",
            ));
        }
        let preview = self
            .previews
            .get(preview_id)
            .cloned()
            .ok_or_else(Error::stale)?;
        let workspace = self.store.workspace(&preview.workspace_id)?;
        self.require_write(&workspace)?;
        let git = self.git()?;
        // Hold Git's real index lock, but let git commit use a captured private
        // index. Hooks/signing remain Git's responsibility. External index writers
        // cannot introduce unselected content between preview and this commit.
        let _lock = IndexLock::acquire(Path::new(&workspace.git_dir))?;
        let bytes = git.index_bytes(&workspace)?;
        if fingerprint(&[&bytes]) != preview.index_fingerprint
            || git.head(&workspace)? != preview.head
            || git.branch(&workspace)? != preview.branch
        {
            return Err(Error::stale());
        }
        if self.store.preferences()?.strict_review {
            let mut reviewed = 0;
            let mut total = 0;
            for file in &preview.files {
                let diff = self.file_diff(&workspace.id, &file.path, Side::Staged)?;
                total += diff.hunks.len();
                reviewed += diff
                    .hunks
                    .iter()
                    .filter(|h| h.review_state == "reviewed")
                    .count();
            }
            if reviewed != total {
                return Err(Error::new(
                    "REVIEW_REQUIRED",
                    "本应用已启用提交前审查，请完成已暂存内容的审查。",
                    format!("{reviewed}/{total}"),
                ));
            }
        }
        let mut index = tempfile::NamedTempFile::new_in(&self.data_dir)?;
        index.write_all(&bytes)?;
        index.flush()?;
        let mut tree_cmd = git.command(&workspace)?;
        tree_cmd.arg("write-tree");
        git::index_override(&mut tree_cmd, index.path());
        let expected_tree = git::text(process::checked(process::run(
            tree_cmd,
            None,
            Duration::from_secs(20),
        )?)?)?
        .trim()
        .to_string();
        let mut command = git.command(&workspace)?;
        command.args(["commit", "--file=-"]);
        git::index_override(&mut command, index.path());
        let output = process::run(command, Some(message.as_bytes()), Duration::from_secs(120))?;
        let actual_head = git.head(&workspace)?;
        if output.code != 0 {
            return Err(Error::new(
                "COMMIT_FAILED",
                "提交未成功，说明草稿已保留。请检查 Git Hook 或签名错误后刷新。",
                String::from_utf8_lossy(&output.stderr),
            ));
        }
        let actual = git::text(git.query(&workspace, &["show", "-s", "--format=%T%n%P", "HEAD"])?)?;
        let mut lines = actual.lines();
        let tree = lines.next().unwrap_or("");
        let parents = lines.next().unwrap_or("");
        let actual_branch = git.branch(&workspace)?;
        let target_ref = preview
            .branch
            .as_ref()
            .map(|b| format!("refs/heads/{b}"))
            .unwrap_or("HEAD".into());
        let target_query = git.query(&workspace, &["rev-parse", "--verify", &target_ref]);
        let target_head = target_query
            .as_ref()
            .ok()
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .map(str::trim);
        let matches = tree == expected_tree
            && parents == preview.head.as_deref().unwrap_or("")
            && actual_branch == preview.branch
            && target_head.is_some()
            && actual_head.as_deref() == target_head;
        let mut result = OperationResult {
            ok: matches,
            message: if matches {
                "提交已完成"
            } else {
                "提交已产生，实际结果与预览不同，请核对历史"
            }
            .into(),
            actual_head,
            actual_branch,
            warning: if matches {
                None
            } else if target_head.is_none() {
                Some("Git 提交已产生，但原预览目标分支已不存在或无法读取。请核对实际分支和提交；Proof 没有自动回退仓库。".into())
            } else {
                Some(
                    "Hook 或外部操作改变了提交对象。Proof 已保留实际结果，没有自动回退仓库。"
                        .into(),
                )
            },
        };
        if let Err(error) =
            self.store
                .record_operation(&workspace.id, "commit", &serde_json::to_string(&result)?)
        {
            result.warning = Some(format!(
                "Git 提交已产生，但本地操作记录保存失败，请核对历史：{error}"
            ));
        }
        self.previews.remove(preview_id);
        Ok(result)
    }
    pub fn history(
        &self,
        workspace_id: &str,
        offset: usize,
        path: Option<&str>,
    ) -> Result<Vec<CommitEntry>> {
        self.git()?
            .history(&self.store.workspace(workspace_id)?, offset, path)
    }
    pub fn commit_diff(&self, workspace_id: &str, oid: &str, parent: usize) -> Result<String> {
        if !(4..=64).contains(&oid.len()) || !oid.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(Error::new(
                "INVALID_REVISION",
                "请选择有效的提交。",
                "Expected a hexadecimal Git object ID",
            ));
        }
        let workspace = self.store.workspace(workspace_id)?;
        let git = self.git()?;
        let commit = git::text(git.query(
            &workspace,
            &["rev-parse", "--verify", &format!("{oid}^{{commit}}")],
        )?)?
        .trim()
        .to_string();
        let ancestry = git::text(git.query(&workspace, &["show", "-s", "--format=%P", &commit])?)?;
        let parents: Vec<&str> = ancestry.split_whitespace().collect();
        if parents.is_empty() {
            return git::text(git.query(
                &workspace,
                &[
                    "diff-tree",
                    "-r",
                    "--root",
                    "--no-commit-id",
                    "-p",
                    "--binary",
                    "--full-index",
                    "--no-ext-diff",
                    "--no-textconv",
                    &commit,
                    "--",
                ],
            )?);
        }
        let base = parents
            .get(parent)
            .ok_or_else(|| Error::new("INVALID_PARENT", "所选父提交不存在。", parent))?;
        git::text(git.query(
            &workspace,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--binary",
                "--full-index",
                base,
                &commit,
                "--",
            ],
        )?)
    }
    pub fn branches(&self, workspace_id: &str) -> Result<Vec<BranchEntry>> {
        self.git()?.branches(&self.store.workspace(workspace_id)?)
    }
    pub fn worktrees(&self, workspace_id: &str) -> Result<Vec<WorktreeEntry>> {
        self.git()?.worktrees(&self.store.workspace(workspace_id)?)
    }
    pub fn switch_branch(
        &mut self,
        workspace_id: &str,
        name: &str,
        create: bool,
        expected_token: &str,
    ) -> Result<OperationResult> {
        let workspace = self.store.workspace(workspace_id)?;
        self.require_write(&workspace)?;
        let git = self.git()?;
        if git.changes(&workspace)?.token != expected_token {
            return Err(Error::stale());
        }
        git.query(&workspace, &["check-ref-format", "--branch", name])?;
        let mut cmd = git.command(&workspace)?;
        cmd.arg("switch");
        if create {
            cmd.arg("--create").arg(name);
        } else {
            cmd.arg("--").arg(name);
        }
        process::checked(process::run(cmd, None, Duration::from_secs(30))?)?;
        let after = git.changes(&workspace)?;
        Ok(OperationResult {
            ok: after.branch.as_deref() == Some(name),
            message: "已切换分支，请核对新的比较基准".into(),
            actual_head: after.head,
            actual_branch: after.branch,
            warning: None,
        })
    }
}

fn selected_units(diff: &FileDiff, hunk_id: Option<&str>) -> Result<Vec<String>> {
    if let Some(id) = hunk_id {
        if !diff.hunks.iter().any(|h| h.id == id) {
            return Err(Error::new("HUNK_MISSING", "所选变化块已失效。", id));
        }
        Ok(vec![id.into()])
    } else {
        Ok(diff.hunks.iter().map(|h| h.id.clone()).collect())
    }
}

pub(crate) struct IndexLock {
    path: PathBuf,
    file: fs::File,
    published: bool,
}
impl IndexLock {
    pub(crate) fn acquire(git_dir: &Path) -> Result<Self> {
        let path = git_dir.join("index.lock");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| {
                Error::new("GIT_LOCKED", "索引正在被其他 Git 操作使用，请稍后重试。", e)
            })?;
        Ok(Self {
            path,
            file,
            published: false,
        })
    }
    fn publish(mut self, bytes: &[u8]) -> Result<()> {
        self.file.write_all(bytes)?;
        self.file.sync_all()?;
        let destination = self.path.with_file_name("index");
        fs::rename(&self.path, &destination)?;
        self.published = true;
        Ok(())
    }
}
impl Drop for IndexLock {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_file(&self.path);
        }
    }
}
