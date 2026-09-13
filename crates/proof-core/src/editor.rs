//! Explicit handoff of a current Worktree file to a user-configured application.
//! The app owns editing after handoff. Identity checks do not certify publishers.
use crate::{
    fingerprint,
    program::{program_identity, resolve_program_path, trusted_program_workspace},
    store::Store,
    Error, Proof, Result, Workspace,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const REVISION: &str = "editor:revision";
const APPLICATION: &str = "editor:application";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorApplication {
    pub path: String,
    pub name: String,
    pub bundle_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum EditorChoice {
    Inherit,
    Disabled,
    Application { application: EditorApplication },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorScope {
    Application,
    Repository,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorMode {
    Inherit,
    Disabled,
    Application,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorUpdate {
    pub scope: EditorScope,
    pub mode: EditorMode,
    pub path: Option<String>,
    pub expected_revision: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    pub revision: u64,
    pub application: EditorChoice,
    pub repository: Option<EditorChoice>,
    pub effective: Option<EditorApplication>,
    pub source: EditorScope,
    pub platform: &'static str,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorOpenResult {
    pub application: EditorApplication,
    pub path: String,
    pub message: String,
}

impl Proof {
    pub fn editor_settings(&self, workspace_id: Option<&str>) -> Result<EditorSettings> {
        let workspace = workspace_id
            .map(|id| self.store.workspace(id))
            .transpose()?;
        let transaction =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Deferred)?;
        read_settings(&transaction, workspace.as_ref())
    }
    pub fn set_editor_settings(
        &self,
        workspace_id: Option<&str>,
        update: EditorUpdate,
    ) -> Result<EditorSettings> {
        let workspace = workspace_id
            .map(|id| self.store.workspace(id))
            .transpose()?;
        let key = match update.scope {
            EditorScope::Application => APPLICATION.into(),
            EditorScope::Repository => repository_key(workspace.as_ref().ok_or_else(|| {
                Error::new(
                    "EDITOR_SCOPE",
                    "请先打开仓库。",
                    "Repository scope needs a workspace",
                )
            })?),
        };
        let choice = match update.mode {
            EditorMode::Inherit if matches!(update.scope, EditorScope::Repository) => {
                EditorChoice::Inherit
            }
            EditorMode::Inherit => {
                return Err(Error::new(
                    "EDITOR_SCOPE",
                    "应用默认不能继承仓库设置。",
                    "Application scope cannot inherit",
                ))
            }
            EditorMode::Disabled => EditorChoice::Disabled,
            EditorMode::Application => {
                let path = update.path.as_deref().ok_or_else(|| {
                    Error::new(
                        "EDITOR_APPLICATION_MISSING",
                        "请选择外部编辑器。",
                        "Application path is required",
                    )
                })?;
                let checked = inspect_application(path)?;
                check_application_trust(&self.store, &checked)?;
                EditorChoice::Application {
                    application: checked.application,
                }
            }
        };
        let transaction =
            Transaction::new_unchecked(&self.store.connection, TransactionBehavior::Immediate)?;
        let revision = revision(&transaction)?;
        if revision != update.expected_revision {
            return Err(Error::new(
                "EDITOR_SETTINGS_CHANGED",
                "编辑器设置已在其他窗口更新，请重新读取。",
                "Settings revision mismatch",
            ));
        }
        let next = revision.checked_add(1).ok_or_else(|| {
            Error::new(
                "EDITOR_SETTINGS_INVALID",
                "编辑器设置无法保存。",
                "Revision exhausted",
            )
        })?;
        transaction.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&key, &serde_json::to_string(&choice)?])?;
        transaction.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [REVISION, &next.to_string()])?;
        let result = read_settings(&transaction, workspace.as_ref())?;
        transaction.commit()?;
        Ok(result)
    }
    pub fn prepare_editor_open(&self, snapshot_id: &str) -> Result<EditorOpenRequest> {
        let diff = self.snapshot(snapshot_id)?;
        let workspace = self.store.workspace(&diff.workspace_id)?;
        require_workspace_trust(&workspace)?;
        let settings = self.editor_settings(Some(&workspace.id))?;
        let application = settings.effective.ok_or_else(|| {
            Error::new(
                "EDITOR_NOT_CONFIGURED",
                "请先选择外部编辑器。",
                "No effective editor application",
            )
        })?;
        let checked = inspect_application(&application.path)?;
        check_application_trust(&self.store, &checked)?;
        let target = inspect_target(&workspace, &diff.path)?;
        Ok(EditorOpenRequest {
            data_directory: self.data_dir.clone(),
            workspace_id: workspace.id,
            relative_path: diff.path,
            revision: settings.revision,
            application: checked.application,
            application_identity: checked.identity,
            target_identity: target.identity,
            _target_handle: target._handle,
        })
    }
}

/// Own data so the launcher can run outside the desktop's Git mutex.
pub struct EditorOpenRequest {
    data_directory: PathBuf,
    workspace_id: String,
    relative_path: String,
    revision: u64,
    application: EditorApplication,
    application_identity: String,
    target_identity: String,
    _target_handle: fs::File,
}
impl EditorOpenRequest {
    pub fn run(self) -> Result<EditorOpenResult> {
        self.handoff(|application, path| {
            #[cfg(target_os = "macos")]
            {
                let mut command = Command::new("/usr/bin/open");
                command.arg("-a").arg(&application.path).arg(path);
                let output = crate::process::run(command, None, Duration::from_secs(10)).map_err(
                    |error| {
                        Error::new(
                            "EDITOR_LAUNCH_FAILED",
                            "无法启动外部编辑器，请检查应用是否可用。",
                            error,
                        )
                    },
                )?;
                if output.code != 0 {
                    return Err(Error::new(
                        "EDITOR_LAUNCH_FAILED",
                        "编辑器未能打开文件，请检查应用是否可用。",
                        String::from_utf8_lossy(&output.stderr),
                    ));
                }
                Ok(())
            }
            #[cfg(windows)]
            {
                // Absolute literal path, no command string or shell association.
                Command::new(&application.path)
                    .arg(path)
                    .spawn()
                    .map_err(|error| {
                        Error::new("EDITOR_LAUNCH_FAILED", "无法启动外部编辑器。", error)
                    })?;
                Ok(())
            }
            #[cfg(not(any(target_os = "macos", windows)))]
            {
                let _ = (application, path);
                Err(Error::new(
                    "EDITOR_PLATFORM",
                    "当前平台尚不支持外部编辑器。",
                    std::env::consts::OS,
                ))
            }
        })
    }
    fn handoff(
        self,
        launch: impl FnOnce(&EditorApplication, &Path) -> Result<()>,
    ) -> Result<EditorOpenResult> {
        let store = Store::open(&self.data_directory)?;
        let workspace = store.workspace(&self.workspace_id)?;
        require_workspace_trust(&workspace)?;
        let transaction =
            Transaction::new_unchecked(&store.connection, TransactionBehavior::Deferred)?;
        let settings = read_settings(&transaction, Some(&workspace))?;
        if settings.revision != self.revision
            || settings.effective.as_ref().map(|app| &app.path) != Some(&self.application.path)
        {
            return Err(Error::new(
                "EDITOR_SETTINGS_CHANGED",
                "编辑器设置已变化，请重新打开文件。",
                "Queued handoff configuration changed",
            ));
        }
        transaction.commit()?;
        let checked = inspect_application(&self.application.path)?;
        check_application_trust(&store, &checked)?;
        if checked.identity != self.application_identity {
            return Err(Error::new(
                "EDITOR_APPLICATION_CHANGED",
                "编辑器应用已变化，请重新打开文件。",
                "Application was replaced after the click",
            ));
        }
        let target = inspect_target(&workspace, &self.relative_path)?;
        if target.identity != self.target_identity {
            return Err(Error::new(
                "EDITOR_FILE_CHANGED",
                "文件已被替换，请重新打开。",
                "Target file identity changed",
            ));
        }
        // Validation may inspect several filesystem locations. Recheck the
        // saved choice and trust immediately before the external handoff.
        require_workspace_trust(&store.workspace(&self.workspace_id)?)?;
        if revision(&store.connection)? != self.revision {
            return Err(Error::new(
                "EDITOR_SETTINGS_CHANGED",
                "编辑器设置已变化，请重新打开文件。",
                "Configuration changed during validation",
            ));
        }
        // This is a path handoff: the receiving editor resolves the path after
        // our final checks and owns all subsequent edits and extension behavior.
        launch(&checked.application, &target.path)?;
        Ok(EditorOpenResult {
            message: format!(
                "已交给 {} 打开 {}",
                checked.application.name, self.relative_path
            ),
            application: checked.application,
            path: target.path.to_string_lossy().into_owned(),
        })
    }
}

fn require_workspace_trust(workspace: &Workspace) -> Result<()> {
    if !workspace.trusted {
        return Err(Error::new(
            "TRUST_REQUIRED",
            "信任仓库后可在外部编辑器打开文件。",
            "External editors may run workspace extensions",
        ));
    }
    Ok(())
}
fn repository_key(workspace: &Workspace) -> String {
    format!("editor:repository:{}", workspace.repository_id)
}
fn revision(connection: &Connection) -> Result<u64> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM settings WHERE key=?",
            [REVISION],
            |row| row.get(0),
        )
        .optional()?;
    value
        .as_deref()
        .unwrap_or("0")
        .parse()
        .map_err(|error| Error::new("EDITOR_SETTINGS_INVALID", "编辑器设置无法读取。", error))
}
fn choice(connection: &Connection, key: &str, default: EditorChoice) -> Result<EditorChoice> {
    let value: Option<String> = connection
        .query_row("SELECT value FROM settings WHERE key=?", [key], |row| {
            row.get(0)
        })
        .optional()?;
    value
        .map(|value| serde_json::from_str(&value).map_err(Error::from))
        .unwrap_or(Ok(default))
}
fn read_settings(connection: &Connection, workspace: Option<&Workspace>) -> Result<EditorSettings> {
    let revision = revision(connection)?;
    let application = choice(connection, APPLICATION, EditorChoice::Disabled)?;
    let repository = workspace
        .map(|workspace| {
            choice(
                connection,
                &repository_key(workspace),
                EditorChoice::Inherit,
            )
        })
        .transpose()?;
    let (effective, source) = match &repository {
        None | Some(EditorChoice::Inherit) => (&application, EditorScope::Application),
        Some(choice) => (choice, EditorScope::Repository),
    };
    let effective = match effective {
        EditorChoice::Application { application } => Some(application.clone()),
        _ => None,
    };
    Ok(EditorSettings {
        revision,
        application,
        repository,
        effective,
        source,
        platform: std::env::consts::OS,
    })
}

struct CheckedApplication {
    application: EditorApplication,
    identity: String,
    origins: Vec<PathBuf>,
}
fn check_application_trust(store: &Store, application: &CheckedApplication) -> Result<()> {
    let workspaces = store.workspaces()?;
    for origin in &application.origins {
        trusted_program_workspace(store, origin, &workspaces)?;
    }
    Ok(())
}
fn inspect_application(path: &str) -> Result<CheckedApplication> {
    let requested = Path::new(path);
    if !requested.is_absolute() || path.contains('\0') || path.len() > 32768 {
        return Err(Error::new(
            "EDITOR_APPLICATION_PATH",
            "请选择编辑器应用的绝对路径。",
            "Invalid application path",
        ));
    }
    let (path, mut origins) = resolve_program_path(requested).map_err(|error| {
        Error::new(
            "EDITOR_APPLICATION_MISSING",
            "找不到所选编辑器应用。",
            error,
        )
    })?;
    #[cfg(target_os = "macos")]
    {
        if !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
            || !path.is_dir()
        {
            return Err(Error::new(
                "EDITOR_APPLICATION_TYPE",
                "请选择 .app 编辑器应用。",
                "Expected a macOS application bundle",
            ));
        }
        let (plist, links) = resolve_program_path(&path.join("Contents/Info.plist"))?;
        origins.extend(links);
        origins.push(
            plist
                .parent()
                .ok_or_else(|| {
                    Error::new(
                        "EDITOR_APPLICATION_PATH",
                        "应用信息文件的路径无效。",
                        "Metadata has no parent",
                    )
                })?
                .to_owned(),
        );
        if !plist.starts_with(&path) {
            return Err(Error::new(
                "EDITOR_APPLICATION_PATH",
                "应用的配置文件超出包目录。",
                "Bundle metadata path escaped",
            ));
        }
        let bytes = read_small_regular(&plist)?;
        let dictionary = crate::editor_metadata::application_fields(&bytes)?;
        let value = |key: &str| dictionary.get(key).map(String::as_str);
        if value("CFBundlePackageType") != Some("APPL") {
            return Err(Error::new(
                "EDITOR_APPLICATION_TYPE",
                "请选择可启动的编辑器应用。",
                "Bundle is not APPL",
            ));
        }
        let executable = value("CFBundleExecutable").ok_or_else(|| {
            Error::new(
                "EDITOR_APPLICATION_INVALID",
                "应用缺少可执行文件。",
                "No CFBundleExecutable",
            )
        })?;
        if Path::new(executable).components().count() != 1
            || !matches!(
                Path::new(executable).components().next(),
                Some(std::path::Component::Normal(_))
            )
        {
            return Err(Error::new(
                "EDITOR_APPLICATION_PATH",
                "应用的程序路径无效。",
                "Bundle executable must be one filename",
            ));
        }
        let (executable, links) =
            resolve_program_path(&path.join("Contents/MacOS").join(executable))?;
        origins.extend(links);
        if !executable.starts_with(&path) {
            return Err(Error::new(
                "EDITOR_APPLICATION_PATH",
                "应用的程序超出包目录。",
                "Bundle executable path escaped",
            ));
        }
        origins.push(executable.parent().unwrap().to_owned());
        let program = program_identity(&executable)?;
        let path_string = path
            .to_str()
            .ok_or_else(|| {
                Error::new(
                    "EDITOR_APPLICATION_PATH",
                    "应用路径不是 UTF-8。",
                    "Non-UTF8 application path",
                )
            })?
            .to_string();
        let name = value("CFBundleDisplayName")
            .or_else(|| value("CFBundleName"))
            .or_else(|| path.file_stem().and_then(|name| name.to_str()))
            .unwrap_or("Editor");
        let name: String = name.chars().filter(|c| !c.is_control()).take(120).collect();
        let identity = fingerprint(&[path_string.as_bytes(), &bytes, program.as_bytes()]);
        origins.sort();
        origins.dedup();
        Ok(CheckedApplication {
            application: EditorApplication {
                path: path_string,
                name,
                bundle_id: value("CFBundleIdentifier")
                    .map(|value| value.chars().take(255).collect()),
            },
            identity,
            origins,
        })
    }
    #[cfg(windows)]
    {
        if !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        {
            return Err(Error::new(
                "EDITOR_APPLICATION_TYPE",
                "请选择编辑器的 .exe 程序。",
                "Expected an executable",
            ));
        }
        origins.push(path.parent().unwrap().to_owned());
        let identity = program_identity(&path)?;
        Ok(CheckedApplication {
            application: EditorApplication {
                path: path.to_string_lossy().into_owned(),
                name: path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                bundle_id: None,
            },
            identity,
            origins,
        })
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (path, origins);
        Err(Error::new(
            "EDITOR_PLATFORM",
            "当前平台尚不支持外部编辑器。",
            std::env::consts::OS,
        ))
    }
}
fn read_small_regular(path: &Path) -> Result<Vec<u8>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() > 1024 * 1024 {
        return Err(Error::new(
            "EDITOR_APPLICATION_INVALID",
            "应用信息文件过大或格式不受支持。",
            "Bundle metadata must be a regular file under 1 MiB",
        ));
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(Error::new(
            "EDITOR_APPLICATION_INVALID",
            "应用信息文件过大。",
            "Metadata grew beyond the limit",
        ));
    }
    Ok(bytes)
}

struct CheckedTarget {
    path: PathBuf,
    identity: String,
    _handle: fs::File,
}
fn inspect_target(workspace: &Workspace, relative: &str) -> Result<CheckedTarget> {
    let path = crate::git::checked_path(workspace, relative)?;
    if path.starts_with(&workspace.git_dir) || path.starts_with(&workspace.common_dir) {
        return Err(Error::new(
            "EDITOR_FILE_PATH",
            "不能将 Git 内部文件作为代码打开。",
            "Git metadata target",
        ));
    }
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::new(
                "EDITOR_FILE_MISSING",
                "Worktree 中已没有这个文件。",
                relative,
            ))
        }
        Err(error) => return Err(error.into()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(Error::new(
                "EDITOR_FILE_PATH",
                "请直接打开目标文件，当前路径是符号链接。",
                relative,
            ))
        }
        Ok(_) => (),
    }
    #[cfg(unix)]
    let handle = crate::guarded_file::BoundFile::open(Path::new(&workspace.path), relative)
        .and_then(|bound| bound.open_file())
        .map_err(|error| {
            Error::new(
                "EDITOR_FILE_PATH",
                "文件路径已变化或经过符号链接，请检查后重试。",
                error,
            )
        })?
        .ok_or_else(|| {
            Error::new(
                "EDITOR_FILE_MISSING",
                "Worktree 中已没有这个文件。",
                relative,
            )
        })?;
    #[cfg(not(unix))]
    let handle = {
        let mut cursor = PathBuf::from(&workspace.path);
        for part in Path::new(relative).components() {
            cursor.push(part);
            if fs::symlink_metadata(&cursor)?.file_type().is_symlink() {
                return Err(Error::new(
                    "EDITOR_FILE_PATH",
                    "文件路径经过符号链接。",
                    relative,
                ));
            }
        }
        fs::File::open(&path)?
    };
    let metadata = handle.metadata()?;
    if !metadata.is_file() {
        return Err(Error::new(
            "EDITOR_FILE_TYPE",
            "只能在编辑器中打开普通文件。",
            relative,
        ));
    }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(Error::new(
                "EDITOR_FILE_TYPE",
                "此文件有硬链接，请在编辑器中手动打开。",
                relative,
            ));
        }
        format!("{}:{}", metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let identity = format!("{:?}:{:?}", metadata.created()?, path);
    Ok(CheckedTarget {
        path,
        identity,
        _handle: handle,
    })
}

/// Discovery reads known application locations; it never launches applications.
pub fn editor_applications() -> Vec<EditorApplication> {
    let mut paths = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let mut roots = vec![
            PathBuf::from("/Applications"),
            PathBuf::from("/System/Applications"),
        ];
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(PathBuf::from(home).join("Applications"));
        }
        for root in roots {
            for name in [
                "Zed.app",
                "Visual Studio Code.app",
                "Cursor.app",
                "Sublime Text.app",
                "IntelliJ IDEA.app",
                "WebStorm.app",
                "TextEdit.app",
            ] {
                paths.push(root.join(name));
            }
        }
    }
    #[cfg(windows)]
    {
        for variable in ["LOCALAPPDATA", "ProgramFiles"] {
            if let Some(root) = std::env::var_os(variable) {
                for path in [
                    "Programs/Microsoft VS Code/Code.exe",
                    "Microsoft VS Code/Code.exe",
                    "Programs/Zed/zed.exe",
                ] {
                    paths.push(PathBuf::from(&root).join(path));
                }
            }
        }
    }
    let mut applications: Vec<_> = paths
        .iter()
        .filter_map(|path| {
            path.to_str()
                .and_then(|path| inspect_application(path).ok())
                .map(|checked| checked.application)
        })
        .collect();
    applications.sort_by(|a, b| a.name.cmp(&b.name));
    applications.dedup_by(|a, b| a.path == b.path);
    applications
}

#[cfg(all(test, target_os = "macos"))]
#[path = "editor_tests.rs"]
mod tests;
