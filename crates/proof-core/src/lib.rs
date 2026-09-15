mod adapter;
mod ai;
mod compare;
mod context;
mod data;
mod diagnostic_metrics;
mod diagnostics;
mod diff_load;
mod editor;
#[cfg(target_os = "macos")]
mod editor_metadata;
mod error;
mod git;
mod graph;
mod guarded_file;
mod history;
mod history_actions;
mod hook_registry;
mod language;
mod local_data;
mod model;
mod observer;
mod owned_data;
mod patch;
mod process;
mod program;
mod read_cancel;
mod reading;
mod recovery;
mod service;
mod staging;
mod store;
mod transient;

pub use adapter::*;
pub use ai::*;
pub use compare::*;
pub use context::*;
pub use data::*;
pub use diagnostic_metrics::*;
pub use diagnostics::*;
pub use diff_load::{DiffRead, DiffSummary};
pub use editor::*;
pub use error::{Error, Result};
pub use history_actions::*;
pub use hook_registry::*;
pub use language::*;
pub use local_data::*;
pub use model::*;
pub use observer::*;
pub use process::cancel_owned_operations_for_shutdown;
pub use read_cancel::{check_read_cancellation, read_cancellation_active, ReadCancellation};
pub use service::Proof;

pub(crate) fn fingerprint(parts: &[&[u8]]) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    format!("{:x}", hash.finalize())
}
pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
