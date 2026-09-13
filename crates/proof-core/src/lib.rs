mod adapter;
mod data;
mod editor;
#[cfg(target_os = "macos")]
mod editor_metadata;
mod error;
mod git;
mod graph;
mod guarded_file;
mod history;
mod local_data;
mod model;
mod observer;
mod owned_data;
mod patch;
mod process;
mod program;
mod reading;
mod recovery;
mod service;
mod staging;
mod store;
mod transient;

pub use adapter::*;
pub use data::*;
pub use editor::*;
pub use error::{Error, Result};
pub use local_data::*;
pub use model::*;
pub use observer::*;
pub use process::cancel_owned_operations_for_shutdown;
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
