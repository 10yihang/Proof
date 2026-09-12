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
    #[serde(skip)]
    pub guard: String,
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
    pub index_fingerprint: String,
    pub captured_at: u64,
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
pub struct Preferences {
    pub theme: String,
    pub font_size: u16,
    pub diff_mode: String,
    pub wrap_lines: bool,
    pub context_open: bool,
    pub strict_review: bool,
    pub git_path: String,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            font_size: 13,
            diff_mode: "unified".into(),
            wrap_lines: false,
            context_open: true,
            strict_review: false,
            git_path: "git".into(),
        }
    }
}
