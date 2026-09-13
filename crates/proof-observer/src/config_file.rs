//! Bounded, no-follow configuration reads and atomic file publication.
use proof_core::{Error, Result};
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::Path,
};

const LIMIT: u64 = 1024 * 1024;
#[derive(Clone)]
pub(crate) struct ConfigSnapshot {
    pub text: Option<String>,
    identity: Option<String>,
    parent: Option<String>,
    mode: u32,
}

fn directory(path: &Path) -> Result<File> {
    Ok(File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(path)?)
}
fn child(parent: &File, name: &str, flags: i32, mode: u32) -> std::io::Result<File> {
    let name = CString::new(name).unwrap();
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode,
        )
    };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn identity(metadata: &std::fs::Metadata) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}:{}",
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
        metadata.mode()
    )
}
fn parent_identity(parent: &File) -> Result<String> {
    let meta = parent.metadata()?;
    Ok(format!("{}:{}", meta.dev(), meta.ino()))
}
fn parent(root: &Path, folder: &str, create: bool) -> Result<Option<File>> {
    if folder.is_empty() || [".", ".."].contains(&folder) || folder.contains(['/', '\0']) {
        return Err(Error::new(
            "OBSERVER_CONFIG_PATH",
            "Hook 配置目录无效。",
            "Unexpected provider directory",
        ));
    }
    let root = directory(root)?;
    if create {
        let name = CString::new(folder).unwrap();
        if unsafe { libc::mkdirat(root.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(error.into());
            }
        }
    }
    match child(&root, folder, libc::O_RDONLY | libc::O_DIRECTORY, 0) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn capture_file(parent: &File, filename: &str) -> Result<ConfigSnapshot> {
    let parent_id = Some(parent_identity(parent)?);
    let mut file = match child(parent, filename, libc::O_RDONLY, 0) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConfigSnapshot {
                text: None,
                identity: None,
                parent: parent_id,
                mode: 0o600,
            })
        }
        Err(error) => return Err(error.into()),
    };
    let before = file.metadata()?;
    if !before.is_file()
        || before.nlink() != 1
        || before.uid() != unsafe { libc::geteuid() }
        || before.mode() & 0o200 == 0
        || before.len() > LIMIT
    {
        return Err(Error::new(
            "OBSERVER_CONFIG_FILE",
            "配置文件的类型、权限或大小不支持安全编辑。",
            "Expected owned writable regular file, one link, at most 1 MiB",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > LIMIT as usize || identity(&file.metadata()?) != identity(&before) {
        return Err(changed());
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        Error::new(
            "OBSERVER_CONFIG_ENCODING",
            "配置文件不是 UTF-8，尚未修改。",
            "Unsupported config encoding",
        )
    })?;
    Ok(ConfigSnapshot {
        text: Some(text),
        identity: Some(identity(&before)),
        parent: parent_id,
        mode: before.mode() & 0o777,
    })
}
pub(crate) fn capture(root: &Path, folder: &str, filename: &str) -> Result<ConfigSnapshot> {
    match parent(root, folder, false)? {
        Some(parent) => capture_file(&parent, filename),
        None => Ok(ConfigSnapshot {
            text: None,
            identity: None,
            parent: None,
            mode: 0o600,
        }),
    }
}
fn changed() -> Error {
    Error::new(
        "OBSERVER_CONFIG_CHANGED",
        "Agent 配置已变化，请重新预览；现有配置保留。",
        "Configuration changed since preview",
    )
}
struct WriteLease(File);
impl Drop for WriteLease {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn check_parent(root: &Path, folder: &str, bound: &File) -> Result<()> {
    let current = parent(root, folder, false)?.ok_or_else(changed)?;
    if parent_identity(&current)? != parent_identity(bound)? {
        return Err(changed());
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct TemporaryReceipt {
    parent: String,
    name: String,
    identity: String,
}

fn cleanup_bound(parent: &File, receipt: &TemporaryReceipt) -> Result<()> {
    match child(parent, &receipt.name, libc::O_RDONLY, 0) {
        Ok(file) => {
            let meta = file.metadata()?;
            if !meta.is_file()
                || meta.nlink() != 1
                || meta.uid() != unsafe { libc::geteuid() }
                || parent_identity(&file)? != receipt.identity
            {
                return Err(changed());
            }
            let name = CString::new(receipt.name.as_str()).unwrap();
            if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            parent.sync_all()?;
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
fn cleanup_temporary(root: &Path, folder: &str, journal: &Path) -> Result<()> {
    let file = match File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(journal)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.len() > 4096
    {
        return Err(changed());
    }
    let receipt: TemporaryReceipt = serde_json::from_reader(file.take(4097))?;
    if !receipt.name.starts_with(".proof-hook-")
        || !receipt.name.ends_with(".tmp")
        || receipt.name.contains(['/', '\0'])
    {
        return Err(changed());
    }
    let bound = parent(root, folder, false)?.ok_or_else(changed)?;
    if parent_identity(&bound)? != receipt.parent {
        return Err(changed());
    }
    cleanup_bound(&bound, &receipt)?;
    std::fs::remove_file(journal)?;
    Ok(())
}
pub(crate) fn apply(
    root: &Path,
    folder: &str,
    filename: &str,
    expected: &ConfigSnapshot,
    desired: Option<&str>,
    journal: &Path,
) -> Result<()> {
    apply_owned(root, folder, filename, expected, desired, journal, || {})
}
#[cfg(test)]
fn apply_with(
    root: &Path,
    folder: &str,
    filename: &str,
    expected: &ConfigSnapshot,
    desired: Option<&str>,
    before_publish: impl FnOnce(),
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    apply_owned(
        root,
        folder,
        filename,
        expected,
        desired,
        &directory.path().join("temporary.json"),
        before_publish,
    )
}
fn apply_owned(
    root: &Path,
    folder: &str,
    filename: &str,
    expected: &ConfigSnapshot,
    desired: Option<&str>,
    journal: &Path,
    before_publish: impl FnOnce(),
) -> Result<()> {
    cleanup_temporary(root, folder, journal)?;
    if desired.is_none() && expected.text.is_none() {
        return if capture(root, folder, filename)?.text.is_none() {
            Ok(())
        } else {
            Err(changed())
        };
    }
    let parent = parent(root, folder, true)?.unwrap();
    if unsafe { libc::flock(parent.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(Error::new(
            "OBSERVER_CONFIG_BUSY",
            "另一个 Hook 操作正在修改此配置，请稍后重试。",
            "Provider directory lease unavailable",
        ));
    }
    let lease = WriteLease(parent);
    if expected.parent.is_some() && expected.parent != Some(parent_identity(&lease.0)?) {
        return Err(changed());
    }
    let current = capture_file(&lease.0, filename)?;
    if current.identity != expected.identity || current.text != expected.text {
        return Err(changed());
    }
    if current.text.as_deref() == desired {
        return Ok(());
    }
    let temporary = format!(".proof-hook-{}.tmp", uuid::Uuid::new_v4());
    let temporary_c = CString::new(temporary.as_str()).unwrap();
    let name = CString::new(filename).unwrap();
    let mut receipt: Option<TemporaryReceipt> = None;
    let publish = (|| -> Result<()> {
        if let Some(text) = desired {
            if text.len() > LIMIT as usize {
                return Err(Error::new(
                    "OBSERVER_CONFIG_LIMIT",
                    "Hook 配置超过大小限制，尚未修改。",
                    "Config exceeds 1 MiB",
                ));
            }
            let mut file = child(
                &lease.0,
                &temporary,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )?;
            // Persist exact ownership before writing any configuration bytes.
            let owned = TemporaryReceipt {
                parent: parent_identity(&lease.0)?,
                name: temporary.clone(),
                identity: parent_identity(&file)?,
            };
            let mut ledger = File::options()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(journal)?;
            serde_json::to_writer(&mut ledger, &owned)?;
            ledger.sync_all()?;
            directory(journal.parent().unwrap())?.sync_all()?;
            receipt = Some(owned);
            #[cfg(target_os = "macos")]
            if current.text.is_some() {
                let source = child(&lease.0, filename, libc::O_RDONLY, 0)?;
                if unsafe {
                    libc::fcopyfile(
                        source.as_raw_fd(),
                        file.as_raw_fd(),
                        std::ptr::null_mut(),
                        libc::COPYFILE_METADATA,
                    )
                } != 0
                {
                    return Err(std::io::Error::last_os_error().into());
                }
            }
            file.write_all(text.as_bytes())?;
            file.set_permissions(std::fs::Permissions::from_mode(expected.mode))?;
            file.sync_all()?;
        }
        before_publish();
        check_parent(root, folder, &lease.0)?;
        let current = capture_file(&lease.0, filename)?;
        if current.identity != expected.identity || current.text != expected.text {
            return Err(changed());
        }
        let status = unsafe {
            if desired.is_none() {
                if current.text.is_none() {
                    0
                } else {
                    libc::unlinkat(lease.0.as_raw_fd(), name.as_ptr(), 0)
                }
            } else if expected.text.is_none() {
                #[cfg(target_os = "macos")]
                {
                    libc::renameatx_np(
                        lease.0.as_raw_fd(),
                        temporary_c.as_ptr(),
                        lease.0.as_raw_fd(),
                        name.as_ptr(),
                        libc::RENAME_EXCL,
                    )
                }
                #[cfg(target_os = "linux")]
                {
                    libc::renameat2(
                        lease.0.as_raw_fd(),
                        temporary_c.as_ptr(),
                        lease.0.as_raw_fd(),
                        name.as_ptr(),
                        libc::RENAME_NOREPLACE,
                    )
                }
                #[cfg(not(any(target_os = "macos", target_os = "linux")))]
                {
                    return Err(Error::new(
                        "OBSERVER_CONFIG_PLATFORM",
                        "此平台的配置写入尚未验证。",
                        "Missing no-replace primitive",
                    ));
                }
            } else {
                libc::renameat(
                    lease.0.as_raw_fd(),
                    temporary_c.as_ptr(),
                    lease.0.as_raw_fd(),
                    name.as_ptr(),
                )
            }
        };
        if status != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        lease.0.sync_all()?;
        check_parent(root, folder, &lease.0)?;
        if capture_file(&lease.0, filename)?.text.as_deref() != desired {
            return Err(changed());
        }
        Ok(())
    })();
    if let Some(receipt) = receipt {
        cleanup_bound(&lease.0, &receipt)?;
        std::fs::remove_file(journal)?;
    } else {
        // Publication never copied content before the receipt became durable.
        unsafe {
            libc::unlinkat(lease.0.as_raw_fd(), temporary_c.as_ptr(), 0);
        }
    }
    publish
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parent_replaced_during_publish_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".codex")).unwrap();
        let path = root.path().join(".codex/hooks.json");
        std::fs::write(&path, "{}\n").unwrap();
        let before = capture(root.path(), ".codex", "hooks.json").unwrap();
        let result = apply_with(
            root.path(),
            ".codex",
            "hooks.json",
            &before,
            Some("{\"proof\":true}"),
            || {
                std::fs::rename(root.path().join(".codex"), root.path().join("archive")).unwrap();
                std::fs::create_dir(root.path().join(".codex")).unwrap();
                std::fs::write(&path, "{\"user\":true}").unwrap();
            },
        );
        assert_eq!(result.unwrap_err().code, "OBSERVER_CONFIG_CHANGED");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"user\":true}");
        assert_eq!(
            std::fs::read_to_string(root.path().join("archive/hooks.json")).unwrap(),
            "{}\n"
        );
    }
    #[test]
    fn preview_conflicts_and_directory_links_preserve_user_config() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".codex")).unwrap();
        let path = root.path().join(".codex/hooks.json");
        std::fs::write(&path, "{\"user\":1}\n").unwrap();
        let before = capture(root.path(), ".codex", "hooks.json").unwrap();
        assert_eq!(
            apply_with(
                root.path(),
                ".codex",
                "hooks.json",
                &before,
                Some("{}\n"),
                || {
                    std::fs::write(&path, "{\"user\":2}\n").unwrap();
                }
            )
            .unwrap_err()
            .code,
            "OBSERVER_CONFIG_CHANGED"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"user\":2}\n");
        let before = capture(root.path(), ".codex", "hooks.json").unwrap();
        std::fs::rename(root.path().join(".codex"), root.path().join("original")).unwrap();
        std::os::unix::fs::symlink(root.path().join("original"), root.path().join(".codex"))
            .unwrap();
        assert!(apply_with(
            root.path(),
            ".codex",
            "hooks.json",
            &before,
            Some("{}\n"),
            || {}
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join("original/hooks.json")).unwrap(),
            "{\"user\":2}\n"
        );
    }
}
