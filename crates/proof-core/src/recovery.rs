use crate::{
    guarded_file::{self, BoundFile, FileImage, RecoveryLease},
    model::*,
    now,
    service::IndexLock,
    Error, Proof, Result,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const CAPACITY: u64 = 256 * 1024 * 1024;
type StoredRecovery = (String, Option<Vec<u8>>, Option<Vec<u8>>);

#[derive(Serialize, Deserialize)]
struct Record {
    #[serde(default)]
    schema_version: u32,
    point: RecoveryPoint,
    guard: String,
    context: String,
    before: Option<FileImage>,
    after: Option<FileImage>,
}

impl Proof {
    fn recovery_usage(&self) -> Result<u64> {
        let mut query = self.store.connection.prepare("SELECT id,reserved_bytes,COALESCE(length(before_data),0)+COALESCE(length(after_data),0) FROM recovery_points")?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u64>(1)?,
                    r.get::<_, u64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut total = 0u64;
        for (id, reserved, immutable) in rows {
            let directory = self.recovery_directory(&id)?;
            let mut actual = immutable + 8192;
            for name in [
                "original",
                "discarded-version",
                "new.candidate",
                "undo.candidate",
            ] {
                match fs::symlink_metadata(directory.join(name)) {
                    Ok(meta) => actual = actual.saturating_add(meta.len()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
            // An external editor can still grow a captured inode through an old
            // descriptor. Preserve that data, but block further allocations.
            total = total.saturating_add(reserved.max(actual));
        }
        Ok(total)
    }
    fn recovery_directory(&self, id: &str) -> Result<PathBuf> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(Error::new("RECOVERY_MISSING", "恢复点不存在。", id));
        }
        Ok(self.data_dir.join("recovery").join(id))
    }
    fn load_recovery(&self, id: &str) -> Result<Record> {
        let row: Option<StoredRecovery> = self
            .store
            .connection
            .query_row(
                "SELECT payload,before_data,after_data FROM recovery_points WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (payload, before, after) =
            row.ok_or_else(|| Error::new("RECOVERY_MISSING", "恢复点不存在或已经过期。", id))?;
        let mut record: Record = serde_json::from_str(&payload)?;
        if let Some(image) = &mut record.before {
            image.bytes = before.ok_or_else(|| {
                Error::new("RECOVERY_DAMAGED", "恢复内容不完整，已阻止写入。", id)
            })?;
        }
        if let Some(image) = &mut record.after {
            image.bytes = after.ok_or_else(|| {
                Error::new("RECOVERY_DAMAGED", "恢复内容不完整，已阻止写入。", id)
            })?;
        }
        Ok(record)
    }
    fn save_recovery(&self, record: &Record) -> Result<()> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM recovery_points WHERE id=?)",
            [&record.point.id],
            |r| r.get(0),
        )?;
        if !exists {
            let used = self.recovery_usage()?;
            if used.saturating_add(record.point.bytes) > CAPACITY {
                return Err(Error::new(
                    "RECOVERY_FULL",
                    "恢复点已达到 256 MiB 上限，未执行丢弃。",
                    "Concurrent quota reservation",
                ));
            }
        }
        transaction.execute("INSERT INTO recovery_points VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET point=excluded.point,payload=excluded.payload",
            params![record.point.id, record.point.workspace_id, serde_json::to_string(&record.point)?, serde_json::to_string(record)?, record.point.expires_at, record.point.bytes,
                record.before.as_ref().map(|f| &f.bytes), record.after.as_ref().map(|f| &f.bytes)])?;
        transaction.commit()?;
        Ok(())
    }
    pub(crate) fn expire_recovery(&self) -> Result<()> {
        let mut statement = self
            .store
            .connection
            .prepare("SELECT id FROM recovery_points WHERE expires_at<=?")?;
        let ids = statement
            .query_map([now()], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in ids {
            let path = self.recovery_directory(&id)?;
            let _lease = if path.exists() {
                match RecoveryLease::acquire(&path) {
                    Ok(lease) => Some(lease),
                    Err(e) if e.code == "RECOVERY_BUSY" => continue,
                    Err(e) => return Err(e),
                }
            } else {
                None
            };
            if path.exists() {
                fs::remove_dir_all(path)?;
            }
            let tx = rusqlite::Transaction::new_unchecked(
                &self.store.connection,
                rusqlite::TransactionBehavior::Immediate,
            )?;
            tx.execute("DELETE FROM recovery_points WHERE id=?", [id])?;
            crate::data::mark_cleanup_pending(&tx)?;
            tx.commit()?;
        }
        Ok(())
    }
    pub fn recovery_points(&self, workspace_id: &str) -> Result<Vec<RecoveryPoint>> {
        self.store.workspace(workspace_id)?;
        self.expire_recovery()?;
        let mut statement = self.store.connection.prepare(
            "SELECT point FROM recovery_points WHERE workspace_id=? ORDER BY expires_at DESC",
        )?;
        let rows = statement
            .query_map([workspace_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|row| serde_json::from_str(&row).map_err(Error::from))
            .collect()
    }
    pub fn discard_preview(
        &mut self,
        snapshot_id: &str,
        hunk_id: Option<&str>,
    ) -> Result<RecoveryPoint> {
        let diff = self.snapshot(snapshot_id)?;
        let workspace = self.validate(&diff)?;
        self.require_write(&workspace)?;
        if !diff.can_discard || (hunk_id.is_some() && !diff.can_discard_hunks) {
            return Err(Error::new(
                "UNSUPPORTED_DISCARD",
                "此变化不支持安全丢弃。",
                diff.discard_reason.as_deref().unwrap_or("Unsupported hunk"),
            ));
        }
        self.expire_recovery()?;
        let git = self.git()?;
        let _lock = IndexLock::acquire(Path::new(&workspace.git_dir))?;
        self.validate(&diff)?;
        let file = BoundFile::open(Path::new(&workspace.path), &diff.path)?;
        let before = file.read()?;
        let index_content = git.index_worktree_content(&workspace, &diff.path)?;
        if index_content.len() > 32 * 1024 * 1024
            || index_content.contains(&0)
            || std::str::from_utf8(&index_content).is_err()
        {
            return Err(Error::new(
                "UNSUPPORTED_RECOVERY_ENCODING",
                "索引内容不是受支持的 UTF-8 文本，已阻止丢弃。",
                &diff.path,
            ));
        }
        let content = if let Some(id) = hunk_id {
            let source = before.as_ref().ok_or_else(Error::stale)?;
            let selected = diff
                .hunks
                .iter()
                .find(|h| h.id == id && !h.lines.is_empty())
                .ok_or_else(|| Error::new("HUNK_MISSING", "所选变化块已失效。", id))?;
            // Prove the entire transformation is reversible before offering a
            // partial write. This catches custom filters, encodings and mixed EOL.
            let mut reversed = source.bytes.clone();
            for hunk in diff.hunks.iter().rev().filter(|h| !h.lines.is_empty()) {
                reversed = reverse_hunk(&reversed, hunk, &index_content)?;
            }
            if reversed != index_content {
                return Err(Error::new(
                    "UNSUPPORTED_HUNK_TRANSFORM",
                    "过滤器或行尾转换使此 Hunk 无法安全还原，请使用文件级预览。",
                    "Full inverse differs from effective index content",
                ));
            }
            reverse_hunk(&source.bytes, selected, &index_content)?
        } else {
            index_content
        };
        let mode = if let Some(before) = &before {
            before.mode
        } else {
            // Git::command already forces --literal-pathspecs for every command.
            let entries =
                git.query(&workspace, &["ls-files", "--stage", "-z", "--", &diff.path])?;
            if entries.starts_with(b"100755 ") {
                0o755
            } else if entries.starts_with(b"100644 ") {
                0o644
            } else {
                return Err(Error::new(
                    "UNSUPPORTED_DISCARD",
                    "索引中的文件类型不支持恢复。",
                    &diff.path,
                ));
            }
        };
        let after = Some(FileImage {
            bytes: content,
            mode,
            identity: String::new(),
        });
        let size = 2
            * (before.as_ref().map_or(0, |f| f.bytes.len())
                + after.as_ref().map_or(0, |f| f.bytes.len())) as u64
            + 8192;
        let used = self.recovery_usage()?;
        if used.saturating_add(size) > CAPACITY {
            return Err(Error::new(
                "RECOVERY_FULL",
                "恢复点已达到 256 MiB 上限，无法保存新恢复点，因此未执行丢弃。",
                format!("Used {used}, required {size}"),
            ));
        }
        let created_at = now();
        let point = RecoveryPoint {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: workspace.id.clone(),
            path: diff.path.clone(),
            scope: hunk_id.map_or_else(
                || "文件全部未暂存变化".into(),
                |_| {
                    format!(
                        "单个 Hunk（{}）",
                        diff.hunks
                            .iter()
                            .find(|h| Some(h.id.as_str()) == hunk_id)
                            .unwrap()
                            .header
                    )
                },
            ),
            status: "prepared".into(),
            created_at,
            expires_at: created_at + RETENTION_MS,
            bytes: size,
            message: None,
        };
        let directory = self.recovery_directory(&point.id)?;
        fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        }
        file.check_volume(&directory)?;
        self.validate(&diff)?;
        if !file.same_parent(&BoundFile::open(Path::new(&workspace.path), &diff.path)?)?
            || !guarded_file::matches(&before, &file.read()?)
        {
            return Err(Error::stale());
        }
        let record = Record {
            schema_version: 1,
            point: point.clone(),
            guard: diff.guard,
            context: git.context_guard(&workspace)?,
            before,
            after,
        };
        // SQLite synchronous=FULL makes the bytes durable before any source move.
        if let Err(error) = self.save_recovery(&record) {
            let _ = fs::remove_dir(&directory);
            return Err(error);
        }
        Ok(point)
    }
    pub fn cancel_discard_preview(&self, id: &str) -> Result<()> {
        let directory = self.recovery_directory(id)?;
        // A failed database delete may leave only the prepared record. Such a
        // retry has no filesystem mutation to protect and must remain cancellable.
        let _lease = if directory.exists() {
            Some(RecoveryLease::acquire(&directory)?)
        } else {
            None
        };
        let record = self.load_recovery(id)?;
        if record.point.status != "prepared" {
            return Err(Error::new(
                "RECOVERY_ACTIVE",
                "此恢复点已开始使用，不能作为预览取消。",
                id,
            ));
        }
        if directory.join("original").exists() {
            return Err(Error::new(
                "RECOVERY_ACTIVE",
                "恢复目录中存在原文件，请检查恢复点。",
                id,
            ));
        }
        if directory.exists() {
            fs::remove_dir_all(directory)?;
        }
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        tx.execute("DELETE FROM recovery_points WHERE id=?", [id])?;
        crate::data::mark_cleanup_pending(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn discard(&mut self, id: &str) -> Result<RecoveryAction> {
        self.perform_recovery(id, false, false)
    }
    pub fn undo_discard(&mut self, id: &str) -> Result<RecoveryAction> {
        self.perform_recovery(id, true, false)
    }
    pub fn restore_missing_recovery(&mut self, id: &str) -> Result<RecoveryAction> {
        self.perform_recovery(id, true, true)
    }
    fn perform_recovery(
        &mut self,
        id: &str,
        undo: bool,
        restore_missing: bool,
    ) -> Result<RecoveryAction> {
        let _lease = RecoveryLease::acquire(&self.recovery_directory(id)?)?;
        let mut record = self.load_recovery(id)?;
        if record.point.expires_at <= now() {
            return Err(Error::new(
                "RECOVERY_EXPIRED",
                "恢复点已过期，未执行写入。",
                id,
            ));
        }
        let workspace = self.store.workspace(&record.point.workspace_id)?;
        self.require_write(&workspace)?;
        let directory = self.recovery_directory(id)?;
        let original = directory.join("original");
        if (!undo && record.point.status != "prepared")
            || (undo
                && !["applied", "applying", "undoing", "conflict"]
                    .contains(&record.point.status.as_str()))
        {
            return Err(Error::new(
                "RECOVERY_STATE",
                "恢复点状态不支持此动作。",
                &record.point.status,
            ));
        }
        let git = self.git()?;
        let _lock = IndexLock::acquire(Path::new(&workspace.git_dir))?;
        let context = git.context_guard(&workspace)?;
        if record.schema_version > 1 {
            return Err(Error::new(
                "RECOVERY_VERSION",
                "恢复点来自更新版本，请使用对应版本打开。",
                record.schema_version,
            ));
        }
        if record.schema_version == 0 {
            // Store::workspace already checked both current physical identities.
            // Require the old recorded base as well; never just replace hashes.
            if record.context != context
                && record.context != git.legacy_recovery_context(&workspace)?
            {
                return Err(Error::stale());
            }
            if record.point.status == "prepared" {
                let current_guard = git.guard(&workspace, &record.point.path, None)?;
                if record.guard != current_guard
                    && record.guard != git.legacy_recovery_guard(&workspace, &record.point.path)?
                {
                    return Err(Error::stale());
                }
                record.guard = current_guard;
            }
            record.context = context.clone();
            record.schema_version = 1;
            self.save_recovery(&record)?;
        }
        if context != record.context {
            return Err(Error::stale());
        }
        let file = BoundFile::open(Path::new(&workspace.path), &record.point.path)?;
        file.check_volume(&directory)?;
        let current = file.read()?;
        if restore_missing && (current.is_some() || record.before.is_none()) {
            return Err(Error::new(
                "RECOVERY_RECREATE_SCOPE",
                "仅能将保存的文件恢复到当前为空的路径，现有文件未被修改。",
                id,
            ));
        }
        // A saved in-progress undo may already have published its destination.
        // Reconcile it without running another filesystem mutation.
        if undo
            && ["applying", "undoing", "conflict"].contains(&record.point.status.as_str())
            && guarded_file::matches(&current, &record.before)
        {
            record.point.status = "undone".into();
            record.point.message = None;
            self.save_recovery(&record)?;
            return Ok(RecoveryAction {
                point: record.point,
                result: OperationResult {
                    ok: true,
                    message: "已核对：文件匹配丢弃前的保存版本。".into(),
                    actual_head: git.head(&workspace)?,
                    actual_branch: git.branch(&workspace)?,
                    warning: None,
                },
            });
        }
        let (expected, desired) = if undo {
            if !restore_missing && current.is_none() && record.before.is_some() {
                return Err(Error::new("RECOVERY_MISSING_PATH", "当前路径已无文件，无法判断是操作中断还是后续删除。请单独确认是否将保存版本恢复到空路径。", &record.point.path));
            }
            if !restore_missing && !guarded_file::matches(&current, &record.after) {
                return Err(Error::stale());
            }
            if original.exists() {
                let saved = guarded_file::read_saved(&original)?;
                if record
                    .before
                    .as_ref()
                    .is_none_or(|image| !image.same_content(&saved))
                {
                    return Err(Error::new(
                        "RECOVERY_CONCURRENT_BACKUP",
                        "原文件的恢复副本收到后续编辑，请先查看副本，未覆盖当前文件。",
                        original.display(),
                    ));
                }
            }
            (current, record.before.clone())
        } else {
            if git.guard(&workspace, &record.point.path, None)? != record.guard
                || !guarded_file::matches(&current, &record.before)
            {
                return Err(Error::stale());
            }
            (record.before.clone(), record.after.clone())
        };
        if !file.same_parent(&BoundFile::open(
            Path::new(&workspace.path),
            &record.point.path,
        )?)? {
            return Err(Error::stale());
        }
        record.point.status = if undo { "undoing" } else { "applying" }.into();
        record.point.message = None;
        self.save_recovery(&record)?;
        let backup = directory.join(if undo {
            "discarded-version"
        } else {
            "original"
        });
        let candidate = directory.join(if undo {
            "undo.candidate"
        } else {
            "new.candidate"
        });
        if candidate.exists() {
            fs::remove_file(&candidate)?;
        }
        let metadata_source = (undo && original.exists()).then_some(original.as_path());
        let mutation = file.replace(&expected, &desired, &backup, &candidate, metadata_source);
        if candidate.exists() {
            let _ = fs::remove_file(&candidate);
        }
        let check = (|| -> Result<()> {
            mutation?;
            if git.context_guard(&workspace)? != record.context
                || !file.same_parent(&BoundFile::open(
                    Path::new(&workspace.path),
                    &record.point.path,
                )?)?
                || !guarded_file::matches(&file.read()?, &desired)
            {
                return Err(Error::stale());
            }
            Ok(())
        })();
        record.point.status = if check.is_ok() {
            if undo {
                "undone"
            } else {
                "applied"
            }
        } else {
            "conflict"
        }
        .into();
        record.point.message = check
            .as_ref()
            .err()
            .map(|e| format!("{} 恢复内容已保留，请检查当前文件。", e.message));
        let mut result = OperationResult {
            ok: check.is_ok(),
            message: if check.is_ok() {
                if undo {
                    "已恢复丢弃前的内容。"
                } else {
                    "已丢弃所选未暂存变化，恢复点保留 7 天。"
                }
            } else {
                "检测到并发变化或文件操作失败，请检查当前文件和恢复副本。"
            }
            .into(),
            actual_head: git.head(&workspace).ok().flatten(),
            actual_branch: git.branch(&workspace).ok().flatten(),
            warning: record.point.message.clone(),
        };
        if let Err(error) = self.save_recovery(&record) {
            result.warning = Some(format!(
                "文件操作已执行，但结果记录保存失败；恢复内容仍在，请检查恢复点。{}",
                error.message
            ));
        }
        Ok(RecoveryAction {
            point: record.point,
            result,
        })
    }
    pub fn recovery_content(&self, id: &str) -> Result<serde_json::Value> {
        self.expire_recovery()?;
        let directory = self.recovery_directory(id)?;
        let _lease = if directory.exists() {
            Some(RecoveryLease::acquire(&directory)?)
        } else {
            None
        };
        let record = self.load_recovery(id)?;
        let original = self.recovery_directory(id)?.join("original");
        let (captured, warning) = if original.exists() {
            match guarded_file::read_saved(&original) {
                Ok(image) => (Some(String::from_utf8_lossy(&image.bytes).into_owned()), None),
                Err(error) => (None, Some(format!("捕获的原文件无法预览：{} 保存前后的不可变副本仍可读取；请在恢复目录检查原文件。", error.message))),
            }
        } else {
            (None, None)
        };
        Ok(
            serde_json::json!({"point": record.point, "before": record.before.map(|f| String::from_utf8_lossy(&f.bytes).into_owned()), "after": record.after.map(|f| String::from_utf8_lossy(&f.bytes).into_owned()), "capturedOriginal": captured, "capturedWarning": warning, "directory": self.recovery_directory(id)?}),
        )
    }
}

/// Reverse only the recorded coordinates; never search for a similar block.
fn reverse_hunk(source: &[u8], hunk: &Hunk, base: &[u8]) -> Result<Vec<u8>> {
    let source = std::str::from_utf8(source).map_err(|_| Error::stale())?;
    let source_lines: Vec<&str> = source.split_inclusive('\n').collect();
    let range = hunk
        .header
        .split_whitespace()
        .nth(2)
        .ok_or_else(Error::stale)?;
    let count = range
        .split(',')
        .nth(1)
        .unwrap_or("1")
        .parse::<usize>()
        .map_err(|_| Error::stale())?;
    let start = if count == 0 {
        hunk.new_start as usize
    } else {
        hunk.new_start.saturating_sub(1) as usize
    };
    if start > source_lines.len() {
        return Err(Error::stale());
    }
    let crlf = base.windows(2).any(|b| b == b"\r\n");
    let mut position = start;
    let mut replacement = String::new();
    for (i, line) in hunk.lines.iter().enumerate() {
        if line.kind == "note" {
            continue;
        }
        let no_newline = hunk.lines.get(i + 1).is_some_and(|l| l.kind == "note");
        let mut raw = line.content.clone();
        if !no_newline {
            if crlf && !raw.ends_with('\r') {
                raw.push('\r');
            }
            raw.push('\n');
        }
        if line.kind == "context" || line.kind == "add" {
            let actual = source_lines.get(position).ok_or_else(Error::stale)?;
            // Git may normalize CRLF in its patch. Exact content and the newline
            // marker are still required; untouched lines keep their original bytes.
            let normalized = actual
                .strip_suffix('\n')
                .unwrap_or(actual)
                .strip_suffix('\r')
                .unwrap_or_else(|| actual.strip_suffix('\n').unwrap_or(actual));
            if normalized != line.content.strip_suffix('\r').unwrap_or(&line.content)
                || actual.ends_with('\n') == no_newline
            {
                return Err(Error::stale());
            }
            if line.kind == "context" {
                replacement.push_str(actual);
            }
            position += 1;
        } else if line.kind == "delete" {
            replacement.push_str(&raw);
        } else {
            return Err(Error::stale());
        }
    }
    if position - start != count {
        return Err(Error::stale());
    }
    Ok(format!(
        "{}{}{}",
        source_lines[..start].concat(),
        replacement,
        source_lines[position..].concat()
    )
    .into_bytes())
}
