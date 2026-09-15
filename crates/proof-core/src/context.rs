//! File-level links and reversible user corrections. Original events and Git are never rewritten.
use crate::{
    fingerprint, now, Error, ObserverAgent, ObserverEvent, Proof, Result, OBSERVATION_RETENTION_MS,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

const PAGE: usize = 30;
const HISTORY_ORDER: &str = "CAST(COALESCE(json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.sequence'),0) AS INTEGER)";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssociationOverride {
    pub enabled: bool,
    pub note: String,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssociationEvidence {
    pub path_event_count: u64,
    pub event_ids: Vec<String>,
    pub matched_at_capture: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSession {
    pub id: String,
    pub agent: Option<ObserverAgent>,
    pub native_session_id: Option<String>,
    pub native_agent_id: Option<String>,
    pub first_received_at: Option<u64>,
    pub last_received_at: Option<u64>,
    pub event_count: u64,
    pub prompt_excerpt: Option<String>,
    pub prompt_status: String,
    pub cleared: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLink {
    pub session: ContextSession,
    pub original_evidence: AssociationEvidence,
    pub user_override: Option<AssociationOverride>,
    pub revision: String,
    pub active: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextOverview {
    pub workspace_id: String,
    pub path: String,
    pub links: Vec<ContextLink>,
    pub excluded_count: u64,
    pub history_count: u64,
    pub has_more: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCandidates {
    pub links: Vec<ContextLink>,
    pub next: Option<ContextCandidateCursor>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCandidateCursor {
    pub first_received_at: u64,
    pub session_id: String,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextAction {
    Link,
    Exclude,
    Automatic,
    Undo,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CorrectionSource {
    User,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangePayload {
    schema_version: u32,
    sequence: u64,
    source: CorrectionSource,
    action: ContextAction,
    before: Option<AssociationOverride>,
    after: Option<AssociationOverride>,
    original_evidence: AssociationEvidence,
    undo_of: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextChange {
    pub id: String,
    pub session_id: String,
    pub created_at: u64,
    pub action: ContextAction,
    pub before: Option<AssociationOverride>,
    pub after: Option<AssociationOverride>,
    pub original_evidence: AssociationEvidence,
    pub undo_of: Option<String>,
    pub source: CorrectionSource,
    pub can_undo: bool,
    pub revision: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextHistory {
    pub entries: Vec<ContextChange>,
    pub next_offset: Option<usize>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMutation {
    pub change: Option<ContextChange>,
    pub revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextEventCursor {
    pub received_at: u64,
    pub id: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEvents {
    pub events: Vec<ObserverEvent>,
    pub expiry: std::collections::BTreeMap<String, ContextEventExpiry>,
    pub next: Option<ContextEventCursor>,
    pub cleared: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEventExpiry {
    pub content_expires_at: u64,
    pub expires_at: u64,
}

fn invalid(message: &str) -> Error {
    Error::new(
        "CONTEXT_INVALID",
        message,
        "Invalid local association request",
    )
}
fn changed() -> Error {
    Error::new(
        "CONTEXT_CHANGED",
        "关联已更新，请重新读取后再保存。",
        "Expected association revision no longer matches",
    )
}
fn cutoff() -> u64 {
    now().saturating_sub(OBSERVATION_RETENTION_MS)
}
fn state(
    db: &Connection,
    workspace: &str,
    path: &str,
    session: &str,
) -> Result<Option<AssociationOverride>> {
    Ok(db.query_row("SELECT enabled,note FROM observer_associations WHERE workspace_id=? AND path=? AND session_id=? AND updated_at>?",params![workspace,path,session,cutoff()],|row|Ok(AssociationOverride{enabled:row.get(0)?,note:row.get(1)?})).optional()?)
}
fn latest(
    db: &Connection,
    workspace: &str,
    path: &str,
    session: Option<&str>,
) -> Result<Option<(String, ChangePayload)>> {
    // Include expired rows until deletion. The persistent deletion epoch then
    // prevents an old editor token becoming valid again when history is removed.
    let sql=format!("SELECT id,payload FROM observer_association_history WHERE workspace_id=? AND path=? AND (? IS NULL OR session_id=?) ORDER BY {HISTORY_ORDER} DESC,created_at DESC,id DESC LIMIT 1");
    let row: Option<(String, String)> = db
        .query_row(&sql, params![workspace, path, session, session], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    row.map(|(id, payload)| Ok((id, serde_json::from_str(&payload)?)))
        .transpose()
}
fn revision(db: &Connection, workspace: &str, path: &str, session: &str) -> Result<String> {
    let epoch: String = db.query_row(
        "SELECT value FROM settings WHERE key='data_epoch'",
        [],
        |r| r.get(0),
    )?;
    let policy: String = db.query_row(
        "SELECT value FROM settings WHERE key='observer_revision'",
        [],
        |r| r.get(0),
    )?;
    let history_epoch: String = db.query_row(
        "SELECT value FROM settings WHERE key='context_history_epoch'",
        [],
        |r| r.get(0),
    )?;
    let head = latest(db, workspace, path, Some(session))?
        .map(|(id, _)| id)
        .unwrap_or_default();
    let session_started: Option<u64> = db
        .query_row(
            "SELECT first_received_at FROM observer_sessions WHERE workspace_id=? AND id=?",
            params![workspace, session],
            |r| r.get(0),
        )
        .optional()?;
    Ok(fingerprint(&[
        workspace.as_bytes(),
        path.as_bytes(),
        session.as_bytes(),
        epoch.as_bytes(),
        policy.as_bytes(),
        history_epoch.as_bytes(),
        head.as_bytes(),
        &serde_json::to_vec(&session_started)?,
        &serde_json::to_vec(&state(db, workspace, path, session)?)?,
    ]))
}
fn evidence(
    db: &Connection,
    workspace: &str,
    path: &str,
    session: &str,
) -> Result<AssociationEvidence> {
    let count:u64=db.query_row("SELECT count(*) FROM observer_events WHERE workspace_id=? AND session_id=? AND expires_at>? AND EXISTS(SELECT 1 FROM json_each(payload,'$.paths') WHERE value=?)",params![workspace,session,now(),path],|r|r.get(0))?;
    let mut query=db.prepare("SELECT id,payload FROM observer_events WHERE workspace_id=? AND session_id=? AND expires_at>? AND EXISTS(SELECT 1 FROM json_each(payload,'$.paths') WHERE value=?) ORDER BY received_at DESC,id DESC LIMIT 20")?;
    let rows = query
        .query_map(params![workspace, session, now(), path], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut answer = AssociationEvidence {
        path_event_count: count,
        ..Default::default()
    };
    for (id, payload) in rows {
        let event: ObserverEvent = serde_json::from_str(&payload)?;
        answer.event_ids.push(id);
        answer.matched_at_capture |= event.matched_content_hashes.contains_key(path);
    }
    Ok(answer)
}
fn summary(db: &Connection, workspace: &str, session: &str) -> Result<ContextSession> {
    let row:Option<(String,Option<String>,Option<String>)>=db.query_row("SELECT i.agent,s.native_session_id,s.native_agent_id FROM observer_sessions s JOIN observer_installations i ON i.id=s.installation_id WHERE s.workspace_id=? AND s.id=?",params![workspace,session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (count,first,last):(u64,Option<u64>,Option<u64>)=db.query_row("SELECT count(*),min(received_at),max(received_at) FROM observer_events WHERE workspace_id=? AND session_id=? AND expires_at>?",params![workspace,session,now()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    let prompt:Option<String>=db.query_row("SELECT payload FROM observer_events WHERE workspace_id=? AND session_id=? AND expires_at>? ORDER BY CASE WHEN json_type(payload,'$.prompt')='text' THEN 0 ELSE 1 END,received_at DESC,id DESC LIMIT 1",params![workspace,session,now()],|r|r.get(0)).optional()?;
    let (excerpt, status) = if let Some(payload) = prompt {
        let event: ObserverEvent = serde_json::from_str(&payload)?;
        (
            event.prompt.map(|s| s.chars().take(240).collect()),
            event
                .field_status
                .get("prompt")
                .cloned()
                .unwrap_or_else(|| "not_provided".into()),
        )
    } else {
        (None, "expired".into())
    };
    let (agent, native_session_id, native_agent_id) = match row {
        Some((agent, id, child)) => (
            Some(serde_json::from_value(serde_json::Value::String(agent))?),
            id,
            child,
        ),
        None => (None, None, None),
    };
    Ok(ContextSession {
        id: session.into(),
        agent,
        native_session_id,
        native_agent_id,
        first_received_at: first,
        last_received_at: last,
        event_count: count,
        prompt_excerpt: excerpt,
        prompt_status: status,
        cleared: count == 0,
    })
}
fn link(db: &Connection, workspace: &str, path: &str, session: &str) -> Result<ContextLink> {
    let original = evidence(db, workspace, path, session)?;
    let user_override = state(db, workspace, path, session)?;
    let active = user_override
        .as_ref()
        .map_or(original.path_event_count > 0, |value| value.enabled);
    Ok(ContextLink {
        session: summary(db, workspace, session)?,
        original_evidence: original,
        user_override,
        revision: revision(db, workspace, path, session)?,
        active,
    })
}
impl Proof {
    fn context_scope(&self, workspace: &str, path: &str, verify_identity: bool) -> Result<()> {
        let stored = if verify_identity {
            self.store.workspace(workspace)?
        } else {
            self.store.recorded_workspace(workspace)?
        };
        if path.len() > 32768
            || std::path::Path::new(path).components().any(|p| {
                p.as_os_str()
                    .as_encoded_bytes()
                    .eq_ignore_ascii_case(b".git")
            })
        {
            return Err(invalid("请选择 Worktree 内的文件。"));
        }
        let full = crate::git::checked_path(&stored, path)?;
        let parent = full
            .parent()
            .ok_or_else(|| invalid("请选择 Worktree 内的文件。"))?;
        let resolved_parent = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.into());
        if full.starts_with(&stored.git_dir)
            || full.starts_with(&stored.common_dir)
            || resolved_parent.starts_with(&stored.git_dir)
            || resolved_parent.starts_with(&stored.common_dir)
            || crate::observer::crosses_git_boundary(parent, std::path::Path::new(&stored.path))
            || crate::observer::crosses_git_boundary(
                &resolved_parent,
                std::path::Path::new(&stored.path),
            )
        {
            return Err(invalid("不能关联 Git 内部文件或另一个仓库的文件。"));
        }
        Ok(())
    }
    pub fn context_overview(&self, workspace: &str, path: &str) -> Result<ContextOverview> {
        self.context_scope(workspace, path, false)?;
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            TransactionBehavior::Deferred,
        )?;
        let mut query=tx.prepare("SELECT session_id FROM (SELECT session_id,max(received_at) AS at FROM observer_events WHERE workspace_id=?1 AND expires_at>?2 AND EXISTS(SELECT 1 FROM json_each(payload,'$.paths') WHERE value=?3) GROUP BY session_id UNION ALL SELECT session_id,updated_at FROM observer_associations WHERE workspace_id=?1 AND path=?3 AND enabled=1 AND updated_at>?4) x WHERE NOT EXISTS(SELECT 1 FROM observer_associations a WHERE a.workspace_id=?1 AND a.path=?3 AND a.session_id=x.session_id AND a.enabled=0 AND a.updated_at>?4) GROUP BY session_id ORDER BY max(at) DESC,session_id LIMIT 31")?;
        let ids = query
            .query_map(params![workspace, now(), path, cutoff()], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let links = ids
            .iter()
            .take(PAGE)
            .map(|id| link(&tx, workspace, path, id))
            .collect::<Result<Vec<_>>>()?;
        let excluded_count=tx.query_row("SELECT count(*) FROM observer_associations WHERE workspace_id=? AND path=? AND enabled=0 AND updated_at>?",params![workspace,path,cutoff()],|r|r.get(0))?;
        let history_count=tx.query_row("SELECT count(*) FROM observer_association_history WHERE workspace_id=? AND path=? AND created_at>?",params![workspace,path,cutoff()],|r|r.get(0))?;
        drop(query);
        tx.commit()?;
        Ok(ContextOverview {
            workspace_id: workspace.into(),
            path: path.into(),
            links,
            excluded_count,
            history_count,
            has_more: ids.len() > PAGE,
        })
    }
    pub fn context_candidates(
        &self,
        workspace: &str,
        path: &str,
        search: &str,
        before: Option<ContextCandidateCursor>,
    ) -> Result<ContextCandidates> {
        self.context_scope(workspace, path, false)?;
        if search.chars().count() > 100
            || before.as_ref().is_some_and(|cursor| {
                cursor.session_id.len() > 128 || cursor.first_received_at > i64::MAX as u64
            })
        {
            return Err(invalid("搜索条件过长，请缩短后重试。"));
        }
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            TransactionBehavior::Deferred,
        )?;
        let search = search.trim().to_lowercase();
        // Use immutable session registration time and keyset paging. New activity
        // and removed earlier rows cannot move an unread session behind the cursor.
        // Local corrections stay discoverable when their source is no longer retained.
        let mut query = tx.prepare(
            "WITH candidates AS (
            SELECT session_id FROM observer_events
              WHERE workspace_id=?1 AND expires_at>?2 GROUP BY session_id
            UNION SELECT session_id FROM observer_associations
              WHERE workspace_id=?1 AND path=?5 AND updated_at>?6
          ) SELECT c.session_id,COALESCE(s.first_received_at,0) FROM candidates c
          LEFT JOIN observer_sessions s ON s.id=c.session_id AND s.workspace_id=?1
          LEFT JOIN observer_installations i ON i.id=s.installation_id
          WHERE (?4 IS NULL OR COALESCE(s.first_received_at,0)<?4
            OR (COALESCE(s.first_received_at,0)=?4 AND c.session_id>?7))
            AND (?3='' OR instr(lower(c.session_id),?3)>0
            OR instr(lower(COALESCE(s.native_session_id,'')),?3)>0
            OR instr(lower(COALESCE(s.native_agent_id,'')),?3)>0
            OR instr(lower(COALESCE(i.agent,'')),?3)>0
            OR EXISTS(SELECT 1 FROM observer_events e WHERE e.workspace_id=?1
              AND e.session_id=c.session_id AND e.expires_at>?2
              AND instr(lower(COALESCE(json_extract(e.payload,'$.prompt'),'')),?3)>0))
          ORDER BY COALESCE(s.first_received_at,0) DESC,c.session_id LIMIT 31",
        )?;
        let ids = query
            .query_map(
                params![
                    workspace,
                    now(),
                    search,
                    before.as_ref().map(|c| c.first_received_at),
                    path,
                    cutoff(),
                    before.as_ref().map(|c| c.session_id.as_str())
                ],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let links = ids
            .iter()
            .take(PAGE)
            .map(|(id, _)| link(&tx, workspace, path, id))
            .collect::<Result<Vec<_>>>()?;
        drop(query);
        tx.commit()?;
        Ok(ContextCandidates {
            links,
            next: (ids.len() > PAGE).then(|| ContextCandidateCursor {
                first_received_at: ids[PAGE - 1].1,
                session_id: ids[PAGE - 1].0.clone(),
            }),
        })
    }
    pub fn context_session_events(
        &self,
        workspace: &str,
        session: &str,
        before: Option<ContextEventCursor>,
    ) -> Result<ContextEvents> {
        self.store.recorded_workspace(workspace)?;
        let owner: Option<String> = self
            .store
            .connection
            .query_row(
                "SELECT workspace_id FROM observer_sessions WHERE id=?",
                [session],
                |r| r.get(0),
            )
            .optional()?;
        if owner.as_deref().is_some_and(|owner| owner != workspace) {
            return Err(invalid("此会话不属于当前 Worktree。"));
        }
        if owner.is_none() {
            return Ok(ContextEvents {
                events: vec![],
                expiry: Default::default(),
                next: None,
                cleared: true,
            });
        }
        let mut query=self.store.connection.prepare("SELECT payload,content_expires_at,expires_at FROM observer_events WHERE workspace_id=?1 AND session_id=?2 AND expires_at>?3 AND (?4 IS NULL OR received_at<?4 OR (received_at=?4 AND id<?5)) ORDER BY received_at DESC,id DESC LIMIT 21")?;
        let rows = query
            .query_map(
                params![
                    workspace,
                    session,
                    now(),
                    before.as_ref().map(|c| c.received_at),
                    before.as_ref().map(|c| c.id.as_str())
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, u64>(1)?,
                        r.get::<_, u64>(2)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = rows.len() > 20;
        let mut events = Vec::new();
        let mut expiry = std::collections::BTreeMap::new();
        for (payload, content_expires_at, expires_at) in rows.into_iter().take(20) {
            let event = retained_event(&payload, content_expires_at)?;
            expiry.insert(
                event.id.clone(),
                ContextEventExpiry {
                    content_expires_at,
                    expires_at,
                },
            );
            events.push(event);
        }
        let next = if has_more {
            events.last().map(|e| ContextEventCursor {
                received_at: e.received_at,
                id: e.id.clone(),
            })
        } else {
            None
        };
        Ok(ContextEvents {
            cleared: events.is_empty() && before.is_none(),
            events,
            expiry,
            next,
        })
    }
    pub fn context_history(
        &self,
        workspace: &str,
        path: &str,
        offset: usize,
    ) -> Result<ContextHistory> {
        self.context_scope(workspace, path, false)?;
        if offset > 100_000 {
            return Err(invalid("历史位置超出范围。"));
        }
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            TransactionBehavior::Deferred,
        )?;
        let sql=format!("SELECT id,session_id,payload,created_at FROM observer_association_history WHERE workspace_id=? AND path=? AND created_at>? ORDER BY {HISTORY_ORDER} DESC,created_at DESC,id DESC LIMIT 31 OFFSET ?");
        let mut query = tx.prepare(&sql)?;
        let rows = query
            .query_map(params![workspace, path, cutoff(), offset], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, u64>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = rows.len() > PAGE;
        let mut entries = Vec::new();
        for (id, session, payload, at) in rows.into_iter().take(PAGE) {
            entries.push(history_entry(
                &tx,
                workspace,
                path,
                id,
                session,
                serde_json::from_str(&payload)?,
                at,
            )?);
        }
        drop(query);
        tx.commit()?;
        Ok(ContextHistory {
            entries,
            next_offset: has_more.then_some(offset + PAGE),
        })
    }
    pub fn update_context_association(
        &self,
        workspace: &str,
        path: &str,
        session: &str,
        action: ContextAction,
        note: &str,
        expected_revision: &str,
    ) -> Result<ContextMutation> {
        self.context_scope(workspace, path, true)?;
        if action == ContextAction::Undo {
            return Err(invalid("请选择要撤销的修改记录。"));
        }
        if note.chars().count() > 2000 || note.len() > 8192 || note.contains('\0') {
            return Err(invalid("备注最多 2000 字，且不能包含空字符。"));
        }
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            TransactionBehavior::Immediate,
        )?;
        self.store.recorded_workspace(workspace)?;
        if revision(&tx, workspace, path, session)? != expected_revision {
            return Err(changed());
        }
        let before = state(&tx, workspace, path, session)?;
        let owner: Option<String> = tx
            .query_row(
                "SELECT workspace_id FROM observer_sessions WHERE id=?",
                [session],
                |r| r.get(0),
            )
            .optional()?;
        if owner.as_deref().is_some_and(|owner| owner != workspace) {
            return Err(invalid("此会话不属于当前 Worktree。"));
        }
        let live:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM observer_events WHERE workspace_id=? AND session_id=? AND expires_at>?)",params![workspace,session,now()],|r|r.get(0))?;
        if !live
            && (before.is_none()
                || action == ContextAction::Link && !before.as_ref().is_some_and(|s| s.enabled))
        {
            return Err(Error::new(
                "CONTEXT_SESSION_EXPIRED",
                "会话记录已清理，请重新选择。",
                "No retained session in this workspace",
            ));
        }
        let after = match action {
            ContextAction::Link => Some(AssociationOverride {
                enabled: true,
                note: note.into(),
            }),
            ContextAction::Exclude => Some(AssociationOverride {
                enabled: false,
                note: note.into(),
            }),
            ContextAction::Automatic => None,
            ContextAction::Undo => unreachable!(),
        };
        if before == after {
            return Ok(ContextMutation {
                change: None,
                revision: expected_revision.into(),
            });
        }
        let original = evidence(&tx, workspace, path, session)?;
        let result = write_change(
            &tx,
            workspace,
            path,
            session,
            ChangeDraft {
                action,
                before,
                after,
                original_evidence: original,
                undo_of: None,
            },
        )?;
        tx.commit()?;
        Ok(result)
    }
    pub fn undo_context_association(
        &self,
        workspace: &str,
        path: &str,
        change_id: &str,
        expected_revision: &str,
    ) -> Result<ContextMutation> {
        self.context_scope(workspace, path, true)?;
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            TransactionBehavior::Immediate,
        )?;
        let row:Option<(String,String)>=tx.query_row("SELECT session_id,payload FROM observer_association_history WHERE workspace_id=? AND path=? AND id=? AND created_at>?",params![workspace,path,change_id,cutoff()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let (session, payload) = row.ok_or_else(|| invalid("修改记录已清理，请重新读取。"))?;
        let old: ChangePayload = serde_json::from_str(&payload)?;
        if old.schema_version != 1
            || revision(&tx, workspace, path, &session)? != expected_revision
            || latest(&tx, workspace, path, Some(&session))?.is_none_or(|(id, _)| id != change_id)
            || state(&tx, workspace, path, &session)? != old.after
        {
            return Err(changed());
        }
        let original = evidence(&tx, workspace, path, &session)?;
        let result = write_change(
            &tx,
            workspace,
            path,
            &session,
            ChangeDraft {
                action: ContextAction::Undo,
                before: old.after,
                after: old.before,
                original_evidence: original,
                undo_of: Some(change_id.into()),
            },
        )?;
        tx.commit()?;
        Ok(result)
    }
}
pub(crate) fn retained_event(payload: &str, content_expires_at: u64) -> Result<ObserverEvent> {
    let mut event: ObserverEvent = serde_json::from_str(payload)?;
    if content_expires_at <= now() && event.output.is_some() {
        event.output = None;
        event.field_status.insert("output".into(), "expired".into());
    }
    Ok(event)
}
fn history_entry(
    db: &Connection,
    workspace: &str,
    path: &str,
    id: String,
    session: String,
    payload: ChangePayload,
    at: u64,
) -> Result<ContextChange> {
    let can_undo = payload.schema_version == 1
        && latest(db, workspace, path, Some(&session))?.is_some_and(|(head, _)| head == id)
        && state(db, workspace, path, &session)? == payload.after;
    Ok(ContextChange {
        id,
        session_id: session.clone(),
        created_at: at,
        action: payload.action,
        before: payload.before,
        after: payload.after,
        original_evidence: payload.original_evidence,
        undo_of: payload.undo_of,
        source: payload.source,
        can_undo,
        revision: revision(db, workspace, path, &session)?,
    })
}
struct ChangeDraft {
    action: ContextAction,
    before: Option<AssociationOverride>,
    after: Option<AssociationOverride>,
    original_evidence: AssociationEvidence,
    undo_of: Option<String>,
}
fn write_change(
    db: &Connection,
    workspace: &str,
    path: &str,
    session: &str,
    draft: ChangeDraft,
) -> Result<ContextMutation> {
    let sequence = latest(db, workspace, path, None)?.map_or(Ok(1), |(_, p)| {
        p.sequence
            .checked_add(1)
            .filter(|s| *s <= i64::MAX as u64)
            .ok_or_else(|| invalid("关联历史已超过计数范围。"))
    })?;
    let at = now();
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(value) = &draft.after {
        db.execute("INSERT INTO observer_associations VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,path,session_id) DO UPDATE SET enabled=excluded.enabled,note=excluded.note,updated_at=excluded.updated_at",params![workspace,path,session,value.enabled,value.note,at])?;
    } else {
        db.execute(
            "DELETE FROM observer_associations WHERE workspace_id=? AND path=? AND session_id=?",
            params![workspace, path, session],
        )?;
    }
    let payload = ChangePayload {
        schema_version: 1,
        sequence,
        source: CorrectionSource::User,
        action: draft.action,
        before: draft.before,
        after: draft.after,
        original_evidence: draft.original_evidence,
        undo_of: draft.undo_of,
    };
    db.execute(
        "INSERT INTO observer_association_history VALUES(?,?,?,?,?,?)",
        params![
            id,
            workspace,
            path,
            session,
            serde_json::to_string(&payload)?,
            at
        ],
    )?;
    let change = history_entry(db, workspace, path, id, session.into(), payload, at)?;
    Ok(ContextMutation {
        revision: change.revision.clone(),
        change: Some(change),
    })
}
