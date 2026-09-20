use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub repository_id: String,
    pub name: String,
    pub path: String,
    pub git_dir: String,
    pub common_dir: String,
    pub trusted: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Unstaged,
    Staged,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Text,
    Binary,
    Symlink,
    Submodule,
    Conflict,
    Rename,
    Metadata,
}
impl std::fmt::Display for FileKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Text => "text",
            Self::Binary => "binary",
            Self::Symlink => "symlink",
            Self::Submodule => "submodule",
            Self::Conflict => "conflict",
            Self::Rename => "rename",
            Self::Metadata => "metadata",
        })
    }
}
impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Staged => "staged",
            Self::Unstaged => "unstaged",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub side: Side,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub workspace: Workspace,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub operation: Option<String>,
    pub token: String,
    pub file_versions: std::collections::HashMap<String, String>,
    pub captured_at: u64,
    pub files: Vec<ChangedFile>,
    pub git_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub content: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub id: String,
    pub header: String,
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
    pub review_state: String,
    #[serde(skip)]
    pub patch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub id: String,
    pub workspace_id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub side: Side,
    pub base: String,
    pub captured_at: u64,
    pub token: String,
    pub patch: String,
    pub hunks: Vec<Hunk>,
    pub additions: usize,
    pub deletions: usize,
    pub kind: FileKind,
    pub notice: Option<String>,
    pub can_stage: bool,
    pub can_stage_hunks: bool,
    pub can_discard: bool,
    pub can_discard_hunks: bool,
    pub discard_reason: Option<String>,
    #[serde(skip)]
    pub guard: String,
}

/// Read-only unchanged lines around the original review units. Never a patch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffContext {
    pub snapshot_id: String,
    pub context_lines: u16,
    #[serde(default)]
    pub full_file: bool,
    pub gaps: Vec<ContextGap>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextGap {
    /// None means the tail after the final original Hunk.
    pub before_hunk_id: Option<String>,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub refs: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraphPage {
    pub snapshot_id: String,
    pub workspace_id: String,
    pub scope: String,
    pub commits: Vec<CommitEntry>,
    pub branches: Vec<BranchEntry>,
    pub head: Option<String>,
    pub offset: usize,
    pub has_more: bool,
    pub captured_at: u64,
    pub shallow: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub oid: Option<String>,
    pub original_line: u32,
    pub line: u32,
    pub author: Option<String>,
    pub author_time: Option<i64>,
    pub summary: String,
    pub content: String,
    pub origin_path: String,
    pub uncommitted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBlame {
    pub workspace_id: String,
    pub path: String,
    pub revision: Option<String>,
    pub head: Option<String>,
    pub lines: Vec<BlameLine>,
    pub total_lines: usize,
    pub offset: usize,
    pub has_more: bool,
    pub notice: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchEntry {
    pub name: String,
    pub current: bool,
    pub oid: String,
    pub remote: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPreview {
    pub id: String,
    pub workspace_id: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub files: Vec<ChangedFile>,
    pub reviewed: usize,
    pub total: usize,
    #[serde(default)]
    pub coverage_computed: bool,
    #[serde(default)]
    pub unread_files: Vec<String>,
    pub index_fingerprint: String,
    pub captured_at: u64,
    #[serde(default)]
    pub amend: bool,
    pub message: String,
    #[serde(skip)]
    pub parents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub ok: bool,
    pub message: String,
    pub actual_head: Option<String>,
    pub actual_branch: Option<String>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchStageResult {
    #[serde(flatten)]
    pub result: OperationResult,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPoint {
    pub id: String,
    pub workspace_id: String,
    pub path: String,
    pub scope: String,
    pub status: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub bytes: u64,
    pub message: Option<String>,
    #[serde(default)]
    pub removes_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryAction {
    pub point: RecoveryPoint,
    pub result: OperationResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: String,
    pub font_size: u16,
    pub diff_mode: String,
    pub wrap_lines: bool,
    #[serde(default)]
    pub ignore_whitespace: bool,
    #[serde(default)]
    pub show_whitespace: bool,
    pub context_open: bool,
    pub strict_review: bool,
    pub git_path: String,
    /// Delimiter used to group branch names into a collapsible tree (default "/").
    #[serde(default = "default_branch_delimiter")]
    pub branch_delimiter: String,
}
fn default_branch_delimiter() -> String {
    "/".to_string()
}
/// UI layout belongs to a local repository, including its linked worktrees.
/// It is separate from Git/Agent configuration and from review state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryLayout {
    pub sidebar_width: u16,
    pub context_width: u16,
    pub sidebar_open: bool,
    /// None inherits the application's context-panel default.
    pub context_open: Option<bool>,
}
impl Default for RepositoryLayout {
    fn default() -> Self {
        Self {
            sidebar_width: 320,
            context_width: 300,
            sidebar_open: true,
            context_open: None,
        }
    }
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            font_size: 13,
            diff_mode: "unified".into(),
            wrap_lines: false,
            ignore_whitespace: false,
            show_whitespace: false,
            context_open: true,
            strict_review: false,
            git_path: "git".into(),
            branch_delimiter: default_branch_delimiter(),
        }
    }
}
