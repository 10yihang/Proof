use proof_core::{Error, Proof};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{io::Write, path::Path, sync::Mutex};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveInstructions {
    workspace_id: String,
    report_id: String,
    expected_revision: u64,
    markdown: String,
    language: String,
    #[serde(rename = "_dataEpoch")]
    data_epoch: u64,
}

fn check_report(proof: &Proof, input: &SaveInstructions) -> Result<(), Error> {
    let report = proof.ai_review_report(&input.workspace_id, &input.report_id)?;
    if report.revision != input.expected_revision {
        return Err(Error::new(
            "AI_REVIEW_CHANGED",
            "此 Review 已在其他窗口更新，请重新操作。",
            "Review export revision mismatch",
        ));
    }
    Ok(())
}

pub fn dispatch(app: &tauri::AppHandle, core: &Mutex<Proof>, args: &Value) -> Result<Value, Error> {
    let input: SaveInstructions = serde_json::from_value(args.clone())?;
    if input.markdown.trim().is_empty() || input.markdown.len() > 16 * 1024 * 1024 {
        return Err(Error::new(
            "REVIEW_EXPORT_INVALID",
            "请选择要导出的意见，并减少过大的导出内容。",
            "Empty export or more than 16 MiB of Markdown",
        ));
    }
    {
        let proof = super::session(core, input.data_epoch)?;
        check_report(&proof, &input)?;
    }
    // A native Save dialog is the only source of the output path. IPC cannot
    // write to a caller-supplied location. This runs on proof_command's worker.
    let destination = app
        .dialog()
        .file()
        .set_title(if input.language == "en" {
            "Save review instructions"
        } else {
            "保存修改说明"
        })
        .set_file_name("proof-review.md")
        .add_filter("Markdown", &["md"])
        .blocking_save_file();
    let Some(destination) = destination else {
        return Ok(Value::Null);
    };
    let destination = destination
        .into_path()
        .map_err(|error| write_error(&error))?;
    // A report may have changed or been deleted while the dialog was open.
    let proof = super::session(core, input.data_epoch)?;
    check_report(&proof, &input)?;
    save_markdown(&destination, &input.markdown)?;
    Ok(json!({ "path": destination.to_string_lossy() }))
}

fn write_error(error: &dyn std::fmt::Display) -> Error {
    Error::new(
        "REVIEW_EXPORT_FAILED",
        "修改说明未能保存，请检查目标位置和权限。",
        error,
    )
}

fn save_markdown(destination: &Path, content: &str) -> Result<(), Error> {
    let parent = destination
        .parent()
        .ok_or_else(|| write_error(&"Missing destination directory"))?;
    // Write completely before replacing the file confirmed by the Save dialog.
    // A failed write must not truncate an existing export.
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| write_error(&error))?;
    file.write_all(content.as_bytes())
        .map_err(|error| write_error(&error))?;
    file.as_file()
        .sync_all()
        .map_err(|error| write_error(&error))?;
    file.persist(destination)
        .map_err(|error| write_error(&error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_exact_preview_and_atomically_replaces_an_existing_export() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("proof-review.md");
        std::fs::write(&path, "previous export").unwrap();
        let content = "# Review 修改任务\n\n`src/auth.ts` · 修改前 · L3–L8\n";
        save_markdown(&path, content).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn failed_save_preserves_destination_and_removes_temporary_files() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("existing-directory");
        std::fs::create_dir(&destination).unwrap();
        let existing = destination.join("source.ts");
        std::fs::write(&existing, "unchanged").unwrap();
        assert_eq!(
            save_markdown(&destination, "instructions")
                .unwrap_err()
                .code,
            "REVIEW_EXPORT_FAILED"
        );
        assert_eq!(std::fs::read_to_string(existing).unwrap(), "unchanged");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn ipc_does_not_accept_an_output_path() {
        let input = json!({
            "workspaceId": "workspace", "reportId": "review", "expectedRevision": 0,
            "markdown": "instructions", "language": "en", "_dataEpoch": 0,
            "path": "/unexpected/output.md"
        });
        assert!(serde_json::from_value::<SaveInstructions>(input).is_err());
    }
}
