use proof_core::{DataScope, Error, Proof, Result};
use proof_observer::manager::{AgentConfigPaths, CaptureFields, ObserverManager};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
struct Deletion {
    epoch: u64,
    policy: u64,
    hooks: Vec<String>,
}
pub struct NativeObserver {
    manager: ObserverManager,
    deletions: HashMap<String, Deletion>,
    last_error: Option<Error>,
}
pub struct ObserverState {
    pub inner: Arc<Mutex<NativeObserver>>,
    pub running: Arc<AtomicBool>,
}
fn missing() -> Error {
    Error::new("OBSERVER_REQUEST", "观察设置请求无效。", "Missing field")
}
fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key].as_str().ok_or_else(missing)
}
impl ObserverState {
    pub fn new(data: PathBuf, home: PathBuf) -> Result<Self> {
        let exe = std::env::current_exe()?;
        let helper = exe.parent().ok_or_else(missing)?.join("proof-observer");
        // Explicit fixture overrides are native environment values, never renderer paths.
        let codex = std::env::var_os("PROOF_CODEX_CONFIG_DIR")
            .or_else(|| std::env::var_os("CODEX_HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        let claude = std::env::var_os("PROOF_CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"));
        let codewiz = std::env::var_os("PROOF_CODEWIZ_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .filter(|p| p.is_absolute())
                    .unwrap_or_else(|| home.join(".config"))
                    .join("codewiz")
            });
        Ok(Self {
            inner: Arc::new(Mutex::new(NativeObserver {
                manager: ObserverManager::new(
                    data,
                    helper,
                    AgentConfigPaths {
                        codex,
                        claude,
                        codewiz,
                    },
                ),
                deletions: HashMap::new(),
                last_error: None,
            })),
            running: Arc::new(AtomicBool::new(true)),
        })
    }
    pub fn start(&self, core: Arc<Mutex<Proof>>) {
        let observer = self.inner.clone();
        let running = self.running.clone();
        std::thread::spawn(move || {
            while running.load(Ordering::Acquire) {
                if let (Ok(proof), Ok(mut native)) = (core.lock(), observer.lock()) {
                    native.last_error = native.manager.tick(&proof).err();
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            if let (Ok(proof), Ok(mut native)) = (core.lock(), observer.lock()) {
                let _ = native.manager.release_foreground(&proof);
            }
        });
    }
}
pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "observer_status"
            | "preview_observer_install"
            | "preview_observer_uninstall"
            | "apply_observer_config"
            | "cancel_observer_config"
            | "configure_observer_workspace"
            | "prepare_data_deletion"
            | "cancel_data_deletion"
            | "delete_local_data"
    )
}
pub fn dispatch(
    core: &Mutex<Proof>,
    native: &Mutex<NativeObserver>,
    command: &str,
    args: Value,
) -> Result<Value> {
    let epoch = args["_dataEpoch"].as_u64().ok_or_else(missing)?;
    // Version execution runs outside the core and manager locks.
    let probe = if command == "preview_observer_install" {
        let job = {
            let proof = core.lock().map_err(|_| missing())?;
            proof.check_data_epoch(epoch)?;
            proof.prepare_observer_probe(
                serde_json::from_value(args["agent"].clone())?,
                string(&args, "executablePath")?,
            )?
        };
        Some(job.run()?)
    } else {
        None
    };
    let mut proof = core.lock().map_err(|_| missing())?;
    proof.synchronize_data_epoch()?;
    proof.check_data_epoch(epoch)?;
    let mut native = native.lock().map_err(|_| missing())?;
    native.manager.clear_stale_previews(epoch);
    match command {
        "observer_status" => {
            let mut value = serde_json::to_value(native.manager.status(&proof)?)?;
            value["serviceError"] = serde_json::to_value(&native.last_error)?;
            Ok(value)
        }
        "preview_observer_install" => serde_json::to_value(native.manager.preview_install(
            &proof,
            string(&args, "workspaceId")?,
            string(&args, "executablePath")?,
            probe.unwrap(),
            serde_json::from_value(args["fields"].clone())?,
        )?)
        .map_err(Error::from),
        "preview_observer_uninstall" => serde_json::to_value(
            native
                .manager
                .preview_uninstall(&proof, string(&args, "installationId")?)?,
        )
        .map_err(Error::from),
        "apply_observer_config" => {
            serde_json::to_value(native.manager.apply(&proof, string(&args, "previewId")?)?)
                .map_err(Error::from)
        }
        "cancel_observer_config" => {
            native.manager.cancel(string(&args, "previewId")?);
            Ok(Value::Null)
        }
        "configure_observer_workspace" => {
            native.manager.configure_workspace(
                &proof,
                string(&args, "installationId")?,
                string(&args, "workspaceId")?,
                serde_json::from_value::<CaptureFields>(args["fields"].clone())?,
                args["enabled"].as_bool().ok_or_else(missing)?,
                epoch,
                args["policyRevision"].as_u64().ok_or_else(missing)?,
            )?;
            Ok(Value::Null)
        }
        "prepare_data_deletion" => {
            let scope: DataScope = serde_json::from_value(args["scope"].clone())?;
            let preview = proof.prepare_data_deletion(scope.clone())?;
            let records = proof.observer_hook_records()?;
            let permissions = proof.observer_consents()?;
            let workspaces = proof.data_workspaces()?;
            let mut removals = Vec::new();
            for record in records.iter().filter(|r| r.state != "uninstalled") {
                let applicable = match &scope {
                    DataScope::All => true,
                    DataScope::Repository { repository_id } => {
                        let scopes: Vec<_> = permissions
                            .iter()
                            .filter(|p| p.installation_id == record.installation_id)
                            .collect();
                        !scopes.is_empty()
                            && scopes.iter().all(|p| {
                                workspaces.iter().any(|w| {
                                    w.workspace.id == p.workspace_id
                                        && w.workspace.repository_id == *repository_id
                                })
                            })
                    }
                };
                if applicable {
                    removals.push(
                        native
                            .manager
                            .preview_uninstall(&proof, &record.installation_id)?,
                    );
                }
            }
            let policy = proof.observer_policy_revision()?;
            native.deletions.retain(|_, d| d.epoch == epoch);
            if native.deletions.len() >= 8 {
                native.deletions.clear();
            }
            native.deletions.insert(
                preview.id.clone(),
                Deletion {
                    epoch,
                    policy,
                    hooks: removals.iter().map(|p| p.id.clone()).collect(),
                },
            );
            let mut value = serde_json::to_value(preview)?;
            value["hookRemovals"] = serde_json::to_value(removals)?;
            Ok(value)
        }
        "cancel_data_deletion" => {
            let id = string(&args, "previewId")?;
            proof.cancel_data_deletion(id);
            if let Some(plan) = native.deletions.remove(id) {
                for hook in plan.hooks {
                    native.manager.cancel(&hook)
                }
            }
            Ok(Value::Null)
        }
        "delete_local_data" => {
            let id = string(&args, "previewId")?;
            proof.validate_data_deletion_preview(id)?;
            let mut removed = 0;
            if let Some(plan) = native.deletions.remove(id) {
                if plan.epoch != epoch || proof.observer_policy_revision()? != plan.policy {
                    return Err(Error::new(
                        "OBSERVER_POLICY_CHANGED",
                        "观察范围已变化，请重新查看删除预览。",
                        "Deletion consent changed",
                    ));
                }
                for hook in plan.hooks {
                    if let Err(error) = native.manager.apply_for_deletion(&proof, &hook, Some(id)) {
                        return Err(if removed > 0 {
                            Error::new(
                                "DATA_DELETE_PARTIAL",
                                &format!(
                                    "已移除 {removed} 个 Proof Hook；记录尚未删除。{}",
                                    error.message
                                ),
                                error.code,
                            )
                        } else {
                            error
                        });
                    }
                    removed += 1;
                }
            }
            let result = proof.delete_local_data(id).map_err(|error| {
                if removed > 0 {
                    Error::new(
                        "DATA_DELETE_PARTIAL",
                        &format!(
                            "已移除 {removed} 个 Proof Hook；记录尚未删除。{}",
                            error.message
                        ),
                        error.code,
                    )
                } else {
                    error
                }
            })?;
            native.manager.clear_stale_previews(result.session.epoch);
            Ok(serde_json::to_value(result)?)
        }
        _ => Ok(json!(null)),
    }
}
