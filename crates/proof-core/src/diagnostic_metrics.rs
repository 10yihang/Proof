//! Bounded process-local measurements. Request arguments and error prose never enter this store.
use crate::{now, DiagnosticGeneration};
use serde::Serialize;
use serde_json::Value;
use std::{collections::BTreeMap, time::Duration};

const ACTIONS: &[&str] = &[
    "open_workspace",
    "changes",
    "file_diff",
    "read_file_diff",
    "diff_context",
    "stage",
    "stage_files",
    "commit_preview",
    "commit",
    "discard_preview",
    "discard",
    "undo_discard",
    "restore_missing_recovery",
    "mark_reviewed",
    "commit_graph",
    "compare_refs",
    "compare_commit",
    "compare_file",
    "read_compare_file",
    "file_history",
    "file_blame",
    "switch_branch",
    "probe_observer",
    "preview_observer_install",
    "apply_observer_config",
    "configure_observer_workspace",
    "preview_observer_uninstall",
    "open_in_editor",
    "set_editor_settings",
    "set_preferences",
    "set_repository_layout",
    "clear_observer_data",
    "delete_local_data",
    "maintain_local_data",
    "watch_workspace",
    "context_overview",
    "context_candidates",
    "context_session_events",
    "context_history",
    "update_context_association",
    "undo_context_association",
];
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionMeasurement {
    pub action: &'static str,
    pub calls: u64,
    pub failures: u64,
    pub total_milliseconds: u64,
    pub maximum_milliseconds: u64,
    /// <= 20, <= 100, <= 500, <= 2000, <= 10000, and >10000 ms.
    pub histogram: [u64; 6],
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticMeasurements {
    #[serde(skip)]
    pub(crate) generation: DiagnosticGeneration,
    pub since: u64,
    pub scope: &'static str,
    pub git_version: Option<String>,
    pub actions: Vec<ActionMeasurement>,
    pub errors: BTreeMap<String, u64>,
    pub detected_agents: BTreeMap<String, String>,
}
#[derive(Default)]
pub struct DiagnosticMetrics {
    epoch: Option<DiagnosticGeneration>,
    since: u64,
    actions: BTreeMap<&'static str, ActionMeasurement>,
    errors: BTreeMap<String, u64>,
    git_version: Option<String>,
    detected_agents: BTreeMap<String, String>,
}
impl DiagnosticMetrics {
    pub fn tracks(action: &str) -> bool {
        ACTIONS.contains(&action)
    }
    fn synchronize(&mut self, epoch: DiagnosticGeneration) {
        if self.epoch != Some(epoch) {
            *self = Self {
                epoch: Some(epoch),
                since: now(),
                ..Self::default()
            };
        }
    }
    pub fn record(
        &mut self,
        current_epoch: DiagnosticGeneration,
        request_epoch: Option<u64>,
        action: &str,
        duration: Duration,
        code: Option<&str>,
        result: Option<&Value>,
    ) {
        // A long operation can finish after deletion and after a newer request.
        if self.epoch.is_some_and(|latest| current_epoch < latest) {
            return;
        }
        self.synchronize(current_epoch);
        if request_epoch != Some(current_epoch.data_epoch) {
            return;
        }
        if action == "changes" {
            if let Some(version) = result
                .and_then(|v| v["gitVersion"].as_str())
                .and_then(|s| s.strip_prefix("git version "))
                .and_then(|s| s.split_whitespace().next())
                .and_then(safe_version)
            {
                self.git_version = Some(version);
            }
        }
        if action == "probe_observer" {
            if let Some(value) = result {
                if let (Some(agent @ ("codex" | "claude" | "codewiz")), Some(version)) = (
                    value["agent"].as_str(),
                    value["version"].as_str().and_then(safe_version),
                ) {
                    self.detected_agents.insert(agent.into(), version);
                }
            }
        }
        let Some(action) = ACTIONS.iter().find(|known| **known == action).copied() else {
            return;
        };
        let ms = duration.as_millis().min(u64::MAX as u128) as u64;
        let row = self
            .actions
            .entry(action)
            .or_insert_with(|| ActionMeasurement {
                action,
                ..ActionMeasurement::default()
            });
        row.calls = row.calls.saturating_add(1);
        row.total_milliseconds = row.total_milliseconds.saturating_add(ms);
        row.maximum_milliseconds = row.maximum_milliseconds.max(ms);
        let bucket = [20, 100, 500, 2000, 10000]
            .iter()
            .position(|upper| ms <= *upper)
            .unwrap_or(5);
        row.histogram[bucket] = row.histogram[bucket].saturating_add(1);
        if let Some(code) = code {
            row.failures = row.failures.saturating_add(1);
            let count = self.errors.entry(safe_error_code(code).into()).or_default();
            *count = count.saturating_add(1);
        }
    }
    pub fn snapshot(&mut self, epoch: DiagnosticGeneration) -> DiagnosticMeasurements {
        self.synchronize(epoch);
        DiagnosticMeasurements {
            generation: epoch,
            since: self.since,
            scope: "current_process_since_start_or_local_record_deletion",
            git_version: self.git_version.clone(),
            actions: self.actions.values().cloned().collect(),
            errors: self.errors.clone(),
            detected_agents: self.detected_agents.clone(),
        }
    }
}
/// Public version identifiers only, never suffixes supplied by external programs.
pub(crate) fn safe_version(value: &str) -> Option<String> {
    let parts: Vec<_> = value.split('.').collect();
    ((1..=4).contains(&parts.len())
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 6 && part.bytes().all(|b| b.is_ascii_digit())
        }))
    .then(|| value.to_owned())
}
pub(crate) fn safe_error_code(code: &str) -> &str {
    if ERROR_CODES.contains(&code) {
        code
    } else {
        "UNCLASSIFIED_ERROR"
    }
}
// Closed vocabulary from native error producers. Unknown codes are not copied.
const ERROR_CODES: &[&str] = &[
    "DIAGNOSTIC_STORAGE_READONLY",
    "CORE_STARTUP_FAILED",
    "BINARY_BLAME",
    "BLAME_INCOMPLETE",
    "BLAME_PARSE",
    "BLAME_TRANSFORM",
    "BRANCH_MISSING",
    "CAPTURE_CHANGED",
    "CHANGE_MISSING",
    "COMMIT_FAILED",
    "COMMIT_MESSAGE",
    "COMPARE_ENCODING",
    "COMPARE_FILE_MISSING",
    "COMPARE_FILE_RANGE",
    "COMPARE_LIMIT",
    "COMPARE_PARENT",
    "COMPARE_PARSE",
    "COMPARE_REVISION",
    "CONFIG_ENCODING",
    "CONTEXT_MISMATCH",
    "CONTEXT_INVALID",
    "CONTEXT_CHANGED",
    "CONTEXT_SESSION_EXPIRED",
    "CONTEXT_TOO_LARGE",
    "CONTEXT_UNAVAILABLE",
    "CORE_UNAVAILABLE",
    "DATABASE_VERSION",
    "DATA_CLEANUP_CHANGED",
    "DATA_CLEANUP_PATH",
    "DATA_CLEANUP_PENDING",
    "DATA_CLEANUP_PLATFORM",
    "DATA_CLEANUP_RANGE",
    "DATA_CLEANUP_UNRECOGNIZED",
    "DATA_DELETE_PARTIAL",
    "DATA_EPOCH_CHANGED",
    "DATA_EPOCH_LIMIT",
    "DATA_ERROR",
    "DATA_INDEX_BUSY",
    "DATA_LEGACY_INDEX_BUSY",
    "DATA_PREVIEW_EXPIRED",
    "DATA_RECORDS_DELETED",
    "DATA_SCOPE_CHANGED",
    "DATA_SCOPE_MISSING",
    "DATA_SESSION_REQUIRED",
    "DIAGNOSTIC_CHANGED",
    "DIAGNOSTIC_DESTINATION_EXISTS",
    "DIAGNOSTIC_EXPIRED",
    "DIAGNOSTIC_LIMIT",
    "DIAGNOSTIC_WRITE_FAILED",
    "EDITOR_APPLICATION_CHANGED",
    "EDITOR_APPLICATION_INVALID",
    "EDITOR_APPLICATION_MISSING",
    "EDITOR_APPLICATION_PATH",
    "EDITOR_APPLICATION_TYPE",
    "EDITOR_FILE_CHANGED",
    "EDITOR_FILE_MISSING",
    "EDITOR_FILE_PATH",
    "EDITOR_FILE_TYPE",
    "EDITOR_LAUNCH_FAILED",
    "EDITOR_NOT_CONFIGURED",
    "EDITOR_PLATFORM",
    "EDITOR_SCOPE",
    "EDITOR_SETTINGS_CHANGED",
    "EDITOR_SETTINGS_INVALID",
    "FILE_MISSING",
    "FILE_TOO_LARGE",
    "GIT_APPLIED_REFRESH_REQUIRED",
    "GIT_COMMAND_FAILED",
    "GIT_EXECUTION_FAILED",
    "GIT_FAILED",
    "GIT_IN_PROGRESS",
    "GIT_LOCKED",
    "GIT_PARSE",
    "GIT_UNAVAILABLE",
    "GRAPH_CHANGED",
    "GRAPH_PARSE",
    "GRAPH_RANGE",
    "GRAPH_REFERENCE_LIMIT",
    "GRAPH_REF_MISSING",
    "GRAPH_REWRITTEN_HISTORY",
    "GRAPH_SHALLOW_BOUNDARY",
    "GRAPH_SNAPSHOT",
    "GRAPH_TIPS_LIMIT",
    "HUNK_MISSING",
    "INDEX_LOCKED",
    "INDEX_SCOPE_CHANGED",
    "INVALID_BRANCH",
    "INVALID_CONTEXT_SIZE",
    "INVALID_LAYOUT",
    "INVALID_PARENT",
    "INVALID_PATH",
    "INVALID_REQUEST",
    "INVALID_REVISION",
    "INVALID_SELECTION",
    "INVALID_SETTING",
    "IO_ERROR",
    "METADATA_REQUIRES_FILE_ACTION",
    "NOTHING_STAGED",
    "NO_COMMIT_TO_AMEND",
    "OBSERVER_ALREADY_CONFIGURED",
    "OBSERVER_BRIDGE_OUTPUT",
    "OBSERVER_COMBINATION_UNVERIFIED",
    "OBSERVER_CONFIG_BUSY",
    "OBSERVER_CONFIG_CHANGED",
    "OBSERVER_CONFIG_ENCODING",
    "OBSERVER_CONFIG_FILE",
    "OBSERVER_CONFIG_LIMIT",
    "OBSERVER_CONFIG_NOT_READY",
    "OBSERVER_CONFIG_PATH",
    "OBSERVER_CONFIG_PLATFORM",
    "OBSERVER_CONFIG_RECEIPT",
    "OBSERVER_CONFIG_STATE",
    "OBSERVER_CONFIG_STATE_CHANGED",
    "OBSERVER_CONNECTION_FAILED",
    "OBSERVER_EVENT_UNSUPPORTED",
    "OBSERVER_GAP_CODE",
    "OBSERVER_HEALTH_WRITE",
    "OBSERVER_HELPER_CHANGED",
    "OBSERVER_HELPER_INVALID",
    "OBSERVER_INPUT_LIMIT",
    "OBSERVER_INSTALL_BUSY",
    "OBSERVER_LEASE_PERMISSION",
    "OBSERVER_MISSING",
    "OBSERVER_NORMALIZED_LIMIT",
    "OBSERVER_POLICY_CHANGED",
    "OBSERVER_PREVIEW_EXPIRED",
    "OBSERVER_PROBE_TIMEOUT",
    "OBSERVER_PROGRAM_CHANGED",
    "OBSERVER_PROGRAM_MISSING",
    "OBSERVER_PROGRAM_PATH",
    "OBSERVER_PROGRAM_PERMISSION",
    "OBSERVER_PROGRAM_TYPE",
    "OBSERVER_REQUEST",
    "OBSERVER_SCHEMA",
    "OBSERVER_SCOPE",
    "OBSERVER_START_FAILED",
    "OBSERVER_START_TIMEOUT",
    "OBSERVER_STOP_PENDING",
    "OBSERVER_STORAGE_LIMIT",
    "OBSERVER_STORAGE_MEASUREMENT_LIMIT",
    "OBSERVER_STORAGE_PATH",
    "OBSERVER_TRANSPORT",
    "OBSERVER_UNINSTALL_REQUIRED",
    "OBSERVER_VERSION",
    "OBSERVER_VERSION_FORMAT",
    "OBSERVER_VERSION_QUERY",
    "OBSERVER_VERSION_UNSUPPORTED",
    "OUTPUT_LIMIT",
    "PATH_ENCODING",
    "PATH_ESCAPE",
    "PATH_UNAVAILABLE",
    "PROCESS_CANCELLED",
    "PROCESS_OUTPUT_LIMIT",
    "PROCESS_READ",
    "PROCESS_START",
    "PROCESS_TIMEOUT",
    "RECOVERY_ACTIVE",
    "RECOVERY_BUSY",
    "RECOVERY_CONCURRENT_BACKUP",
    "RECOVERY_DAMAGED",
    "RECOVERY_EXPIRED",
    "RECOVERY_FULL",
    "RECOVERY_MISSING",
    "RECOVERY_MISSING_PATH",
    "RECOVERY_PLATFORM",
    "RECOVERY_RECREATE_SCOPE",
    "RECOVERY_STATE",
    "RECOVERY_VERSION",
    "RECOVERY_VOLUME",
    "RENAME_SOURCE_CHANGED",
    "REVIEW_REQUIRED",
    "SNAPSHOT_EXPIRED",
    "STALE_CONTENT",
    "STORAGE_ERROR",
    "SUBMODULE_ACTION",
    "TEXT_ENCODING",
    "TRUST_REQUIRED",
    "UNCLASSIFIED_ERROR",
    "UNKNOWN_COMMAND",
    "UNRESOLVED_CONFLICT",
    "UNSUPPORTED_DISCARD",
    "UNSUPPORTED_HUNK_TRANSFORM",
    "UNSUPPORTED_PATCH",
    "UNSUPPORTED_RECOVERY_ENCODING",
    "UNSUPPORTED_RECOVERY_FILE",
    "WATCH_UNAVAILABLE",
    "WORKSPACE_MISSING",
    "WORKSPACE_REPLACED",
];
