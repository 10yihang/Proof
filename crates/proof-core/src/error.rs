use serde::Serialize;

#[derive(Debug, Clone, thiserror::Error, Serialize)]
#[serde(rename_all = "camelCase")]
#[error("{message} ({code})")]
pub struct Error {
    pub code: String,
    pub message: String,
    pub detail: String,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn new(code: &str, message: &str, detail: impl ToString) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: detail.to_string(),
        }
    }
    pub fn stale() -> Self {
        Self::new(
            "STALE_CONTENT",
            "Worktree 已更新，请检查最新 Diff 后重试。",
            "Expected content or comparison base no longer matches",
        )
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new("IO_ERROR", "无法完成文件操作，现有审查内容已保留。", e)
    }
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::new(
            "STORAGE_ERROR",
            "本地记录未能保存，请检查存储空间和权限。",
            e,
        )
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::new("DATA_ERROR", "本地数据格式无法读取。", e)
    }
}
