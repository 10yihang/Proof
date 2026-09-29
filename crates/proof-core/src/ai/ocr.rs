//! OpenCodeReview (`ocr`): a fixed-pipeline review CLI, not a general agent.
//! Proof runs `ocr review --format json` inside the read-only sandbox and maps
//! its findings onto the shared review schema. The CLI reads its own LLM
//! configuration from ~/.opencodereview; Proof never edits it.
use super::{invalid, provider::unsupported, Side};
use crate::Result;
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}};

/// npm ships a Node launcher (`bin/ocr.js`) that spawns a platform binary.
/// Resolve the native binary of that exact installation so the sandbox can
/// pin one self-contained executable instead of allowing Node.
pub(super) fn native_program(wrapper: &Path) -> Result<Option<PathBuf>> {
    // npm links `ocr` → `bin/ocr.js`; both names reach here after resolution.
    if !matches!(wrapper.file_name().and_then(|s| s.to_str()), Some("ocr") | Some("ocr.js")) {
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
    for comment in comments.iter().take(100) {
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
        let line = comment["start_line"].as_u64().unwrap_or(0).max(1);
        let end = comment["end_line"].as_u64().unwrap_or(0).max(line);
        let category = comment["category"].as_str().unwrap_or("other");
        // Title budget: 200 bytes total, minus the "[category] " prefix.
        let title = clipped(content.lines().next().unwrap_or(content), 160);
        let suggestion = ["suggestion_code", "existing_code"]
            .iter()
            .filter_map(|key| comment[key].as_str())
            .map(str::trim)
            .find(|text| !text.is_empty())
            .unwrap_or("No code suggestion.");
        findings.push(json!({
            "severity": severity,
            "title": format!("[{category}] {title}"),
            "description": clipped(content, 5900),
            "file": path,
            "side": side,
            "line": line,
            "endLine": end,
            "lineSide": "new",
            "suggestion": clipped(suggestion, 3900),
        }));
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
            format!("OCR 审查完成：{reviewed} 个文件，{} 条发现。", findings.len())
        } else {
            format!("OCR review complete: {reviewed} files, {} finding(s).", findings.len())
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
        "reviewPriority": selected.iter().map(|(p, _)| p).collect::<Vec<_>>(),
    }))
}
