use crate::{now, Error, Proof, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use std::{fs, path::Path, time::Duration};

const DAY: u64 = 24 * 60 * 60 * 1000;
pub const OBSERVATION_RETENTION_MS: u64 = 30 * DAY;
pub const OUTPUT_RETENTION_MS: u64 = 7 * DAY;
pub const REVIEW_RETENTION_MS: u64 = 180 * DAY;
pub const DATA_SOFT_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
// Reserve a bounded record plus its SQLite journal copy. Use the same admission
// threshold for incoming events, diagnostics, and space-recovery decisions.
const OBSERVATION_RESERVE: u64 = 2 * crate::OBSERVER_INPUT_LIMIT as u64 + 8192;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCleanup {
    pub pending_content_deletions: u64,
    pub content_cleanup_error: Option<String>,
    pub redacted_outputs: usize,
    pub deleted_events: usize,
    pub deleted_sessions: usize,
    pub deleted_review_records: usize,
    pub deleted_corrections: usize,
    pub deleted_operations: usize,
    /// False means an older SQLite reader still prevents removal of old WAL
    /// frames. The UI must retain a pending-cleanup notice until a later retry.
    pub wal_checkpoint_complete: bool,
    pub database_compaction_pending: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataUsage {
    pub active_observer_scopes: u64,
    pub pending_content_deletions: u64,
    pub content_cleanup_error: Option<String>,
    pub application_bytes: u64,
    pub application_bytes_lower_bound: bool,
    pub soft_limit_bytes: u64,
    pub observer_events: u64,
    pub observer_sessions: u64,
    pub observation_payload_bytes: u64,
    pub content_collection_paused: bool,
    pub cleanup_pending: bool,
    pub database_compaction_pending: bool,
    pub output_retention_days: u32,
    pub observation_retention_days: u32,
    pub review_retention_days: u32,
}

impl Proof {
    /// No source repository or Agent history is traversed or changed. SQLite
    /// deletes and output redaction share one transaction; secure_delete plus a
    /// completed WAL checkpoint removes the application's old database copies.
    pub fn maintain_local_data(&self) -> Result<DataCleanup> {
        let (pending_content_deletions, content_cleanup_error) =
            self.finish_pending_file_deletions()?;
        self.expire_recovery()?;
        let current = now();
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        let mut report = DataCleanup {
            pending_content_deletions,content_cleanup_error,
            redacted_outputs: tx.execute("UPDATE observer_events SET payload=json_set(payload,'$.output',NULL,'$.fieldStatus.output','expired') WHERE content_expires_at<=? AND json_type(payload,'$.output')='text'",[current])?,
            deleted_events: tx.execute("DELETE FROM observer_events WHERE expires_at<=?",[current])?,
            ..DataCleanup::default()
        };
        report.deleted_sessions = tx.execute("DELETE FROM observer_sessions WHERE NOT EXISTS(SELECT 1 FROM observer_events e WHERE e.session_id=observer_sessions.id)",[])?;
        let context_cutoff = current.saturating_sub(OBSERVATION_RETENTION_MS);
        report.deleted_corrections = tx.execute(
            "DELETE FROM observer_associations WHERE updated_at<=?",
            [context_cutoff],
        )? + tx.execute(
            "DELETE FROM observer_association_history WHERE created_at<=?",
            [context_cutoff],
        )?;
        let review_cutoff = current.saturating_sub(REVIEW_RETENTION_MS);
        report.deleted_review_records = tx.execute(
            "DELETE FROM review_marks WHERE updated_at<=?",
            [review_cutoff],
        )? + tx.execute(
            "DELETE FROM review_events WHERE created_at<=?",
            [review_cutoff],
        )?;
        report.deleted_review_records += tx.execute(
            "DELETE FROM ai_review_reports WHERE captured_at<=?",
            [review_cutoff],
        )?;
        report.deleted_operations = tx.execute(
            "DELETE FROM operations WHERE created_at<=?",
            [review_cutoff],
        )?;
        let gaps = tx.execute(
            "DELETE FROM observer_gaps WHERE started_at<=?",
            [context_cutoff],
        )? + trim_observer_gaps(&tx)?;
        if report.redacted_outputs
            + report.deleted_events
            + report.deleted_sessions
            + report.deleted_review_records
            + report.deleted_corrections
            + report.deleted_operations
            + gaps
            > 0
        {
            mark_cleanup_pending(&tx)?;
            crate::diagnostics::invalidate_diagnostics(&tx)?;
            self.diagnostic_previews.borrow_mut().clear();
        }
        tx.commit()?;
        let compacted = self.reclaim_database_space()?;
        report.wal_checkpoint_complete = self.finish_data_cleanup()?;
        report.database_compaction_pending =
            compacted == Some(false) || (compacted.is_some() && !report.wal_checkpoint_complete);
        Ok(report)
    }

    /// Explicitly clearing observation also pauses this workspace in the same
    /// transaction. An already queued event cannot recreate the removed data.
    /// A missing or unavailable source repository does not prevent local cleanup.
    pub fn clear_observer_data(&self, workspace_id: &str) -> Result<DataCleanup> {
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?)",
            [workspace_id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error::new(
                "WORKSPACE_MISSING",
                "本地工作区记录不存在。",
                "Unknown workspace id",
            ));
        }
        tx.execute("UPDATE observer_permissions SET enabled=0,generation=generation+1 WHERE workspace_id=?",[workspace_id])?;
        tx.execute(
            "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='data_epoch'",
            [],
        )?;
        tx.execute(
            "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='observer_revision'",
            [],
        )?;
        let mut report = DataCleanup {
            deleted_events: tx.execute(
                "DELETE FROM observer_events WHERE workspace_id=?",
                [workspace_id],
            )?,
            deleted_sessions: tx.execute(
                "DELETE FROM observer_sessions WHERE workspace_id=?",
                [workspace_id],
            )?,
            deleted_corrections: tx.execute(
                "DELETE FROM observer_associations WHERE workspace_id=?",
                [workspace_id],
            )? + tx.execute(
                "DELETE FROM observer_association_history WHERE workspace_id=?",
                [workspace_id],
            )?,
            ..DataCleanup::default()
        };
        tx.execute(
            "DELETE FROM observer_gaps WHERE workspace_id=?",
            [workspace_id],
        )?;
        tx.execute(
            "INSERT INTO observer_gaps VALUES(?,NULL,?,'user_cleared_observation',NULL,?,NULL)",
            params![uuid::Uuid::new_v4().to_string(), workspace_id, now()],
        )?;
        trim_observer_gaps(&tx)?;
        mark_cleanup_pending(&tx)?;
        crate::diagnostics::invalidate_diagnostics(&tx)?;
        self.diagnostic_previews.borrow_mut().clear();
        tx.commit()?;
        let compacted = self.reclaim_database_space()?;
        report.wal_checkpoint_complete = self.finish_data_cleanup()?;
        report.database_compaction_pending =
            compacted == Some(false) || (compacted.is_some() && !report.wal_checkpoint_complete);
        Ok(report)
    }

    pub fn data_usage(&self, workspace_id: Option<&str>) -> Result<DataUsage> {
        let cleanup = self.maintain_local_data()?;
        let (events,bytes):(u64,u64)=self.store.connection.query_row("SELECT count(*),COALESCE(sum(length(CAST(payload AS BLOB))),0) FROM observer_events WHERE (? IS NULL OR workspace_id=?)",params![workspace_id,workspace_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let sessions: u64 = self.store.connection.query_row(
            "SELECT count(*) FROM observer_sessions WHERE (? IS NULL OR workspace_id=?)",
            params![workspace_id, workspace_id],
            |r| r.get(0),
        )?;
        let (application_bytes, complete) = application_data_bytes(&self.data_dir)?;
        Ok(DataUsage {
            active_observer_scopes:self.store.connection.query_row("SELECT count(*) FROM observer_permissions WHERE enabled=1 AND (? IS NULL OR workspace_id=?)",params![workspace_id,workspace_id],|r|r.get(0))?,
            pending_content_deletions: cleanup.pending_content_deletions,
            content_cleanup_error: cleanup.content_cleanup_error,
            application_bytes,
            application_bytes_lower_bound: !complete,
            soft_limit_bytes: DATA_SOFT_LIMIT,
            observer_events: events,
            observer_sessions: sessions,
            observation_payload_bytes: bytes,
            content_collection_paused: observation_paused(application_bytes, complete),
            cleanup_pending: self.cleanup_pending()?,
            database_compaction_pending: cleanup.database_compaction_pending,
            output_retention_days: 7,
            observation_retention_days: 30,
            review_retention_days: 180,
        })
    }

    pub(crate) fn check_observer_capacity(&self, incoming_bytes: usize) -> Result<()> {
        // This runs within the insertion transaction, after bounded
        // normalization. Refuse all event content when even metadata would keep
        // growing an over-budget store; transport counters remain bounded.
        let (bytes, complete) = application_data_bytes(&self.data_dir)?;
        if incoming_bytes > crate::OBSERVER_INPUT_LIMIT {
            return Err(Error::new(
                "OBSERVER_NORMALIZED_LIMIT",
                "规范化事件超过单条上限，已丢弃这条记录。",
                "Normalized event exceeded 2 MiB",
            ));
        }
        if !complete && bytes < DATA_SOFT_LIMIT {
            return Err(Error::new(
                "OBSERVER_STORAGE_MEASUREMENT_LIMIT",
                "本地数据目录超出统计范围，观察内容采集已暂停。",
                "Application data traversal limit",
            ));
        }
        if observation_paused(bytes, complete) {
            return Err(Error::new(
                "OBSERVER_STORAGE_LIMIT",
                "本地数据剩余空间不足，观察内容采集已暂停。",
                "Clear local data or retry after retention cleanup",
            ));
        }
        Ok(())
    }

    fn reclaim_database_space(&self) -> Result<Option<bool>> {
        let pages: u64 = self
            .store
            .connection
            .query_row("PRAGMA page_count", [], |r| r.get(0))?;
        let free: u64 = self
            .store
            .connection
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
        let size: u64 = self
            .store
            .connection
            .query_row("PRAGMA page_size", [], |r| r.get(0))?;
        let reusable = free.saturating_mul(size);
        if free == 0 {
            return Ok(None);
        }
        let (bytes, complete) = application_data_bytes(&self.data_dir)?;
        let pressured = observation_paused(bytes, complete);
        // Rebuild only when it can recover substantial space or unblock the
        // soft cap. Ordinary event reads do not continually VACUUM the database.
        if !pressured && (reusable < 32 * 1024 * 1024 || free < pages / 4) {
            return Ok(None);
        }
        mark_cleanup_pending(&self.store.connection)?;
        self.store.connection.busy_timeout(Duration::ZERO)?;
        let result = self.store.connection.execute_batch("VACUUM");
        self.store.connection.busy_timeout(Duration::from_secs(3))?;
        // Another writer or insufficient scratch space may prevent compaction.
        // Logical deletion is already committed; report and retry separately.
        Ok(Some(result.is_ok()))
    }

    fn cleanup_pending(&self) -> Result<bool> {
        Ok(self
            .store
            .connection
            .query_row(
                "SELECT CAST(value AS INTEGER)>COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key='data_cleanup_completed'),0) FROM settings WHERE key='data_cleanup_pending'",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false))
    }
    fn finish_data_cleanup(&self) -> Result<bool> {
        if !self.cleanup_pending()? {
            return Ok(true);
        }
        let generation: u64 = self.store.connection.query_row(
            "SELECT CAST(value AS INTEGER) FROM settings WHERE key='data_cleanup_pending'",
            [],
            |r| r.get(0),
        )?;
        // Do not wait behind a long-running reader. Preserve a durable pending
        // flag instead of falsely claiming that old WAL bytes were removed.
        self.store.connection.busy_timeout(Duration::ZERO)?;
        let checkpoint =
            self.store
                .connection
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                    r.get::<_, i32>(0)
                });
        self.store.connection.busy_timeout(Duration::from_secs(3))?;
        let complete = checkpoint? == 0;
        if complete {
            self.store.connection.execute(
                "INSERT INTO settings VALUES('data_cleanup_completed',?) ON CONFLICT(key) DO UPDATE SET value=MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER))",
                [generation],
            )?;
        }
        Ok(complete && !self.cleanup_pending()?)
    }
}

pub(crate) fn mark_cleanup_pending(connection: &Connection) -> Result<()> {
    connection.execute("INSERT INTO settings VALUES('data_cleanup_pending','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[])?;
    Ok(())
}
pub(crate) fn trim_observer_gaps(connection: &Connection) -> Result<usize> {
    Ok(connection.execute("DELETE FROM observer_gaps WHERE id IN (SELECT id FROM observer_gaps ORDER BY started_at DESC,rowid DESC LIMIT -1 OFFSET 500)",[])?)
}

fn observation_paused(bytes: u64, complete: bool) -> bool {
    !complete || bytes.saturating_add(OBSERVATION_RESERVE) > DATA_SOFT_LIMIT
}

/// Count application-owned data without following symlinks into a source
/// repository. Stop at the soft cap; the result is then a lower bound, which is
/// sufficient to pause capture. Limit traversal depth and entry count as well.
fn application_data_bytes(root: &Path) -> Result<(u64, bool)> {
    let mut directories = vec![(root.to_path_buf(), 0usize)];
    let mut bytes = 0u64;
    let mut visited = 0usize;
    while let Some((path, depth)) = directories.pop() {
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) if path != root && error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            visited += 1;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                if depth >= 8 {
                    return Ok((bytes, false));
                }
                directories.push((entry.path(), depth + 1));
            } else {
                bytes = bytes.saturating_add(metadata.len());
            }
            if bytes >= DATA_SOFT_LIMIT || visited >= 16_384 {
                return Ok((bytes, false));
            }
        }
    }
    Ok((bytes, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    #[test]
    fn checkpoint_ack_cannot_clear_a_newer_concurrent_deletion() {
        let temp = tempfile::tempdir().unwrap();
        let first = Proof::open(temp.path()).unwrap();
        let second = Proof::open(temp.path()).unwrap();
        let db = &first.store.connection;
        let timestamp = now();
        db.execute("INSERT INTO observer_installations VALUES('i','claude','v','v','hash','active',?,NULL)",[timestamp]).unwrap();
        db.execute(
            "INSERT INTO observer_sessions VALUES('s','w','i',NULL,NULL,?,?)",
            [timestamp, timestamp],
        )
        .unwrap();
        db.execute(
            "INSERT INTO observer_events VALUES('e','w','i','s',NULL,?,?,?,?)",
            params![
                timestamp,
                r#"{"output":"CONCURRENT_DELETE_SECRET_REMAINS"}"#,
                timestamp + 100000,
                timestamp + 100000
            ],
        )
        .unwrap();
        mark_cleanup_pending(db).unwrap();
        let root = temp.path().to_path_buf();
        let fired = Arc::new(AtomicBool::new(false));
        let observed = fired.clone();
        let mut pinned = None::<Connection>;
        // Interleave a second connection's deletion after the first checkpoint
        // and before its acknowledgement, without a hook in production code.
        db.authorizer(Some(move |context: AuthContext<'_>| {
            if matches!(
                context.action,
                AuthAction::Update {
                    table_name: "settings",
                    column_name: "value"
                }
            ) && !observed.swap(true, Ordering::AcqRel)
            {
                let reader = Connection::open(root.join("proof.sqlite3")).unwrap();
                reader.execute_batch("BEGIN").unwrap();
                let _: String = reader
                    .query_row(
                        "SELECT payload FROM observer_events WHERE id='e'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                second
                    .store
                    .connection
                    .execute("UPDATE observer_events SET expires_at=0 WHERE id='e'", [])
                    .unwrap();
                assert!(
                    !second
                        .maintain_local_data()
                        .unwrap()
                        .wal_checkpoint_complete
                );
                pinned = Some(reader);
            }
            let _ = &pinned;
            Authorization::Allow
        }));
        assert!(!first.finish_data_cleanup().unwrap());
        assert!(fired.load(Ordering::Acquire));
        assert!(first.cleanup_pending().unwrap());
        first
            .store
            .connection
            .authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
        assert!(first.maintain_local_data().unwrap().wal_checkpoint_complete);
        for name in ["proof.sqlite3", "proof.sqlite3-wal"] {
            if let Ok(bytes) = fs::read(temp.path().join(name)) {
                assert!(!bytes
                    .windows(b"CONCURRENT_DELETE_SECRET_REMAINS".len())
                    .any(|w| w == b"CONCURRENT_DELETE_SECRET_REMAINS"));
            }
        }
    }

    #[test]
    fn quota_scan_tolerates_atomic_health_file_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        let running = Arc::new(AtomicBool::new(true));
        let active = running.clone();
        let writer = std::thread::spawn(move || {
            let pending = root.join("runtime.pending");
            let health = root.join("runtime.json");
            while active.load(Ordering::Acquire) {
                fs::write(&pending, b"health").unwrap();
                fs::rename(&pending, &health).unwrap();
            }
        });
        let mut failure = None;
        for _ in 0..10000 {
            if let Err(error) = application_data_bytes(temp.path()) {
                failure = Some(error);
                break;
            }
        }
        running.store(false, Ordering::Release);
        writer.join().unwrap();
        assert!(
            failure.is_none(),
            "concurrent health file replacement: {failure:?}"
        );
    }
}
