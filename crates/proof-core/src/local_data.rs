use crate::{now, owned_data, DataCleanup, Error, Proof, Result, Workspace};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DataScope {
    Repository {
        #[serde(rename = "repositoryId")]
        repository_id: String,
    },
    All,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataWorkspace {
    pub workspace: Workspace,
    pub recent: bool,
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRecordCounts {
    pub observer_events: u64,
    pub review_records: u64,
    pub operations: u64,
    pub recovery_points: u64,
    pub recovery_bytes: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSession {
    pub epoch: u64,
    pub wipe_epoch: u64,
    /// Opaque identifiers only. These durable tombstones let a renderer that
    /// crashed after SQL commit remove its own cached drafts on its next start.
    pub deleted_workspace_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDeletionPreview {
    pub id: String,
    pub scope: DataScope,
    pub workspaces: Vec<Workspace>,
    pub counts: DataRecordCounts,
    pub captured_at: u64,
    pub(crate) repository_ids: Vec<String>,
    pub(crate) epoch: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDeletionResult {
    pub session: DataSession,
    pub deleted_workspace_ids: Vec<String>,
    pub all: bool,
    pub cleanup: DataCleanup,
    pub cleanup_error: Option<Error>,
}

impl Proof {
    pub fn synchronize_data_epoch(&mut self) -> Result<u64> {
        let epoch = setting_number(&self.store.connection, "data_epoch")?;
        if epoch != self.cached_data_epoch {
            self.clear_reading_cache();
            self.cached_data_epoch = epoch;
        }
        Ok(epoch)
    }
    pub fn observer_storage_generation(&self) -> Result<u64> {
        setting_number(&self.store.connection, "data_client_wipe_epoch")
    }
    /// Serialize a collector's small metadata write with a full data deletion.
    /// A collector from the previous generation cannot recreate health or gaps.
    pub fn with_observer_storage_generation(
        &self,
        expected: u64,
        write: impl FnOnce() -> Result<()>,
    ) -> Result<bool> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            TransactionBehavior::Immediate,
        )?;
        if setting_number(&tx, "data_client_wipe_epoch")? != expected {
            return Ok(false);
        }
        self.finish_runtime_file_deletions()?;
        write()?;
        tx.commit()?;
        Ok(true)
    }
    pub fn pause_observer_scope(&self, workspace_id: Option<&str>) -> Result<()> {
        if workspace_id.is_none() {
            return self.pause_all_observers();
        }
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            TransactionBehavior::Immediate,
        )?;
        if !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?)",
            [workspace_id],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(Error::new(
                "WORKSPACE_MISSING",
                "此 Worktree 的记录已不存在。",
                "Unknown workspace",
            ));
        }
        tx.execute("UPDATE observer_permissions SET enabled=0,generation=generation+1 WHERE workspace_id=?",[workspace_id])?;
        tx.execute(
            "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='observer_revision'",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn data_session(&self) -> Result<DataSession> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            TransactionBehavior::Deferred,
        )?;
        let epoch = setting_number(&tx, "data_epoch")?;
        let wipe_epoch = setting_number(&tx, "data_client_wipe_epoch")?;
        let mut query =
            tx.prepare("SELECT workspace_id FROM data_client_deletions ORDER BY workspace_id")?;
        let deleted_workspace_ids = query
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        drop(query);
        tx.commit()?;
        Ok(DataSession {
            epoch,
            wipe_epoch,
            deleted_workspace_ids,
        })
    }
    pub fn check_data_epoch(&self, epoch: u64) -> Result<()> {
        if setting_number(&self.store.connection, "data_epoch")? != epoch {
            return Err(Error::new(
                "DATA_EPOCH_CHANGED",
                "本地记录已删除，旧请求已取消，请重新载入。",
                "Local data generation changed",
            ));
        }
        Ok(())
    }
    pub fn data_workspaces(&self) -> Result<Vec<DataWorkspace>> {
        let recent = self
            .recent_workspaces()?
            .into_iter()
            .map(|w| w.id)
            .collect::<BTreeSet<_>>();
        Ok(self
            .store
            .workspaces()?
            .into_iter()
            .map(|workspace| DataWorkspace {
                recent: recent.contains(&workspace.id),
                workspace,
            })
            .collect())
    }
    pub fn remove_recent_workspace(&self, id: &str) -> Result<()> {
        let changed = self.store.connection.execute(
            "INSERT OR IGNORE INTO hidden_recent_workspaces SELECT id FROM workspaces WHERE id=?",
            [id],
        )?;
        if changed == 0
            && !self.store.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?)",
                [id],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Err(Error::new(
                "WORKSPACE_MISSING",
                "最近项目已不存在。",
                "Unknown workspace",
            ));
        }
        Ok(())
    }
    fn deletion_scope(&self, scope: &DataScope) -> Result<(Vec<String>, Vec<Workspace>)> {
        let filter = match scope {
            DataScope::Repository { repository_id } => Some(repository_id.as_str()),
            DataScope::All => None,
        };
        let mut statement = self
            .store
            .connection
            .prepare("SELECT id FROM repositories WHERE (? IS NULL OR id=?) ORDER BY id")?;
        let repositories = statement
            .query_map(params![filter, filter], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if filter.is_some() && repositories.is_empty() {
            return Err(Error::new(
                "DATA_SCOPE_MISSING",
                "仓库的本地记录已不存在，请刷新列表。",
                "Unknown repository record",
            ));
        }
        let mut workspaces = self
            .store
            .workspaces()?
            .into_iter()
            .filter(|w| repositories.contains(&w.repository_id))
            .collect::<Vec<_>>();
        workspaces.sort_by(|a, b| a.id.cmp(&b.id));
        Ok((repositories, workspaces))
    }
    fn record_counts(&self, scope: &DataScope) -> Result<DataRecordCounts> {
        let repository = match scope {
            DataScope::Repository { repository_id } => Some(repository_id),
            DataScope::All => None,
        };
        let count = |table: &str| -> Result<u64> {
            Ok(self.store.connection.query_row(&format!("SELECT count(*) FROM {table} WHERE (? IS NULL OR workspace_id IN(SELECT id FROM workspaces WHERE repository_id=?))"),params![repository,repository],|r|r.get(0))?)
        };
        Ok(DataRecordCounts {
            observer_events:count("observer_events")?,review_records:count("review_marks")?+count("review_events")?,operations:count("operations")?,recovery_points:count("recovery_points")?,
            recovery_bytes:self.store.connection.query_row("SELECT COALESCE(sum(reserved_bytes),0) FROM recovery_points WHERE (? IS NULL OR workspace_id IN(SELECT id FROM workspaces WHERE repository_id=?))",params![repository,repository],|r|r.get(0))?,
        })
    }
    pub fn prepare_data_deletion(&mut self, scope: DataScope) -> Result<DataDeletionPreview> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            TransactionBehavior::Deferred,
        )?;
        let (repository_ids, workspaces) = self.deletion_scope(&scope)?;
        let preview = DataDeletionPreview {
            id: uuid::Uuid::new_v4().to_string(),
            counts: self.record_counts(&scope)?,
            scope,
            repository_ids,
            workspaces,
            epoch: setting_number(&tx, "data_epoch")?,
            captured_at: now(),
        };
        tx.commit()?;
        while self.data_previews.len() >= 8 {
            self.data_previews.pop_front();
        }
        self.data_previews.push_back(preview.clone());
        Ok(preview)
    }
    pub fn cancel_data_deletion(&mut self, id: &str) {
        self.data_previews.retain(|p| p.id != id);
    }
    /// Also used inside the Hook installer's SQL writer transaction, before
    /// any external configuration is changed as part of record deletion.
    pub fn validate_data_deletion_preview(&self, id: &str) -> Result<()> {
        let preview = self
            .data_previews
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| {
                Error::new(
                    "DATA_PREVIEW_EXPIRED",
                    "删除确认已过期，请重新查看删除范围。",
                    "Unknown deletion preview",
                )
            })?;
        if now().saturating_sub(preview.captured_at) > 300_000 {
            return Err(Error::new(
                "DATA_PREVIEW_EXPIRED",
                "删除确认已过期，请重新查看删除范围。",
                "Expired deletion preview",
            ));
        }
        self.check_data_epoch(preview.epoch)?;
        let (repositories, workspaces) = self.deletion_scope(&preview.scope)?;
        if repositories != preview.repository_ids
            || workspaces
                .iter()
                .map(|w| &w.id)
                .ne(preview.workspaces.iter().map(|w| &w.id))
        {
            return Err(Error::new(
                "DATA_SCOPE_CHANGED",
                "仓库列表已变化，请重新查看删除范围。",
                "Repository membership changed",
            ));
        }
        Ok(())
    }
    pub fn delete_local_data(&mut self, id: &str) -> Result<DataDeletionResult> {
        let preview = self
            .data_previews
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    "DATA_PREVIEW_EXPIRED",
                    "删除确认已过期，请重新查看删除范围。",
                    "Unknown deletion preview",
                )
            })?;
        if now().saturating_sub(preview.captured_at) > 300_000 {
            return Err(Error::new(
                "DATA_PREVIEW_EXPIRED",
                "删除确认已过期，请重新查看删除范围。",
                "Deletion preview older than five minutes",
            ));
        }
        let all = matches!(preview.scope, DataScope::All);
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            TransactionBehavior::Immediate,
        )?;
        self.check_data_epoch(preview.epoch)?;
        let (repositories, workspaces) = self.deletion_scope(&preview.scope)?;
        if repositories != preview.repository_ids
            || workspaces
                .iter()
                .map(|w| &w.id)
                .ne(preview.workspaces.iter().map(|w| &w.id))
        {
            return Err(Error::new(
                "DATA_SCOPE_CHANGED",
                "仓库列表已变化，请重新查看删除范围。",
                "Repository membership changed since confirmation",
            ));
        }
        let ids = workspaces.iter().map(|w| w.id.clone()).collect::<Vec<_>>();
        let repository = match &preview.scope {
            DataScope::Repository { repository_id } => Some(repository_id),
            DataScope::All => None,
        };
        let hook_scope = "(?1 IS NULL OR (EXISTS(SELECT 1 FROM observer_permissions p JOIN workspaces w ON w.id=p.workspace_id WHERE p.installation_id=h.installation_id AND w.repository_id=?1) AND NOT EXISTS(SELECT 1 FROM observer_permissions p JOIN workspaces w ON w.id=p.workspace_id WHERE p.installation_id=h.installation_id AND w.repository_id!=?1)))";
        let active_hooks: bool = tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM observer_hook_configs h WHERE h.state!='uninstalled' AND {hook_scope})"), [repository], |r|r.get(0))?;
        if active_hooks {
            return Err(Error::new(
                "OBSERVER_UNINSTALL_REQUIRED",
                "仍有 Proof Hook 配置，需要先移除接入后再删除记录。",
                "Active hook receipts must be reconciled before data deletion",
            ));
        }
        let mut hooks = tx.prepare(&format!(
            "SELECT h.installation_id FROM observer_hook_configs h WHERE {hook_scope}"
        ))?;
        let hook_ids = hooks
            .query_map([repository], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(hooks);
        for id in &hook_ids {
            tx.execute(
                "INSERT OR IGNORE INTO data_file_deletions VALUES('hook_installation',?)",
                [id],
            )?;
        }
        let mut statement=tx.prepare("SELECT id FROM recovery_points WHERE (? IS NULL OR workspace_id IN(SELECT id FROM workspaces WHERE repository_id=?))")?;
        let mut recovery_ids = statement
            .query_map(params![repository, repository], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<BTreeSet<_>>>()?;
        drop(statement);
        let index_ids =
            owned_data::index_directories(&self.data_dir, if all { None } else { Some(&ids) })?;
        let index_workspaces = owned_data::index_workspace_ids(&self.data_dir)?
            .into_iter()
            .filter(|id| all || ids.contains(id))
            .collect::<Vec<_>>();
        let legacy_indexes = owned_data::legacy_indexes(&self.data_dir)?;
        if !legacy_indexes.is_empty() {
            for workspace in self.store.workspaces()? {
                match std::fs::symlink_metadata(
                    std::path::Path::new(&workspace.git_dir).join("index.lock"),
                ) {
                    Ok(_) => return Err(Error::new(
                        "DATA_LEGACY_INDEX_BUSY",
                        "仍有 Git Index 锁，尚未清理旧版临时 Index。请等待 Git 操作结束后重试。",
                        "Legacy private indexes cannot be leased",
                    )),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                    Err(error) => return Err(error.into()),
                }
            }
        }
        if all {
            let root = self.data_dir.join("recovery");
            match std::fs::symlink_metadata(&root) {
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                    for entry in std::fs::read_dir(root)? {
                        let entry = entry?;
                        let name = entry.file_name().to_string_lossy().to_string();
                        if uuid::Uuid::parse_str(&name).is_err() {
                            return Err(Error::new(
                                "DATA_CLEANUP_UNRECOGNIZED",
                                "恢复目录中有未识别的文件，请先检查，尚未删除记录。",
                                "Unexpected entry in recovery storage",
                            ));
                        }
                        recovery_ids.insert(name);
                    }
                }
                Ok(_) => {
                    return Err(Error::new(
                        "DATA_CLEANUP_PATH",
                        "恢复目录已被替换，尚未删除记录。",
                        "Recovery root is not an ordinary directory",
                    ))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
        // The immediate SQL transaction prevents a new recovery from recording
        // its applying/undoing state. Check existing leases one at a time to
        // avoid exhausting file descriptors. A recovery that starts after its
        // check cannot pass save_recovery after these workspaces are deleted.
        for recovery in &recovery_ids {
            let _lease = owned_data::RecoveryFolder::acquire(&self.data_dir, recovery)?;
        }
        for index in index_ids {
            tx.execute(
                "INSERT OR IGNORE INTO data_file_deletions VALUES('index',?)",
                [index],
            )?;
        }
        for workspace in index_workspaces {
            tx.execute(
                "INSERT OR IGNORE INTO data_file_deletions VALUES('index_workspace',?)",
                [workspace],
            )?;
        }
        // Legacy private indexes had no repository ownership. They are shared,
        // disposable caches, and only scanned at explicit data deletion.
        for index in legacy_indexes {
            tx.execute(
                "INSERT OR IGNORE INTO data_file_deletions VALUES('legacy_index',?)",
                [index],
            )?;
        }
        for recovery in &recovery_ids {
            tx.execute(
                "INSERT OR IGNORE INTO data_file_deletions VALUES('recovery',?)",
                [recovery],
            )?;
        }
        for table in [
            "observer_events",
            "observer_sessions",
            "observer_associations",
            "observer_association_history",
            "observer_gaps",
            "review_marks",
            "review_events",
            "operations",
            "recovery_points",
            "observer_permissions",
        ] {
            tx.execute(&format!("DELETE FROM {table} WHERE (? IS NULL OR workspace_id IN(SELECT id FROM workspaces WHERE repository_id=?))"),params![repository,repository])?;
        }
        for id in &hook_ids {
            tx.execute(
                "DELETE FROM observer_hook_configs WHERE installation_id=?",
                [id],
            )?;
            tx.execute("DELETE FROM observer_installations WHERE id=? AND NOT EXISTS(SELECT 1 FROM observer_events WHERE installation_id=?) AND NOT EXISTS(SELECT 1 FROM observer_sessions WHERE installation_id=?) AND NOT EXISTS(SELECT 1 FROM observer_permissions WHERE installation_id=?)", params![id,id,id,id])?;
        }
        for workspace in &ids {
            tx.execute(
                "INSERT OR IGNORE INTO data_client_deletions VALUES(?)",
                [workspace],
            )?;
        }
        tx.execute(
            "DELETE FROM workspaces WHERE (? IS NULL OR repository_id=?)",
            params![repository, repository],
        )?;
        for repository in &repositories {
            tx.execute(
                "DELETE FROM settings WHERE key=?",
                [format!("editor:repository:{repository}")],
            )?;
        }
        tx.execute(
            "DELETE FROM repositories WHERE (? IS NULL OR id=?)",
            params![repository, repository],
        )?;
        let epoch = preview.epoch.checked_add(1).ok_or_else(|| {
            Error::new(
                "DATA_EPOCH_LIMIT",
                "本地记录版本已达上限，尚未删除记录。",
                "Data epoch overflow",
            )
        })?;
        if all {
            tx.execute("DELETE FROM observer_installations", [])?;
            tx.execute("DELETE FROM repository_layouts", [])?;
            tx.execute("DELETE FROM hidden_recent_workspaces", [])?;
            tx.execute("DELETE FROM settings WHERE key NOT IN('data_epoch','data_client_wipe_epoch','observer_revision','editor:revision','data_cleanup_pending','data_cleanup_completed')",[])?;
            tx.execute("DELETE FROM data_client_deletions", [])?;
            tx.execute(
                "UPDATE settings SET value=? WHERE key='data_client_wipe_epoch'",
                [epoch],
            )?;
            for name in [
                "foreground.json",
                "runtime.json",
                "foreground.pending",
                "runtime.pending",
            ] {
                tx.execute(
                    "INSERT OR IGNORE INTO data_file_deletions VALUES('runtime',?)",
                    [name],
                )?;
            }
        }
        tx.execute(
            "UPDATE settings SET value=? WHERE key='data_epoch'",
            [epoch],
        )?;
        tx.execute(
            "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='observer_revision'",
            [],
        )?;
        tx.execute("INSERT INTO settings VALUES('editor:revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[])?;
        crate::data::mark_cleanup_pending(&tx)?;
        let mut tombstones =
            tx.prepare("SELECT workspace_id FROM data_client_deletions ORDER BY workspace_id")?;
        let deleted_workspace_ids = tombstones
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(tombstones);
        let session = DataSession {
            epoch,
            wipe_epoch: setting_number(&tx, "data_client_wipe_epoch")?,
            deleted_workspace_ids,
        };
        tx.commit()?;
        self.clear_reading_cache();
        self.cached_data_epoch = epoch;
        // A committed deletion is never reported as though nothing happened.
        // Cleanup failures retain durable jobs and are returned separately.
        let (cleanup, cleanup_error) = match self.maintain_local_data() {
            Ok(cleanup) => (cleanup, None),
            Err(error) => (
                DataCleanup {
                    pending_content_deletions: 1,
                    ..DataCleanup::default()
                },
                Some(Error::new(
                    "DATA_CLEANUP_PENDING",
                    "记录已删除，磁盘副本清理尚未完成，请重试清理。",
                    error,
                )),
            ),
        };
        Ok(DataDeletionResult {
            session,
            deleted_workspace_ids: ids,
            all,
            cleanup,
            cleanup_error,
        })
    }
    pub(crate) fn finish_pending_file_deletions(&self) -> Result<(u64, Option<String>)> {
        let mut statement = self.store.connection.prepare(
            "SELECT kind,id FROM data_file_deletions ORDER BY kind='index_workspace',kind,id",
        )?;
        let jobs = statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        let mut error_code = None;
        for (kind, id) in jobs {
            let tx = rusqlite::Transaction::new_unchecked(
                &self.store.connection,
                TransactionBehavior::Immediate,
            )?;
            if !tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM data_file_deletions WHERE kind=? AND id=?)",
                params![kind, id],
                |r| r.get::<_, bool>(0),
            )? {
                continue;
            }
            let result = match kind.as_str() {
                "recovery" => owned_data::RecoveryFolder::acquire(&self.data_dir, &id)
                    .and_then(|folder| folder.map_or(Ok(()), |f| f.delete())),
                "runtime" => owned_data::remove_runtime_file(&self.data_dir, &id),
                "index" => owned_data::RecoveryFolder::acquire_index(&self.data_dir, &id)
                    .and_then(|folder| folder.map_or(Ok(()), |f| f.delete_index())),
                "legacy_index" => owned_data::remove_legacy_index(&self.data_dir, &id),
                "index_workspace" => owned_data::remove_index_workspace(&self.data_dir, &id),
                "hook_installation" => {
                    owned_data::RecoveryFolder::acquire_hook_installation(&self.data_dir, &id)
                        .and_then(|folder| folder.map_or(Ok(()), |f| f.delete_hook_installation()))
                }
                _ => Err(Error::new(
                    "DATA_CLEANUP_PATH",
                    "清理记录无效，磁盘清理尚未完成。",
                    "Unknown cleanup job",
                )),
            };
            match result {
                Ok(()) => {
                    self.store.connection.execute(
                        "DELETE FROM data_file_deletions WHERE kind=? AND id=?",
                        params![kind, id],
                    )?;
                }
                Err(error) => {
                    error_code.get_or_insert(error.code);
                }
            }
            tx.commit()?;
        }
        let count = self.store.connection.query_row(
            "SELECT count(*) FROM data_file_deletions",
            [],
            |r| r.get(0),
        )?;
        Ok((count, error_code))
    }
    // Called only under the metadata writer's IMMEDIATE transaction. A new
    // collector must finish old runtime jobs before reusing these filenames.
    fn finish_runtime_file_deletions(&self) -> Result<()> {
        let mut query = self
            .store
            .connection
            .prepare("SELECT id FROM data_file_deletions WHERE kind='runtime'")?;
        let names = query
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(query);
        for name in names {
            owned_data::remove_runtime_file(&self.data_dir, &name)?;
            self.store.connection.execute(
                "DELETE FROM data_file_deletions WHERE kind='runtime' AND id=?",
                [name],
            )?;
        }
        Ok(())
    }
}
fn setting_number(connection: &rusqlite::Connection, key: &str) -> Result<u64> {
    Ok(connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM settings WHERE key=?",
            [key],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

#[cfg(test)]
#[path = "local_data_tests.rs"]
mod tests;
