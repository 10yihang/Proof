use super::{AiReport, AiScope, AiTask, PreparedAiTask};
use crate::{Error, Proof, Result};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

/// A human decision about a suggestion, never a Reviewed mark or a code edit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindingDecision {
    Pending,
    Accepted,
    Dismissed,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReviewRecord {
    pub id: String,
    pub captured_at: u64,
    pub provider: super::AgentKind,
    pub summary: String,
}
fn scope_key(scope: &AiScope) -> String {
    match scope {
        AiScope::Local { .. } => "local".into(),
        AiScope::Comparison { base, target, .. } => format!("comparison:{base}:{target}"),
    }
}
impl PreparedAiTask {
    /// Called under the owning Core lock after run. Only verified backend
    /// results enter storage; no IPC accepts a renderer-authored report.
    pub fn finish(&self, proof: &Proof, report: AiReport) -> Result<AiReport> {
        self.cancellation.run(|| {
            let tx = Transaction::new_unchecked(&proof.store.connection, TransactionBehavior::Immediate)?;
            proof.check_data_epoch(self.data_epoch)?;
            if !proof.store.workspace(self.request.scope.workspace_id())?.trusted {
                return Err(Error::new("TRUST_REQUIRED", "仓库信任已撤销，未保存分析结果。", "AI report completion requires trust"));
            }
            if report.task == AiTask::Review {
                tx.execute("INSERT INTO ai_review_reports(id,workspace_id,scope_key,captured_at,revision,value) VALUES(?1,?2,?3,?4,?5,?6)", params![report.id,report.scope.workspace_id(),scope_key(&report.scope),report.captured_at,report.revision,serde_json::to_string(&report)?])?;
            }
            tx.commit()?;
            Ok(report)
        })
    }
}
impl Proof {
    /// Lightweight report history. Full text is loaded only for the chosen report.
    pub fn ai_review_reports(&self, workspace: &str, scope: &str) -> Result<Vec<AiReviewRecord>> {
        self.store.workspace(workspace)?;
        let mut query = self.store.connection.prepare("SELECT id,captured_at,json_extract(value,'$.provider'),substr(json_extract(value,'$.review.summary'),1,160) FROM ai_review_reports WHERE workspace_id=? AND scope_key=? ORDER BY captured_at DESC,rowid DESC")?;
        let rows = query.query_map([workspace, scope], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        rows.map(|row| {
            let (id, captured_at, provider, summary) = row?;
            Ok(AiReviewRecord {
                id,
                captured_at,
                provider: serde_json::from_value(serde_json::Value::String(provider))?,
                summary,
            })
        })
        .collect()
    }
    pub fn ai_review_report(&self, workspace: &str, id: &str) -> Result<AiReport> {
        self.store.workspace(workspace)?;
        let raw: Option<String> = self
            .store
            .connection
            .query_row(
                "SELECT value FROM ai_review_reports WHERE workspace_id=? AND id=?",
                [workspace, id],
                |row| row.get(0),
            )
            .optional()?;
        serde_json::from_str(&raw.ok_or_else(|| {
            Error::new(
                "AI_REPORT_NOT_FOUND",
                "此 Review 记录已删除或过期。",
                "Unknown report in workspace",
            )
        })?)
        .map_err(Into::into)
    }
    pub fn set_ai_finding_decision(
        &self,
        workspace: &str,
        id: &str,
        revision: u64,
        index: usize,
        decision: FindingDecision,
    ) -> Result<AiReport> {
        let tx =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        let mut report = self.ai_review_report(workspace, id)?;
        if report.revision != revision {
            return Err(Error::new(
                "AI_REVIEW_CHANGED",
                "此 Review 已在其他窗口更新，请重新操作。",
                "Review revision mismatch",
            ));
        }
        let status = report.decisions.get_mut(index).ok_or_else(|| {
            Error::new(
                "AI_FINDING_NOT_FOUND",
                "此 Finding 不存在。",
                "Unknown finding index",
            )
        })?;
        *status = decision;
        report.revision = revision
            .checked_add(1)
            .ok_or_else(|| super::invalid("Report revision overflow"))?;
        tx.execute(
            "UPDATE ai_review_reports SET revision=?,value=? WHERE workspace_id=? AND id=?",
            params![
                report.revision,
                serde_json::to_string(&report)?,
                workspace,
                id
            ],
        )?;
        tx.commit()?;
        Ok(report)
    }
}
