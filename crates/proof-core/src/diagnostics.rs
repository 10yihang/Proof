//! Diagnostics are an explicit, bounded projection, never a copy of logs or stored payloads.
use crate::{
    diagnostic_metrics::{safe_error_code, safe_version},
    now, DiagnosticMeasurements, Error, Proof, Result,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const PREVIEW_TTL: u64 = 5 * 60 * 1000;
const MAX_BYTES: usize = 256 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct DiagnosticGeneration {
    pub data_epoch: u64,
    revision: u64,
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct DiagnosticOptions {
    pub include_paths: bool,
    pub include_timeline: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPreview {
    pub application_only: bool,
    pub id: String,
    pub file_name: String,
    pub bytes: usize,
    pub sha256: String,
    pub captured_at: u64,
    pub expires_at: u64,
    pub options: DiagnosticOptions,
    pub content: String,
}
#[derive(Clone)]
pub(crate) struct PreparedDiagnostic {
    preview: DiagnosticPreview,
    generation: DiagnosticGeneration,
}
impl PreparedDiagnostic {
    fn into_export_job(self, data_dir: PathBuf) -> DiagnosticExportJob {
        DiagnosticExportJob {
            preview: self.preview,
            generation: Some(self.generation),
            data_dir,
        }
    }
}
pub struct DiagnosticExportJob {
    preview: DiagnosticPreview,
    generation: Option<DiagnosticGeneration>,
    data_dir: PathBuf,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSaved {
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
}

fn generation(db: &Connection) -> Result<DiagnosticGeneration> {
    fn number(db: &Connection, key: &str) -> Result<u64> {
        Ok(db
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key=?",
                [key],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }
    Ok(DiagnosticGeneration {
        data_epoch: number(db, "data_epoch")?,
        revision: number(db, "diagnostic_revision")?,
    })
}
pub(crate) fn invalidate_diagnostics(db: &Connection) -> Result<()> {
    db.execute("INSERT INTO settings(key,value) VALUES('diagnostic_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[])?;
    Ok(())
}
fn expired() -> Error {
    Error::new(
        "DIAGNOSTIC_EXPIRED",
        "诊断预览已失效，请重新生成。",
        "Preview missing, cancelled, expired or local records changed",
    )
}
impl Proof {
    pub fn diagnostic_generation(&self) -> Result<DiagnosticGeneration> {
        generation(&self.store.connection)
    }
    pub fn prepare_diagnostic(
        &mut self,
        options: DiagnosticOptions,
        measurements: DiagnosticMeasurements,
    ) -> Result<DiagnosticPreview> {
        self.synchronize_data_epoch()?;
        let captured = now();
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            TransactionBehavior::Deferred,
        )?;
        let current = generation(&tx)?;
        if measurements.generation != current {
            return Err(expired());
        }
        let count = |table: &str| -> Result<u64> {
            Ok(tx.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?)
        };
        let records = json!({"repositories":count("repositories")?,"worktrees":count("workspaces")?,"observerEvents":count("observer_events")?,"observerSessions":count("observer_sessions")?,"pendingFileDeletions":count("data_file_deletions")?});
        let mut statement=tx.prepare("SELECT agent,agent_version,adapter_version,state,count(*) FROM observer_installations GROUP BY agent,agent_version,adapter_version,state ORDER BY agent,agent_version LIMIT 129")?;
        let raw = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, u64>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let installations:Vec<_>=raw.iter().take(128).map(|(agent,version,adapter,state,count)|json!({
            "agent":known(agent,&["codex","claude","codewiz"]),"agentVersion":safe_version(version),"adapterVersion":safe_version(adapter),
            "state":known(state,&["configured_pending","receiving_unverified","helper_changed","revoked","active","paused","installed","uninstalled","invalidated","pending","config_changed","program_changed"]),"count":count
        })).collect();
        drop(statement);
        let mut statement=tx.prepare("SELECT code,count,started_at,ended_at FROM observer_gaps WHERE started_at>? ORDER BY started_at DESC LIMIT 501")?;
        let gaps = statement
            .query_map(
                [captured.saturating_sub(crate::OBSERVATION_RETENTION_MS)],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<u64>>(1)?,
                        r.get::<_, u64>(2)?,
                        r.get::<_, Option<u64>>(3)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut gap_counts: BTreeMap<&str, Value> = BTreeMap::new();
        let mut timeline = Vec::new();
        for (code, count, start, end) in gaps.iter().take(500) {
            let code = gap_code(code);
            let item = gap_counts.entry(code).or_insert(
                json!({"records":0u64,"knownDroppedEvents":0u64,"unknownCountRecords":0u64}),
            );
            item["records"] = json!(item["records"].as_u64().unwrap_or(0).saturating_add(1));
            if let Some(count) = count {
                item["knownDroppedEvents"] = json!(item["knownDroppedEvents"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(*count));
            } else {
                item["unknownCountRecords"] = json!(item["unknownCountRecords"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(1));
            }
            if options.include_timeline && timeline.len() < 100 {
                timeline.push(json!({"code":code,"count":count,"startedAt":start,"endedAt":end}));
            }
        }
        drop(statement);
        let mut additional = json!({});
        if options.include_timeline {
            additional["gapTimeline"] = json!({"entries":timeline,"truncated":gaps.len()>100});
        }
        if options.include_paths {
            let mut statement =
                tx.prepare("SELECT path,git_dir,common_dir FROM workspaces ORDER BY id LIMIT 129")?;
            let worktrees=statement.query_map([],|r|Ok(json!({"worktree":r.get::<_,String>(0)?,"gitDirectory":r.get::<_,String>(1)?,"commonDirectory":r.get::<_,String>(2)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut configs = tx.prepare(
                "SELECT config_path FROM observer_hook_configs ORDER BY installation_id LIMIT 129",
            )?;
            let configs = configs
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            additional["localPaths"] = json!({"applicationData":self.data_dir,"worktrees":worktrees.iter().take(128).collect::<Vec<_>>(),"hookConfigurations":configs.iter().take(128).collect::<Vec<_>>(),"truncated":worktrees.len()>128||configs.len()>128});
        }
        let document = json!({
            "schemaVersion":1,"product":"Proof","version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"capturedAt":captured,
            "included":options,"excluded":["sourceCode","prompts","agentReplies","commands","commandOutput","remoteUrls","credentials","nativeSessionIds"],
            "capabilities":{"supportedFeatures":{"workingCopyDiff":true,"commitComparison":true,"hunkStaging":true},"git":{"version":measurements.git_version,"source":"last_successful_worktree_read","checkedDuringExport":false},"observer":{"adapterVersion":crate::OBSERVER_ADAPTER_VERSION,"installableAgents":if cfg!(target_os="macos"){json!(["codex"])}else{json!([])},"versionPolicy":"protocol_candidate_no_version_pin","versionDetection":"last_explicit_probe_or_recorded_installation","newProbeExecuted":false}},
            "installations":{"entries":installations,"truncated":raw.len()>128},"records":records,
            "observerQueue":read_queue(&self.data_dir,self.observer_storage_generation()?,captured),
            "observerGaps":{"byCode":gap_counts,"truncated":gaps.len()>500},
            "performance":{"measurement":"native_command_elapsed_including_dispatch_wait","histogramUpperBoundsMs":[20,100,500,2000,10000,null],"summary":measurements},
            "additional":additional
        });
        tx.commit()?;
        let content = serde_json::to_string_pretty(&document)? + "\n";
        if content.len() > MAX_BYTES {
            return Err(Error::new(
                "DIAGNOSTIC_LIMIT",
                "诊断内容超过大小限制，请减少附加内容后重试。",
                "Maximum diagnostic size is 256 KiB",
            ));
        }
        let preview = DiagnosticPreview {
            application_only: false,
            id: uuid::Uuid::new_v4().to_string(),
            file_name: format!("Proof-diagnostics-{captured}.json"),
            bytes: content.len(),
            sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
            captured_at: captured,
            expires_at: captured + PREVIEW_TTL,
            options,
            content,
        };
        let mut previews = self.diagnostic_previews.borrow_mut();
        previews.retain(|p| p.generation == current && p.preview.expires_at > captured);
        while previews.len() >= 4 {
            previews.pop_front();
        }
        previews.push_back(PreparedDiagnostic {
            preview: preview.clone(),
            generation: current,
        });
        Ok(preview)
    }
    pub fn cancel_diagnostic(&mut self, id: &str) {
        self.diagnostic_previews
            .borrow_mut()
            .retain(|p| p.preview.id != id);
    }
    pub fn validate_diagnostic(&self, id: &str, sha256: &str) -> Result<DiagnosticPreview> {
        Ok(self.validated_diagnostic(id, sha256)?.preview)
    }
    fn validated_diagnostic(&self, id: &str, sha256: &str) -> Result<PreparedDiagnostic> {
        let current = self.diagnostic_generation()?;
        let mut previews = self.diagnostic_previews.borrow_mut();
        previews.retain(|p| p.generation == current && p.preview.expires_at > now());
        previews
            .iter()
            .find(|p| {
                p.preview.id == id
                    && p.preview.sha256 == sha256
                    && p.generation == current
                    && p.preview.expires_at > now()
            })
            .cloned()
            .ok_or_else(expired)
    }
    pub fn prepare_diagnostic_export(
        &mut self,
        id: &str,
        sha256: &str,
    ) -> Result<DiagnosticExportJob> {
        let prepared = self.validated_diagnostic(id, sha256)?;
        self.cancel_diagnostic(id);
        Ok(prepared.into_export_job(self.data_dir.clone()))
    }
}
fn known<'a>(value: &'a str, allowed: &[&str]) -> &'a str {
    if allowed.contains(&value) {
        value
    } else {
        "unknown"
    }
}
fn gap_code(code: &str) -> &str {
    match code {
        "all_paused"
        | "scope_paused"
        | "consent_changed"
        | "collector_started"
        | "collector_restart_integrity_unknown"
        | "collector_stopped"
        | "transport_queue_full"
        | "transport_invalid"
        | "transport_expired"
        | "transport_input_limit"
        | "storage_rejected"
        | "user_cleared_observation"
        | "queue_full"
        | "storage_unavailable"
        | "service_restart"
        | "unclean_shutdown"
        | "gui_closed"
        | "capture_paused"
        | "storage_limit"
        | "invalid_event"
        | "permission_changed"
        | "config_changed"
        | "helper_changed"
        | "program_changed" => code,
        _ => safe_error_code(code),
    }
}
fn read_queue(root: &Path, expected_generation: u64, captured: u64) -> Value {
    let read = || -> Option<Value> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(root.join("observer/runtime.json")).ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() || metadata.len() > 64 * 1024 {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
                return None;
            }
        }
        let mut bytes = Vec::new();
        file.take(64 * 1024 + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 64 * 1024 {
            return None;
        }
        serde_json::from_slice(&bytes).ok()
    };
    let Some(raw) = read() else {
        return json!({"status":"unavailable","snapshot":null});
    };
    if raw["schemaVersion"].as_u64() != Some(1)
        || raw["storageGeneration"].as_u64() != Some(expected_generation)
    {
        return json!({"status":"unavailable","snapshot":null});
    }
    let heartbeat = raw["heartbeatAt"].as_u64();
    let fresh = heartbeat.is_some_and(|at| at <= captured && captured - at < 4000);
    let status = if raw["cleanShutdown"].as_bool() == Some(true) {
        "stopped"
    } else if fresh && raw["cleanShutdown"].as_bool() == Some(false) {
        "running"
    } else {
        "stale"
    };
    let mut snapshot = BTreeMap::new();
    for key in [
        "received",
        "processed",
        "rejected",
        "invalid",
        "expired",
        "queueFull",
        "storageRejected",
        "maxConnections",
        "queueCapacity",
        "queued",
        "processing",
    ] {
        snapshot.insert(key, raw["metrics"][key].as_u64());
    }
    json!({"status":status,"heartbeatAt":heartbeat,"scope":"collector_process_at_last_heartbeat","snapshot":snapshot})
}
impl DiagnosticExportJob {
    /// The native save dialog chooses the path. No core mutex is held during filesystem I/O.
    /// A SQLite writer lease orders export against deletion in every Proof process.
    pub fn run(self, destination: &Path) -> Result<DiagnosticSaved> {
        let mut db = if self.generation.is_some() {
            Some(Connection::open_with_flags(
                self.data_dir.join("proof.sqlite3"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
            )?)
        } else {
            None
        };
        if let Some(db) = &db {
            // SQLITE_OPEN_READ_WRITE can silently fall back to a read-only
            // connection, whose BEGIN IMMEDIATE is not a deletion writer lease.
            if db.is_readonly("main")? {
                return Err(Error::new(
                    "DIAGNOSTIC_STORAGE_READONLY",
                    "本地记录当前只读，无法安全保存此预览。可以改为导出应用信息。",
                    "Read-only database cannot hold the deletion lease",
                ));
            }
            db.busy_timeout(Duration::from_secs(3))?;
        }
        let tx = db
            .as_mut()
            .map(|db| db.transaction_with_behavior(TransactionBehavior::Immediate))
            .transpose()?;
        if self.preview.expires_at <= now()
            || match (&tx, self.generation) {
                (Some(tx), Some(expected)) => generation(tx)? != expected,
                (None, None) => false,
                _ => true,
            }
        {
            return Err(expired());
        }
        let parent = destination
            .parent()
            .filter(|_| destination.is_absolute())
            .ok_or_else(|| {
                Error::new(
                    "DIAGNOSTIC_WRITE_FAILED",
                    "请选择本地文件位置。",
                    "Destination must be absolute",
                )
            })?;
        let parent = fs::canonicalize(parent).map_err(|error| {
            Error::new(
                "DIAGNOSTIC_WRITE_FAILED",
                "保存位置不可用，请重新选择。",
                error,
            )
        })?;
        let owned_root = fs::canonicalize(&self.data_dir).unwrap_or_else(|_| self.data_dir.clone());
        if parent.starts_with(&owned_root) {
            return Err(Error::new(
                "DIAGNOSTIC_WRITE_FAILED",
                "请将诊断保存到 Proof 数据目录之外。",
                "Export must be user-owned",
            ));
        }
        let path = parent.join(destination.file_name().ok_or_else(expired)?);
        #[cfg(unix)]
        let directory = {
            use std::os::unix::fs::OpenOptionsExt;
            OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(&parent)?
        };
        #[cfg(unix)]
        let opened = {
            use std::os::{
                fd::{AsRawFd, FromRawFd},
                unix::ffi::OsStrExt,
            };
            let name = std::ffi::CString::new(path.file_name().ok_or_else(expired)?.as_bytes())
                .map_err(|_| expired())?;
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_NONBLOCK
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(unsafe { std::fs::File::from_raw_fd(fd) })
            }
        };
        #[cfg(not(unix))]
        let opened = OpenOptions::new().write(true).create_new(true).open(&path);
        let mut file = opened.map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                Error::new(
                    "DIAGNOSTIC_DESTINATION_EXISTS",
                    "文件已存在，请选择其他文件名。",
                    "No file was replaced",
                )
            } else {
                Error::new(
                    "DIAGNOSTIC_WRITE_FAILED",
                    "诊断未能保存，请检查位置、权限和剩余空间。",
                    error,
                )
            }
        })?;
        let result = file
            .write_all(self.preview.content.as_bytes())
            .and_then(|_| file.sync_all());
        if let Err(error) = result {
            // The selected destination is a user-owned export, including on failure.
            // Do not unlink by pathname: another process could have replaced it.
            return Err(Error::new(
                "DIAGNOSTIC_WRITE_FAILED",
                "诊断未能完整保存，目标位置可能留有不完整文件，请检查后重新导出。",
                error,
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let owned = file.metadata()?;
            let current = fs::symlink_metadata(&path)?;
            let original_parent = directory.metadata()?;
            let current_parent = fs::symlink_metadata(&parent)?;
            if (owned.dev(), owned.ino()) != (current.dev(), current.ino())
                || (original_parent.dev(), original_parent.ino())
                    != (current_parent.dev(), current_parent.ino())
            {
                return Err(Error::new(
                    "DIAGNOSTIC_WRITE_FAILED",
                    "保存位置已改变，请检查目标文件后重新导出。",
                    "Destination identity changed",
                ));
            }
            directory.sync_all()?;
        }
        // This transaction makes no database writes; release the deletion lease after publication.
        drop(tx);
        Ok(DiagnosticSaved {
            path: path.to_string_lossy().into_owned(),
            bytes: self.preview.bytes,
            sha256: self.preview.sha256,
        })
    }
}

/// A separate cache for application information. It never opens a database,
/// reads an Agent configuration, or incorporates old local records/measurements.
/// This remains available when the main core cannot start.
pub struct ApplicationDiagnostics {
    data_dir: PathBuf,
    previews: std::collections::VecDeque<DiagnosticPreview>,
    error_code: Option<String>,
    diagnostic_error: Option<String>,
}
impl ApplicationDiagnostics {
    pub fn new(data_dir: PathBuf, error_code: Option<&str>) -> Self {
        Self {
            data_dir,
            previews: Default::default(),
            error_code: error_code.map(|code| safe_error_code(code).to_owned()),
            diagnostic_error: None,
        }
    }
    pub fn note_failure(&mut self, code: &str) {
        self.diagnostic_error = Some(safe_error_code(code).to_owned());
    }
    pub fn prepare(&mut self) -> Result<DiagnosticPreview> {
        let captured = now();
        let document = json!({"schemaVersion":1,"product":"Proof","version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"capturedAt":captured,
            "scope":"application_only","adapterVersion":crate::OBSERVER_ADAPTER_VERSION,"startupErrorCode":self.error_code,"diagnosticErrorCode":self.diagnostic_error,
            "localRecordsRead":false,"unavailableSections":["gitDetection","agentDetection","installations","observerQueue","observerGaps","performance","localPaths"],
            "excluded":["localRecords","sourceCode","prompts","agentReplies","commands","commandOutput","remoteUrls","credentials","nativeSessionIds","absolutePaths"]});
        let content = serde_json::to_string_pretty(&document)? + "\n";
        let preview = DiagnosticPreview {
            application_only: true,
            id: uuid::Uuid::new_v4().to_string(),
            file_name: format!("Proof-application-{captured}.json"),
            bytes: content.len(),
            sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
            captured_at: captured,
            expires_at: captured + PREVIEW_TTL,
            options: DiagnosticOptions::default(),
            content,
        };
        self.previews.retain(|p| p.expires_at > captured);
        while self.previews.len() >= 4 {
            self.previews.pop_front();
        }
        self.previews.push_back(preview.clone());
        Ok(preview)
    }
    pub fn validate(&mut self, id: &str, digest: &str) -> Result<DiagnosticPreview> {
        self.previews.retain(|p| p.expires_at > now());
        self.previews
            .iter()
            .find(|p| p.id == id && p.sha256 == digest)
            .cloned()
            .ok_or_else(expired)
    }
    pub fn cancel(&mut self, id: &str) {
        self.previews.retain(|p| p.id != id);
    }
    pub fn take_export(&mut self, id: &str, digest: &str) -> Result<DiagnosticExportJob> {
        let preview = self.validate(id, digest)?;
        self.cancel(id);
        Ok(DiagnosticExportJob {
            preview,
            generation: None,
            data_dir: self.data_dir.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DataScope, DiagnosticMetrics};
    #[test]
    fn a_validated_preview_never_acquires_the_generation_after_deletion() {
        let root = tempfile::tempdir().unwrap();
        let mut proof = Proof::open(root.path().join("data")).unwrap();
        let summary = DiagnosticMetrics::default().snapshot(proof.diagnostic_generation().unwrap());
        let preview = proof
            .prepare_diagnostic(
                DiagnosticOptions {
                    include_paths: true,
                    include_timeline: true,
                },
                summary,
            )
            .unwrap();
        let validated = proof
            .validated_diagnostic(&preview.id, &preview.sha256)
            .unwrap();
        // Exact race seam: deletion after validation, before export-job construction.
        let mut other = Proof::open(root.path().join("data")).unwrap();
        let deletion = other.prepare_data_deletion(DataScope::All).unwrap();
        other.delete_local_data(&deletion.id).unwrap();
        let job = validated.into_export_job(proof.data_dir.clone());
        let destination = root.path().join("deleted.json");
        assert_eq!(
            job.run(&destination).unwrap_err().code,
            "DIAGNOSTIC_EXPIRED"
        );
        assert!(!destination.exists());
    }
    #[test]
    fn expired_previews_and_jobs_cannot_write_and_are_removed_from_memory() {
        let root = tempfile::tempdir().unwrap();
        let mut proof = Proof::open(root.path().join("data")).unwrap();
        let summary = DiagnosticMetrics::default().snapshot(proof.diagnostic_generation().unwrap());
        let preview = proof
            .prepare_diagnostic(DiagnosticOptions::default(), summary)
            .unwrap();
        let mut prepared = proof
            .validated_diagnostic(&preview.id, &preview.sha256)
            .unwrap();
        prepared.preview.expires_at = 0;
        assert!(prepared
            .into_export_job(proof.data_dir.clone())
            .run(&root.path().join("expired.json"))
            .is_err());
        proof.diagnostic_previews.borrow_mut()[0].preview.expires_at = 0;
        assert!(proof
            .validate_diagnostic(&preview.id, &preview.sha256)
            .is_err());
        assert!(proof.diagnostic_previews.borrow().is_empty());
        assert!(!root.path().join("expired.json").exists());
    }
}
