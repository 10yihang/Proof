//! OpenCodeReview (`ocr`): a fixed-pipeline review CLI, not a general agent.
//! Proof runs `ocr review --format json` inside the read-only sandbox and maps
//! its findings onto the shared review schema. The CLI reads its own LLM
//! configuration from ~/.opencodereview.
use super::{invalid, provider::unsupported, AgentAnalysis, AiProgress, AiScope, Side};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Deserialize, Serialize)]
pub struct OcrPreview {
    pub files: Vec<OcrPreviewFile>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPreviewFile {
    pub path: String,
    #[serde(alias = "will_review")]
    pub will_review: bool,
    #[serde(default, alias = "exclude_reason")]
    pub exclude_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrReviewDetails {
    pub status: String,
    #[serde(default)]
    pub pinned_diff: bool,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub eligible: Option<usize>,
    pub reviewed: usize,
    pub excluded: Vec<OcrFileOutcome>,
    pub incomplete: Vec<OcrFileOutcome>,
    pub omitted_findings: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OcrFileOutcome {
    pub path: String,
    pub reason: String,
}

pub(super) fn combine(
    parts: Vec<AgentAnalysis>,
    language: crate::UiLanguage,
) -> Result<AgentAnalysis> {
    let mut parts = parts.into_iter();
    let mut result = parts
        .next()
        .ok_or_else(|| invalid("No pinned OCR review range"))?;
    let Some(next) = parts.next() else {
        return Ok(result);
    };
    let details = result
        .ocr
        .as_mut()
        .ok_or_else(|| invalid("Missing OCR coverage"))?;
    let next_details = next.ocr.ok_or_else(|| invalid("Missing OCR coverage"))?;
    details.status = match (details.status.as_str(), next_details.status.as_str()) {
        ("partial", _) | (_, "partial") => "partial",
        ("skipped", "skipped") => "skipped",
        _ => "complete",
    }
    .into();
    details.session_id = None;
    details.eligible = details
        .eligible
        .zip(next_details.eligible)
        .map(|(left, right)| left + right);
    details.reviewed += next_details.reviewed;
    details.excluded.extend(next_details.excluded);
    details.incomplete.extend(next_details.incomplete);
    details.omitted_findings += next_details.omitted_findings;
    let rank = |risk: &Value| match risk.as_str() {
        Some("critical") => 4,
        Some("high") => 3,
        Some("medium") => 2,
        Some("low") => 1,
        _ => 0,
    };
    if rank(&next.value["overallRisk"]) > rank(&result.value["overallRisk"]) {
        result.value["overallRisk"] = next.value["overallRisk"].clone();
    }
    let findings = result.value["findings"]
        .as_array_mut()
        .ok_or_else(|| invalid("Missing OCR findings"))?;
    findings.extend(
        next.value["findings"]
            .as_array()
            .ok_or_else(|| invalid("Missing OCR findings"))?
            .iter()
            .cloned(),
    );
    findings.sort_by_key(|finding| std::cmp::Reverse(rank(&finding["severity"])));
    details.omitted_findings += findings.len().saturating_sub(100);
    findings.truncate(100);
    let count = findings.len();
    let mut paths = result.value["reviewPriority"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(
            next.value["reviewPriority"]
                .as_array()
                .into_iter()
                .flatten(),
        )
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    paths.sort_unstable();
    paths.dedup();
    let paths = json!(paths);
    result.value["reviewPriority"] = paths;
    result.value["summary"] = match language {
        crate::UiLanguage::Chinese => {
            format!("OCR 分别审查了暂存与未暂存的变更，得到 {count} 条发现。")
        }
        crate::UiLanguage::English => format!(
            "OCR reviewed staged and unstaged changes separately and returned {count} finding(s)."
        ),
    }
    .into();
    Ok(result)
}

pub(super) fn scope_flags(scope: &AiScope) -> Vec<&str> {
    match scope {
        AiScope::Local { .. } => Vec::new(),
        AiScope::Comparison { base, target, .. } if base == "empty" => vec!["--commit", target],
        AiScope::Comparison { base, target, .. } => vec!["--from", base, "--to", target],
    }
}

pub(super) fn is_scoped(scope: &AiScope) -> bool {
    match scope {
        AiScope::Local { files, .. } => files.is_some(),
        AiScope::Comparison { path, paths, .. } => path.is_some() || paths.is_some(),
    }
}

pub(super) fn selection_rule(preview: &OcrPreview, paths: &[String]) -> Result<Value> {
    let mut include = Vec::new();
    let mut exclude = Vec::new();
    for file in &preview.files {
        let path = &file.path;
        let pattern = path
            .chars()
            .flat_map(|character| {
                matches!(character, '*' | '?' | '[' | ']' | '{' | '}' | '\\')
                    .then_some('\\')
                    .into_iter()
                    .chain(std::iter::once(character))
            })
            .collect::<String>();
        if file.will_review && paths.contains(path) {
            include.push(pattern);
        } else {
            exclude.push(pattern);
        }
    }
    // OCR's file filter is case insensitive, even on case-sensitive volumes.
    if include.iter().any(|path| {
        let folded = path.to_lowercase();
        exclude.iter().any(|other| other.to_lowercase() == folded)
    }) {
        return Err(Error::new(
            "OCR_SCOPE_PATH",
            "OCR 无法区分仅大小写不同的文件，请审查整个 Diff。",
            "Case-insensitive OCR scope would also exclude a selected file",
        ));
    }
    Ok(json!({ "include": include, "exclude": exclude }))
}

pub(super) struct Activity<'a> {
    pub paths: &'a [String],
    pub emit: &'a dyn Fn(AiProgress),
    pub scoped: bool,
    pub pending: Vec<u8>,
    pub last: Option<(String, Option<String>)>,
}

impl Activity<'_> {
    pub fn feed(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() > 2 * 1024 * 1024 {
            self.pending.clear();
            return;
        }
        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line);
            let Some(text) = text.trim().strip_prefix("[ocr]").map(str::trim) else {
                continue;
            };
            if let Some((changed, reviewing)) = selection_counts(text) {
                if !self.scoped {
                    (self.emit)(AiProgress {
                        total: Some(reviewing),
                        excluded: Some(changed.saturating_sub(reviewing)),
                        ..AiProgress::phase("ocr_scope")
                    });
                }
                continue;
            }
            let phase = if text.starts_with("Plan completed") {
                "ocr_plan_done"
            } else if text.starts_with("Subtask error") || text.starts_with("Subtask panic") {
                "ocr_subtask_failed"
            } else if text.starts_with("Review filter") {
                "ocr_filtering"
            } else if text.starts_with("Round ") || text.contains("main_task") {
                "ocr_reviewing"
            } else if text.starts_with('▶') && text.contains("file_read") {
                "ocr_reading"
            } else if text.starts_with('▶')
                && (text.contains("code_search") || text.contains("file_find"))
            {
                "ocr_searching"
            } else {
                "ocr_reviewing"
            };
            let path = self
                .paths
                .iter()
                .filter(|path| text.contains(path.as_str()))
                .max_by_key(|path| path.len())
                .cloned();
            let key = (text.to_owned(), path.clone());
            if self.last.as_ref() == Some(&key) {
                continue;
            }
            self.last = Some(key);
            (self.emit)(AiProgress {
                path,
                ..AiProgress::phase(phase)
            });
        }
    }
}

fn selection_counts(line: &str) -> Option<(usize, usize)> {
    let (changed, rest) = line.split_once(" file(s) changed, reviewing ")?;
    let (reviewing, _) = rest.split_once(" in ")?;
    let changed = changed.parse().ok()?;
    let reviewing = reviewing.parse().ok()?;
    (reviewing <= changed).then_some((changed, reviewing))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_preserves_real_selection_counts_and_typed_activity() {
        let events = std::cell::RefCell::new(Vec::new());
        let paths = vec!["src/cache.ts".into()];
        let mut activity = Activity {
            paths: &paths,
            emit: &|event| events.borrow_mut().push(event),
            scoped: false,
            pending: Vec::new(),
            last: None,
        };
        for chunk in "[ocr] 5 file(s) changed, reviewing 3 in /repo\n[ocr]   ▶ file_read \"src/cache.ts\"\n[ocr] Plan completed for group \"src/cache.ts\"\n[ocr] Subtask error for group \"src/cache.ts\": timeout\n".as_bytes().chunks(9) {
            activity.feed(chunk);
        }
        let events = events.into_inner();
        assert_eq!(events.len(), 4);
        assert_eq!((events[0].total, events[0].excluded), (Some(3), Some(2)));
        assert_eq!(events[1].phase, "ocr_reading");
        assert_eq!(events[1].path.as_deref(), Some("src/cache.ts"));
        assert_eq!(events[2].phase, "ocr_plan_done");
        assert_eq!(events[3].phase, "ocr_subtask_failed");
        assert!(events.iter().all(|event| event.completed.is_none()));
    }
}

/// npm ships a Node launcher (`bin/ocr.js`) that spawns a platform binary.
/// Resolve the native binary of that exact installation so the sandbox can
/// pin one self-contained executable instead of allowing Node.
pub(super) fn native_program(wrapper: &Path) -> Result<Option<PathBuf>> {
    // npm links `ocr` → `bin/ocr.js`; both names reach here after resolution.
    if !matches!(
        wrapper.file_name().and_then(|s| s.to_str()),
        Some("ocr") | Some("ocr.js")
    ) {
        return Ok(None);
    }
    let Some(package) = wrapper.parent().and_then(Path::parent) else {
        return Ok(None);
    };
    let manifest = package.join("package.json");
    if !manifest.is_file() {
        return Ok(None);
    }
    let value: Value = serde_json::from_slice(&fs::read(&manifest)?).unwrap_or(Value::Null);
    if value["name"] != "@alibaba-group/open-code-review" {
        return Ok(None);
    }
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    let name = format!("ocr-{platform}-{arch}");
    let binary = if cfg!(windows) {
        "bin/opencodereview.exe"
    } else {
        "bin/opencodereview"
    };
    for parent in package.ancestors() {
        let path = parent
            .join("node_modules/@alibaba-group")
            .join(&name)
            .join(binary);
        if path.is_file() {
            return Ok(Some(path));
        }
    }
    let legacy = package.join(binary);
    if legacy.is_file() {
        return Ok(Some(legacy));
    }
    Err(unsupported(
        "OpenCodeReview 安装不完整，请重新安装 CLI 或选择其原生可执行文件。",
    ))
}

/// `ocr` is npm-distributed; reuse the Node-manager discovery roots.
pub(super) fn installation_roots(home: &Path) -> Vec<PathBuf> {
    super::codewiz::installation_roots(home)
}

/// A configured provider with an API key counts as authenticated. The model
/// is never called for this check.
pub(super) fn authenticated() -> Option<bool> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let bytes = fs::read(home.join(".opencodereview/config.json")).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let provider = value["provider"].as_str().unwrap_or("");
    if provider.is_empty() {
        return Some(false);
    }
    for section in ["custom_providers", "providers"] {
        let key = value[section][provider]["api_key"].as_str().unwrap_or("");
        if !key.is_empty() {
            return Some(true);
        }
    }
    Some(false)
}

/// Proof validates text by BYTE length and rejects control characters.
/// Clip on char boundaries within the byte budget and strip unsafe controls.
fn clipped(text: &str, max_bytes: usize) -> String {
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t' | '\r'))
        .collect();
    if cleaned.len() <= max_bytes {
        return cleaned;
    }
    let mut end = max_bytes;
    while end > 0 && !cleaned.is_char_boundary(end) {
        end -= 1;
    }
    cleaned[..end].to_owned()
}

pub(super) fn details(
    value: &Value,
    selected: &[(String, Side)],
    scoped_preview: Option<&OcrPreview>,
    visible: usize,
) -> OcrReviewDetails {
    let known = |path: &str| selected.iter().any(|(file, _)| file == path);
    let coverage = &value["manifest"]["coverage"];
    let items = |key: &str| coverage[key].as_array().into_iter().flatten();
    let statuses = |key: &str, reason: &str| {
        items(key)
            .filter_map(|item| {
                let path = item["path"].as_str().filter(|path| known(path))?;
                let reason = item[reason].as_str().unwrap_or(key);
                Some(OcrFileOutcome {
                    path: path.into(),
                    reason: clipped(reason, 120),
                })
            })
            .collect::<Vec<_>>()
    };
    let string = |value: &Value| value.as_str().map(|text| clipped(text, 200));
    let count = |key: &str| {
        items(key)
            .filter(|item| item["path"].as_str().is_some_and(known))
            .count()
    };
    let eligible = coverage["selected"]
        .as_array()
        .map(|_| count("selected"))
        .or_else(|| {
            scoped_preview.map(|preview| {
                preview
                    .files
                    .iter()
                    .filter(|file| known(&file.path) && file.will_review)
                    .count()
            })
        });
    let mut excluded = statuses("excluded", "exclude_reason");
    if let Some(preview) = scoped_preview {
        for file in preview
            .files
            .iter()
            .filter(|file| known(&file.path) && !file.will_review)
        {
            // The temporary selection rule can give a file a generic user-rule
            // exclusion. Present the reason from the actual project rules.
            excluded.retain(|item| item.path != file.path);
            excluded.push(OcrFileOutcome {
                path: file.path.clone(),
                reason: file
                    .exclude_reason
                    .clone()
                    .unwrap_or_else(|| "excluded".into()),
            });
        }
        for (path, _) in selected {
            if !preview.files.iter().any(|file| &file.path == path)
                && !excluded.iter().any(|item| &item.path == path)
            {
                excluded.push(OcrFileOutcome {
                    path: path.clone(),
                    reason: "no_net_change".into(),
                });
            }
        }
    }
    let mut incomplete = statuses("failed", "failure_class");
    incomplete.extend(statuses("waived", "waive_reason"));
    OcrReviewDetails {
        status: value["status"].as_str().unwrap_or("failed").into(),
        pinned_diff: false,
        session_id: string(&value["session_id"]),
        model: string(&value["llm"]["model"]),
        provider: string(&value["llm"]["provider"]),
        eligible,
        reviewed: if coverage["completed"].is_array() {
            count("completed") + count("reused")
        } else {
            value["summary"]["files_reviewed"].as_u64().unwrap_or(0) as usize
        },
        excluded,
        incomplete,
        omitted_findings: value["comments"]
            .as_array()
            .map_or(0, |comments| comments.len().saturating_sub(visible)),
    }
}

/// Map `ocr review --format json` output onto the shared review schema.
/// Findings outside the selected paths are dropped; the remaining ones anchor
/// on the new side of the live diff, which is the only side OCR reports.
pub(super) fn map_review(
    bytes: &[u8],
    selected: &[(String, Side)],
    language: crate::UiLanguage,
) -> Result<Value> {
    let value: Value = serde_json::from_slice(bytes).map_err(invalid)?;
    // `complete` = reviewed; `skipped` = nothing to review; `partial` = some
    // items failed (LLM timeouts, rate limits) but real findings exist.
    // Anything else (failed) keeps the CLI's own message as detail.
    let status = value["status"].as_str().unwrap_or("");
    if !matches!(status, "complete" | "skipped" | "partial") {
        let message = value["message"].as_str().unwrap_or("");
        return Err(invalid(format!(
            "OCR review ended with status {status:?}: {message}"
        )));
    }
    let Some(comments) = value["comments"].as_array() else {
        return Err(invalid("OCR result has no comments"));
    };
    let rank = |severity: &str| match severity {
        "critical" => 4,
        "high" => 3,
        "medium" => 2,
        "low" => 1,
        _ => 0,
    };
    let mut overall = 0;
    let mut findings = Vec::new();
    let mut comments: Vec<_> = comments.iter().collect();
    comments.sort_by_key(|comment| {
        std::cmp::Reverse(rank(comment["severity"].as_str().unwrap_or_default()))
    });
    for comment in comments {
        let Some(path) = comment["path"].as_str() else {
            continue;
        };
        let Some((_, side)) = selected
            .iter()
            .find(|(p, s)| p == path && *s == Side::Unstaged)
            .or_else(|| selected.iter().find(|(p, _)| p == path))
        else {
            continue;
        };
        let content = comment["content"].as_str().unwrap_or("").trim();
        if content.is_empty() {
            continue;
        }
        let severity = match comment["severity"].as_str().unwrap_or("") {
            known @ ("critical" | "high" | "medium" | "low") => known,
            _ => "unknown",
        };
        overall = overall.max(rank(severity));
        let line = comment["start_line"]
            .as_u64()
            .and_then(|line| u32::try_from(line).ok())
            .unwrap_or(0);
        let end = comment["end_line"]
            .as_u64()
            .and_then(|line| u32::try_from(line).ok())
            .filter(|end| *end > 0);
        let category = clipped(comment["category"].as_str().unwrap_or("other"), 24);
        // Title budget: 200 bytes total, minus the "[category] " prefix.
        let title = clipped(content.lines().next().unwrap_or(content), 160);
        let suggestion = comment["suggestion_code"]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .unwrap_or("No code suggestion.");
        findings.push(json!({
            "severity": severity,
            "title": format!("[{category}] {title}"),
            "description": clipped(content, 5900),
            "file": path,
            "side": side,
            "line": line,
            "endLine": if line == 0 { None } else { Some(end.unwrap_or(line)) },
            "lineSide": "new",
            "suggestion": clipped(suggestion, 3900),
        }));
        if findings.len() == 100 {
            break;
        }
    }
    let summary = {
        let message = value["message"].as_str().unwrap_or("").trim();
        let reviewed = value["summary"]["files_reviewed"].as_u64().unwrap_or(0);
        let chinese = language == crate::UiLanguage::Chinese;
        if matches!(status, "skipped" | "partial") && !message.is_empty() {
            // Skipped/partial messages carry the actionable information.
            if chinese {
                let message = if message == "Review skipped: no items were selected." {
                    "没有可审查的变更（改动可能全是测试文件、文档等默认排除的类型）。"
                } else {
                    message
                };
                format!("OCR：{message}")
            } else {
                format!("OCR: {message}")
            }
        } else if chinese {
            format!(
                "OCR 审查完成：{reviewed} 个文件，{} 条发现。",
                findings.len()
            )
        } else {
            format!(
                "OCR review complete: {reviewed} files, {} finding(s).",
                findings.len()
            )
        }
    };
    let overall_risk = ["unknown", "low", "medium", "high", "critical"][overall];
    Ok(json!({
        "analysisStatus": "completed",
        "blockers": [],
        "summary": clipped(&summary, 7900),
        "overallRisk": overall_risk,
        "findings": findings,
        "behaviorChanges": [],
        "missingTests": [],
        "reviewPriority": selected.iter().map(|(p, _)| p).collect::<std::collections::BTreeSet<_>>(),
    }))
}
