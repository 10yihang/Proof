//! 「文件」页的内置文本编辑器读写通道。
//!
//! - `list_files`：仓库内全部 tracked + 未忽略的 untracked 文件；
//! - `read_text_file`：读取 worktree 当前内容或指定提交的历史版本（只读），
//!   仅 UTF-8 文本、32 MiB 以内；4 MiB 以内才可编辑；
//! - `save_text_file`：带指纹乐观锁的原子写入（与 Discard 同一套 BoundFile
//!   防护：fd 绑定防符号链接、备份、RENAME_EXCL 安装、读后校验）。
use crate::{
    fingerprint,
    git::{self, Git},
    guarded_file::{BoundFile, FileImage},
    model::*,
    service::IndexLock,
    Error, Proof, Result,
};
use std::{collections::BTreeSet, fs, path::Path};

/// 超过 4 MiB 的文件只读展示，不提供编辑保存。
const EDIT_LIMIT: u64 = 4 * 1024 * 1024;

impl Proof {
    /// 列出仓库内全部文件（tracked + 未忽略的 untracked），按路径排序。
    pub fn list_files(&self, workspace_id: &str) -> Result<Vec<String>> {
        let workspace = self.store.workspace(workspace_id)?;
        let git = self.git()?;
        let mut files = BTreeSet::new();
        for args in [
            vec!["ls-files", "-z"],
            vec!["ls-files", "-z", "--others", "--exclude-standard"],
        ] {
            for entry in git.query(&workspace, &args)?.split(|b| *b == 0) {
                if entry.is_empty() {
                    continue;
                }
                files.insert(git::text(entry.to_vec())?);
            }
        }
        Ok(files.into_iter().collect())
    }

    /// 读取文本文件全文；`revision` 为提交 oid 时读取该历史版本（只读）。
    pub fn read_text_file(
        &self,
        workspace_id: &str,
        path: &str,
        revision: Option<&str>,
    ) -> Result<TextFileContent> {
        let workspace = self.store.workspace(workspace_id)?;
        git::checked_path(&workspace, path)?;
        let git = self.git()?;
        let revision = revision
            .map(|oid| verified_commit(&git, &workspace, oid))
            .transpose()?;
        let bytes = if let Some(revision) = &revision {
            git.query(
                &workspace,
                &["cat-file", "blob", &format!("{revision}:{path}")],
            )?
        } else {
            let file = BoundFile::open(Path::new(&workspace.path), path)?;
            match file.read() {
                Ok(Some(image)) => image.bytes,
                Ok(None) => {
                    return Err(Error::new(
                        "FILE_MISSING",
                        "文件不存在或已被移出工作区。",
                        path,
                    ))
                }
                Err(error) if error.code == "UNSUPPORTED_RECOVERY_ENCODING" => {
                    return Err(Error::new(
                        "BINARY_FILE",
                        "二进制文件不提供文本查看与编辑。",
                        path,
                    ))
                }
                Err(error) if error.code == "UNSUPPORTED_RECOVERY_FILE" => {
                    return Err(Error::new(
                        "FILE_TOO_LARGE",
                        "仅支持 32 MiB 以内、没有硬链接的普通文件。",
                        path,
                    ))
                }
                Err(error) => return Err(error),
            }
        };
        if bytes.contains(&0) {
            return Err(Error::new(
                "BINARY_FILE",
                "二进制文件不提供文本查看与编辑。",
                path,
            ));
        }
        let content = String::from_utf8(bytes).map_err(|_| {
            Error::new("UNSUPPORTED_ENCODING", "文件不是有效的 UTF-8 文本。", path)
        })?;
        let size = content.len() as u64;
        let editable = revision.is_none() && size <= EDIT_LIMIT;
        let fingerprint = fingerprint(&[content.as_bytes()]);
        Ok(TextFileContent {
            workspace_id: workspace_id.into(),
            path: path.into(),
            revision,
            eol: if content.contains("\r\n") {
                "crlf".into()
            } else {
                "lf".into()
            },
            editable,
            size,
            fingerprint,
            content,
        })
    }

    /// 原子写入 worktree 文件。`expected_fingerprint` 与磁盘当前内容不符时
    /// 拒绝（STALE_CONTENT），传 None 表示调用方已确认强制覆盖。
    pub fn save_text_file(
        &self,
        workspace_id: &str,
        path: &str,
        content: &str,
        expected_fingerprint: Option<&str>,
    ) -> Result<TextFileState> {
        let workspace = self.store.workspace(workspace_id)?;
        self.require_write(&workspace)?;
        git::checked_path(&workspace, path)?;
        if content.len() as u64 > EDIT_LIMIT {
            return Err(Error::new(
                "FILE_TOO_LARGE",
                "仅支持保存 4 MiB 以内的文本文件。",
                path,
            ));
        }
        let _lock = IndexLock::acquire(Path::new(&workspace.git_dir))?;
        let file = BoundFile::open(Path::new(&workspace.path), path)?;
        let before = file.read()?;
        if let Some(expected) = expected_fingerprint {
            let current = before
                .as_ref()
                .map(|image| fingerprint(&[&image.bytes]))
                .unwrap_or_default();
            if current != expected {
                return Err(Error::stale());
            }
        }
        let bytes = content.as_bytes().to_vec();
        let desired = FileImage {
            mode: before.as_ref().map_or(0o644, |image| image.mode),
            identity: String::new(),
            bytes,
        };
        // 备份与候选文件放在 git_dir 内，保证与工作区同卷（原子 rename 前提）。
        let staging = Path::new(&workspace.git_dir)
            .join("proof-save")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&staging)?;
        let backup = staging.join("backup");
        let candidate = staging.join("candidate");
        file.check_volume(&staging)?;
        let result = file
            .replace(&before, &Some(desired), &backup, &candidate, None)
            .inspect_err(|_| {
                let _ = fs::remove_dir_all(&staging);
            });
        fs::remove_dir_all(&staging).ok();
        // 父目录仅在本次保存独占时为空，remove_dir 对非空目录静默失败。
        fs::remove_dir(staging.parent().unwrap()).ok();
        result?;
        Ok(TextFileState {
            path: path.into(),
            size: content.len() as u64,
            fingerprint: fingerprint(&[content.as_bytes()]),
        })
    }

    /// 新建空文件（路径可含未存在的目录，一并创建）。已存在则拒绝。
    pub fn create_text_file(&self, workspace_id: &str, path: &str) -> Result<()> {
        let workspace = self.store.workspace(workspace_id)?;
        self.require_write(&workspace)?;
        let full = git::checked_path(&workspace, path)?;
        if full.exists() {
            return Err(Error::new("FILE_EXISTS", "同名文件或目录已存在。", path));
        }
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)?;
        }
        // create_new 保证竞态下也不覆盖既有文件（含符号链接）。
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&full)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    Error::new("FILE_EXISTS", "同名文件或目录已存在。", path)
                } else {
                    Error::from(error)
                }
            })?;
        Ok(())
    }

    /// 重命名/移动文件（仅文件；目标已存在则拒绝）。
    pub fn rename_text_file(&self, workspace_id: &str, from: &str, to: &str) -> Result<()> {
        let workspace = self.store.workspace(workspace_id)?;
        self.require_write(&workspace)?;
        let source = git::checked_path(&workspace, from)?;
        let target = git::checked_path(&workspace, to)?;
        if !source.is_file() {
            return Err(Error::new("FILE_MISSING", "文件不存在或已被移出工作区。", from));
        }
        if target.exists() {
            return Err(Error::new("FILE_EXISTS", "同名文件或目录已存在。", to));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&source, &target)?;
        Ok(())
    }
}

/// 校验并解析提交 oid（4–64 位 hex，且必须指向一个 commit）。
pub(crate) fn verified_commit(git: &Git, workspace: &Workspace, oid: &str) -> Result<String> {
    if !(4..=64).contains(&oid.len()) || !oid.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::new(
            "INVALID_REVISION",
            "请选择有效的提交。",
            "Expected Git object ID",
        ));
    }
    Ok(git::text(git.query(
        workspace,
        &["rev-parse", "--verify", &format!("{oid}^{{commit}}")],
    )?)?
    .trim()
    .to_string())
}
