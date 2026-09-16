//! Native-only Hook installation. Previews never contain transport credentials.
use crate::{
    config::{self, ConfigOwnership, HookSpec},
    config_file::{self, ConfigSnapshot},
    protocol::{self, Registration},
};
use proof_core::{
    Error, ObserverAgent, ObserverConsent, ObserverHookRecord, ObserverProbe,
    ObserverRegistrationSecret, Proof, Result,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs::{self, File},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureFields {
    pub prompt: bool,
    pub command: bool,
    pub reply: bool,
    pub output: bool,
    pub background: bool,
}
impl CaptureFields {
    fn consent(&self, id: &str, workspace_id: &str) -> ObserverConsent {
        ObserverConsent {
            installation_id: id.into(),
            workspace_id: workspace_id.into(),
            enabled: true,
            prompt: self.prompt,
            command: self.command,
            reply: self.reply,
            output: self.output,
            background: self.background,
        }
    }
}
pub struct AgentConfigPaths {
    pub codex: PathBuf,
    pub claude: PathBuf,
    pub codewiz: PathBuf,
}
impl AgentConfigPaths {
    fn directory(&self, agent: ObserverAgent) -> &Path {
        match agent {
            ObserverAgent::Codex => &self.codex,
            ObserverAgent::Claude => &self.claude,
            ObserverAgent::Codewiz => &self.codewiz,
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookPreview {
    pub id: String,
    pub action: String,
    pub agent: ObserverAgent,
    pub agent_version: String,
    pub workspace_id: Option<String>,
    pub config_path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub fields: CaptureFields,
    pub requires_hook_trust: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookActionResult {
    pub installation_id: String,
    pub message: String,
    pub observing_enabled: bool,
    pub warning: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub installation_id: String,
    pub agent: ObserverAgent,
    pub agent_version: String,
    pub config_path: String,
    pub state: String,
    pub last_event_at: Option<u64>,
    pub consents: Vec<ObserverConsent>,
    pub issue: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatusReport {
    pub policy_revision: u64,
    pub service_available: bool,
    pub installations: Vec<HookStatus>,
}
struct Prepared {
    preview: HookPreview,
    epoch: u64,
    policy: u64,
    created: Instant,
    record: ObserverHookRecord,
    secret: Option<ObserverRegistrationSecret>,
    snapshot: ConfigSnapshot,
    helper_hash: String,
}
pub struct ObserverManager {
    data_dir: PathBuf,
    helper_source: PathBuf,
    paths: AgentConfigPaths,
    pending: VecDeque<Prepared>,
    owner: String,
    gui_lease: Option<File>,
    collector: Option<Child>,
    collector_generation: Option<u64>,
}

impl ObserverManager {
    pub fn status(&self, proof: &Proof) -> Result<HookStatusReport> {
        let registrations = proof.observer_installations()?;
        let consents = proof.observer_consents()?;
        let mut installations = Vec::new();
        for record in proof.observer_hook_records()? {
            if record.state == "uninstalled" {
                continue;
            }
            let Some(registration) = registrations
                .iter()
                .find(|i| i.id == record.installation_id)
            else {
                continue;
            };
            let issue = self.configuration_issue(&record);
            let state = if record.state == "installing" {
                "incomplete".into()
            } else if issue.is_some() {
                "config_changed".into()
            } else {
                registration.state.clone()
            };
            installations.push(HookStatus {
                installation_id: record.installation_id.clone(),
                agent: registration.agent,
                agent_version: registration.agent_version.clone(),
                config_path: record.config_path,
                state,
                last_event_at: registration.last_event_at,
                consents: consents
                    .iter()
                    .filter(|p| p.installation_id == record.installation_id)
                    .cloned()
                    .collect(),
                issue,
            });
        }
        Ok(HookStatusReport {
            policy_revision: proof.observer_policy_revision()?,
            service_available: self.health_is_fresh(proof.observer_storage_generation()?),
            installations,
        })
    }
    fn configuration_issue(&self, record: &ObserverHookRecord) -> Option<String> {
        let check = (|| -> Result<bool> {
            let ownership: ConfigOwnership =
                serde_json::from_value(record.ownership["config"].clone())?;
            let (root, folder, filename) = config_location(Path::new(&record.config_path))?;
            let current = config_file::capture(root, folder, filename)?;
            Ok(config::install_plan(
                current.text.as_deref().map(str::as_bytes),
                &ownership.spec,
                Some(&ownership),
            )?
            .changed)
        })();
        match check {
            Ok(false) => None,
            Ok(true) => Some("Proof Hook 配置已变化，需要重新检查。".into()),
            Err(error) => Some(format!("{} · {}", error.message, error.code)),
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub fn configure_workspace(
        &mut self,
        proof: &Proof,
        id: &str,
        workspace_id: &str,
        fields: CaptureFields,
        enabled: bool,
        epoch: u64,
        policy: u64,
    ) -> Result<()> {
        if !enabled {
            return proof.pause_installed_observer(id, workspace_id, epoch, policy);
        }
        let record = proof
            .observer_hook_records()?
            .into_iter()
            .find(|r| r.installation_id == id && r.state == "installed")
            .ok_or_else(|| {
                Error::new(
                    "OBSERVER_CONFIG_NOT_READY",
                    "Hook 尚未安装完成。",
                    "Missing installed receipt",
                )
            })?;
        if let Some(issue) = self.configuration_issue(&record) {
            return Err(Error::new(
                "OBSERVER_CONFIG_CHANGED",
                "Hook 配置已改变，请先检查接入。",
                issue,
            ));
        }
        let ownership: ConfigOwnership =
            serde_json::from_value(record.ownership["config"].clone())?;
        self.start_runtime(proof, Path::new(&ownership.spec.helper_path))?;
        self.check_connection(proof, id, Path::new(&ownership.spec.helper_path))?;
        proof.enable_installed_observer(&fields.consent(id, workspace_id), epoch, policy)
    }
    pub fn clear_stale_previews(&mut self, epoch: u64) {
        self.pending
            .retain(|p| p.epoch == epoch && p.created.elapsed() < Duration::from_secs(300));
    }
    pub fn new(data_dir: PathBuf, helper_source: PathBuf, paths: AgentConfigPaths) -> Self {
        Self {
            data_dir,
            helper_source,
            paths,
            pending: VecDeque::new(),
            owner: uuid::Uuid::new_v4().to_string(),
            gui_lease: None,
            collector: None,
            collector_generation: None,
        }
    }
    pub fn preview_install(
        &mut self,
        proof: &Proof,
        workspace_id: &str,
        program_path: &str,
        probe: ObserverProbe,
        fields: CaptureFields,
    ) -> Result<HookPreview> {
        // Keep the supported provider/platform boundary, not a CLI version pin.
        // Config parsing, preview, executable identity and bridge checks follow.
        if !probe.agent.adapter().hook_installation_available() {
            return Err(Error::new(
                "OBSERVER_COMBINATION_UNVERIFIED",
                "此 Agent 与平台组合尚未完成真实 Hook 验证。",
                "This adapter has not enabled Hook installation on the current platform",
            ));
        }
        let workspace = proof
            .data_workspaces()?
            .into_iter()
            .find(|w| w.workspace.id == workspace_id)
            .ok_or_else(|| {
                Error::new(
                    "WORKSPACE_MISSING",
                    "请先打开要观察的 Worktree。",
                    "Unknown workspace",
                )
            })?
            .workspace;
        proof.workspace_watch_paths(workspace_id)?;
        if !workspace.trusted {
            return Err(Error::new(
                "TRUST_REQUIRED",
                "请先信任此 Worktree，再授权观察。",
                "Untrusted workspace",
            ));
        }
        let (_, helper_hash) = read_helper(&self.helper_source)?;
        let secret = Proof::new_observer_registration(probe.agent, &probe.version)?;
        let id = &secret.installation.id;
        let spec = HookSpec {
            installation_id: id.clone(),
            agent: probe.agent,
            agent_version: probe.version.clone(),
            helper_path: self
                .helper_path(&helper_hash)
                .to_string_lossy()
                .into_owned(),
            registration_path: self
                .installation_dir(id)
                .join("registration.json")
                .to_string_lossy()
                .into_owned(),
        };
        let config_path = self.config_path(probe.agent);
        let (root, folder, filename) = config_location(&config_path)?;
        let snapshot = config_file::capture(root, folder, filename)?;
        let plan = config::install_plan(snapshot.text.as_deref().map(str::as_bytes), &spec, None)?;
        let preview = HookPreview {
            id: uuid::Uuid::new_v4().to_string(),
            action: "install".into(),
            agent: probe.agent,
            agent_version: probe.version,
            workspace_id: Some(workspace_id.into()),
            config_path: config_path.to_string_lossy().into_owned(),
            before: plan.before,
            after: plan.after,
            fields,
            requires_hook_trust: probe.agent == ObserverAgent::Codex,
        };
        let record = ObserverHookRecord {
            installation_id: id.clone(),
            config_path: preview.config_path.clone(),
            ownership: serde_json::json!({"config":plan.ownership,"program":{"path":program_path,"resolvedPath":probe.executable_path,"identity":probe.executable_identity},"helperHash":helper_hash}),
            state: "installing".into(),
        };
        self.remember(Prepared {
            preview: preview.clone(),
            epoch: proof.data_session()?.epoch,
            policy: proof.observer_policy_revision()?,
            created: Instant::now(),
            record,
            secret: Some(secret),
            snapshot,
            helper_hash,
        });
        Ok(preview)
    }
    pub fn preview_uninstall(&mut self, proof: &Proof, id: &str) -> Result<HookPreview> {
        let record = proof
            .observer_hook_records()?
            .into_iter()
            .find(|r| r.installation_id == id)
            .ok_or_else(|| {
                Error::new(
                    "OBSERVER_MISSING",
                    "此 Hook 安装记录不存在。",
                    "Unknown installation",
                )
            })?;
        let ownership: ConfigOwnership =
            serde_json::from_value(record.ownership["config"].clone())?;
        let path = Path::new(&record.config_path);
        let (root, folder, filename) = config_location(path)?;
        let snapshot = config_file::capture(root, folder, filename)?;
        let plan = config::uninstall_plan(snapshot.text.as_deref().map(str::as_bytes), &ownership)?;
        let preview = HookPreview {
            id: uuid::Uuid::new_v4().to_string(),
            action: "uninstall".into(),
            agent: ownership.spec.agent,
            agent_version: ownership.spec.agent_version,
            workspace_id: None,
            config_path: record.config_path.clone(),
            before: plan.before,
            after: plan.after,
            fields: CaptureFields::default(),
            requires_hook_trust: false,
        };
        self.remember(Prepared {
            preview: preview.clone(),
            epoch: proof.data_session()?.epoch,
            policy: proof.observer_policy_revision()?,
            created: Instant::now(),
            record,
            secret: None,
            snapshot,
            helper_hash: String::new(),
        });
        Ok(preview)
    }
    pub fn cancel(&mut self, id: &str) {
        self.pending.retain(|p| p.preview.id != id);
    }
    fn remember(&mut self, value: Prepared) {
        self.pending
            .retain(|p| p.created.elapsed() < Duration::from_secs(300));
        if self.pending.len() >= 8 {
            self.pending.pop_front();
        }
        self.pending.push_back(value);
    }
    pub fn apply(&mut self, proof: &Proof, id: &str) -> Result<HookActionResult> {
        self.apply_for_deletion(proof, id, None)
    }
    pub fn apply_for_deletion(
        &mut self,
        proof: &Proof,
        id: &str,
        deletion: Option<&str>,
    ) -> Result<HookActionResult> {
        let index = self
            .pending
            .iter()
            .position(|p| p.preview.id == id)
            .ok_or_else(|| {
                Error::new(
                    "OBSERVER_PREVIEW_EXPIRED",
                    "Hook 预览已失效，请重新查看配置变更。",
                    "Unknown preview",
                )
            })?;
        let prepared = self.pending.remove(index).unwrap();
        if prepared.created.elapsed() > Duration::from_secs(300) {
            return Err(Error::new(
                "OBSERVER_PREVIEW_EXPIRED",
                "Hook 预览已过期，请重新确认。",
                "Expired preview",
            ));
        }
        proof.check_data_epoch(prepared.epoch)?;
        let preview = &prepared.preview;
        let (root, folder, filename) = config_location(Path::new(&preview.config_path))?;
        let installation_id = prepared.record.installation_id.clone();
        if let Some(secret) = prepared.secret {
            if !proof.observer_hook_program_matches(&prepared.record)? {
                return Err(Error::new(
                    "OBSERVER_PROGRAM_CHANGED",
                    "Agent 程序或其来源已变化，请重新检测。",
                    "Executable changed since preview",
                ));
            }
            let (helper_bytes, hash) = read_helper(&self.helper_source)?;
            if hash != prepared.helper_hash {
                return Err(Error::new(
                    "OBSERVER_HELPER_CHANGED",
                    "观察程序已更新，请重新预览安装。",
                    "Helper changed since preview",
                ));
            }
            let workspace_id = preview.workspace_id.as_deref().unwrap();
            proof.begin_observer_hook_install(
                &prepared.record,
                &secret,
                workspace_id,
                prepared.epoch,
                prepared.policy,
            )?;
            let install_dir = self.installation_dir(&installation_id);
            let helper = self.helper_path(&hash);
            proof.change_observer_hook_with_policy(
                &installation_id,
                prepared.epoch,
                "installed",
                Some(prepared.policy),
                || {
                    private_directory(&self.data_dir.join("observer"))?;
                    private_directory(&self.data_dir.join("observer/helpers"))?;
                    private_directory(helper.parent().unwrap())?;
                    match write_new(&helper, &helper_bytes, 0o700) {
                        Ok(()) => (),
                        Err(error)
                            if helper.exists()
                                && read_helper(&helper)
                                    .is_ok_and(|(_, existing)| existing == hash) =>
                        {
                            let _ = error;
                        }
                        Err(error) => return Err(error),
                    }
                    private_directory(&self.data_dir.join("observer/installations"))?;
                    private_directory(&install_dir)?;
                    if let Some(before) = preview.before.as_deref() {
                        write_new(
                            &install_dir.join("config-backup.json"),
                            before.as_bytes(),
                            0o600,
                        )?;
                    }
                    write_new(
                        &install_dir.join("receipt.json"),
                        &serde_json::to_vec(&prepared.record)?,
                        0o600,
                    )?;
                    let registration = Registration {
                        schema_version: 1,
                        installation_id: installation_id.clone(),
                        agent: preview.agent,
                        agent_version: preview.agent_version.clone(),
                        socket_path: crate::runtime::socket_path(&self.data_dir)
                            .map_err(transport_error)?
                            .to_string_lossy()
                            .into_owned(),
                        token: secret.token,
                    };
                    write_new(
                        &install_dir.join("registration.json"),
                        &serde_json::to_vec(&registration)?,
                        0o600,
                    )?;
                    config_file::apply(
                        root,
                        folder,
                        filename,
                        &prepared.snapshot,
                        preview.after.as_deref(),
                        &self
                            .installation_dir(&installation_id)
                            .join("config-temporary.json"),
                    )
                },
            )?;
            let activation = (|| {
                self.start_runtime(proof, &helper)?;
                self.check_connection(proof, &installation_id, &helper)?;
                proof.enable_installed_observer(
                    &preview.fields.consent(&installation_id, workspace_id),
                    prepared.epoch,
                    prepared.policy,
                )
            })();
            Ok(HookActionResult {
                installation_id,
                message: match preview.agent {
                    ObserverAgent::Codex => "Proof Hook 已安装。请在 Codex 中运行 /hooks，确认此 Hook 后开始工作。",
                    ObserverAgent::Codewiz => "Proof Hook 已安装。下次启动 Codewiz 时加载插件；正在运行的 Session 保持不变。",
                    ObserverAgent::Claude => "Proof Hook 已安装。",
                }.into(),
                observing_enabled: activation.is_ok(),
                warning: activation
                    .err()
                    .map(|e| format!("配置已安装，观察尚未开启：{} · {}", e.message, e.code)),
            })
        } else {
            proof.change_observer_hook_with_policy(
                &installation_id,
                prepared.epoch,
                "uninstalled",
                Some(prepared.policy),
                || {
                    if let Some(id) = deletion {
                        proof.validate_data_deletion_preview(id)?;
                    }
                    config_file::apply(
                        root,
                        folder,
                        filename,
                        &prepared.snapshot,
                        preview.after.as_deref(),
                        &self
                            .installation_dir(&installation_id)
                            .join("config-temporary.json"),
                    )
                },
            )?;
            let warning = match proof.maintain_local_data() {
                Ok(cleanup) if cleanup.pending_content_deletions > 0 => {
                    Some("Hook 已移除，备份清理尚未完成；可在本地数据中重试。".into())
                }
                Ok(_) => None,
                Err(error) => Some(format!(
                    "Hook 已移除，备份清理未完成：{} · {}",
                    error.message, error.code
                )),
            };
            Ok(HookActionResult {
                installation_id,
                message: "Proof Hook 已移除，已有观察记录保留。".into(),
                observing_enabled: false,
                warning,
            })
        }
    }
    fn config_path(&self, agent: ObserverAgent) -> PathBuf {
        self.paths.directory(agent).join(match agent {
            ObserverAgent::Codex => "hooks.json",
            ObserverAgent::Claude => "settings.json",
            ObserverAgent::Codewiz => "plugins/proof-observer.js",
        })
    }
    fn installation_dir(&self, id: &str) -> PathBuf {
        self.data_dir.join("observer/installations").join(id)
    }
    fn helper_path(&self, hash: &str) -> PathBuf {
        self.data_dir
            .join("observer/helpers")
            .join(hash)
            .join("proof-observer")
    }
    /// One GUI owns the foreground lease at a time. Other windows may read the
    /// same service; after the owner closes another GUI can acquire the lease.
    fn renew_foreground(&mut self, proof: &Proof) -> Result<bool> {
        let runtime = self.data_dir.join("observer");
        private_directory(&runtime)?;
        if self.gui_lease.is_none() {
            let file = File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
                .open(runtime.join("gui.lock"))?;
            let meta = file.metadata()?;
            if !meta.is_file()
                || meta.nlink() != 1
                || meta.uid() != unsafe { libc::geteuid() }
                || meta.mode() & 0o077 != 0
            {
                return Err(Error::new(
                    "OBSERVER_LEASE_PERMISSION",
                    "观察控制文件权限异常。",
                    "Invalid GUI lease file",
                ));
            }
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Ok(false);
            }
            self.gui_lease = Some(file);
        }
        let generation = proof.observer_storage_generation()?;
        proof.with_observer_storage_generation(generation, || {
            crate::server::write_health(
                &runtime.join("foreground.json"),
                &serde_json::json!({"validUntil":protocol::now()+5000,"owner":self.owner}),
            )
            .map_err(transport_error)
        })?;
        Ok(true)
    }
    fn health_is_fresh(&self, generation: u64) -> bool {
        read_private_json(&self.data_dir.join("observer/runtime.json")).is_some_and(|value| {
            value["storageGeneration"].as_u64() == Some(generation)
                && value["cleanShutdown"].as_bool() == Some(false)
                && value["heartbeatAt"]
                    .as_u64()
                    .is_some_and(|at| protocol::now().saturating_sub(at) < 4000)
        })
    }
    fn validate_helper(&self, proof: &Proof, helper: &Path) -> Result<()> {
        let actual = read_helper(helper).ok().map(|(_, hash)| hash);
        let record = proof.observer_hook_records()?.into_iter().find(|r| {
            r.state == "installed"
                && r.ownership["config"]["spec"]["helperPath"].as_str() == helper.to_str()
        });
        if let Some(record) = record {
            if actual.as_deref() == record.ownership["helperHash"].as_str() && actual.is_some() {
                return Ok(());
            }
            proof.invalidate_observer_installation(&record.installation_id, "helper_changed")?;
        }
        Err(Error::new(
            "OBSERVER_HELPER_CHANGED",
            "观察程序已改变，请卸载后重新安装。",
            "Installed helper hash mismatch",
        ))
    }
    fn start_runtime(&mut self, proof: &Proof, helper: &Path) -> Result<()> {
        self.validate_helper(proof, helper)?;
        self.renew_foreground(proof)?;
        let generation = proof.observer_storage_generation()?;
        if let Some(child) = self.collector.as_mut() {
            if child.try_wait()?.is_none() && self.collector_generation != Some(generation) {
                unsafe {
                    libc::kill(child.id() as i32, libc::SIGTERM);
                }
                let until = Instant::now() + Duration::from_secs(3);
                while child.try_wait()?.is_none() && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(20));
                }
                if child.try_wait()?.is_none() {
                    return Err(Error::new(
                        "OBSERVER_STOP_PENDING",
                        "旧采集器仍在退出，请稍后重试。",
                        "Owned collector did not stop",
                    ));
                }
            }
            if child.try_wait()?.is_some() {
                self.collector = None;
                self.collector_generation = None;
            }
        }
        if self.health_is_fresh(generation) {
            return Ok(());
        }
        // A collector belonging to another GUI exits itself after a wipe.
        // Never send a signal to a PID read from a health file.
        if self.collector.is_none() {
            self.collector = Some(
                Command::new(helper)
                    .args(["serve", "--data-dir"])
                    .arg(&self.data_dir)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()?,
            );
            self.collector_generation = Some(generation);
        }
        let until = Instant::now() + Duration::from_secs(3);
        while Instant::now() < until {
            if self.health_is_fresh(generation) {
                return Ok(());
            }
            if self
                .collector
                .as_mut()
                .is_some_and(|child| child.try_wait().ok().flatten().is_some())
            {
                self.collector = None;
                self.collector_generation = None;
                // A concurrent GUI may have won the service's socket lease.
                if self.health_is_fresh(generation) {
                    return Ok(());
                }
                return Err(Error::new(
                    "OBSERVER_START_FAILED",
                    "采集服务未能启动，请重试。",
                    "Helper exited before its heartbeat",
                ));
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        Err(Error::new(
            "OBSERVER_START_TIMEOUT",
            "采集服务尚未就绪，请重试。",
            "No current heartbeat within 3 seconds",
        ))
    }
    fn check_connection(&self, proof: &Proof, id: &str, helper: &Path) -> Result<()> {
        self.validate_helper(proof, helper)?;
        let nonce = uuid::Uuid::new_v4().to_string();
        let payload = serde_json::to_vec(
            &serde_json::json!({"hook_event_name":"ProofConnectionCheck","nonce":nonce}),
        )?;
        let child = Command::new(helper)
            .arg("bridge")
            .arg("--registration")
            .arg(self.installation_dir(id).join("registration.json"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut guard = BridgeChild(Some(child));
        let child = guard.0.as_mut().unwrap();
        if let Some(mut input) = child.stdin.take() {
            input.write_all(&payload)?;
        }
        let until = Instant::now() + Duration::from_secs(2);
        while child.try_wait()?.is_none() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        if child.try_wait()?.is_none() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::new(
                "OBSERVER_PROBE_TIMEOUT",
                "桥接连通检查超时，观察尚未开启。",
                "Bridge process exceeded check budget",
            ));
        }
        let output = guard.0.take().unwrap().wait_with_output()?;
        if !output.status.success() || !output.stdout.is_empty() || !output.stderr.is_empty() {
            return Err(Error::new(
                "OBSERVER_BRIDGE_OUTPUT",
                "桥接程序返回了非中性结果，观察尚未开启。",
                "Bridge must exit zero with no output",
            ));
        }
        while Instant::now() < until {
            if proof.observer_transport_probe_received(id, &nonce)? {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err(Error::new(
            "OBSERVER_CONNECTION_FAILED",
            "桥接连通检查未完成，观察尚未开启。",
            "No authenticated nonce acknowledgement",
        ))
    }
    pub fn tick(&mut self, proof: &Proof) -> Result<()> {
        self.clear_stale_previews(proof.data_session()?.epoch);
        for record in proof
            .observer_hook_records()?
            .into_iter()
            .filter(|r| r.state == "installed")
        {
            if !proof.observer_hook_program_source_trusted(&record)? {
                proof
                    .invalidate_observer_installation(&record.installation_id, "program_changed")?;
            } else if self.configuration_issue(&record).is_some() {
                proof
                    .invalidate_observer_installation(&record.installation_id, "config_changed")?;
            }
        }
        let active = proof
            .observer_consents()?
            .iter()
            .any(|consent| consent.enabled);
        if !active {
            return self.release_foreground(proof);
        }
        self.renew_foreground(proof)?;
        let generation = proof.observer_storage_generation()?;
        if !self.health_is_fresh(generation) {
            if let Some(record) = proof
                .observer_hook_records()?
                .into_iter()
                .find(|r| r.state == "installed")
            {
                let ownership: ConfigOwnership =
                    serde_json::from_value(record.ownership["config"].clone())?;
                let expected = record.ownership["helperHash"].as_str().unwrap_or("");
                if read_helper(Path::new(&ownership.spec.helper_path))?.1 != expected {
                    return Err(Error::new(
                        "OBSERVER_HELPER_CHANGED",
                        "观察程序已改变，请重新安装接入。",
                        "Installed helper hash mismatch",
                    ));
                }
                self.start_runtime(proof, Path::new(&ownership.spec.helper_path))?;
            }
        }
        Ok(())
    }
    pub fn release_foreground(&mut self, proof: &Proof) -> Result<()> {
        if self.gui_lease.is_some() {
            let path = self.data_dir.join("observer/foreground.json");
            proof.with_observer_storage_generation(proof.observer_storage_generation()?, || {
                if read_private_json(&path)
                    .is_some_and(|v| v["owner"].as_str() == Some(self.owner.as_str()))
                {
                    match fs::remove_file(&path) {
                        Ok(()) => (),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                        Err(e) => return Err(e.into()),
                    }
                }
                Ok(())
            })?;
            if let Some(file) = self.gui_lease.take() {
                unsafe {
                    libc::flock(file.as_raw_fd(), libc::LOCK_UN);
                }
            }
        }
        Ok(())
    }
    /// Test/explicit-stop path; only the process handle created here is used.
    pub fn stop_owned_runtime(&mut self, proof: &Proof) -> Result<()> {
        self.release_foreground(proof)?;
        if let Some(mut child) = self.collector.take() {
            if child.try_wait()?.is_none() {
                unsafe {
                    libc::kill(child.id() as i32, libc::SIGTERM);
                }
            }
            let until = Instant::now() + Duration::from_secs(3);
            while child.try_wait()?.is_none() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(20));
            }
            if child.try_wait()?.is_none() {
                child.kill()?;
                child.wait()?;
            }
        }
        self.collector_generation = None;
        Ok(())
    }
}

struct BridgeChild(Option<Child>);
impl Drop for BridgeChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for ObserverManager {
    fn drop(&mut self) {
        if let Some(file) = self.gui_lease.take() {
            unsafe {
                libc::flock(file.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

fn read_private_json(path: &Path) -> Option<serde_json::Value> {
    let file = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.len() > 64 * 1024
    {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 64 * 1024 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn config_location(path: &Path) -> Result<(&Path, &str, &str)> {
    let directory = path
        .parent()
        .ok_or_else(|| Error::new("OBSERVER_CONFIG_PATH", "配置路径无效。", "Missing parent"))?;
    let root = directory
        .ancestors()
        .skip(1)
        .find(|path| path.is_dir())
        .ok_or_else(|| {
            Error::new(
                "OBSERVER_CONFIG_PATH",
                "配置目录不存在。",
                "No existing config ancestor",
            )
        })?;
    let folder = directory
        .strip_prefix(root)
        .ok()
        .and_then(|path| path.to_str())
        .ok_or_else(|| {
            Error::new(
                "OBSERVER_CONFIG_PATH",
                "配置目录必须是 UTF-8。",
                "Non-UTF8 path",
            )
        })?;
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| ["hooks.json", "settings.json", "proof-observer.js"].contains(s))
        .ok_or_else(|| {
            Error::new(
                "OBSERVER_CONFIG_PATH",
                "不支持此配置文件。",
                "Unexpected provider filename",
            )
        })?;
    Ok((root, folder, filename))
}
fn private_directory(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error.into()),
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(Error::new(
            "OBSERVER_STORAGE_PATH",
            "观察存储目录已变化，请检查后重试。",
            "Expected an owned ordinary directory",
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
fn write_new(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let mut file = File::options()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
fn read_helper(path: &Path) -> Result<(Vec<u8>, String)> {
    let mut file = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.mode() & 0o111 == 0
        || meta.mode() & 0o022 != 0
        || meta.len() > 128 * 1024 * 1024
    {
        return Err(Error::new(
            "OBSERVER_HELPER_INVALID",
            "观察程序的类型、权限或大小异常。",
            "Invalid helper binary",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(128 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 128 * 1024 * 1024 {
        return Err(Error::new(
            "OBSERVER_HELPER_INVALID",
            "观察程序超过大小限制。",
            "Helper exceeds 128 MiB",
        ));
    }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    Ok((bytes, hash))
}
fn transport_error(error: impl std::fmt::Debug) -> Error {
    Error::new(
        "OBSERVER_TRANSPORT",
        "观察服务暂时不可用，请重试。",
        format!("{error:?}"),
    )
}
