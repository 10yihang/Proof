use crate::{FileDiff, Side};
use serde::{Deserialize, Serialize};

pub(crate) const PREVIEW_BYTES: usize = 1024 * 1024;
const PREVIEW_LINES: usize = 10_000;
const PREVIEW_LINE_BYTES: usize = 64 * 1024;
const LOADED_BYTES: usize = 8 * 1024 * 1024;
const LOADED_LINES: usize = 100_000;
pub(crate) fn read_limit(allow_large: bool) -> usize {
    if allow_large {
        LOADED_BYTES
    } else {
        PREVIEW_BYTES
    }
}

/// A deferred read has no patch, Review units, or writable snapshot ID.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DiffRead {
    Ready { diff: FileDiff },
    Deferred { summary: DiffSummary },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub workspace_id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub side: Side,
    pub base: String,
    pub captured_at: u64,
    pub patch_bytes: Option<usize>,
    pub reason: String,
    pub can_load: bool,
}

pub(crate) fn load_reason(patch: &str, allow_large: bool) -> Option<(&'static str, bool)> {
    if patch.len() > LOADED_BYTES {
        return Some(("read_limit", false));
    }
    let mut lines = 0;
    let mut long_line = false;
    for line in patch.lines() {
        lines += 1;
        long_line |= line.len() > PREVIEW_LINE_BYTES;
        if lines > LOADED_LINES {
            return Some(("read_limit", false));
        }
    }
    if !allow_large {
        if patch.len() > PREVIEW_BYTES {
            return Some(("patch_size", true));
        }
        if lines > PREVIEW_LINES {
            return Some(("line_count", true));
        }
        if long_line {
            return Some(("long_line", true));
        }
    }
    None
}

impl FileDiff {
    /// Owned payload capacity, not allocator overhead or process RSS.
    pub(crate) fn retained_bytes(&self) -> usize {
        let strings = [
            &self.id,
            &self.workspace_id,
            &self.path,
            &self.base,
            &self.token,
            &self.patch,
            &self.guard,
        ];
        let mut bytes = std::mem::size_of::<Self>()
            + strings.into_iter().map(String::capacity).sum::<usize>()
            + self.old_path.as_ref().map_or(0, String::capacity)
            + self.notice.as_ref().map_or(0, String::capacity)
            + self.discard_reason.as_ref().map_or(0, String::capacity)
            + self.hunks.capacity() * std::mem::size_of::<crate::Hunk>();
        for hunk in &self.hunks {
            bytes += hunk.id.capacity()
                + hunk.header.capacity()
                + hunk.review_state.capacity()
                + hunk.patch.capacity()
                + hunk.lines.capacity() * std::mem::size_of::<crate::DiffLine>();
            bytes += hunk
                .lines
                .iter()
                .map(|line| line.kind.capacity() + line.content.capacity())
                .sum::<usize>();
        }
        bytes
    }
}
