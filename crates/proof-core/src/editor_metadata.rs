//! Binary plist references can expand exponentially. Extract only top-level
//! application strings, under budgets for decoded events, bytes and depth.
use crate::{Error, Result};
use plist::stream::{Event, Reader};
use std::collections::BTreeMap;

const MAX_EVENTS: usize = 16_384;
const MAX_DEPTH: usize = 32;
const MAX_DECODED_BYTES: usize = 1024 * 1024;

pub(crate) fn application_fields(bytes: &[u8]) -> Result<BTreeMap<String, String>> {
    fn invalid() -> Error {
        Error::new(
            "EDITOR_APPLICATION_INVALID",
            "应用信息过于复杂或格式无效，请选择其他编辑器。",
            "Info.plist structure or decoding budget exceeded",
        )
    }
    // Dictionaries alternate keys and values. Never build nested collections.
    enum Frame {
        Dictionary(Option<String>),
        Array,
    }
    let mut stack = Vec::<Frame>::new();
    let mut fields = BTreeMap::new();
    let mut decoded = 0usize;
    let mut started = false;
    for (count, event) in Reader::new(std::io::Cursor::new(bytes)).enumerate() {
        if count >= MAX_EVENTS {
            return Err(invalid());
        }
        let event = event.map_err(|_| invalid())?;
        decoded = decoded
            .checked_add(match &event {
                Event::String(value) => value.len(),
                Event::Data(value) => value.len(),
                _ => 8,
            })
            .ok_or_else(invalid)?;
        if decoded > MAX_DECODED_BYTES {
            return Err(invalid());
        }
        if stack.is_empty() {
            if started || !matches!(event, Event::StartDictionary(_)) {
                return Err(invalid());
            }
            started = true;
        } else if matches!(event, Event::EndCollection) {
            if matches!(stack.last(), Some(Frame::Dictionary(Some(_)))) {
                return Err(invalid());
            }
            stack.pop();
            continue;
        } else {
            let root = stack.len() == 1;
            if let Some(Frame::Dictionary(pending)) = stack.last_mut() {
                if let Some(key) = pending.take() {
                    if root
                        && [
                            "CFBundlePackageType",
                            "CFBundleExecutable",
                            "CFBundleDisplayName",
                            "CFBundleName",
                            "CFBundleIdentifier",
                        ]
                        .contains(&key.as_str())
                    {
                        let Event::String(value) = &event else {
                            return Err(invalid());
                        };
                        // Some installed bundles repeat unrelated metadata keys.
                        // Only our application identity fields must be unambiguous.
                        if fields.insert(key, value.to_string()).is_some() {
                            return Err(invalid());
                        }
                    }
                } else {
                    let Event::String(value) = event else {
                        return Err(invalid());
                    };
                    let key = value.into_owned();
                    *pending = Some(key);
                    continue;
                }
            }
        }
        match event {
            Event::StartDictionary(length) | Event::StartArray(length) => {
                if length.is_some_and(|length| length > MAX_EVENTS as u64)
                    || stack.len() >= MAX_DEPTH
                {
                    return Err(invalid());
                }
                stack.push(if matches!(event, Event::StartDictionary(_)) {
                    Frame::Dictionary(None)
                } else {
                    Frame::Array
                });
            }
            Event::EndCollection => return Err(invalid()),
            _ => (),
        }
    }
    if !started || !stack.is_empty() {
        return Err(invalid());
    }
    Ok(fields)
}
