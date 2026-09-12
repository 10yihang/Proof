mod error;
mod git;
mod guarded_file;
mod history;
mod model;
mod patch;
mod process;
mod recovery;
mod service;
mod store;

pub use error::{Error, Result};
pub use model::*;
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
