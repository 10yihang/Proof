use crate::{git, patch, ChangedFile, Error, FileDiff, FileKind, Proof, Result, Side, Workspace};
use serde::Serialize;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub base_oid: String,
    pub target_oid: String,
    pub files: Vec<ChangedFile>,
}
fn resolve(git: &git::Git, workspace: &Workspace, reference: &str) -> Result<String> {
    if reference.is_empty()
        || reference.len() > 1024
        || reference.starts_with('-')
        || reference.chars().any(char::is_control)
    {
        return Err(Error::new(
            "COMPARE_REVISION",
            "请选择 Branch 或输入 Commit ID。",
            "Invalid comparison reference",
        ));
    }
    let oid = git::text(git.query(
        workspace,
        &[
            "--no-replace-objects",
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
    )?)?
    .trim()
    .to_owned();
    if ![40, 64].contains(&oid.len()) || !oid.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::new(
            "COMPARE_REVISION",
            "无法解析所选 Commit。",
            "Invalid resolved OID",
        ));
    }
    Ok(oid)
}
fn files(
    git: &git::Git,
    workspace: &Workspace,
    base: &str,
    target: &str,
) -> Result<Vec<ChangedFile>> {
    let mut args = vec!["--no-replace-objects"];
    if base == "empty" {
        args.extend(["diff-tree", "-r", "--root", "--no-commit-id"]);
    } else {
        args.push("diff");
    }
    args.extend([
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--name-status",
        "-z",
    ]);
    if base != "empty" {
        args.push(base);
    }
    args.extend([target, "--"]);
    let raw = git.query(workspace, &args)?;
    let mut parts = raw.split(|b| *b == 0).filter(|p| !p.is_empty());
    let mut files = Vec::new();
    while let Some(status) = parts.next() {
        let read_path = |bytes: Option<&[u8]>| -> Result<String> {
            String::from_utf8(
                bytes
                    .ok_or_else(|| {
                        Error::new("COMPARE_PARSE", "无法读取文件列表。", "Missing path")
                    })?
                    .to_vec(),
            )
            .map_err(|_| {
                Error::new(
                    "PATH_ENCODING",
                    "文件路径不是 UTF-8，无法显示此次比较。",
                    "Unsupported path encoding",
                )
            })
        };
        let first = read_path(parts.next())?;
        let rename = status.starts_with(b"R") || status.starts_with(b"C");
        let path = if rename {
            read_path(parts.next())?
        } else {
            first.clone()
        };
        files.push(ChangedFile {
            path,
            old_path: rename.then_some(first),
            status: String::from_utf8_lossy(status).into_owned(),
            side: Side::Unstaged,
            conflicted: false,
        });
        if files.len() > 20_000 {
            return Err(Error::new(
                "COMPARE_LIMIT",
                "此次比较超过 20,000 个文件，请缩小 Commit 范围。",
                "Comparison file limit exceeded",
            ));
        }
    }
    Ok(files)
}
impl Proof {
    pub fn compare_refs(&self, workspace_id: &str, base: &str, target: &str) -> Result<Comparison> {
        let workspace = self.store.workspace(workspace_id)?;
        let git = self.git()?;
        let base_oid = resolve(&git, &workspace, base)?;
        let target_oid = resolve(&git, &workspace, target)?;
        Ok(Comparison {
            files: files(&git, &workspace, &base_oid, &target_oid)?,
            base_oid,
            target_oid,
        })
    }
    pub fn compare_commit(
        &self,
        workspace_id: &str,
        reference: &str,
        parent: usize,
    ) -> Result<Comparison> {
        let workspace = self.store.workspace(workspace_id)?;
        let git = self.git()?;
        let target_oid = resolve(&git, &workspace, reference)?;
        // Raw commit headers retain real parents at shallow boundaries.
        let raw = git.query(
            &workspace,
            &["--no-replace-objects", "cat-file", "commit", &target_oid],
        )?;
        let parents: Vec<String> = raw
            .split(|byte| *byte == b'\n')
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.strip_prefix(b"parent "))
            .map(|value| {
                if ![40, 64].contains(&value.len()) || !value.iter().all(u8::is_ascii_hexdigit) {
                    return Err(Error::new(
                        "COMPARE_PARENT",
                        "无法解析 Commit 的父版本。",
                        "Malformed parent header",
                    ));
                }
                Ok(String::from_utf8(value.to_vec()).unwrap())
            })
            .collect::<Result<_>>()?;
        let base_oid = if parents.is_empty() && parent == 0 {
            "empty".to_owned()
        } else {
            parents
                .get(parent)
                .ok_or_else(|| {
                    Error::new("COMPARE_PARENT", "所选父 Commit 不存在。", "Invalid parent")
                })?
                .to_string()
        };
        Ok(Comparison {
            files: files(&git, &workspace, &base_oid, &target_oid)?,
            base_oid,
            target_oid,
        })
    }
    /// Read two immutable trees. This snapshot is never registered for Git writes.
    pub fn compare_file(
        &self,
        workspace_id: &str,
        base: &str,
        target: &str,
        path: &str,
    ) -> Result<FileDiff> {
        for oid in [base, target].into_iter().filter(|oid| *oid != "empty") {
            if ![40, 64].contains(&oid.len()) || !oid.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err(Error::new(
                    "COMPARE_REVISION",
                    "比较已失效，请重新选择版本。",
                    "Expected frozen OIDs",
                ));
            }
        }
        if target == "empty" {
            return Err(Error::new(
                "COMPARE_REVISION",
                "请选择有效的 Commit。",
                "Target must be a commit",
            ));
        }
        let workspace = self.store.workspace(workspace_id)?;
        let git = self.git()?;
        let file = files(&git, &workspace, base, target)?
            .into_iter()
            .find(|f| f.path == path)
            .ok_or_else(|| {
                Error::new(
                    "COMPARE_FILE_MISSING",
                    "所选文件不在此次比较中。",
                    "Unknown comparison path",
                )
            })?;
        let mut args = vec!["--no-literal-pathspecs", "--no-replace-objects"];
        if base == "empty" {
            args.extend(["diff-tree", "-r", "--root", "--no-commit-id", "-p"]);
        } else {
            args.push("diff");
        }
        args.extend([
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--find-renames",
            "--full-index",
            "--unified=3",
        ]);
        if base != "empty" {
            args.push(base);
        }
        args.extend([target, "--"]);
        let selected_paths: Vec<_> = std::iter::once(path)
            .chain(file.old_path.as_deref())
            .collect();
        let mut pathspecs = Vec::new();
        for selected in selected_paths {
            pathspecs.push(format!(":(top,literal){selected}"));
            let escaped: String = selected
                .chars()
                .flat_map(|c| {
                    if ['\\', '*', '?', '[', ']'].contains(&c) {
                        vec!['\\', c]
                    } else {
                        vec![c]
                    }
                })
                .collect();
            pathspecs.push(format!(":(top,glob,exclude){escaped}/**"));
        }
        args.extend(pathspecs.iter().map(String::as_str));
        let raw = git.query(&workspace, &args)?;
        let patch = String::from_utf8(raw).map_err(|_| {
            Error::new(
                "COMPARE_ENCODING",
                "此文本不是 UTF-8，无法显示代码 Diff。",
                "Unsupported diff encoding",
            )
        })?;
        let metadata = patch::metadata(&patch);
        if metadata.sections > 1 {
            return Err(Error::new(
                "COMPARE_FILE_RANGE",
                "此文件的历史路径存在歧义，请在原始 Git 中核对。",
                "Multiple file sections in a file comparison",
            ));
        }
        let id = crate::fingerprint(&[
            workspace_id.as_bytes(),
            base.as_bytes(),
            target.as_bytes(),
            path.as_bytes(),
        ]);
        let hunks = patch::hunks(&patch, &id);
        let additions = hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|l| l.kind == "add")
            .count();
        let deletions = hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|l| l.kind == "delete")
            .count();
        let kind = if metadata.binary {
            FileKind::Binary
        } else if metadata.has_mode("160000") {
            FileKind::Submodule
        } else if metadata.has_mode("120000") {
            FileKind::Symlink
        } else if file.old_path.is_some() {
            FileKind::Rename
        } else if hunks.is_empty() {
            FileKind::Metadata
        } else {
            FileKind::Text
        };
        Ok(FileDiff {
            id,
            workspace_id: workspace_id.into(),
            path: path.into(),
            old_path: file.old_path,
            side: Side::Unstaged,
            base: base.into(),
            captured_at: crate::now(),
            token: target.into(),
            patch,
            hunks,
            additions,
            deletions,
            kind,
            notice: (kind == FileKind::Binary).then(|| "Binary 文件内容不同。".into()),
            can_stage: false,
            can_stage_hunks: false,
            can_discard: false,
            can_discard_hunks: false,
            discard_reason: None,
            guard: String::new(),
        })
    }
}
