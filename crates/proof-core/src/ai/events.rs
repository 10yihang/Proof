//! JSONL transport framing shared by final-result and activity readers.
use regex::bytes::Regex;
use serde_json::Value;
use std::{borrow::Cow, sync::OnceLock};

/// CLI diagnostics may share stdout with the event stream. Only parse objects
/// at the start of a line, never JSON embedded in a log message. Strip terminal
/// formatting at line boundaries only: damaged event payloads must still fail.
pub(super) fn parse_line(line: &[u8]) -> serde_json::Result<Option<Value>> {
    let line = line.trim_ascii();
    let line = if line.contains(&0x1b) || line.starts_with(b"\xef\xbb\xbf") {
        static DECORATION: OnceLock<Regex> = OnceLock::new();
        DECORATION
            .get_or_init(|| {
                Regex::new(
                    r"(?-u)^(?:\xEF\xBB\xBF|[ \t\r]|\x1b\[[0-?]*[ -/]*[@-~])+|(?:[ \t\r]|\x1b\[[0-?]*[ -/]*[@-~])+$",
                )
                .expect("static terminal decoration pattern")
            })
            .replace_all(line, &b""[..])
    } else {
        Cow::Borrowed(line)
    };
    if line.first() != Some(&b'{') {
        return Ok(None);
    }
    serde_json::from_slice(&line).map(Some)
}
