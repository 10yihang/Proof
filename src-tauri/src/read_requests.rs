use proof_core::{Error, ReadCancellation};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Default)]
pub(crate) struct ReadRequests(Arc<Mutex<HashMap<String, Entry>>>);
struct Entry {
    owner: String,
    cancellation: ReadCancellation,
    claimed: bool,
    created: Instant,
}
pub(crate) struct ReadTicket {
    pub cancellation: ReadCancellation,
    registry: ReadRequests,
    id: String,
}
fn cancelled() -> Error {
    Error::new(
        "READ_CANCELLED",
        "本次读取已取消。",
        "Read ticket is missing, expired or already claimed",
    )
}
impl ReadRequests {
    pub fn prepare(&self, owner: &str) -> Result<String, Error> {
        let mut entries = self.0.lock().map_err(|_| cancelled())?;
        entries
            .retain(|_, entry| entry.claimed || entry.created.elapsed() < Duration::from_secs(30));
        if entries.len() >= 64 {
            return Err(Error::new(
                "READ_QUEUE_FULL",
                "正在读取其他内容，请稍后重试。",
                "Read request capacity reached",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        entries.insert(
            id.clone(),
            Entry {
                owner: owner.into(),
                cancellation: ReadCancellation::default(),
                claimed: false,
                created: Instant::now(),
            },
        );
        Ok(id)
    }
    pub fn claim(&self, owner: &str, id: &str, command: &str) -> Result<ReadTicket, Error> {
        if !matches!(
            command,
            "run_ai_task"
                | "probe_ai_agent"
                | "read_file_diff"
                | "read_compare_file"
                | "compare_commit"
                | "compare_refs"
                | "diff_context"
                | "compare_context"
        ) {
            return Err(Error::new(
                "INVALID_READ_REQUEST",
                "此操作不支持读取取消。",
                "Write commands cannot claim a read ticket",
            ));
        }
        let mut entries = self.0.lock().map_err(|_| cancelled())?;
        let entry = entries
            .get_mut(id)
            .filter(|entry| entry.owner == owner && !entry.claimed)
            .ok_or_else(cancelled)?;
        if entry.created.elapsed() >= Duration::from_secs(30) {
            entries.remove(id);
            return Err(cancelled());
        }
        entry.claimed = true;
        Ok(ReadTicket {
            cancellation: entry.cancellation.clone(),
            registry: self.clone(),
            id: id.into(),
        })
    }
    pub fn cancel(&self, owner: &str, id: &str) -> bool {
        let Ok(mut entries) = self.0.lock() else {
            return false;
        };
        let Some(entry) = entries.get(id).filter(|entry| entry.owner == owner) else {
            return false;
        };
        entry.cancellation.cancel();
        if !entry.claimed {
            entries.remove(id);
        }
        true
    }
    pub fn cancel_owner(&self, owner: &str) {
        if let Ok(mut entries) = self.0.lock() {
            entries.retain(|_, entry| {
                if entry.owner == owner {
                    entry.cancellation.cancel();
                    entry.claimed
                } else {
                    true
                }
            });
        }
    }
}
impl Drop for ReadTicket {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.registry.0.lock() {
            entries.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn context_reads_share_scoped_cancellation_without_authorizing_writes() {
        let reads = ReadRequests::default();
        for command in ["diff_context", "compare_context"] {
            let id = reads.prepare("main").unwrap();
            let ticket = reads.claim("main", &id, command).unwrap();
            assert!(reads.cancel("main", &id));
            assert_eq!(
                ticket.cancellation.check().unwrap_err().code,
                "READ_CANCELLED"
            );
        }
        assert!(reads.0.lock().unwrap().is_empty());
    }
    #[test]
    fn cancelling_before_dispatch_cannot_resurrect_a_read() {
        let reads = ReadRequests::default();
        let id = reads.prepare("main").unwrap();
        assert!(reads.cancel("main", &id));
        assert!(reads.claim("main", &id, "read_file_diff").is_err());
    }
    #[test]
    fn cancellation_is_owned_one_shot_and_excludes_writes() {
        let reads = ReadRequests::default();
        let id = reads.prepare("main").unwrap();
        assert!(!reads.cancel("other", &id));
        assert!(reads.claim("main", &id, "stage").is_err());
        let ticket = reads.claim("main", &id, "read_file_diff").unwrap();
        assert!(reads.claim("main", &id, "read_file_diff").is_err());
        assert!(ticket.cancellation.check().is_ok());
        assert!(reads.cancel("main", &id));
        assert_eq!(
            ticket.cancellation.check().unwrap_err().code,
            "READ_CANCELLED"
        );
        drop(ticket);
        assert_eq!(reads.0.lock().unwrap().len(), 0);
    }
}
