//! Durable coordination between native hook configuration and observation.
//! No Agent configuration or credential plaintext is stored in this table.
use crate::{fingerprint, Error, ObserverConsent, ObserverRegistrationSecret, Proof, Result};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverHookRecord {
    pub installation_id: String,
    pub config_path: String,
    pub ownership: serde_json::Value,
    pub state: String,
}

impl Proof {
    pub fn invalidate_observer_installation(&self, id: &str, state: &str) -> Result<()> {
        if !["program_changed", "config_changed", "helper_changed"].contains(&state) {
            return Err(Error::new(
                "OBSERVER_CONFIG_STATE",
                "观察状态无效。",
                "Unknown invalidation state",
            ));
        }
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        if tx.execute("UPDATE observer_installations SET state=? WHERE id=? AND state!=? AND state!='revoked'",params![state,id,state])?>0 {
            tx.execute("UPDATE observer_permissions SET enabled=0,generation=generation+1 WHERE installation_id=?",[id])?;
            tx.execute("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='observer_revision'",[])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn pause_installed_observer(
        &self,
        id: &str,
        workspace_id: &str,
        epoch: u64,
        policy: u64,
    ) -> Result<()> {
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        self.check_data_epoch(epoch)?;
        check_policy(&tx, policy)?;
        tx.execute("UPDATE observer_permissions SET enabled=0,generation=generation+1 WHERE installation_id=? AND workspace_id=?",params![id,workspace_id])?;
        tx.execute(
            "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='observer_revision'",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn observer_hook_program_matches(&self, record: &ObserverHookRecord) -> Result<bool> {
        let Some(expected) = record.ownership["program"]["identity"].as_str() else {
            return Ok(false);
        };
        Ok(self.observer_hook_program_identity(record)?.as_deref() == Some(expected))
    }
    /// A passive Hook invokes our helper, not the Agent executable. Agent updates
    /// do not revoke existing capture consent; source trust and permissions still do.
    pub fn observer_hook_program_source_trusted(
        &self,
        record: &ObserverHookRecord,
    ) -> Result<bool> {
        Ok(self.observer_hook_program_identity(record)?.is_some())
    }
    fn observer_hook_program_identity(
        &self,
        record: &ObserverHookRecord,
    ) -> Result<Option<String>> {
        let Some(path) = record.ownership["program"]["path"].as_str() else {
            return Ok(None);
        };
        let agent: crate::ObserverAgent =
            match serde_json::from_value(record.ownership["config"]["spec"]["agent"].clone()) {
                Ok(agent) => agent,
                Err(_) => return Ok(None),
            };
        let Ok((resolved, mut origins, identity)) =
            crate::ai::resolve_agent_executable(agent.adapter().kind, std::path::Path::new(path))
        else {
            return Ok(None);
        };
        if let Some(parent) = resolved.parent() {
            origins.push(parent.to_owned());
        }
        let workspaces = self.store.workspaces()?;
        for origin in origins {
            if crate::program::trusted_program_workspace(&self.store, &origin, &workspaces).is_err()
            {
                return Ok(None);
            }
        }
        Ok(Some(identity))
    }
    pub(crate) fn check_observer_hook_program(&self, id: &str) -> Result<bool> {
        let Some(record) = self
            .observer_hook_records()?
            .into_iter()
            .find(|r| r.installation_id == id)
        else {
            return Ok(true);
        };
        if self.observer_hook_program_source_trusted(&record)? {
            return Ok(true);
        }
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        let changed=tx.execute("UPDATE observer_installations SET state='program_changed' WHERE id=? AND state NOT IN('program_changed','revoked')",[id])?;
        if changed > 0 {
            tx.execute("UPDATE observer_permissions SET enabled=0,generation=generation+1 WHERE installation_id=?",[id])?;
            tx.execute(
                "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='observer_revision'",
                [],
            )?;
        }
        tx.commit()?;
        Ok(false)
    }
    pub(crate) fn record_observer_transport_probe(
        &self,
        id: &str,
        token: &str,
        nonce: &str,
        policy_revision: u64,
    ) -> Result<bool> {
        if uuid::Uuid::parse_str(nonce).is_err() {
            return Ok(false);
        }
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        check_policy(&tx, policy_revision)?;
        let permitted: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM observer_installations i JOIN observer_hook_configs h ON h.installation_id=i.id WHERE i.id=? AND i.token_hash=? AND i.state!='revoked' AND h.state IN('installing','installed'))", params![id,fingerprint(&[token.as_bytes()])], |r| r.get(0))?;
        if !permitted {
            return Ok(false);
        }
        tx.execute("INSERT INTO observer_transport_probes VALUES(?,?,?) ON CONFLICT(installation_id) DO UPDATE SET nonce_hash=excluded.nonce_hash,received_at=excluded.received_at", params![id,fingerprint(&[nonce.as_bytes()]),crate::now()])?;
        tx.commit()?;
        Ok(true)
    }
    pub fn observer_transport_probe_received(&self, id: &str, nonce: &str) -> Result<bool> {
        let value: Option<String> = self
            .store
            .connection
            .query_row(
                "SELECT nonce_hash FROM observer_transport_probes WHERE installation_id=?",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(value.is_some_and(|hash| hash == fingerprint(&[nonce.as_bytes()])))
    }
    pub fn observer_hook_records(&self) -> Result<Vec<ObserverHookRecord>> {
        let mut query = self.store.connection.prepare("SELECT installation_id,config_path,ownership,state FROM observer_hook_configs ORDER BY installation_id")?;
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(installation_id, config_path, ownership, state)| {
                Ok(ObserverHookRecord {
                    installation_id,
                    config_path,
                    ownership: serde_json::from_str(&ownership)?,
                    state,
                })
            })
            .collect()
    }

    /// Journal the intended installation before any external config changes.
    /// A crash leaves a recoverable installing row, never an unowned Hook.
    pub fn begin_observer_hook_install(
        &self,
        record: &ObserverHookRecord,
        secret: &ObserverRegistrationSecret,
        workspace_id: &str,
        epoch: u64,
        policy_revision: u64,
    ) -> Result<()> {
        let workspace = self.store.workspace(workspace_id)?;
        self.workspace_watch_paths(&workspace.id)?;
        if !workspace.trusted {
            return Err(Error::new(
                "TRUST_REQUIRED",
                "请先信任此仓库，再安装 Hook。",
                "Workspace is not trusted",
            ));
        }
        if !std::path::Path::new(&record.config_path).is_absolute()
            || record.config_path.len() > 32768
            || uuid::Uuid::parse_str(&record.installation_id).is_err()
            || secret.token.len() != 64
            || !secret.token.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(Error::new(
                "OBSERVER_CONFIG_PATH",
                "Hook 安装路径或注册信息无效。",
                "Expected an absolute provider configuration and generated transport identity",
            ));
        }
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        self.check_data_epoch(epoch)?;
        check_policy(&tx, policy_revision)?;
        if record.installation_id != secret.installation.id || record.state != "installing" {
            return Err(Error::new(
                "OBSERVER_CONFIG_RECEIPT",
                "Hook 安装信息无效，请重新预览。",
                "Mismatched installation identity",
            ));
        }
        let existing: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM observer_hook_configs h JOIN observer_installations i ON i.id=h.installation_id WHERE i.agent=? AND h.state!='uninstalled')", [secret.installation.agent.as_str()], |r| r.get(0))?;
        if existing {
            return Err(Error::new(
                "OBSERVER_ALREADY_CONFIGURED",
                "此 Agent 已有 Proof Hook，请管理现有接入或授权其他 Worktree。",
                "An active hook receipt exists",
            ));
        }
        let install = &secret.installation;
        tx.execute(
            "INSERT INTO observer_installations VALUES(?,?,?,?,?,?,?,NULL)",
            params![
                install.id,
                install.agent.as_str(),
                install.agent_version,
                install.adapter_version,
                fingerprint(&[secret.token.as_bytes()]),
                "configured_pending",
                install.created_at
            ],
        )?;
        tx.execute(
            "INSERT INTO observer_hook_configs VALUES(?,?,?,?)",
            params![
                record.installation_id,
                record.config_path,
                serde_json::to_string(&record.ownership)?,
                record.state
            ],
        )?;
        tx.execute(
            "INSERT INTO observer_permissions VALUES(?,?,0,0,0,0,0,0,1)",
            params![record.installation_id, workspace_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The SQL writer lock orders configuration writes with deletion and
    /// consent changes in other windows. It never spans a user dialog.
    pub fn change_observer_hook<T>(
        &self,
        id: &str,
        epoch: u64,
        state: &str,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.change_observer_hook_with_policy(id, epoch, state, None, operation)
    }
    pub fn change_observer_hook_with_policy<T>(
        &self,
        id: &str,
        epoch: u64,
        state: &str,
        policy: Option<u64>,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        if !["installed", "uninstalled"].contains(&state) {
            return Err(Error::new(
                "OBSERVER_CONFIG_STATE",
                "Hook 操作状态无效。",
                "Unknown target state",
            ));
        }
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        self.check_data_epoch(epoch)?;
        if let Some(policy) = policy {
            check_policy(&tx, policy)?;
        }
        let previous: Option<String> = tx
            .query_row(
                "SELECT state FROM observer_hook_configs WHERE installation_id=?",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let allowed = match state {
            "installed" => previous.as_deref() == Some("installing"),
            "uninstalled" => matches!(previous.as_deref(), Some("installing" | "installed")),
            _ => false,
        };
        if !allowed {
            return Err(Error::new(
                "OBSERVER_CONFIG_STATE_CHANGED",
                "Hook 状态已改变，请重新预览。",
                "Configuration transition no longer applies",
            ));
        }
        let value = operation()?;
        tx.execute(
            "UPDATE observer_hook_configs SET state=? WHERE installation_id=?",
            params![state, id],
        )?;
        if state == "uninstalled" {
            tx.execute(
                "DELETE FROM observer_transport_probes WHERE installation_id=?",
                [id],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO data_file_deletions VALUES('hook_installation',?)",
                [id],
            )?;
            tx.execute("UPDATE observer_permissions SET enabled=0,generation=generation+1 WHERE installation_id=?", [id])?;
            tx.execute(
                "UPDATE observer_installations SET state='revoked' WHERE id=?",
                [id],
            )?;
            tx.execute(
                "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='observer_revision'",
                [],
            )?;
        }
        tx.commit()?;
        Ok(value)
    }

    /// Enabling after a configuration write still respects a concurrent pause.
    pub fn enable_installed_observer(
        &self,
        consent: &ObserverConsent,
        epoch: u64,
        policy_revision: u64,
    ) -> Result<()> {
        let record = self
            .observer_hook_records()?
            .into_iter()
            .find(|r| r.installation_id == consent.installation_id)
            .ok_or_else(|| {
                Error::new(
                    "OBSERVER_MISSING",
                    "Hook 安装记录不存在。",
                    "Missing installation",
                )
            })?;
        if !self.observer_hook_program_source_trusted(&record)? {
            return Err(Error::new(
                "OBSERVER_PROGRAM_CHANGED",
                "Agent 程序已改变，请重新检测并更新接入。",
                "Agent executable changed",
            ));
        }
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        self.check_data_epoch(epoch)?;
        check_policy(&tx, policy_revision)?;
        let permitted: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM observer_hook_configs h JOIN workspaces w ON w.id=? WHERE h.installation_id=? AND h.state='installed' AND w.trusted=1)", params![consent.workspace_id,consent.installation_id], |r|r.get(0))?;
        if !permitted {
            return Err(Error::new(
                "OBSERVER_CONFIG_NOT_READY",
                "Hook 配置或仓库信任已改变，观察未开启。",
                "Installed trusted scope required",
            ));
        }
        tx.execute("INSERT INTO observer_permissions VALUES(?,?,1,?,?,?,?,?,1) ON CONFLICT(installation_id,workspace_id) DO UPDATE SET enabled=1,prompt=excluded.prompt,command=excluded.command,reply=excluded.reply,output=excluded.output,background=excluded.background,generation=generation+1", params![consent.installation_id,consent.workspace_id,consent.prompt,consent.command,consent.reply,consent.output,consent.background])?;
        tx.execute(
            "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='observer_revision'",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }
}

fn check_policy(tx: &Transaction<'_>, expected: u64) -> Result<()> {
    let actual: u64 = tx.query_row(
        "SELECT CAST(value AS INTEGER) FROM settings WHERE key='observer_revision'",
        [],
        |r| r.get(0),
    )?;
    if actual != expected {
        return Err(Error::new(
            "OBSERVER_POLICY_CHANGED",
            "观察设置已改变，请重新确认授权。",
            "Observer policy generation changed",
        ));
    }
    Ok(())
}
