//! Durable, read-only Finding anchors. A mapped position is not a resolution verdict.
use crate::{
    ai::{AiFinding, AiScope, LineSide},
    fingerprint, git, process, ChangedFile, Error, Proof, Result, Side,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, time::Duration};

const FILE_LIMIT: usize = 1024 * 1024;
const ANCHOR_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingAnchors {
    pub epoch: u64,
    #[serde(default)]
    pub target_oid: Option<String>,
    pub files: Vec<FindingAnchor>,
    pub entries: Vec<FindingAnchorEntry>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingAnchor {
    pub path: String,
    pub current_path: String,
    pub source: String,
    pub content: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingAnchorEntry {
    pub file: Option<usize>,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingLocationDocument {
    pub path: String,
    pub source: String,
    pub line: Option<u32>,
    pub end_line: Option<u32>,
    pub content: String,
    pub start_line: u32,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingLocation {
    pub workspace_id: String,
    pub path: String,
    pub status: String,
    pub original: Option<FindingLocationDocument>,
    pub current: Option<FindingLocationDocument>,
    pub candidates: Vec<FindingLocationCandidate>,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingLocationCandidate {
    pub line: u32,
    pub end_line: u32,
}
fn bounded(content: String, path: &str) -> Result<String> {
    if content.len() > FILE_LIMIT || content.lines().count() > 100_000 {
        return Err(Error::new(
            "FILE_TOO_LARGE",
            "定位仅支持 1 MiB、10 万行以内的文本文件。",
            path,
        ));
    }
    if content.contains('\0') {
        return Err(Error::new(
            "BINARY_FILE",
            "二进制文件不提供文本定位。",
            path,
        ));
    }
    Ok(content)
}
fn document(
    path: &str,
    source: &str,
    content: String,
    range: Option<(u32, u32)>,
) -> FindingLocationDocument {
    FindingLocationDocument {
        path: path.into(),
        source: source.into(),
        line: range.map(|range| range.0),
        end_line: range.map(|range| range.1),
        fingerprint: fingerprint(&[content.as_bytes()]),
        content,
        start_line: 1,
    }
}
// Linear line matching also handles overlapping repeated blocks without a
// quadratic scan on a long range of identical lines.
fn matching_lines(haystack: &[&str], needle: &[&str]) -> Vec<usize> {
    if needle.is_empty() {
        return vec![];
    }
    let mut prefix = vec![0usize; needle.len()];
    let mut matched = 0;
    for index in 1..needle.len() {
        while matched > 0 && needle[index] != needle[matched] {
            matched = prefix[matched - 1];
        }
        if needle[index] == needle[matched] {
            matched += 1;
        }
        prefix[index] = matched;
    }
    let mut starts = vec![];
    matched = 0;
    for (index, line) in haystack.iter().enumerate() {
        while matched > 0 && *line != needle[matched] {
            matched = prefix[matched - 1];
        }
        if *line == needle[matched] {
            matched += 1;
        }
        if matched == needle.len() {
            starts.push(index + 2 - needle.len());
            matched = prefix[matched - 1];
        }
    }
    starts
}
impl Proof {
    /// Capture exactly the cited Git side; raw blobs never execute filters/textconv.
    /// Failed and oversized captures leave explicit per-Finding limitations.
    pub fn capture_finding_anchors(
        &self,
        workspace_id: &str,
        scope: &AiScope,
        findings: &[AiFinding],
        files: &[ChangedFile],
    ) -> Result<FindingAnchors> {
        let workspace = self.store.workspace(workspace_id)?;
        if !workspace.trusted {
            return Err(Error::new(
                "TRUST_REQUIRED",
                "请先确认仓库信任。",
                "Finding capture requires trust",
            ));
        }
        let target_oid = match scope {
            AiScope::Comparison { target, .. } => Some(target.clone()),
            AiScope::Local { .. } => self.git()?.head(&workspace)?,
        };
        let mut anchors = FindingAnchors {
            epoch: self.cached_data_epoch,
            target_oid,
            ..Default::default()
        };
        let mut known = HashMap::new();
        for finding in findings {
            crate::check_read_cancellation()?;
            let old = finding.line_side == LineSide::Old;
            let file = files
                .iter()
                .find(|file| file.path == finding.file && file.side == finding.side);
            let path = if old {
                file.and_then(|file| file.old_path.as_deref())
                    .unwrap_or(&finding.file)
            } else {
                &finding.file
            };
            let (source, revision) = match (scope, finding.side, old) {
                (AiScope::Comparison { base, .. }, _, true) => ("base", Some(base.as_str())),
                (AiScope::Comparison { target, .. }, _, false) => ("target", Some(target.as_str())),
                (AiScope::Local { .. }, Side::Staged, true) => ("head", Some("HEAD")),
                (AiScope::Local { .. }, Side::Staged, false)
                | (AiScope::Local { .. }, Side::Unstaged, true) => ("index", Some("index")),
                (AiScope::Local { .. }, Side::Unstaged, false) => ("worktree", None),
            };
            let key = format!("{source}:{path}");
            let result = if let Some(index) = known.get(&key) {
                Ok(*index)
            } else {
                (|| {
                    git::checked_path(&workspace, path)?;
                    let content = if let Some(revision) = revision {
                        let object = if revision == "index" {
                            format!(":{path}")
                        } else {
                            let oid = if revision == "HEAD" {
                                self.git()?.head(&workspace)?.ok_or_else(|| {
                                    Error::new("FILE_MISSING", "审查原版本不存在。", path)
                                })?
                            } else {
                                crate::text_files::verified_commit(
                                    &self.git()?,
                                    &workspace,
                                    revision,
                                )?
                            };
                            format!("{oid}:{path}")
                        };
                        let mut command = self.workspace_watch_spec(workspace_id)?.command();
                        command
                            .args(["--no-replace-objects", "cat-file", "blob", &object])
                            .env("GIT_NO_LAZY_FETCH", "1");
                        let bytes = process::checked(process::run_diff(
                            command,
                            None,
                            Duration::from_secs(20),
                            FILE_LIMIT,
                        )?)?;
                        String::from_utf8(bytes).map_err(|_| {
                            Error::new("UNSUPPORTED_ENCODING", "文件不是有效 UTF-8 文本。", path)
                        })?
                    } else {
                        self.finding_current_content(workspace_id, path)?
                    };
                    let content = bounded(content, path)?;
                    let index = anchors.files.len();
                    anchors.files.push(FindingAnchor {
                        path: path.into(),
                        current_path: finding.file.clone(),
                        source: source.into(),
                        content,
                    });
                    if serde_json::to_vec(&anchors)?.len() > ANCHOR_LIMIT {
                        anchors.files.pop();
                        return Err(Error::new(
                            "ANCHOR_STORAGE_LIMIT",
                            "本次审查的定位基线超过保存上限。",
                            path,
                        ));
                    }
                    known.insert(key.clone(), index);
                    Ok(index)
                })()
            };
            anchors.entries.push(match result {
                Ok(file) => FindingAnchorEntry {
                    file: Some(file),
                    reason: None,
                },
                Err(error) => FindingAnchorEntry {
                    file: None,
                    reason: Some(if error.code == "DIFF_OUTPUT_LIMIT" {
                        "FILE_TOO_LARGE".into()
                    } else {
                        error.code
                    }),
                },
            });
        }
        while serde_json::to_vec(&anchors)?.len() > ANCHOR_LIMIT {
            let Some(last) = anchors.files.len().checked_sub(1) else {
                break;
            };
            anchors.files.pop();
            for entry in &mut anchors.entries {
                if entry.file == Some(last) {
                    entry.file = None;
                    entry.reason = Some("ANCHOR_STORAGE_LIMIT".into());
                }
            }
        }
        Ok(anchors)
    }

    /// Resolve a stored Finding identity; the renderer cannot supply a baseline.
    pub fn resolve_finding_location(
        &self,
        workspace_id: &str,
        report_id: &str,
        finding_index: usize,
    ) -> Result<FindingLocation> {
        let report = self.ai_review_report(workspace_id, report_id)?;
        let finding = report
            .review
            .as_ref()
            .and_then(|review| review.findings.get(finding_index))
            .ok_or_else(|| {
                Error::new("AI_FINDING_NOT_FOUND", "此 Finding 不存在。", finding_index)
            })?;
        let raw: Option<String> = self
            .store
            .connection
            .query_row(
                "SELECT value FROM ai_finding_anchors WHERE report_id=?",
                [report_id],
                |row| row.get(0),
            )
            .optional()?;
        let mut anchors = raw
            .as_deref()
            .map(serde_json::from_str::<FindingAnchors>)
            .transpose()?;
        // Immutable historical objects can reconstruct old reports without guessing.
        if anchors.is_none() && matches!(report.scope, AiScope::Comparison { .. }) {
            if let AiScope::Comparison { base, target, .. } = &report.scope {
                let comparison = self.frozen_comparison(workspace_id, base, target)?;
                anchors = Some(self.capture_finding_anchors(
                    workspace_id,
                    &report.scope,
                    &report.review.as_ref().unwrap().findings,
                    &comparison.files,
                )?);
            }
        }
        if anchors.is_none() && matches!(report.scope, AiScope::Local { .. }) {
            if let Some(reference) = report.files.iter().find(|file| {
                file.path == finding.file
                    && file.side == finding.side
                    && !file.snapshot_token.is_empty()
            }) {
                if let Ok(diff) = self.snapshot(&reference.snapshot_id) {
                    if diff.token == reference.snapshot_token && self.validate(&diff).is_ok() {
                        let files = self.changes(workspace_id)?.files;
                        let mut captured = self.capture_finding_anchors(
                            workspace_id,
                            &report.scope,
                            std::slice::from_ref(finding),
                            &files,
                        )?;
                        let entry = captured.entries.pop().unwrap_or_default();
                        captured.entries = vec![FindingAnchorEntry::default(); finding_index + 1];
                        captured.entries[finding_index] = entry;
                        anchors = Some(captured);
                    }
                }
            }
        }
        self.resolve_captured_finding_location(
            workspace_id,
            finding,
            anchors.as_ref(),
            finding_index,
        )
    }

    pub fn resolve_captured_finding_location(
        &self,
        workspace_id: &str,
        finding: &AiFinding,
        anchors: Option<&FindingAnchors>,
        finding_index: usize,
    ) -> Result<FindingLocation> {
        let workspace = self.store.workspace(workspace_id)?;
        if !workspace.trusted {
            return Err(Error::new(
                "TRUST_REQUIRED",
                "请先确认仓库信任。",
                "Finding location requires trust",
            ));
        }
        git::checked_path(&workspace, &finding.file)?;
        // The caller validates its current data session. A retained report owns
        // this baseline through its FK; unrelated data deletion may bump epoch.
        let entry = anchors.and_then(|anchors| anchors.entries.get(finding_index));
        let anchor = entry
            .and_then(|entry| entry.file)
            .and_then(|index| anchors.and_then(|anchors| anchors.files.get(index)));
        let mut result = FindingLocation {
            workspace_id: workspace_id.into(),
            path: finding.file.clone(),
            status: "unavailable".into(),
            original: None,
            current: None,
            candidates: vec![],
            reason: Some(
                entry
                    .and_then(|entry| entry.reason.clone())
                    .unwrap_or_else(|| "ANCHOR_NOT_SAVED".into()),
            ),
        };
        let mut current_path = finding.file.clone();
        if !git::checked_path(&workspace, &current_path)?.exists() {
            let renamed: Vec<_> = self
                .changes(workspace_id)?
                .files
                .into_iter()
                .filter(|file| {
                    file.old_path.as_deref() == Some(finding.file.as_str())
                        && file.path != finding.file
                })
                .map(|file| file.path)
                .collect();
            let mut renamed: std::collections::BTreeSet<String> = renamed.into_iter().collect();
            if renamed.is_empty() {
                if let Some(oid) = anchors.and_then(|anchors| anchors.target_oid.as_deref()) {
                    renamed = self.finding_renamed_paths(workspace_id, oid, &finding.file)?;
                }
            }
            if renamed.len() == 1 {
                current_path = renamed.into_iter().next().unwrap();
                result.path = current_path.clone();
            } else if renamed.len() > 1 {
                result.reason = Some("RENAME_AMBIGUOUS".into());
            }
        }
        let current_content = match self.finding_current_content(workspace_id, &current_path) {
            Ok(content) => Some(content),
            Err(error) if error.code == "FILE_MISSING" => None,
            Err(error) => {
                result.reason = Some(error.code);
                None
            }
        };
        if let Some(content) = current_content.as_ref() {
            result.current = Some(document(&current_path, "worktree", content.clone(), None));
        }
        let Some(anchor) = anchor else {
            return Ok(result);
        };
        git::checked_path(&workspace, &anchor.path)?;
        let end = finding.end_line.unwrap_or(finding.line);
        let original_lines: Vec<_> = anchor.content.lines().collect();
        if finding.line == 0 || end < finding.line || end as usize > original_lines.len() {
            result.original = Some(document(
                &anchor.path,
                &anchor.source,
                anchor.content.clone(),
                None,
            ));
            result.reason = Some("ORIGINAL_LINE_UNAVAILABLE".into());
            return Ok(result);
        }
        result.original = Some(document(
            &anchor.path,
            &anchor.source,
            anchor.content.clone(),
            Some((finding.line, end)),
        ));
        let Some(content) = current_content else {
            if result.reason.as_deref() == Some("ANCHOR_NOT_SAVED") {
                result.status = "deleted".into();
                result.reason = Some("FILE_MISSING".into());
            }
            return Ok(result);
        };
        if content == anchor.content {
            result.status = "exact".into();
            result.reason = None;
            result.current = Some(document(
                &current_path,
                "worktree",
                content,
                Some((finding.line, end)),
            ));
            return Ok(result);
        }
        let current_lines: Vec<_> = content.lines().collect();
        let selected = &original_lines[finding.line as usize - 1..end as usize];
        let matches = matching_lines(&current_lines, selected);
        // Repeated anchors need a unique surrounding context, never Myers' first tie.
        let repeated_original = matching_lines(&original_lines, selected).len() > 1;
        let mut unproven_repeat = false;
        let candidates: Vec<_> = if matches.len() > 1 || (repeated_original && !matches.is_empty())
        {
            let before = (finding.line as usize - 1).saturating_sub(3);
            let after = (end as usize + 3).min(original_lines.len());
            let context = &original_lines[before..after];
            let offset = finding.line as usize - 1 - before;
            let unique: Vec<_> = matching_lines(&current_lines, context)
                .into_iter()
                .map(|line| line + offset)
                .collect();
            if unique.len() == 1 {
                unique
            } else {
                unproven_repeat = true;
                matches
            }
        } else {
            matches
        };
        if candidates.len() > 1 || unproven_repeat || (repeated_original && candidates.is_empty()) {
            result.status = "ambiguous".into();
            result.reason = Some("MULTIPLE_MATCHES".into());
            result.candidates = candidates
                .into_iter()
                .take(100)
                .map(|line| FindingLocationCandidate {
                    line: line as u32,
                    end_line: line as u32 + end - finding.line,
                })
                .collect();
            return Ok(result);
        }
        let (status, range) =
            self.map_changed_finding(&anchor.content, &content, finding.line, end)?;
        result.status = status.into();
        result.reason = match status {
            "exact" | "shifted" => None,
            _ => Some(
                if status == "deleted" {
                    "CODE_DELETED"
                } else {
                    "CODE_MODIFIED"
                }
                .into(),
            ),
        };
        result.candidates = candidates
            .into_iter()
            .take(100)
            .map(|line| FindingLocationCandidate {
                line: line as u32,
                end_line: line as u32 + end - finding.line,
            })
            .collect();
        result.current = Some(document(&current_path, "worktree", content, range));
        Ok(result)
    }

    fn map_changed_finding(
        &self,
        original: &str,
        current: &str,
        line: u32,
        end: u32,
    ) -> Result<(&'static str, Option<(u32, u32)>)> {
        let directory = tempfile::Builder::new()
            .prefix("proof-finding-map-")
            .tempdir()?;
        let before = directory.path().join("before");
        let after = directory.path().join("after");
        fs::write(&before, original)?;
        fs::write(&after, current)?;
        let mut command =
            process::git_command(&self.store.preferences()?.git_path, directory.path());
        command.args([
            "-c",
            "core.hooksPath=/dev/null",
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=0",
            "--",
        ]);
        command.arg(&before).arg(&after);
        let output = process::run_diff(command, None, Duration::from_secs(20), 4 * FILE_LIMIT)?;
        if ![0, 1].contains(&output.code) {
            process::checked(output)?;
            return Err(Error::stale());
        }
        let patch = String::from_utf8_lossy(&output.stdout);
        let header = regex::Regex::new(r"(?m)^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").unwrap();
        let count = current.lines().count() as u32;
        let mut shift: i64 = 0;
        for captures in header.captures_iter(&patch) {
            let old: u32 = captures[1].parse().map_err(|_| Error::stale())?;
            let old_count: u32 = captures
                .get(2)
                .map_or("1", |part| part.as_str())
                .parse()
                .map_err(|_| Error::stale())?;
            let new: u32 = captures[3].parse().map_err(|_| Error::stale())?;
            let new_count: u32 = captures
                .get(4)
                .map_or("1", |part| part.as_str())
                .parse()
                .map_err(|_| Error::stale())?;
            if old_count > 0 && old <= end && old.saturating_add(old_count) > line {
                let range = (count > 0).then(|| {
                    let start = new.max(1).min(count);
                    (
                        start,
                        if new_count == 0 {
                            start
                        } else {
                            new.saturating_add(new_count - 1).max(start).min(count)
                        },
                    )
                });
                return Ok((
                    if new_count == 0 {
                        "deleted"
                    } else {
                        "modified"
                    },
                    range,
                ));
            }
            if old.saturating_add(old_count) <= line {
                shift += i64::from(new_count) - i64::from(old_count);
            }
        }
        // Text changed but Git did not provide a corresponding edit (e.g. EOL).
        let range = (count > 0).then(|| {
            let start = (i64::from(line) + shift).max(1).min(i64::from(count)) as u32;
            (start, start.saturating_add(end - line).min(count))
        });
        let unchanged = range.is_some_and(|(start, finish)| {
            let original_lines: Vec<_> = original.lines().collect();
            let current_lines: Vec<_> = current.lines().collect();
            original_lines.get(line as usize - 1..end as usize)
                == current_lines.get(start as usize - 1..finish as usize)
        });
        Ok((
            if unchanged {
                if range.unwrap().0 == line {
                    "exact"
                } else {
                    "shifted"
                }
            } else {
                "modified"
            },
            range,
        ))
    }

    pub(crate) fn save_finding_anchors(
        &self,
        report_id: &str,
        anchors: &FindingAnchors,
    ) -> Result<()> {
        self.store.connection.execute(
            "INSERT INTO ai_finding_anchors(report_id,value) VALUES(?,?)",
            params![report_id, serde_json::to_string(anchors)?],
        )?;
        Ok(())
    }
    fn finding_current_content(&self, workspace_id: &str, path: &str) -> Result<String> {
        let workspace = self.store.workspace(workspace_id)?;
        let full = git::checked_path(&workspace, path)?;
        match fs::symlink_metadata(full) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(Error::new(
                    "FILE_MISSING",
                    "文件不存在或已被移出工作区。",
                    path,
                ))
            }
            Ok(metadata) if metadata.len() as usize > FILE_LIMIT => {
                return Err(Error::new(
                    "FILE_TOO_LARGE",
                    "定位仅支持 1 MiB 以内的文本文件。",
                    path,
                ))
            }
            Err(error) => return Err(error.into()),
            _ => {}
        }
        bounded(self.read_text_file(workspace_id, path, None)?.content, path)
    }
    fn finding_renamed_paths(
        &self,
        workspace_id: &str,
        oid: &str,
        path: &str,
    ) -> Result<std::collections::BTreeSet<String>> {
        let workspace = self.store.workspace(workspace_id)?;
        let oid = crate::text_files::verified_commit(&self.git()?, &workspace, oid)?;
        let Some(head) = self.git()?.head(&workspace)? else {
            return Ok(Default::default());
        };
        let mut command = self.workspace_watch_spec(workspace_id)?.command();
        command
            .args([
                "--no-replace-objects",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--find-renames",
                "--name-status",
                "-z",
                &oid,
                &head,
                "--",
            ])
            .env("GIT_NO_LAZY_FETCH", "1");
        let bytes = process::checked(process::run_diff(
            command,
            None,
            Duration::from_secs(20),
            FILE_LIMIT,
        )?)?;
        let mut parts = bytes
            .split(|byte| *byte == 0)
            .filter(|part| !part.is_empty());
        let mut renamed = std::collections::BTreeSet::new();
        while let Some(status) = parts.next() {
            let Some(first) = parts.next() else {
                return Err(Error::stale());
            };
            if status.starts_with(b"R") || status.starts_with(b"C") {
                let Some(second) = parts.next() else {
                    return Err(Error::stale());
                };
                if status.starts_with(b"R") && first == path.as_bytes() {
                    let target = String::from_utf8(second.to_vec()).map_err(|_| {
                        Error::new("PATH_ENCODING", "重命名路径不是有效 UTF-8。", path)
                    })?;
                    git::checked_path(&workspace, &target)?;
                    renamed.insert(target);
                }
            }
        }
        Ok(renamed)
    }
}

#[cfg(test)]
#[path = "finding_location_tests.rs"]
mod tests;
