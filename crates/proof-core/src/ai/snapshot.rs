//! A disposable on-disk reading view, never a Worktree registered in the source Git repo.
use super::{AiProgress, AiScope};
use crate::{git::Git, process, Error, FileDiff, Proof, Result, Workspace};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

const MAX_SNAPSHOT: usize = 256 * 1024 * 1024;
const MAX_CONTEXT_FILE: usize = 4 * 1024 * 1024;
const MAX_CONTEXT_FILES: usize = 100_000;

pub(super) struct Snapshot {
    _directory: tempfile::TempDir,
    pub root: PathBuf,
    pub paths: Vec<String>,
    pub omitted: Vec<String>,
}
fn limited() -> Error {
    Error::new(
        "AI_SNAPSHOT_LIMIT",
        "分析快照超过本机资源上限，请缩小范围。",
        "256 MiB snapshot / 100,000 context files; no Agent started",
    )
}
fn relative(path: &str) -> Result<()> {
    if path.is_empty() || !Path::new(path).components().all(|p| matches!(p, Component::Normal(name) if !name.to_string_lossy().eq_ignore_ascii_case(".git"))) {
        return Err(Error::new("INVALID_PATH", "文件路径无效。", "Unsafe snapshot path"));
    }
    Ok(())
}
struct Builder {
    root: PathBuf,
    bytes: usize,
    view_budget: usize,
    view_bytes: BTreeMap<String, usize>,
    preferred: BTreeSet<String>,
    paths: BTreeSet<String>,
    omitted: Vec<String>,
}
impl Builder {
    fn write(&mut self, view: &str, path: &str, bytes: &[u8]) -> Result<()> {
        relative(path)?;
        if bytes.len() > MAX_CONTEXT_FILE
            || bytes.contains(&0)
            || std::str::from_utf8(bytes).is_err()
        {
            self.omitted.push(format!(
                "{view}/{path}: binary, non-UTF8 or >4 MiB context; consult the captured patch"
            ));
            return Ok(());
        }
        let used = self.view_bytes.entry(view.into()).or_default();
        if *used + bytes.len() > self.view_budget {
            self.omitted.push(format!(
                "{view}/{path}: context budget exceeded; consult captured patch"
            ));
            return Ok(());
        }
        *used += bytes.len();
        self.bytes += bytes.len();
        if self.paths.len() >= MAX_CONTEXT_FILES && !self.paths.contains(path) {
            return Err(limited());
        }
        let target = self.root.join(view).join(path);
        fs::create_dir_all(target.parent().unwrap())?;
        fs::write(target, bytes)?;
        self.paths.insert(path.into());
        Ok(())
    }
    fn tree(
        &mut self,
        git: &Git,
        workspace: &Workspace,
        revision: &str,
        view: &str,
        emit: &dyn Fn(AiProgress),
    ) -> Result<Vec<String>> {
        if revision == "empty" {
            return Ok(Vec::new());
        }
        let root = Path::new(&workspace.path);
        let output = if revision == ":index" {
            process::checked(git.raw(root, &["ls-files", "--stage", "-z"])?)?
        } else {
            process::checked(git.raw(root, &["ls-tree", "-r", "-z", revision])?)?
        };
        let mut objects: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut paths = Vec::new();
        for record in output.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            crate::check_read_cancellation()?;
            let text = std::str::from_utf8(record).map_err(|_| {
                Error::new(
                    "INVALID_PATH",
                    "文件路径不是 UTF-8。",
                    "Snapshot path encoding",
                )
            })?;
            let (header, path) = text
                .split_once('\t')
                .ok_or_else(|| super::invalid("Malformed Git tree"))?;
            relative(path)?;
            let fields: Vec<_> = header.split_whitespace().collect();
            if fields.len() != 3 {
                return Err(super::invalid("Malformed Git tree entry"));
            }
            paths.push(path.to_owned());
            if paths.len() > MAX_CONTEXT_FILES {
                return Err(limited());
            }
            if !matches!(fields[0], "100644" | "100755")
                || (revision == ":index" && fields[2] != "0")
            {
                self.omitted.push(format!(
                    "{view}/{path}: symlink, submodule or unresolved index entry"
                ));
                continue;
            }
            let oid = if revision == ":index" {
                fields[1]
            } else {
                fields[2]
            };
            if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(super::invalid("Malformed object ID"));
            }
            objects.entry(oid.into()).or_default().push(path.into());
        }
        // Size checks prevent a single giant blob from filling a pipe buffer.
        let mut entries: Vec<_> = objects.into_iter().collect();
        entries.sort_by_key(|(_, paths)| !paths.iter().any(|path| self.preferred.contains(path)));
        for chunk in entries.chunks(32) {
            crate::check_read_cancellation()?;
            let input = chunk
                .iter()
                .map(|(oid, _)| format!("{oid}\n"))
                .collect::<String>();
            let mut command = git.command(workspace)?;
            command.args([
                "cat-file",
                "--batch-check=%(objectname) %(objecttype) %(objectsize)",
            ]);
            let checked = process::checked(process::run_diff(
                command,
                Some(input.as_bytes()),
                Duration::from_secs(20),
                64 * 1024,
            )?)?;
            let sizes = String::from_utf8_lossy(&checked);
            if sizes.lines().count() != chunk.len() {
                return Err(super::invalid("Incomplete snapshot object sizes"));
            }
            let mut read = Vec::new();
            let mut batch_bytes = 0;
            for ((oid, paths), row) in chunk.iter().zip(sizes.lines()) {
                let fields: Vec<_> = row.split_whitespace().collect();
                if fields.len() != 3 || fields[0] != oid || fields[1] != "blob" {
                    return Err(super::invalid("Invalid snapshot object"));
                }
                let size = fields[2].parse::<usize>().map_err(super::invalid)?;
                if size > MAX_CONTEXT_FILE {
                    for path in paths {
                        self.omitted.push(format!(
                            "{view}/{path}: >4 MiB context; consult captured patch"
                        ));
                    }
                } else {
                    // Keep each batch below the Git pipe resource limit.
                    if batch_bytes + size > 16 * 1024 * 1024 {
                        self.blobs(git, workspace, view, &read)?;
                        read.clear();
                        batch_bytes = 0;
                    }
                    read.push((oid.as_str(), paths.as_slice(), size));
                    batch_bytes += size;
                }
            }
            self.blobs(git, workspace, view, &read)?;
            emit(AiProgress::phase("snapshot"));
        }
        Ok(paths)
    }
    fn blobs(
        &mut self,
        git: &Git,
        workspace: &Workspace,
        view: &str,
        entries: &[(&str, &[String], usize)],
    ) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }
        let input = entries
            .iter()
            .map(|(oid, _, _)| format!("{oid}\n"))
            .collect::<String>();
        let mut command = git.command(workspace)?;
        command.args(["cat-file", "--batch"]);
        let bytes = process::checked(process::run_diff(
            command,
            Some(input.as_bytes()),
            Duration::from_secs(20),
            20 * 1024 * 1024,
        )?)?;
        let mut rest = bytes.as_slice();
        for (oid, paths, size) in entries {
            crate::check_read_cancellation()?;
            let end = rest
                .iter()
                .position(|b| *b == b'\n')
                .ok_or_else(|| super::invalid("Incomplete blob header"))?;
            if rest[..end] != format!("{oid} blob {size}").as_bytes()[..]
                || rest.len() < end + 1 + size + 1
            {
                return Err(super::invalid("Incomplete snapshot blob"));
            }
            let content = &rest[end + 1..end + 1 + size];
            for path in *paths {
                self.write(view, path, content)?;
            }
            rest = &rest[end + 1 + size + 1..];
        }
        if !rest.is_empty() {
            return Err(super::invalid("Extra snapshot blob output"));
        }
        Ok(())
    }
}

pub(super) fn capture(
    proof: &Proof,
    workspace: &Workspace,
    scope: &AiScope,
    diffs: &[FileDiff],
    emit: &dyn Fn(AiProgress),
) -> Result<Snapshot> {
    let directory = tempfile::Builder::new()
        .prefix("proof-review-snapshot-")
        .tempdir()?;
    let root = fs::canonicalize(directory.path())?;
    let patch_bytes = diffs.iter().map(|diff| diff.patch.len()).sum::<usize>();
    if patch_bytes > MAX_SNAPSHOT {
        return Err(limited());
    }
    let mut builder = Builder {
        root: root.clone(),
        bytes: 0,
        view_budget: (MAX_SNAPSHOT - patch_bytes) / 3,
        view_bytes: BTreeMap::new(),
        preferred: diffs
            .iter()
            .flat_map(|diff| std::iter::once(diff.path.clone()).chain(diff.old_path.clone()))
            .collect(),
        paths: BTreeSet::new(),
        omitted: Vec::new(),
    };
    for view in ["base", "index", "workspace", "diffs"] {
        fs::create_dir(root.join(view))?;
    }
    let git = proof.git()?;
    emit(AiProgress::phase("snapshot"));
    match scope {
        AiScope::Comparison { base, target, .. } => {
            builder.tree(&git, workspace, base, "base", emit)?;
            builder.tree(&git, workspace, target, "workspace", emit)?;
        }
        AiScope::Local { expected_token, .. } => {
            let changes = proof.changes(&workspace.id)?;
            if &changes.token != expected_token {
                return Err(Error::stale());
            }
            if let Some(head) = &changes.head {
                builder.tree(&git, workspace, head, "base", emit)?;
            }
            let mut paths: BTreeSet<_> = builder
                .tree(&git, workspace, ":index", "index", emit)?
                .into_iter()
                .collect();
            paths.extend(changes.files.iter().map(|file| file.path.clone()));
            let mut paths: Vec<_> = paths.into_iter().collect();
            paths.sort_by_key(|path| !builder.preferred.contains(path));
            for path in paths {
                crate::check_read_cancellation()?;
                if !Path::new(&workspace.path).join(&path).exists() {
                    continue;
                }
                match crate::guarded_file::BoundFile::open(Path::new(&workspace.path), &path)
                    .and_then(|file| file.read())
                {
                    Ok(Some(image)) => builder.write("workspace", &path, &image.bytes)?,
                    Ok(None) => (),
                    Err(error) if error.code == "STALE_CONTENT" => return Err(error),
                    Err(_) => builder.omitted.push(format!(
                        "workspace/{path}: unavailable or unsupported context"
                    )),
                }
            }
            if proof.changes(&workspace.id)?.token != *expected_token {
                return Err(Error::stale());
            }
        }
    }
    let mut manifest = Vec::new();
    for (index, diff) in diffs.iter().enumerate() {
        crate::check_read_cancellation()?;
        builder.bytes += diff.patch.len();
        if builder.bytes > MAX_SNAPSHOT {
            return Err(limited());
        }
        let patch = format!("diffs/{index}.patch");
        fs::write(root.join(&patch), &diff.patch)?;
        manifest.push(json!({"path":diff.path,"oldPath":diff.old_path,"side":diff.side,"kind":diff.kind,"patchFile":patch,"notice":diff.notice}));
        builder.paths.insert(diff.path.clone());
    }
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec_pretty(
            &json!({"scope":scope,"files":manifest,"omittedContext":builder.omitted,"views":{"base":"base/","index":"index/","target":"workspace/"}}),
        )?,
    )?;
    Ok(Snapshot {
        _directory: directory,
        root,
        paths: builder.paths.into_iter().collect(),
        omitted: builder.omitted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn context_budget_does_not_consume_other_versions_or_canonical_patch_space() {
        let root = tempfile::tempdir().unwrap();
        let mut builder = Builder {
            root: root.path().into(),
            bytes: 0,
            view_budget: 8,
            view_bytes: BTreeMap::new(),
            preferred: BTreeSet::new(),
            paths: BTreeSet::new(),
            omitted: Vec::new(),
        };
        builder.write("base", "selected.rs", b"12345678").unwrap();
        builder
            .write("base", "large-context.rs", b"over budget")
            .unwrap();
        builder
            .write("workspace", "selected.rs", b"changed")
            .unwrap();
        assert!(!root.path().join("base/large-context.rs").exists());
        assert_eq!(builder.omitted.len(), 1);
        assert!(builder.omitted[0].contains("large-context.rs"));
        assert_eq!(
            fs::read(root.path().join("workspace/selected.rs")).unwrap(),
            b"changed"
        );
        assert_eq!(builder.bytes, 15);
    }
}
