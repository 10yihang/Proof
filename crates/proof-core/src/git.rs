use crate::{
    error::{Error, Result},
    fingerprint,
    model::*,
    now,
    process::{self, Output},
};
use std::{
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

pub(crate) struct Git {
    pub executable: String,
}
impl Git {
    pub fn raw(&self, path: &Path, args: &[&str]) -> Result<Output> {
        let mut cmd = process::git_command(&self.executable, path);
        cmd.args(args);
        process::run(cmd, None, Duration::from_secs(20))
    }
    pub fn discover(&self, path: &str) -> Result<(Workspace, String, String)> {
        let requested = fs::canonicalize(path)
            .map_err(|e| Error::new("PATH_UNAVAILABLE", "仓库路径不存在或无法访问。", e))?;
        let root = text(process::checked(
            self.raw(&requested, &["rev-parse", "--show-toplevel"])?,
        )?)?;
        let root = fs::canonicalize(root.trim_end_matches('\n'))?;
        let git_dir = text(process::checked(
            self.raw(&root, &["rev-parse", "--absolute-git-dir"])?,
        )?)?;
        let common = text(process::checked(self.raw(
            &root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?)?)?;
        let git_dir = fs::canonicalize(git_dir.trim_end_matches('\n'))?;
        let common = fs::canonicalize(common.trim_end_matches('\n'))?;
        let repo_identity = directory_identity(&common)?;
        let identity = directory_identity(&git_dir)?;
        Ok((
            Workspace {
                id: uuid::Uuid::new_v4().to_string(),
                repository_id: String::new(),
                name: root
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: path_text(&root)?,
                git_dir: path_text(&git_dir)?,
                common_dir: path_text(&common)?,
                trusted: false,
            },
            repo_identity,
            identity,
        ))
    }

    pub fn command(&self, workspace: &Workspace) -> Result<std::process::Command> {
        let root = Path::new(&workspace.path);
        let mut cmd = process::git_command(&self.executable, root);
        if !workspace.trusted {
            // Diff may invoke clean filters even without --ext-diff. Enumerate
            // only key names, then disable executable filters in restricted mode.
            let filters = self.raw(
                root,
                &[
                    "config",
                    "--null",
                    "--name-only",
                    "--get-regexp",
                    r"^filter\..*\.(clean|smudge|process|required)$",
                ],
            )?;
            if filters.code != 0 && filters.code != 1 {
                process::checked(filters)?;
            } else {
                for key in filters.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()) {
                    let key = std::str::from_utf8(key).map_err(|e| {
                        Error::new("CONFIG_ENCODING", "Git 过滤器配置无法安全读取。", e)
                    })?;
                    cmd.arg("-c").arg(format!(
                        "{}={}",
                        key,
                        if key.ends_with(".required") {
                            "false"
                        } else {
                            ""
                        }
                    ));
                }
            }
        }
        Ok(cmd)
    }
    pub fn query(&self, workspace: &Workspace, args: &[&str]) -> Result<Vec<u8>> {
        let mut cmd = self.command(workspace)?;
        cmd.args(args);
        process::checked(process::run(cmd, None, Duration::from_secs(20))?)
    }
    pub fn head(&self, workspace: &Workspace) -> Result<Option<String>> {
        let result = self.raw(
            Path::new(&workspace.path),
            &["rev-parse", "--verify", "--quiet", "HEAD"],
        )?;
        match result.code {
            0 => Ok(Some(text(result.stdout)?.trim().into())),
            1 => Ok(None),
            _ => {
                process::checked(result)?;
                unreachable!()
            }
        }
    }
    pub fn branch(&self, workspace: &Workspace) -> Result<Option<String>> {
        let result = self.raw(
            Path::new(&workspace.path),
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
        )?;
        match result.code {
            0 => Ok(Some(text(result.stdout)?.trim_end_matches('\n').into())),
            1 => Ok(None),
            _ => {
                process::checked(result)?;
                unreachable!()
            }
        }
    }
    pub fn index_bytes(&self, workspace: &Workspace) -> Result<Vec<u8>> {
        match fs::read(Path::new(&workspace.git_dir).join("index")) {
            Ok(bytes) => Ok(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }
    pub fn state(&self, workspace: &Workspace) -> Option<String> {
        for (marker, name) in [
            ("rebase-merge", "Rebase"),
            ("rebase-apply", "Rebase"),
            ("MERGE_HEAD", "Merge"),
            ("CHERRY_PICK_HEAD", "Cherry-pick"),
            ("REVERT_HEAD", "Revert"),
            ("BISECT_LOG", "Bisect"),
        ] {
            if Path::new(&workspace.git_dir).join(marker).exists() {
                return Some(name.into());
            }
        }
        None
    }
    pub fn changes(&self, workspace: &Workspace) -> Result<Changes> {
        let head = self.head(workspace)?;
        let branch = self.branch(workspace)?;
        let index = self.index_bytes(workspace)?;
        let status = self.query(
            workspace,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )?;
        let files = parse_status(&status)?;
        let mut stamps = Vec::new();
        for file in &files {
            let full = checked_path(workspace, &file.path)?;
            if let Ok(metadata) = fs::symlink_metadata(&full) {
                stamps.extend_from_slice(
                    format!(
                        "{:?}:{}:{:?}",
                        file.path,
                        metadata.len(),
                        metadata.modified().ok()
                    )
                    .as_bytes(),
                );
            }
        }
        let token = fingerprint(&[
            head.as_deref().unwrap_or("").as_bytes(),
            branch.as_deref().unwrap_or("").as_bytes(),
            &index,
            &status,
            &stamps,
        ]);
        let version = text(process::checked(
            self.raw(Path::new(&workspace.path), &["--version"])?,
        )?)?;
        Ok(Changes {
            workspace: workspace.clone(),
            head,
            branch,
            operation: self.state(workspace),
            token,
            captured_at: now(),
            files,
            git_version: version.trim().into(),
        })
    }
    pub fn guard(
        &self,
        workspace: &Workspace,
        path: &str,
        old_path: Option<&str>,
    ) -> Result<String> {
        let (_, repository_identity, workspace_identity) = self.discover(&workspace.path)?;
        let head = self.head(workspace)?.unwrap_or_default();
        let branch = self.branch(workspace)?.unwrap_or_default();
        let index = self.index_bytes(workspace)?;
        let content = worktree_bytes(workspace, path)?;
        let old = old_path
            .map(|p| worktree_bytes(workspace, p))
            .transpose()?
            .unwrap_or_default();
        Ok(fingerprint(&[
            workspace.id.as_bytes(),
            repository_identity.as_bytes(),
            workspace_identity.as_bytes(),
            head.as_bytes(),
            branch.as_bytes(),
            &index,
            &content,
            &old,
        ]))
    }

    pub fn context_guard(&self, workspace: &Workspace) -> Result<String> {
        let (_, repository_identity, workspace_identity) = self.discover(&workspace.path)?;
        Ok(fingerprint(&[
            workspace.id.as_bytes(),
            repository_identity.as_bytes(),
            workspace_identity.as_bytes(),
            self.head(workspace)?.unwrap_or_default().as_bytes(),
            self.branch(workspace)?.unwrap_or_default().as_bytes(),
            &self.index_bytes(workspace)?,
        ]))
    }

    // Compatibility for recovery payload format 0. Callers first validate the
    // registered physical repository identity before accepting this older hash.
    pub fn legacy_recovery_context(&self, workspace: &Workspace) -> Result<String> {
        Ok(fingerprint(&[
            workspace.id.as_bytes(),
            self.head(workspace)?.unwrap_or_default().as_bytes(),
            self.branch(workspace)?.unwrap_or_default().as_bytes(),
            &self.index_bytes(workspace)?,
        ]))
    }
    pub fn legacy_recovery_guard(&self, workspace: &Workspace, path: &str) -> Result<String> {
        Ok(fingerprint(&[
            workspace.id.as_bytes(),
            self.head(workspace)?.unwrap_or_default().as_bytes(),
            self.branch(workspace)?.unwrap_or_default().as_bytes(),
            &self.index_bytes(workspace)?,
            &worktree_bytes(workspace, path)?,
            &[],
        ]))
    }

    pub fn index_worktree_content(&self, workspace: &Workspace, path: &str) -> Result<Vec<u8>> {
        checked_path(workspace, path)?;
        self.query(workspace, &["cat-file", "--filters", &format!(":{path}")])
    }
    pub fn patch(&self, workspace: &Workspace, file: &ChangedFile) -> Result<String> {
        self.patch_with_context(workspace, file, 3)
    }
    pub(crate) fn patch_with_context(
        &self,
        workspace: &Workspace,
        file: &ChangedFile,
        context: u16,
    ) -> Result<String> {
        checked_path(workspace, &file.path)?;
        let unified = format!("--unified={context}");
        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--binary",
            "--full-index",
            &unified,
            "--src-prefix=a/",
            "--dst-prefix=b/",
        ];
        if file.status == "?" {
            let full = checked_path(workspace, &file.path)?;
            if fs::symlink_metadata(&full)?.file_type().is_symlink() {
                return Ok("Untracked symbolic link; its target is not read.\n".into());
            }
            args.extend(["--no-index", "--", "/dev/null", &file.path]);
            let mut cmd = self.command(workspace)?;
            cmd.args(args);
            let result = process::run(cmd, None, Duration::from_secs(20))?;
            if result.code != 0 && result.code != 1 {
                return text(process::checked(result)?);
            }
            return text(result.stdout);
        }
        if file.side == Side::Staged {
            args.push("--cached");
        }
        args.push("--");
        args.push(&file.path);
        if let Some(old) = &file.old_path {
            checked_path(workspace, old)?;
            args.push(old);
        }
        text(self.query(workspace, &args)?)
    }
    pub fn apply(
        &self,
        workspace: &Workspace,
        patch: &str,
        reverse: bool,
        private_index: &Path,
    ) -> Result<()> {
        let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
        if reverse {
            args.push("--reverse");
        }
        let mut check = self.command(workspace)?;
        index_override(&mut check, private_index);
        check.args(&args).arg("--check");
        process::checked(process::run(
            check,
            Some(patch.as_bytes()),
            Duration::from_secs(20),
        )?)?;
        let mut apply = self.command(workspace)?;
        index_override(&mut apply, private_index);
        apply.args(&args);
        process::checked(process::run(
            apply,
            Some(patch.as_bytes()),
            Duration::from_secs(20),
        )?)?;
        Ok(())
    }
    pub fn history(
        &self,
        workspace: &Workspace,
        offset: usize,
        path: Option<&str>,
    ) -> Result<Vec<CommitEntry>> {
        if self.head(workspace)?.is_none() {
            return Ok(Vec::new());
        }
        let skip = format!("--skip={}", offset.min(1_000_000));
        let mut args = vec![
            "log",
            "--no-show-signature",
            "-z",
            "--max-count=50",
            &skip,
            "--date=iso-strict",
            "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D",
        ];
        if let Some(path) = path {
            checked_path(workspace, path)?;
            args.extend(["--follow", "--", path]);
        }
        let result = self.query(workspace, &args)?;
        let fields: Vec<&[u8]> = result.split(|b| *b == 0).collect();
        let mut commits = Vec::new();
        for row in fields.chunks(6) {
            if row.len() < 6 {
                break;
            }
            let row = row
                .iter()
                .map(|s| text(s.to_vec()))
                .collect::<Result<Vec<_>>>()?;
            commits.push(CommitEntry {
                oid: row[0].clone(),
                parents: row[1].split_whitespace().map(String::from).collect(),
                author: row[2].clone(),
                date: row[3].clone(),
                subject: row[4].clone(),
                refs: row[5].clone(),
                boundary: None,
            });
        }
        Ok(commits)
    }
    pub fn branches(&self, workspace: &Workspace) -> Result<Vec<BranchEntry>> {
        let bytes = self.query(
            workspace,
            &[
                "for-each-ref",
                "--format=%(refname)%00%(HEAD)%00%(objectname)",
                "refs/heads",
                "refs/remotes",
            ],
        )?;
        text(bytes)?
            .lines()
            .map(|line| {
                let row: Vec<&str> = line.split('\0').collect();
                if row.len() != 3 {
                    return Err(Error::new(
                        "GIT_PARSE",
                        "分支数据无法读取。",
                        "Invalid ref record",
                    ));
                }
                let remote = row[0].starts_with("refs/remotes/");
                Ok(BranchEntry {
                    name: row[0]
                        .trim_start_matches(if remote {
                            "refs/remotes/"
                        } else {
                            "refs/heads/"
                        })
                        .into(),
                    current: row[1] == "*",
                    oid: row[2].into(),
                    remote,
                })
            })
            .collect()
    }
    pub fn worktrees(&self, workspace: &Workspace) -> Result<Vec<WorktreeEntry>> {
        let bytes = self.query(workspace, &["worktree", "list", "--porcelain", "-z"])?;
        let mut result = Vec::new();
        let mut current: Option<WorktreeEntry> = None;
        for field in bytes.split(|b| *b == 0) {
            let field = text(field.to_vec())?;
            if let Some(path) = field.strip_prefix("worktree ") {
                if let Some(previous) = current.take() {
                    result.push(previous);
                }
                current = Some(WorktreeEntry {
                    path: path.into(),
                    branch: None,
                    head: String::new(),
                    locked: false,
                });
            } else if let Some(tree) = &mut current {
                if let Some(head) = field.strip_prefix("HEAD ") {
                    tree.head = head.into();
                }
                if let Some(branch) = field.strip_prefix("branch refs/heads/") {
                    tree.branch = Some(branch.into());
                }
                if field.starts_with("locked") {
                    tree.locked = true;
                }
            }
        }
        if let Some(tree) = current {
            result.push(tree);
        }
        Ok(result)
    }
}

pub(crate) fn parse_status(bytes: &[u8]) -> Result<Vec<ChangedFile>> {
    let mut records = bytes.split(|b| *b == 0);
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            return Err(Error::new(
                "GIT_PARSE",
                "Git 状态数据无法解析。",
                "Invalid porcelain record",
            ));
        }
        let path = text(record[3..].to_vec())?;
        let (x, y) = (record[0] as char, record[1] as char);
        let old_path = if [x, y].iter().any(|c| *c == 'R' || *c == 'C') {
            Some(text(
                records
                    .next()
                    .ok_or_else(|| {
                        Error::new("GIT_PARSE", "重命名信息不完整。", "Missing rename source")
                    })?
                    .to_vec(),
            )?)
        } else {
            None
        };
        let conflicted = x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D');
        if conflicted {
            files.push(ChangedFile {
                path,
                old_path,
                status: "U".into(),
                side: Side::Unstaged,
                conflicted,
            });
            continue;
        }
        if x != ' ' && x != '?' && x != '!' {
            files.push(ChangedFile {
                path: path.clone(),
                old_path: old_path.clone(),
                status: x.to_string(),
                side: Side::Staged,
                conflicted: false,
            });
        }
        if y != ' ' && y != '!' {
            files.push(ChangedFile {
                path,
                old_path,
                status: if x == '?' { "?".into() } else { y.to_string() },
                side: Side::Unstaged,
                conflicted: false,
            });
        }
    }
    Ok(files)
}

pub(crate) fn checked_path(workspace: &Workspace, path: &str) -> Result<PathBuf> {
    let relative = Path::new(path);
    if path.is_empty()
        || path.contains('\0')
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(Error::new(
            "INVALID_PATH",
            "文件路径超出当前工作区。",
            "Only repository-relative literal paths are accepted",
        ));
    }
    let root = Path::new(&workspace.path);
    let full = root.join(relative);
    // Missing/deleted parents are permitted; any existing parent must resolve inside root.
    let mut parent = full.parent();
    while let Some(dir) = parent {
        if dir.exists() {
            if !fs::canonicalize(dir)?.starts_with(root) {
                return Err(Error::new(
                    "PATH_ESCAPE",
                    "文件路径经过工作区外的符号链接。",
                    path,
                ));
            }
            break;
        }
        parent = dir.parent();
    }
    Ok(full)
}
pub(crate) fn worktree_bytes(workspace: &Workspace, path: &str) -> Result<Vec<u8>> {
    let full = checked_path(workspace, path)?;
    let metadata = match fs::symlink_metadata(&full) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(b"missing".to_vec()),
        Err(e) => return Err(e.into()),
    };
    if metadata.file_type().is_symlink() {
        return Ok(format!("symlink:{:?}", fs::read_link(full)?).into_bytes());
    }
    if metadata.is_dir() {
        return Ok(b"directory".to_vec());
    }
    if metadata.len() > 32 * 1024 * 1024 {
        return Err(Error::new(
            "FILE_TOO_LARGE",
            "文件超过 32 MiB，请在外部编辑器查看。",
            path,
        ));
    }
    let mut bytes = format!("{:?}:", metadata.permissions()).into_bytes();
    bytes.extend(fs::read(full)?);
    Ok(bytes)
}
fn directory_identity(path: &Path) -> Result<String> {
    let meta = fs::metadata(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}:{}:{}", path.display(), meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        Ok(format!("{}:{:?}", path.display(), meta.created().ok()))
    }
}
pub(crate) fn path_text(path: &Path) -> Result<String> {
    path.to_str().map(String::from).ok_or_else(|| {
        Error::new(
            "PATH_ENCODING",
            "此路径不是有效 UTF-8，当前仅支持只读外部查看。",
            "Non-UTF8 path",
        )
    })
}
pub(crate) fn text(bytes: Vec<u8>) -> Result<String> {
    String::from_utf8(bytes).map_err(|e| {
        Error::new(
            "TEXT_ENCODING",
            "内容无法按 UTF-8 解码，请使用外部编辑器查看原始内容。",
            e.utf8_error(),
        )
    })
}

pub(crate) fn index_override(command: &mut std::process::Command, path: &Path) {
    command.env("GIT_INDEX_FILE", OsString::from(path));
}
