//! Worktree replacement without overwriting a path created by an external editor.
//! The original inode is captured in the private recovery directory, then a new
//! inode is installed only while the destination is absent. Captured inodes stay
//! available for recovery even if an editor continues writing through an open FD.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};

const MAX_FILE: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FileImage {
    #[serde(skip)]
    pub bytes: Vec<u8>,
    pub mode: u32,
    pub identity: String,
}
impl FileImage {
    pub fn same_content(&self, other: &Self) -> bool {
        self.bytes == other.bytes && self.mode == other.mode
    }
}
pub(crate) fn matches(a: &Option<FileImage>, b: &Option<FileImage>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.same_content(b),
        (None, None) => true,
        _ => false,
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::OsStrExt,
                fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
            },
        },
        path::Component,
    };

    pub(crate) struct BoundFile {
        parent: File,
        name: CString,
        allow_binary: bool,
    }
    pub(crate) struct RecoveryLease {
        _directory: File,
    }
    impl Drop for RecoveryLease {
        fn drop(&mut self) {
            // Explicitly unlock before closing: a concurrently spawned process
            // may briefly hold an inherited duplicate until exec closes it.
            unsafe {
                libc::flock(self._directory.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
    impl RecoveryLease {
        pub fn acquire(path: &Path) -> Result<Self> {
            let directory = directory(path)?;
            io_result(unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) })
                .map_err(|e| {
                    Error::new(
                        "RECOVERY_BUSY",
                        "另一个 Proof 操作正在使用此恢复点，请稍后重试。",
                        e.detail,
                    )
                })?;
            Ok(Self {
                _directory: directory,
            })
        }
    }
    fn cstr(bytes: &[u8]) -> Result<CString> {
        CString::new(bytes).map_err(|_| Error::new("INVALID_PATH", "文件路径无效。", "NUL in path"))
    }
    fn io_result(value: libc::c_int) -> Result<()> {
        if value == -1 {
            Err(std::io::Error::last_os_error().into())
        } else {
            Ok(())
        }
    }
    fn directory(path: &Path) -> Result<File> {
        Ok(fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?)
    }
    fn read_image(mut file: File, limit: u64, allow_binary: bool) -> Result<FileImage> {
        let before = file.metadata()?;
        if !before.is_file() || before.nlink() != 1 || before.len() > limit {
            return Err(Error::new(
                "UNSUPPORTED_RECOVERY_FILE",
                "Discard 仅支持 32 MiB 以内、没有硬链接的普通文件。",
                "Special, hard-linked or oversized file",
            ));
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(limit + 1)
            .read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        if bytes.len() as u64 > limit
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
        {
            return Err(Error::stale());
        }
        if !allow_binary && (bytes.contains(&0) || std::str::from_utf8(&bytes).is_err()) {
            return Err(Error::new(
                "UNSUPPORTED_RECOVERY_ENCODING",
                "丢弃仅支持 UTF-8 文本文件。",
                "Binary or non-UTF8 content",
            ));
        }
        Ok(FileImage {
            bytes,
            mode: after.mode() & 0o7777,
            identity: format!("{}:{}", after.dev(), after.ino()),
        })
    }
    impl BoundFile {
        pub fn open(root: &Path, relative: &str) -> Result<Self> {
            let parts: Vec<_> = Path::new(relative).components().collect();
            if parts.is_empty() || parts.iter().any(|c| !matches!(c, Component::Normal(_))) {
                return Err(Error::new("INVALID_PATH", "文件路径超出工作区。", relative));
            }
            let mut parent = directory(root)?;
            for part in &parts[..parts.len() - 1] {
                let name = cstr(part.as_os_str().as_bytes())?;
                // Bind every component, never following a replaced symlink.
                let fd = unsafe {
                    libc::openat(
                        parent.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                parent = unsafe { File::from_raw_fd(fd) };
            }
            Ok(Self {
                parent,
                name: cstr(parts.last().unwrap().as_os_str().as_bytes())?,
                allow_binary: false,
            })
        }
        pub fn with_binary_content(mut self, enabled: bool) -> Self {
            self.allow_binary = enabled;
            self
        }
        pub fn open_file(&self) -> Result<Option<File>> {
            let fd = unsafe {
                libc::openat(
                    self.parent.as_raw_fd(),
                    self.name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                let error = std::io::Error::last_os_error();
                return if error.kind() == std::io::ErrorKind::NotFound {
                    Ok(None)
                } else {
                    Err(error.into())
                };
            }
            Ok(Some(unsafe { File::from_raw_fd(fd) }))
        }
        pub fn read(&self) -> Result<Option<FileImage>> {
            self.open_file()?
                .map(|file| read_image(file, MAX_FILE, self.allow_binary))
                .transpose()
        }
        pub fn matches_bytes(&self, expected: &[u8]) -> Result<bool> {
            if expected.len() as u64 > MAX_FILE {
                return Ok(false);
            }
            let image = self
                .open_file()?
                .map(|file| read_image(file, expected.len() as u64, self.allow_binary))
                .transpose()?;
            Ok(image.is_some_and(|image| image.bytes == expected))
        }
        pub fn same_parent(&self, other: &Self) -> Result<bool> {
            let a = self.parent.metadata()?;
            let b = other.parent.metadata()?;
            Ok(a.dev() == b.dev() && a.ino() == b.ino())
        }
        pub fn check_volume(&self, recovery: &Path) -> Result<()> {
            if self.parent.metadata()?.dev() != directory(recovery)?.metadata()?.dev() {
                return Err(Error::new(
                    "RECOVERY_VOLUME",
                    "恢复目录与文件不在同一磁盘，当前无法保证安全丢弃。",
                    "Atomic capture requires same filesystem",
                ));
            }
            Ok(())
        }
        pub fn replace(
            &self,
            expected: &Option<FileImage>,
            desired: &Option<FileImage>,
            backup: &Path,
            candidate: &Path,
            metadata_source: Option<&Path>,
        ) -> Result<()> {
            self.replace_with(expected, desired, backup, candidate, metadata_source, || {})
        }
        fn replace_with(
            &self,
            expected: &Option<FileImage>,
            desired: &Option<FileImage>,
            backup: &Path,
            candidate: &Path,
            metadata_source: Option<&Path>,
            after_capture: impl FnOnce(),
        ) -> Result<()> {
            if !matches(&self.read()?, expected) {
                return Err(Error::stale());
            }
            let backup_name = cstr(backup.as_os_str().as_bytes())?;
            let candidate_name = cstr(candidate.as_os_str().as_bytes())?;
            if let Some(image) = desired {
                let mut output = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(candidate)?;
                // Preserve source ACLs and extended attributes before publishing.
                #[cfg(target_os = "macos")]
                if let Some(source) = match metadata_source {
                    Some(path) => Some(
                        fs::OpenOptions::new()
                            .read(true)
                            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                            .open(path)?,
                    ),
                    None => self.open_file()?,
                } {
                    io_result(unsafe {
                        libc::fcopyfile(
                            source.as_raw_fd(),
                            output.as_raw_fd(),
                            std::ptr::null_mut(),
                            libc::COPYFILE_METADATA,
                        )
                    })?;
                }
                output.write_all(&image.bytes)?;
                output.set_permissions(fs::Permissions::from_mode(image.mode))?;
                output.sync_all()?;
            }
            if let Some(expected_image) = expected {
                rename_exclusive(
                    self.parent.as_raw_fd(),
                    &self.name,
                    libc::AT_FDCWD,
                    &backup_name,
                )?;
                // Directory entries must be durable before installation starts.
                self.parent.sync_all()?;
                directory(backup.parent().unwrap())?.sync_all()?;
                let captured = read_saved(backup, self.allow_binary)?;
                if !captured.same_content(expected_image)
                    || captured.identity != expected_image.identity
                {
                    // Never replace a new file that appeared during capture.
                    let _ = rename_exclusive(
                        libc::AT_FDCWD,
                        &backup_name,
                        self.parent.as_raw_fd(),
                        &self.name,
                    );
                    return Err(Error::stale());
                }
            }
            after_capture();
            if desired.is_some() {
                // RENAME_EXCL / NOREPLACE is the write boundary. A check followed
                // by ordinary rename would overwrite an external replacement.
                rename_exclusive(
                    libc::AT_FDCWD,
                    &candidate_name,
                    self.parent.as_raw_fd(),
                    &self.name,
                )?;
            }
            self.parent.sync_all()?;
            directory(backup.parent().unwrap())?.sync_all()?;
            if !matches(&self.read()?, desired) {
                return Err(Error::stale());
            }
            if let Some(expected) = expected {
                if !read_saved(backup, self.allow_binary)?.same_content(expected) {
                    return Err(Error::new(
                        "CAPTURE_CHANGED",
                        "原文件在操作期间收到后续编辑，内容已保留在恢复副本中。",
                        backup.display(),
                    ));
                }
            }
            Ok(())
        }
    }
    pub fn read_saved(path: &Path, allow_binary: bool) -> Result<FileImage> {
        read_image(
            fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path)?,
            MAX_FILE,
            allow_binary,
        )
    }
    fn rename_exclusive(from_dir: i32, from: &CString, to_dir: i32, to: &CString) -> Result<()> {
        #[cfg(target_os = "macos")]
        let rc = unsafe {
            libc::renameatx_np(
                from_dir,
                from.as_ptr(),
                to_dir,
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(target_os = "linux")]
        let rc = unsafe {
            libc::renameat2(
                from_dir,
                from.as_ptr(),
                to_dir,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        return Err(Error::new(
            "RECOVERY_PLATFORM",
            "此平台尚未验证安全丢弃。",
            "No validated no-replace primitive",
        ));
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        io_result(rc)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn external_creation_after_capture_is_never_overwritten() {
            let temp = tempfile::tempdir().unwrap();
            fs::write(temp.path().join("source"), "original\n").unwrap();
            let file = BoundFile::open(temp.path(), "source").unwrap();
            let before = file.read().unwrap();
            let mut after = before.clone().unwrap();
            after.bytes = b"replacement\n".to_vec();
            let result = file.replace_with(
                &before,
                &Some(after),
                &temp.path().join("saved"),
                &temp.path().join("candidate"),
                None,
                || {
                    fs::write(temp.path().join("source"), "external\n").unwrap();
                },
            );
            assert!(result.is_err());
            assert_eq!(fs::read(temp.path().join("source")).unwrap(), b"external\n");
            assert_eq!(fs::read(temp.path().join("saved")).unwrap(), b"original\n");
        }
        #[test]
        fn late_write_through_original_descriptor_is_reported() {
            let temp = tempfile::tempdir().unwrap();
            fs::write(temp.path().join("source"), "original\n").unwrap();
            let mut writer = fs::OpenOptions::new()
                .write(true)
                .open(temp.path().join("source"))
                .unwrap();
            let file = BoundFile::open(temp.path(), "source").unwrap();
            let before = file.read().unwrap();
            let mut after = before.clone().unwrap();
            after.bytes = b"replacement\n".to_vec();
            let result = file.replace_with(
                &before,
                &Some(after),
                &temp.path().join("saved"),
                &temp.path().join("candidate"),
                None,
                || {
                    writer.write_all(b"new edit\n").unwrap();
                    writer.set_len(9).unwrap();
                },
            );
            assert_eq!(result.unwrap_err().code, "CAPTURE_CHANGED");
            assert_eq!(fs::read(temp.path().join("saved")).unwrap(), b"new edit\n");
        }
        #[test]
        fn replaced_parent_symlink_does_not_redirect_capture() {
            let temp = tempfile::tempdir().unwrap();
            fs::create_dir(temp.path().join("folder")).unwrap();
            fs::create_dir(temp.path().join("outside")).unwrap();
            fs::write(temp.path().join("folder/file"), "inside").unwrap();
            fs::write(temp.path().join("outside/file"), "outside").unwrap();
            let bound = BoundFile::open(temp.path(), "folder/file").unwrap();
            fs::rename(temp.path().join("folder"), temp.path().join("moved")).unwrap();
            std::os::unix::fs::symlink(temp.path().join("outside"), temp.path().join("folder"))
                .unwrap();
            assert!(BoundFile::open(temp.path(), "folder/file").is_err());
            assert_eq!(bound.read().unwrap().unwrap().bytes, b"inside");
            assert_eq!(
                fs::read(temp.path().join("outside/file")).unwrap(),
                b"outside"
            );
        }
    }
}

#[cfg(unix)]
pub(crate) use platform::*;

#[cfg(not(unix))]
mod platform {
    use super::*;
    pub(crate) struct BoundFile;
    pub(crate) struct RecoveryLease;
    impl RecoveryLease {
        pub fn acquire(_: &Path) -> Result<Self> {
            unsupported()
        }
    }
    fn unsupported<T>() -> Result<T> {
        Err(Error::new(
            "RECOVERY_PLATFORM",
            "此平台尚未验证安全丢弃。",
            "No validated no-replace primitive",
        ))
    }
    impl BoundFile {
        pub fn open(_: &Path, _: &str) -> Result<Self> {
            unsupported()
        }
        pub fn with_binary_content(self, _: bool) -> Self {
            self
        }
        pub fn read(&self) -> Result<Option<FileImage>> {
            unsupported()
        }
        pub fn same_parent(&self, _: &Self) -> Result<bool> {
            unsupported()
        }
        pub fn check_volume(&self, _: &Path) -> Result<()> {
            unsupported()
        }
        pub fn replace(
            &self,
            _: &Option<FileImage>,
            _: &Option<FileImage>,
            _: &Path,
            _: &Path,
            _: Option<&Path>,
        ) -> Result<()> {
            unsupported()
        }
    }
    pub fn read_saved(_: &Path, _: bool) -> Result<FileImage> {
        unsupported()
    }
}
#[cfg(not(unix))]
pub(crate) use platform::*;
