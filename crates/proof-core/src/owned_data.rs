//! Delete only Proof-owned recovery entries, with bound directories and no
//! traversal through a symlink. A failed unlink remains a durable cleanup job.
use crate::{Error, Result};
use std::path::Path;

#[cfg(unix)]
mod platform {
    use super::*;
    use std::{
        ffi::{CStr, CString},
        fs::File,
        os::fd::{AsRawFd, FromRawFd},
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };

    pub(crate) struct RecoveryFolder {
        parent: File,
        folder: File,
        name: CString,
    }
    fn child(parent: &File, name: &CString) -> std::io::Result<File> {
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }
    fn directory(path: &Path) -> std::io::Result<File> {
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
    }
    impl RecoveryFolder {
        pub fn acquire_hook_installation(root: &Path, id: &str) -> Result<Option<Self>> {
            uuid::Uuid::parse_str(id).map_err(|_| {
                Error::new(
                    "DATA_CLEANUP_PATH",
                    "Hook 清理路径无效。",
                    "Expected installation UUID",
                )
            })?;
            let parent = match child(&directory(root)?, &CString::new("observer").unwrap())
                .and_then(|folder| child(&folder, &CString::new("installations").unwrap()))
            {
                Ok(parent) => parent,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            Self::leased(parent, CString::new(id).unwrap()).map_err(|error| {
                if error.code == "DATA_INDEX_BUSY" {
                    Error::new(
                        "OBSERVER_INSTALL_BUSY",
                        "Hook 操作尚未结束，请稍后重试清理。",
                        "Hook directory lease unavailable",
                    )
                } else {
                    error
                }
            })
        }
        pub fn delete_hook_installation(&self) -> Result<()> {
            let names = entries(&self.folder)?;
            if names.iter().any(|name| {
                ![
                    "registration.json",
                    "config-backup.json",
                    "receipt.json",
                    ".DS_Store",
                ]
                .contains(&name.as_str())
            }) {
                return Err(Error::new(
                    "DATA_CLEANUP_UNRECOGNIZED",
                    "Hook 备份目录中有未识别内容，清理尚未完成。",
                    "Unknown installation artifact",
                ));
            }
            for name in names {
                unlink(&self.folder, &name, 0)?;
            }
            self.remove_directory()
        }
        fn leased(parent: File, name: CString) -> Result<Option<Self>> {
            let folder = match child(&parent, &name) {
                Ok(folder) => folder,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            if unsafe { libc::flock(folder.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(Error::new(
                    "DATA_INDEX_BUSY",
                    "Git 操作仍在使用临时 Index，稍后会继续清理。",
                    "Private index lease unavailable",
                ));
            }
            Ok(Some(Self {
                parent,
                folder,
                name,
            }))
        }
        pub fn acquire_index(root: &Path, id: &str) -> Result<Option<Self>> {
            let (workspace, index) = index_parts(id)?;
            let data = directory(root)?;
            let parent = match child(&data, &CString::new("transient").unwrap())
                .and_then(|p| child(&p, &CString::new(workspace).unwrap()))
            {
                Ok(value) => value,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            Self::leased(parent, CString::new(index).unwrap())
        }
        pub fn delete_index(&self) -> Result<()> {
            let names = entries(&self.folder)?;
            if names.iter().any(|name| !index_entry(name)) {
                return Err(Error::new(
                    "DATA_CLEANUP_UNRECOGNIZED",
                    "临时 Index 目录包含未识别内容，清理尚未完成。",
                    "Unexpected private index entry",
                ));
            }
            for name in names {
                unlink(&self.folder, &name, 0)?;
            }
            self.remove_directory()
        }
        pub fn acquire(root: &Path, id: &str) -> Result<Option<Self>> {
            uuid::Uuid::parse_str(id).map_err(|_| {
                Error::new(
                    "DATA_CLEANUP_PATH",
                    "恢复副本路径无效，尚未删除磁盘副本。",
                    "Expected recovery UUID",
                )
            })?;
            let data = directory(root)?;
            let parent = match child(&data, &CString::new("recovery").unwrap()) {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            let name = CString::new(id).unwrap();
            let folder = match child(&parent, &name) {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            if unsafe { libc::flock(folder.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(Error::new(
                    "RECOVERY_BUSY",
                    "恢复点仍被另一个 Proof 操作使用，请稍后重试。",
                    "Exclusive recovery lease unavailable",
                ));
            }
            Ok(Some(Self {
                parent,
                folder,
                name,
            }))
        }
        pub fn delete(&self) -> Result<()> {
            for name in [
                "original",
                "discarded-version",
                "new.candidate",
                "undo.candidate",
                ".DS_Store",
            ] {
                unlink(&self.folder, name, 0)?;
            }
            self.remove_directory()
        }
        fn remove_directory(&self) -> Result<()> {
            // A replacement of the directory entry must not redirect rmdir.
            let current = child(&self.parent, &self.name)?;
            let a = current.metadata()?;
            let b = self.folder.metadata()?;
            if a.dev() != b.dev() || a.ino() != b.ino() {
                return Err(Error::new(
                    "DATA_CLEANUP_CHANGED",
                    "恢复目录发生变化，磁盘副本清理尚未完成。",
                    "Recovery folder identity changed",
                ));
            }
            if unsafe {
                libc::unlinkat(
                    self.parent.as_raw_fd(),
                    self.name.as_ptr(),
                    libc::AT_REMOVEDIR,
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            self.parent.sync_all()?;
            Ok(())
        }
    }
    fn entries(folder: &File) -> Result<Vec<String>> {
        // fdopendir owns the duplicate. Independent directory iteration never
        // resolves an untrusted child path or follows a symlink.
        let fd = unsafe { libc::fcntl(folder.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            unsafe { libc::close(fd) };
            return Err(std::io::Error::last_os_error().into());
        }
        let mut names = Vec::new();
        let mut invalid = false;
        loop {
            #[cfg(any(
                target_os = "macos",
                target_os = "ios",
                target_os = "freebsd",
                target_os = "dragonfly"
            ))]
            unsafe {
                *libc::__error() = 0;
            }
            #[cfg(any(target_os = "linux", target_os = "android"))]
            unsafe {
                *libc::__errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                if std::io::Error::last_os_error().raw_os_error().unwrap_or(0) != 0 {
                    invalid = true;
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_str();
            match name {
                Ok("." | "..") => (),
                Ok(name) => names.push(name.into()),
                Err(_) => {
                    invalid = true;
                    break;
                }
            }
            if names.len() > 65_536 {
                invalid = true;
                break;
            }
        }
        unsafe { libc::closedir(stream) };
        if invalid {
            return Err(Error::new(
                "DATA_CLEANUP_RANGE",
                "临时文件目录超出清理范围。",
                "Directory entry limit or non-UTF8 name",
            ));
        }
        Ok(names)
    }
    fn index_parts(id: &str) -> Result<(&str, &str)> {
        let (workspace, index) = id.split_once('/').ok_or_else(|| {
            Error::new(
                "DATA_CLEANUP_PATH",
                "临时 Index 路径无效。",
                "Invalid index ID",
            )
        })?;
        if uuid::Uuid::parse_str(workspace).is_err() || uuid::Uuid::parse_str(index).is_err() {
            return Err(Error::new(
                "DATA_CLEANUP_PATH",
                "临时 Index 路径无效。",
                "Expected index UUIDs",
            ));
        }
        Ok((workspace, index))
    }
    fn ensure_child(parent: &File, name: &str) -> Result<File> {
        let name = CString::new(name).unwrap();
        if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(e.into());
            }
        }
        Ok(child(parent, &name)?)
    }
    pub fn create_index_directory(
        root: &Path,
        workspace: &str,
    ) -> Result<(std::path::PathBuf, RecoveryFolder)> {
        uuid::Uuid::parse_str(workspace)
            .map_err(|_| Error::new("DATA_CLEANUP_PATH", "Worktree 标识无效。", "Expected UUID"))?;
        let data = directory(root)?;
        let cache = ensure_child(&data, "transient")?;
        let parent = ensure_child(&cache, workspace)?;
        let id = uuid::Uuid::new_v4().to_string();
        let _folder = ensure_child(&parent, &id)?;
        let folder =
            RecoveryFolder::leased(parent, CString::new(&*id).unwrap())?.ok_or_else(|| {
                Error::new(
                    "DATA_CLEANUP_CHANGED",
                    "临时 Index 目录已变化。",
                    "Index folder disappeared",
                )
            })?;
        Ok((root.join("transient").join(workspace).join(id), folder))
    }
    pub fn index_workspace_ids(root: &Path) -> Result<Vec<String>> {
        let data = directory(root)?;
        let cache = match child(&data, &CString::new("transient").unwrap()) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e.into()),
        };
        let ids = entries(&cache)?
            .into_iter()
            .filter(|s| s != ".DS_Store")
            .collect::<Vec<_>>();
        if ids.iter().any(|id| uuid::Uuid::parse_str(id).is_err()) {
            return Err(Error::new(
                "DATA_CLEANUP_UNRECOGNIZED",
                "临时 Index 目录包含未识别内容。",
                "Unexpected workspace directory",
            ));
        }
        Ok(ids)
    }
    pub fn remove_index_workspace(root: &Path, workspace: &str) -> Result<()> {
        uuid::Uuid::parse_str(workspace).map_err(|_| {
            Error::new(
                "DATA_CLEANUP_PATH",
                "临时 Index 路径无效。",
                "Expected workspace UUID",
            )
        })?;
        let data = directory(root)?;
        let cache = match child(&data, &CString::new("transient").unwrap()) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let parent = match child(&cache, &CString::new(workspace).unwrap()) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        unlink(&parent, ".DS_Store", 0)?;
        unlink(&cache, workspace, libc::AT_REMOVEDIR)?;
        cache.sync_all()?;
        Ok(())
    }
    pub fn index_directories(root: &Path, workspaces: Option<&[String]>) -> Result<Vec<String>> {
        let data = directory(root)?;
        let cache = match child(&data, &CString::new("transient").unwrap()) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e.into()),
        };
        let mut result = Vec::new();
        for workspace in entries(&cache)? {
            if workspace == ".DS_Store" {
                continue;
            }
            if uuid::Uuid::parse_str(&workspace).is_err() {
                return Err(Error::new(
                    "DATA_CLEANUP_UNRECOGNIZED",
                    "临时 Index 目录包含未识别内容。",
                    "Unexpected workspace directory",
                ));
            }
            if workspaces.is_some_and(|ids| !ids.contains(&workspace)) {
                continue;
            }
            let parent = child(&cache, &CString::new(&*workspace).unwrap())?;
            for index in entries(&parent)? {
                if index == ".DS_Store" {
                    continue;
                }
                if uuid::Uuid::parse_str(&index).is_err() {
                    return Err(Error::new(
                        "DATA_CLEANUP_UNRECOGNIZED",
                        "临时 Index 目录包含未识别内容。",
                        "Unexpected operation directory",
                    ));
                }
                result.push(format!("{workspace}/{index}"));
            }
        }
        Ok(result)
    }
    fn legacy_name(name: &str) -> bool {
        let base = name.strip_suffix(".lock").unwrap_or(name);
        base.strip_prefix(".tmp")
            .is_some_and(|s| s.len() == 6 && s.bytes().all(|b| b.is_ascii_alphanumeric()))
            || shared_index(name)
    }
    fn shared_index(name: &str) -> bool {
        name.strip_prefix("sharedindex.").is_some_and(|s| {
            [40, 64].contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
        })
    }
    fn index_entry(name: &str) -> bool {
        ["index", "index.lock", ".DS_Store"].contains(&name) || shared_index(name)
    }
    pub fn legacy_indexes(root: &Path) -> Result<Vec<String>> {
        Ok(entries(&directory(root)?)?
            .into_iter()
            .filter(|name| legacy_name(name))
            .collect())
    }
    pub fn remove_legacy_index(root: &Path, name: &str) -> Result<()> {
        if !legacy_name(name) {
            return Err(Error::new(
                "DATA_CLEANUP_PATH",
                "旧版临时 Index 路径无效。",
                "Unexpected legacy name",
            ));
        }
        let data = directory(root)?;
        let key = CString::new(name).unwrap();
        match child(&data, &key) {
            Ok(_) => {
                if let Some(folder) = RecoveryFolder::leased(data, key)? {
                    folder.delete_index()?;
                }
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) if e.raw_os_error() == Some(libc::ENOTDIR) => {
                use std::io::Read;
                let fd = unsafe {
                    libc::openat(
                        data.as_raw_fd(),
                        key.as_ptr(),
                        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                let mut file = unsafe { File::from_raw_fd(fd) };
                let meta = file.metadata()?;
                let mut magic = [0; 4];
                let read = file.read(&mut magic)?;
                if !meta.is_file() || (meta.len() > 0 && (read != 4 || &magic != b"DIRC")) {
                    return Err(Error::new(
                        "DATA_CLEANUP_UNRECOGNIZED",
                        "旧版临时文件不是可识别的 Git Index，尚未清理。",
                        "Invalid legacy index header",
                    ));
                }
                unlink(&data, name, 0)?;
                data.sync_all()?;
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    }
    impl Drop for RecoveryFolder {
        fn drop(&mut self) {
            unsafe {
                libc::flock(self.folder.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
    fn unlink(parent: &File, name: &str, flags: i32) -> Result<()> {
        let name = CString::new(name).unwrap();
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error.into());
            }
        }
        Ok(())
    }
    pub fn remove_runtime_file(root: &Path, name: &str) -> Result<()> {
        if ![
            "runtime.json",
            "foreground.json",
            "runtime.pending",
            "foreground.pending",
        ]
        .contains(&name)
        {
            return Err(Error::new(
                "DATA_CLEANUP_PATH",
                "清理记录的路径无效。",
                "Unexpected runtime filename",
            ));
        }
        let data = directory(root)?;
        let parent = match child(&data, &CString::new("observer").unwrap()) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        unlink(&parent, name, 0)?;
        parent.sync_all()?;
        Ok(())
    }
}
#[cfg(not(unix))]
mod platform {
    use super::*;
    pub(crate) struct RecoveryFolder;
    impl RecoveryFolder {
        pub fn acquire_hook_installation(root: &Path, id: &str) -> Result<Option<Self>> {
            uuid::Uuid::parse_str(id).map_err(|_| {
                Error::new(
                    "DATA_CLEANUP_PATH",
                    "Hook 清理路径无效。",
                    "Expected installation UUID",
                )
            })?;
            if !root.join("observer/installations").join(id).try_exists()? {
                return Ok(None);
            }
            Err(Error::new(
                "DATA_CLEANUP_PLATFORM",
                "此平台的 Hook 备份清理尚未验证。",
                "Bound hook cleanup unavailable",
            ))
        }
        pub fn delete_hook_installation(&self) -> Result<()> {
            unreachable!()
        }
        pub fn acquire_index(root: &Path, id: &str) -> Result<Option<Self>> {
            if !root.join("transient").join(id).try_exists()? {
                return Ok(None);
            }
            Err(Error::new(
                "DATA_CLEANUP_PLATFORM",
                "此平台的临时 Index 清理尚未验证。",
                "Bound index cleanup unavailable",
            ))
        }
        pub fn delete_index(&self) -> Result<()> {
            unreachable!()
        }
        pub fn acquire(root: &Path, id: &str) -> Result<Option<Self>> {
            uuid::Uuid::parse_str(id).map_err(|_| {
                Error::new("DATA_CLEANUP_PATH", "恢复副本路径无效。", "Expected UUID")
            })?;
            if !root.join("recovery").join(id).try_exists()? {
                return Ok(None);
            }
            Err(Error::new(
                "DATA_CLEANUP_PLATFORM",
                "此平台的恢复副本清理尚未验证。",
                "Bound directory cleanup unavailable",
            ))
        }
        pub fn delete(&self) -> Result<()> {
            unreachable!()
        }
    }
    pub fn index_directories(root: &Path, workspaces: Option<&[String]>) -> Result<Vec<String>> {
        let cache = root.join("transient");
        if !cache.try_exists()? {
            return Ok(vec![]);
        }
        let mut ids = Vec::new();
        for entry in std::fs::read_dir(cache)? {
            let entry = entry?;
            let workspace = entry.file_name().to_string_lossy().into_owned();
            if workspaces.is_some_and(|ids| !ids.contains(&workspace)) {
                continue;
            }
            if !entry.file_type()?.is_dir() {
                continue;
            }
            for operation in std::fs::read_dir(entry.path())? {
                let operation = operation?;
                ids.push(format!(
                    "{workspace}/{}",
                    operation.file_name().to_string_lossy()
                ));
            }
        }
        Ok(ids)
    }
    pub fn index_workspace_ids(root: &Path) -> Result<Vec<String>> {
        let cache = root.join("transient");
        if !cache.try_exists()? {
            return Ok(vec![]);
        }
        Ok(std::fs::read_dir(cache)?
            .map(|e| e.map(|v| v.file_name().to_string_lossy().into_owned()))
            .collect::<std::io::Result<Vec<_>>>()?)
    }
    pub fn remove_index_workspace(_: &Path, _: &str) -> Result<()> {
        Err(Error::new(
            "DATA_CLEANUP_PLATFORM",
            "此平台的临时 Index 清理尚未验证。",
            "Bound index directory cleanup unavailable",
        ))
    }
    pub fn legacy_indexes(root: &Path) -> Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in std::fs::read_dir(root)? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if name.starts_with(".tmp") || name.starts_with("sharedindex.") {
                names.push(name);
            }
        }
        Ok(names)
    }
    pub fn remove_legacy_index(_: &Path, _: &str) -> Result<()> {
        Err(Error::new(
            "DATA_CLEANUP_PLATFORM",
            "此平台的旧版 Index 清理尚未验证。",
            "Bound legacy cleanup unavailable",
        ))
    }
    pub fn remove_runtime_file(root: &Path, name: &str) -> Result<()> {
        if ![
            "runtime.json",
            "foreground.json",
            "runtime.pending",
            "foreground.pending",
        ]
        .contains(&name)
        {
            return Err(Error::new(
                "DATA_CLEANUP_PATH",
                "清理记录的路径无效。",
                "Unexpected runtime filename",
            ));
        }
        if !root.join("observer").join(name).try_exists()? {
            return Ok(());
        }
        Err(Error::new(
            "DATA_CLEANUP_PLATFORM",
            "此平台的运行记录清理尚未验证。",
            "Bound directory cleanup unavailable",
        ))
    }
}
pub(crate) use platform::*;
