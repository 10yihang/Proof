use crate::{git::Git, process, Changes, Error, Result, Side, Workspace};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

pub(super) struct OcrGitPlan {
    git: Git,
    source: Source,
}

enum Source {
    Local(Changes),
    Comparison {
        workspace: Workspace,
        base: String,
        target: String,
    },
}

impl OcrGitPlan {
    pub fn local(git: Git, mut changes: Changes) -> Self {
        changes.file_versions = Default::default();
        Self {
            git,
            source: Source::Local(changes),
        }
    }

    pub fn comparison(git: Git, workspace: Workspace, base: String, target: String) -> Self {
        Self {
            git,
            source: Source::Comparison {
                workspace,
                base,
                target,
            },
        }
    }

    pub fn capture(&self, selected: &[(String, Side)]) -> Result<OcrGitView> {
        match &self.source {
            Source::Local(changes) => {
                let verify = || -> Result<()> {
                    if self.git.changes(&changes.workspace)?.token != changes.token {
                        return Err(Error::stale());
                    }
                    Ok(())
                };
                verify()?;
                let view = OcrGitView::local(&self.git, changes, selected)?;
                verify()?;
                Ok(view)
            }
            Source::Comparison {
                workspace,
                base,
                target,
            } => OcrGitView::comparison(&self.git, workspace, base, target),
        }
    }
}

pub(super) struct OcrGitView {
    _directory: tempfile::TempDir,
    pub git_dir: PathBuf,
    pub ranges: Vec<OcrRange>,
}

pub(super) struct OcrRange {
    pub base: String,
    pub target: String,
    pub side: Option<Side>,
}

impl OcrRange {
    pub fn scope(&self, workspace_id: &str, paths: Option<Vec<String>>) -> super::AiScope {
        super::AiScope::Comparison {
            workspace_id: workspace_id.into(),
            base: self.base.clone(),
            target: self.target.clone(),
            path: None,
            paths,
        }
    }
}

fn run(command: Command, input: Option<&[u8]>) -> Result<Vec<u8>> {
    let output = process::run_diff(command, input, Duration::from_secs(60), 1024 * 1024)?;
    process::checked(output).map_err(|error| {
        Error::new(
            "OCR_DIFF_CAPTURE",
            "无法为 OCR 固定当前 Diff，请查看失败详情。",
            error.detail,
        )
    })
}

pub(super) fn use_git_view(command: &mut Command, git_dir: &Path, project: &Path) {
    command
        .env("GIT_DIR", git_dir)
        .env("GIT_WORK_TREE", project);
}

impl OcrGitView {
    fn new(git: &Git, workspace: &Workspace) -> Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix("proof-ocr-diff-")
            .tempdir()?;
        let root = fs::canonicalize(directory.path())?;
        let object_format =
            crate::git::text(git.query(workspace, &["rev-parse", "--show-object-format"])?)?;
        let mut init = process::git_command(&git.executable, &root);
        init.args([
            "init",
            "--quiet",
            "--template=",
            &format!("--object-format={}", object_format.trim()),
        ]);
        run(init, None)?;
        let git_dir = root.join(".git");
        let objects = Path::new(&workspace.common_dir).join("objects");
        let alternates = git_dir.join("objects/info/alternates");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&objects, git_dir.join("source-objects"))?;
            fs::write(alternates, "../source-objects\n")?;
        }
        #[cfg(not(unix))]
        fs::write(alternates, format!("{}\n", objects.display()))?;
        Ok(Self {
            _directory: directory,
            git_dir,
            ranges: Vec::new(),
        })
    }

    fn commit(
        &self,
        git: &Git,
        workspace: &Workspace,
        tree: &str,
        parent: Option<&str>,
    ) -> Result<String> {
        let project = Path::new(&workspace.path);
        let mut command = process::git_command(&git.executable, project);
        use_git_view(&mut command, &self.git_dir, project);
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GIT_AUTHOR_NAME", "Proof")
            .env("GIT_AUTHOR_EMAIL", "proof@localhost")
            .env("GIT_COMMITTER_NAME", "Proof")
            .env("GIT_COMMITTER_EMAIL", "proof@localhost")
            .env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00Z")
            .env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z")
            .args([
                "commit-tree",
                tree,
                "--no-gpg-sign",
                "-m",
                "Proof OCR review",
            ]);
        if let Some(parent) = parent {
            command.args(["-p", parent]);
        }
        Ok(crate::git::text(run(command, None)?)?.trim().to_owned())
    }

    pub fn local(git: &Git, changes: &Changes, selected: &[(String, Side)]) -> Result<Self> {
        let workspace = &changes.workspace;
        let mut view = Self::new(git, workspace)?;
        let staged_index = view.git_dir.join("staged-index");
        let bytes = git.index_bytes(workspace)?;
        if !bytes.is_empty() {
            fs::write(&staged_index, bytes)?;
        }
        let command = |index: &Path, args: &[&str]| -> Result<Command> {
            let mut command = git.command(workspace)?;
            crate::git::index_override(&mut command, index);
            command
                .env("GIT_OBJECT_DIRECTORY", view.git_dir.join("objects"))
                .env("GIT_NO_REPLACE_OBJECTS", "1")
                .args([
                    "-c",
                    "core.splitIndex=false",
                    "-c",
                    "core.hooksPath=/dev/null",
                ])
                .args(args);
            Ok(command)
        };
        let tree = |index: &Path| {
            crate::git::text(run(command(index, &["write-tree"])?, None)?)
                .map(|value| value.trim().to_owned())
        };
        let staged_tree = tree(&staged_index)?;
        let index_commit = view.commit(git, workspace, &staged_tree, changes.head.as_deref())?;
        if selected.iter().any(|(_, side)| *side == Side::Staged) {
            view.ranges.push(OcrRange {
                base: changes.head.clone().unwrap_or_else(|| "empty".into()),
                target: index_commit.clone(),
                side: Some(Side::Staged),
            });
        }
        if selected.iter().any(|(_, side)| *side == Side::Unstaged) {
            let worktree_index = view.git_dir.join("worktree-index");
            run(
                command(&worktree_index, &["read-tree", &staged_tree])?,
                None,
            )?;
            let paths = changes
                .files
                .iter()
                .filter(|file| file.side == Side::Unstaged)
                .flat_map(|file| {
                    std::iter::once(file.path.as_str()).chain(file.old_path.as_deref())
                })
                .collect::<BTreeSet<_>>();
            let mut input = Vec::new();
            for path in paths {
                crate::git::checked_path(workspace, path)?;
                input.extend_from_slice(path.as_bytes());
                input.push(0);
            }
            run(
                command(
                    &worktree_index,
                    &[
                        "add",
                        "--all",
                        "--pathspec-from-file=-",
                        "--pathspec-file-nul",
                    ],
                )?,
                Some(&input),
            )?;
            let target =
                view.commit(git, workspace, &tree(&worktree_index)?, Some(&index_commit))?;
            view.ranges.push(OcrRange {
                base: index_commit,
                target,
                side: Some(Side::Unstaged),
            });
        }
        Ok(view)
    }

    pub fn comparison(git: &Git, workspace: &Workspace, base: &str, target: &str) -> Result<Self> {
        let mut view = Self::new(git, workspace)?;
        let tree = crate::git::text(git.query(
            workspace,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{target}^{{tree}}"),
            ],
        )?)?;
        let parent = (base != "empty").then_some(base);
        let target = view.commit(git, workspace, tree.trim(), parent)?;
        view.ranges.push(OcrRange {
            base: base.to_owned(),
            target,
            side: None,
        });
        Ok(view)
    }
}
