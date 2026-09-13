//! Shared launch guards. File identity detects replacement, not publisher trust.
use crate::{fingerprint, Error, Result};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn trusted_program_workspace(
    store: &crate::store::Store,
    parent: &Path,
    workspaces: &[crate::Workspace],
) -> Result<Option<String>> {
    let candidates: Vec<_> = workspaces
        .iter()
        .filter(|w| parent.starts_with(&w.path))
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }
    let actual = crate::git::Git {
        executable: store.preferences()?.git_path,
    }
    .discover(parent.to_str().ok_or_else(|| {
        Error::new(
            "OBSERVER_PROGRAM_PATH",
            "程序路径不是 UTF-8。",
            "Non-UTF8 executable parent",
        )
    })?)?
    .0;
    for workspace in candidates.into_iter().filter(|w| {
        w.path == actual.path && w.git_dir == actual.git_dir && w.common_dir == actual.common_dir
    }) {
        match store.workspace(&workspace.id) {
            Ok(current) if current.trusted => return Ok(Some(current.id)),
            Ok(_) => {
                return Err(Error::new(
                    "TRUST_REQUIRED",
                    "所选程序位于未信任的工作区，请先核对程序来源。",
                    "Untrusted workspace executable",
                ))
            }
            Err(error) if error.code == "WORKSPACE_REPLACED" => continue,
            Err(error) => return Err(error),
        }
    }
    Err(Error::new(
        "WORKSPACE_REPLACED",
        "程序所在仓库身份已变化，请重新打开并确认信任。",
        "No currently trusted workspace matches the executable",
    ))
}

/// Keep every link's physical parent before following it. Resolving the whole
/// path first would lose a repository that supplies a directory link, including
/// when that link is reached through another alias outside the repository.
pub(crate) fn resolve_program_path(path: &Path) -> std::io::Result<(PathBuf, Vec<PathBuf>)> {
    let mut pending = path.to_owned();
    let mut origins = Vec::new();
    loop {
        let mut cursor = PathBuf::new();
        let mut components = pending.components();
        let mut redirect = None;
        while let Some(component) = components.next() {
            cursor.push(component);
            if !matches!(component, std::path::Component::Normal(_))
                || !fs::symlink_metadata(&cursor)?.file_type().is_symlink()
            {
                continue;
            }
            if origins.len() == 40 {
                return Err(std::io::Error::other("Too many symbolic links"));
            }
            let parent = fs::canonicalize(
                cursor
                    .parent()
                    .ok_or_else(|| std::io::Error::other("Symbolic link has no parent"))?,
            )?;
            let target = fs::read_link(&cursor)?;
            let target = if target.is_absolute() {
                target
            } else {
                parent.join(target)
            };
            origins.push(parent);
            redirect = Some(target.join(components.as_path()));
            break;
        }
        match redirect {
            Some(target) => pending = target,
            None => return Ok((fs::canonicalize(cursor)?, origins)),
        }
    }
}

pub(crate) fn program_identity(path: &Path) -> Result<String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(Error::new(
            "OBSERVER_PROGRAM_TYPE",
            "所选程序不是可检测的普通文件。",
            "Executable is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.mode() & 0o111 == 0 || before.mode() & 0o022 != 0 {
            return Err(Error::new(
                "OBSERVER_PROGRAM_PERMISSION",
                "所选程序的执行权限不符合要求。",
                "Executable must be executable and not group/world writable",
            ));
        }
    }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
            before.dev(),
            before.ino(),
            before.len(),
            before.mode(),
            before.uid(),
            before.gid(),
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec()
        )
    };
    #[cfg(not(unix))]
    let identity = format!(
        "{}:{:?}:{:?}",
        before.len(),
        before.modified()?,
        before.created()?
    );
    Ok(fingerprint(&[
        path.as_os_str().as_encoded_bytes(),
        identity.as_bytes(),
    ]))
}
