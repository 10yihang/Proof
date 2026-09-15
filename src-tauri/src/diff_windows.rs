//! Owned Diff windows. URLs carry no repository paths, refs or authority.
use proof_core::{Changes, Error, Proof, Side};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::Manager;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Selection {
    Comparison {
        workspace_id: String,
        base: String,
        target: String,
        path: Option<String>,
    },
    Local {
        workspace_id: String,
        path: String,
        side: Side,
    },
}
impl Selection {
    fn workspace(&self) -> &str {
        match self {
            Self::Comparison { workspace_id, .. } | Self::Local { workspace_id, .. } => {
                workspace_id
            }
        }
    }
    fn validate(&self, proof: &Proof) -> Result<Changes, Error> {
        let changes = proof.changes(self.workspace())?;
        let valid = match self {
            Self::Comparison {
                base, target, path, ..
            } => {
                let pair = proof.frozen_comparison(self.workspace(), base, target)?;
                path.as_ref()
                    .is_none_or(|path| pair.files.iter().any(|file| &file.path == path))
            }
            Self::Local { path, side, .. } => changes
                .files
                .iter()
                .any(|file| &file.path == path && file.side == *side),
        };
        if !valid {
            return Err(Error::new(
                "DIFF_WINDOW_SELECTION",
                "此文件已不在当前 Diff 中，请重新选择。",
                "Unknown Diff file",
            ));
        }
        Ok(changes)
    }
}
#[derive(Default)]
pub struct DiffWindows(pub Mutex<HashMap<String, Selection>>);
impl DiffWindows {
    pub fn remove(&self, label: &str) {
        if let Ok(mut windows) = self.0.lock() {
            windows.remove(label);
        }
    }
}
pub fn handles(command: &str) -> bool {
    matches!(command, "open_diff_window" | "diff_window_context")
}
pub fn dispatch(
    app: &tauri::AppHandle,
    core: &Arc<Mutex<Proof>>,
    owner: &str,
    command: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, Error> {
    let registry = app.state::<DiffWindows>();
    let unavailable = || {
        Error::new(
            "DIFF_WINDOW_UNAVAILABLE",
            "无法打开 Diff 窗口。",
            "Window registry unavailable",
        )
    };
    if command == "diff_window_context" {
        let selection = registry
            .0
            .lock()
            .map_err(|_| unavailable())?
            .get(owner)
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    "DIFF_WINDOW_EXPIRED",
                    "此 Diff 窗口已失效，请从仓库重新打开。",
                    "No window-owned selection",
                )
            })?;
        let proof = super::session(
            core,
            args["_dataEpoch"].as_u64().ok_or_else(|| {
                Error::new(
                    "DATA_EPOCH_CHANGED",
                    "读取已失效，请重新打开 Diff。",
                    "Missing data epoch",
                )
            })?,
        )?;
        let changes = selection.validate(&proof)?;
        return Ok(serde_json::json!({"selection":selection,"changes":changes}));
    }
    let selection: Selection = serde_json::from_value(args["selection"].clone())?;
    let changes = {
        let proof = super::session(
            core,
            args["_dataEpoch"].as_u64().ok_or_else(|| {
                Error::new(
                    "DATA_EPOCH_CHANGED",
                    "读取已失效，请重新打开 Diff。",
                    "Missing data epoch",
                )
            })?,
        )?;
        selection.validate(&proof)?
    };
    let label = format!("diff-{}", uuid::Uuid::new_v4());
    {
        let mut windows = registry.0.lock().map_err(|_| unavailable())?;
        if windows.len() >= 8 {
            return Err(Error::new(
                "DIFF_WINDOW_LIMIT",
                "最多打开 8 个 Diff 窗口，请先关闭不需要的窗口。",
                "Owned window limit",
            ));
        }
        windows.insert(label.clone(), selection);
    }
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App("index.html?diffWindow=1".into()),
    )
    .title(format!("{} · Diff — Proof", changes.workspace.name))
    .inner_size(1360.0, 860.0)
    .min_inner_size(1024.0, 620.0);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0));
    if let Err(error) = builder.build() {
        registry.remove(&label);
        return Err(Error::new(
            "DIFF_WINDOW_UNAVAILABLE",
            "无法打开 Diff 窗口，请重试。",
            error,
        ));
    }
    Ok(serde_json::json!({"label":label}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_selection_cannot_supply_a_url_or_cross_window_identity() {
        assert!(serde_json::from_value::<Selection>(serde_json::json!({"kind":"comparison","workspaceId":"fixture","base":"a","target":"b","url":"https://example.com"})).is_err());
        let windows = DiffWindows::default();
        windows.0.lock().unwrap().insert(
            "diff-one".into(),
            Selection::Local {
                workspace_id: "workspace".into(),
                path: "example.rs".into(),
                side: Side::Unstaged,
            },
        );
        windows.remove("main");
        assert!(windows.0.lock().unwrap().contains_key("diff-one"));
        windows.remove("diff-one");
        assert!(windows.0.lock().unwrap().is_empty());
    }
}
