use crate::{
    error::{Error, Result},
    model::{Preferences, RepositoryLayout, Workspace},
    now,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub(crate) struct Store {
    pub connection: Connection,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        std::fs::create_dir_all(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        }
        let connection = Connection::open(path.join("proof.sqlite3"))?;
        connection.busy_timeout(std::time::Duration::from_secs(3))?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 5 {
            return Err(Error::new(
                "DATABASE_VERSION",
                "本地数据由更新版本的 Proof 创建，请使用对应版本打开。",
                version,
            ));
        }
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, path TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, repository_id TEXT NOT NULL REFERENCES repositories(id),
                name TEXT NOT NULL, path TEXT NOT NULL, git_dir TEXT NOT NULL, common_dir TEXT NOT NULL, trusted INTEGER NOT NULL DEFAULT 0, opened_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS review_marks (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                unit_id TEXT NOT NULL, path TEXT NOT NULL, side TEXT NOT NULL, reviewed INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                PRIMARY KEY(workspace_id, unit_id));
            CREATE INDEX IF NOT EXISTS review_path ON review_marks(workspace_id, path, side);
            CREATE TABLE IF NOT EXISTS review_events (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                unit_id TEXT NOT NULL, reviewed INTEGER NOT NULL, source TEXT NOT NULL, origin_unit_id TEXT, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS repository_layouts (repository_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS hidden_recent_workspaces (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS data_client_deletions (workspace_id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS data_file_deletions (kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind,id));
            INSERT OR IGNORE INTO settings VALUES('data_epoch','0');
            INSERT OR IGNORE INTO settings VALUES('data_client_wipe_epoch','0');
            INSERT OR IGNORE INTO settings VALUES('observer_revision','0');
            CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS recovery_points (id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL REFERENCES workspaces(id), point TEXT NOT NULL,
                payload TEXT NOT NULL, expires_at INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL,
                before_data BLOB, after_data BLOB);
            CREATE TABLE IF NOT EXISTS observer_installations (id TEXT PRIMARY KEY, agent TEXT NOT NULL, agent_version TEXT NOT NULL,
                adapter_version TEXT NOT NULL, token_hash TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, last_event_at INTEGER);
            CREATE TABLE IF NOT EXISTS observer_permissions (installation_id TEXT NOT NULL REFERENCES observer_installations(id) ON DELETE CASCADE,
                workspace_id TEXT NOT NULL REFERENCES workspaces(id), enabled INTEGER NOT NULL, prompt INTEGER NOT NULL, command INTEGER NOT NULL,
                reply INTEGER NOT NULL, output INTEGER NOT NULL, background INTEGER NOT NULL, generation INTEGER NOT NULL,
                PRIMARY KEY(installation_id,workspace_id));
            CREATE TABLE IF NOT EXISTS observer_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, installation_id TEXT NOT NULL REFERENCES observer_installations(id),
                native_session_id TEXT, native_agent_id TEXT, first_received_at INTEGER NOT NULL, last_received_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS observer_events (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, installation_id TEXT NOT NULL REFERENCES observer_installations(id),
                session_id TEXT NOT NULL REFERENCES observer_sessions(id) ON DELETE CASCADE, native_key TEXT, received_at INTEGER NOT NULL, payload TEXT NOT NULL,
                content_expires_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(installation_id,native_key));
            CREATE INDEX IF NOT EXISTS observer_event_workspace ON observer_events(workspace_id,received_at);
            CREATE INDEX IF NOT EXISTS observer_event_session ON observer_events(session_id);
            CREATE INDEX IF NOT EXISTS observer_event_expiry ON observer_events(expires_at);
            CREATE INDEX IF NOT EXISTS observer_output_expiry ON observer_events(content_expires_at);
            CREATE TABLE IF NOT EXISTS observer_associations (workspace_id TEXT NOT NULL, path TEXT NOT NULL, session_id TEXT NOT NULL,
                enabled INTEGER NOT NULL, note TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,path,session_id));
            CREATE TABLE IF NOT EXISTS observer_association_history (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, path TEXT NOT NULL, session_id TEXT NOT NULL,
                payload TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS observer_gaps (id TEXT PRIMARY KEY, installation_id TEXT, workspace_id TEXT, code TEXT NOT NULL,
                count INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER);
            PRAGMA user_version=5;")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                path.join("proof.sqlite3"),
                std::fs::Permissions::from_mode(0o600),
            )?;
        }
        Ok(Self { connection })
    }

    pub fn register(
        &mut self,
        repository_identity: &str,
        identity: &str,
        mut workspace: Workspace,
    ) -> Result<Workspace> {
        let tx = self.connection.transaction()?;
        let repo_id: Option<String> = tx
            .query_row(
                "SELECT id FROM repositories WHERE identity=?",
                [repository_identity],
                |row| row.get(0),
            )
            .optional()?;
        workspace.repository_id = match repo_id {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO repositories VALUES (?,?,?)",
                    params![id, repository_identity, workspace.common_dir],
                )?;
                id
            }
        };
        let previous: Option<(String, bool, String)> = tx
            .query_row(
                "SELECT id,trusted,repository_id FROM workspaces WHERE identity=?",
                [identity],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((id, trusted, repository_id)) = previous {
            if repository_id == workspace.repository_id {
                workspace.id = id;
                workspace.trusted = trusted;
            } else {
                // Preserve the old worktree's audit/recovery ownership without
                // transferring authority to a replacement common repository.
                tx.execute(
                    "UPDATE workspaces SET identity=?,trusted=0 WHERE id=?",
                    params![format!("retired:{id}:{identity}"), id],
                )?;
            }
        }
        tx.execute("INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,path=excluded.path,git_dir=excluded.git_dir,common_dir=excluded.common_dir,opened_at=excluded.opened_at",
            params![workspace.id, identity, workspace.repository_id, workspace.name, workspace.path, workspace.git_dir, workspace.common_dir, workspace.trusted, now()])?;
        tx.execute(
            "DELETE FROM hidden_recent_workspaces WHERE workspace_id=?",
            [&workspace.id],
        )?;
        tx.commit()?;
        Ok(workspace)
    }

    fn read_workspace(row: &rusqlite::Row<'_>) -> rusqlite::Result<Workspace> {
        Ok(Workspace {
            id: row.get(0)?,
            repository_id: row.get(1)?,
            name: row.get(2)?,
            path: row.get(3)?,
            git_dir: row.get(4)?,
            common_dir: row.get(5)?,
            trusted: row.get(6)?,
        })
    }
    pub fn workspaces(&self) -> Result<Vec<Workspace>> {
        let mut query = self.connection.prepare("SELECT id,repository_id,name,path,git_dir,common_dir,trusted FROM workspaces ORDER BY opened_at DESC")?;
        let rows = query
            .query_map([], Self::read_workspace)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    pub fn workspace(&self, id: &str) -> Result<Workspace> {
        let workspace = self.connection.query_row("SELECT id,repository_id,name,path,git_dir,common_dir,trusted FROM workspaces WHERE id=?", [id], Self::read_workspace)
            .optional()?.ok_or_else(|| Error::new("WORKSPACE_MISSING", "请重新打开仓库。", "Unknown workspace id"))?;
        let git = crate::git::Git {
            executable: self.preferences()?.git_path,
        };
        let (actual, repository_identity, identity) = git.discover(&workspace.path)?;
        let matches: bool = self.connection.query_row("SELECT w.identity=? AND r.identity=? FROM workspaces w JOIN repositories r ON r.id=w.repository_id WHERE w.id=?",
            params![identity, repository_identity, id], |row| row.get(0))?;
        if !matches
            || actual.path != workspace.path
            || actual.git_dir != workspace.git_dir
            || actual.common_dir != workspace.common_dir
        {
            return Err(Error::new(
                "WORKSPACE_REPLACED",
                "仓库或工作区身份已变化，请重新打开并确认信任。",
                "Git directory identity no longer matches the registered workspace",
            ));
        }
        Ok(workspace)
    }
    pub fn trust(&self, id: &str, trusted: bool) -> Result<()> {
        self.workspace(id)?;
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        transaction.execute(
            "UPDATE workspaces SET trusted=? WHERE id=?",
            params![trusted, id],
        )?;
        transaction.execute(
            "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='observer_revision'",
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }
    pub fn review_state(
        &self,
        workspace: &str,
        path: &str,
        side: &str,
        unit: &str,
    ) -> Result<String> {
        let exact: Option<bool> = self
            .connection
            .query_row(
                "SELECT reviewed FROM review_marks WHERE workspace_id=? AND unit_id=?",
                params![workspace, unit],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(reviewed) = exact {
            return Ok(if reviewed { "reviewed" } else { "unreviewed" }.into());
        }
        let had_review: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM review_marks WHERE workspace_id=? AND path=? AND side=? AND reviewed=1)", params![workspace,path,side], |row| row.get(0))?;
        Ok(if had_review {
            "needs_review"
        } else {
            "unreviewed"
        }
        .into())
    }
    pub fn mark(
        &mut self,
        workspace: &str,
        path: &str,
        side: &str,
        units: &[String],
        reviewed: bool,
    ) -> Result<()> {
        let tx = self.connection.transaction()?;
        for unit in units {
            tx.execute("INSERT INTO review_marks VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,unit_id) DO UPDATE SET reviewed=excluded.reviewed,updated_at=excluded.updated_at",
                params![workspace, unit, path, side, reviewed, now()])?;
            tx.execute(
                "INSERT INTO review_events VALUES(?,?,?,?,?,?,?)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    workspace,
                    unit,
                    reviewed,
                    "user",
                    Option::<String>::None,
                    now()
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn migrate_mark(
        &mut self,
        workspace: &str,
        path: &str,
        side: &str,
        from: &str,
        to: &str,
    ) -> Result<()> {
        let tx = self.connection.transaction()?;
        let timestamp: Option<u64> = tx.query_row("SELECT updated_at FROM review_marks WHERE workspace_id=? AND unit_id=? AND reviewed=1", params![workspace,from], |row|row.get(0)).optional()?;
        if let Some(timestamp) = timestamp {
            tx.execute("INSERT INTO review_marks VALUES(?,?,?,?,1,?) ON CONFLICT(workspace_id,unit_id) DO UPDATE SET reviewed=1,updated_at=excluded.updated_at",params![workspace,to,path,side,timestamp])?;
            tx.execute(
                "INSERT INTO review_events VALUES(?,?,?,?,?,?,?)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    workspace,
                    to,
                    true,
                    "stage_migration",
                    from,
                    now()
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn preferences(&self) -> Result<Preferences> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM settings WHERE key='preferences'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        value
            .map(|v| serde_json::from_str(&v).map_err(Error::from))
            .unwrap_or_else(|| Ok(Preferences::default()))
    }
    pub fn set_preferences(&self, preferences: &Preferences) -> Result<()> {
        if !(10..=26).contains(&preferences.font_size)
            || !["light", "dark", "system"].contains(&preferences.theme.as_str())
            || !["unified", "split"].contains(&preferences.diff_mode.as_str())
            || preferences.git_path.is_empty()
            || preferences.git_path.contains('\0')
        {
            return Err(Error::new(
                "INVALID_SETTING",
                "设置值超出支持范围。",
                "Invalid preference",
            ));
        }
        self.connection.execute("INSERT INTO settings VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(preferences)?])?;
        Ok(())
    }
    pub fn repository_layout(&self, workspace_id: &str) -> Result<RepositoryLayout> {
        let workspace = self.workspace(workspace_id)?;
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM repository_layouts WHERE repository_id=?",
                [&workspace.repository_id],
                |row| row.get(0),
            )
            .optional()?;
        let layout = value
            .map(|value| serde_json::from_str(&value).map_err(Error::from))
            .unwrap_or_else(|| Ok(RepositoryLayout::default()))?;
        Self::validate_layout(&layout)?;
        Ok(layout)
    }
    pub fn set_repository_layout(
        &self,
        workspace_id: &str,
        layout: &RepositoryLayout,
    ) -> Result<()> {
        Self::validate_layout(layout)?;
        let workspace = self.workspace(workspace_id)?;
        self.connection.execute(
            "INSERT INTO repository_layouts VALUES(?,?) ON CONFLICT(repository_id) DO UPDATE SET value=excluded.value",
            params![workspace.repository_id, serde_json::to_string(layout)?],
        )?;
        Ok(())
    }
    fn validate_layout(layout: &RepositoryLayout) -> Result<()> {
        if !(180..=480).contains(&layout.sidebar_width)
            || !(240..=520).contains(&layout.context_width)
        {
            return Err(Error::new(
                "INVALID_LAYOUT",
                "面板宽度超出支持范围。",
                "Sidebar: 180–480 px; context: 240–520 px",
            ));
        }
        Ok(())
    }
    pub fn record_operation(&self, workspace: &str, kind: &str, result: &str) -> Result<()> {
        let changed=self.connection.execute(
            "INSERT INTO operations SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=?2)",
            params![
                uuid::Uuid::new_v4().to_string(),
                workspace,
                kind,
                result,
                now()
            ],
        )?;
        if changed == 0 {
            return Err(Error::new(
                "DATA_RECORDS_DELETED",
                "Git 操作已完成；本地仓库记录已删除，因此未保存操作记录。",
                "Workspace was removed before operation recording",
            ));
        }
        Ok(())
    }
}
