use crate::{
    fingerprint,
    model::{DiffLine, Hunk},
};

pub(crate) fn hunks(patch: &str, identity: &str) -> Vec<Hunk> {
    let lines: Vec<&str> = patch.split_inclusive('\n').collect();
    let starts: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.starts_with("@@ "))
        .map(|(i, _)| i)
        .collect();
    let mut result = Vec::new();
    for (number, start) in starts.iter().enumerate() {
        let end = starts.get(number + 1).copied().unwrap_or(lines.len());
        let header = lines[*start].trim_end_matches('\n').to_string();
        let mut ranges = header.split_whitespace().skip(1);
        let old_start = range_start(ranges.next().unwrap_or("-0"));
        let new_start = range_start(ranges.next().unwrap_or("+0"));
        let (mut old, mut new) = (old_start, new_start);
        let mut rows = Vec::new();
        for raw in &lines[start + 1..end] {
            let content = raw.strip_suffix('\n').unwrap_or(raw);
            let (kind, old_line, new_line) = match content.as_bytes().first() {
                Some(b'+') => {
                    let n = new;
                    new += 1;
                    ("add", None, Some(n))
                }
                Some(b'-') => {
                    let n = old;
                    old += 1;
                    ("delete", Some(n), None)
                }
                Some(b' ') => {
                    let pair = (old, new);
                    old += 1;
                    new += 1;
                    ("context", Some(pair.0), Some(pair.1))
                }
                Some(b'\\') => ("note", None, None),
                _ => continue,
            };
            rows.push(DiffLine {
                kind: kind.into(),
                content: if kind == "note" {
                    content.into()
                } else {
                    content[1..].into()
                },
                old_line,
                new_line,
            });
        }
        let block = lines[*start..end].concat();
        result.push(Hunk {
            id: fingerprint(&[identity.as_bytes(), block.as_bytes()]),
            header,
            old_start,
            new_start,
            lines: rows,
            review_state: "unreviewed".into(),
            patch: block,
        });
    }
    result
}
fn range_start(value: &str) -> u32 {
    value
        .get(1..)
        .unwrap_or("0")
        .split(',')
        .next()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0)
}

pub(crate) fn select(patch: &str, hunk: &Hunk) -> String {
    let header: String = patch
        .split_inclusive('\n')
        .take_while(|line| !line.starts_with("@@ "))
        .filter(|line| !line.starts_with("old mode ") && !line.starts_with("new mode "))
        .collect();
    format!("{header}{}", hunk.patch)
}

#[derive(Default)]
pub(crate) struct Metadata {
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
    pub binary: bool,
    pub sections: usize,
}
impl Metadata {
    pub fn mode_changed(&self) -> bool {
        self.old_mode.is_some() && self.new_mode.is_some() && self.old_mode != self.new_mode
    }
    pub fn has_mode(&self, mode: &str) -> bool {
        self.old_mode.as_deref() == Some(mode) || self.new_mode.as_deref() == Some(mode)
    }
}
pub(crate) fn metadata(patch: &str) -> Metadata {
    let mut result = Metadata::default();
    let mut in_header = false;
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            result.sections += 1;
            in_header = true;
            continue;
        }
        if line.starts_with("@@") {
            in_header = false;
        }
        if !in_header {
            continue;
        }
        if let Some(mode) = line
            .strip_prefix("old mode ")
            .or_else(|| line.strip_prefix("deleted file mode "))
        {
            result.old_mode = Some(mode.into());
        }
        if let Some(mode) = line
            .strip_prefix("new mode ")
            .or_else(|| line.strip_prefix("new file mode "))
        {
            result.new_mode = Some(mode.into());
        }
        if line.starts_with("index ") {
            if let Some(mode) = line.split_whitespace().nth(2) {
                result.old_mode.get_or_insert(mode.into());
                result.new_mode.get_or_insert(mode.into());
            }
        }
        if line == "GIT binary patch" || line.starts_with("Binary files ") {
            result.binary = true;
            in_header = false;
        }
    }
    result
}

pub(crate) fn content_identity(patch: &str) -> String {
    // Bind the base blob, file mode and literal paths. The new blob describes the
    // whole file, so including it would invalidate an unchanged, independent hunk.
    // Each hunk's complete patch and coordinates are hashed separately.
    patch
        .split_inclusive('\n')
        .take_while(|line| !line.starts_with("@@ "))
        .map(|line| {
            if let Some(index) = line.strip_prefix("index ") {
                let mut fields = index.split_whitespace();
                let hashes = fields.next().unwrap_or("");
                format!(
                    "index {} {}\n",
                    hashes.split("..").next().unwrap_or(""),
                    fields.next().unwrap_or("")
                )
            } else {
                line.to_string()
            }
        })
        .collect()
}
