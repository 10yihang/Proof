use super::*;
use crate::Side;
use std::{
    cell::Cell,
    os::unix::fs::{symlink, PermissionsExt},
};

struct Fixture {
    _root: tempfile::TempDir,
    repo: PathBuf,
    app: PathBuf,
    data: PathBuf,
    proof: Proof,
    workspace: Workspace,
}
fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}
fn application(path: &Path) {
    fs::create_dir_all(path.join("Contents/MacOS")).unwrap();
    fs::write(path.join("Contents/Info.plist"),br#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>fixture-editor</string><key>CFBundleName</key><string>Fixture Editor</string><key>CFBundleIdentifier</key><string>dev.proof.fixture-editor</string></dict></plist>"#).unwrap();
    let program = path.join("Contents/MacOS/fixture-editor");
    fs::write(&program, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(program, fs::Permissions::from_mode(0o700)).unwrap();
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let (repo, app, data) = (
            root.path().join("repo"),
            root.path().join("Fixture Editor.app"),
            root.path().join("data"),
        );
        fs::create_dir(&repo).unwrap();
        application(&app);
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Proof Editor Test"]);
        git(&repo, &["config", "user.email", "editor@example.invalid"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        git(
            &repo,
            &[
                "config",
                "core.hooksPath",
                repo.join(".git/hooks").to_str().unwrap(),
            ],
        );
        fs::create_dir(repo.join("src")).unwrap();
        fs::write(repo.join("src/code.txt"), "original\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "Initial"]);
        fs::write(repo.join("src/code.txt"), "current Worktree\n").unwrap();
        let mut proof = Proof::open(&data).unwrap();
        let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
        proof.set_trust(&workspace.id, true).unwrap();
        Self {
            _root: root,
            repo,
            app,
            data,
            proof,
            workspace,
        }
    }
    fn configure(&self) -> EditorSettings {
        self.proof
            .set_editor_settings(
                Some(&self.workspace.id),
                EditorUpdate {
                    scope: EditorScope::Application,
                    mode: EditorMode::Application,
                    path: Some(self.app.to_str().unwrap().into()),
                    expected_revision: self.proof.editor_settings(None).unwrap().revision,
                },
            )
            .unwrap()
    }
    fn job(&mut self) -> EditorOpenRequest {
        let diff = self
            .proof
            .file_diff(&self.workspace.id, "src/code.txt", Side::Unstaged)
            .unwrap();
        self.proof.prepare_editor_open(&diff.id).unwrap()
    }
}

#[test]
fn settings_inherit_by_repository_and_persist_without_touching_git() {
    let mut f = Fixture::new();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let config = fs::read(f.repo.join(".git/config")).unwrap();
    assert!(f
        .proof
        .editor_settings(Some(&f.workspace.id))
        .unwrap()
        .effective
        .is_none());
    let first = f.configure();
    assert_eq!(first.effective.unwrap().name, "Fixture Editor");
    let linked = f._root.path().join("linked");
    git(
        &f.repo,
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    );
    let linked = f.proof.open_workspace(linked.to_str().unwrap()).unwrap();
    let independent = f._root.path().join("clone");
    git(
        &f.repo,
        &[
            "clone",
            f.repo.to_str().unwrap(),
            independent.to_str().unwrap(),
        ],
    );
    let independent = f
        .proof
        .open_workspace(independent.to_str().unwrap())
        .unwrap();
    let second = f
        .proof
        .set_editor_settings(
            Some(&f.workspace.id),
            EditorUpdate {
                scope: EditorScope::Repository,
                mode: EditorMode::Disabled,
                path: None,
                expected_revision: first.revision,
            },
        )
        .unwrap();
    assert!(second.effective.is_none());
    assert!(f
        .proof
        .editor_settings(Some(&linked.id))
        .unwrap()
        .effective
        .is_none());
    assert!(f
        .proof
        .editor_settings(Some(&independent.id))
        .unwrap()
        .effective
        .is_some());
    let reopened = Proof::open(&f.data).unwrap();
    assert!(reopened
        .editor_settings(Some(&linked.id))
        .unwrap()
        .effective
        .is_none());
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(f.repo.join(".git/config")).unwrap(), config);
}

#[test]
fn settings_conflict_and_storage_failure_leave_saved_choice_intact() {
    let f = Fixture::new();
    let first = f.configure();
    let stale = f
        .proof
        .set_editor_settings(
            None,
            EditorUpdate {
                scope: EditorScope::Application,
                mode: EditorMode::Disabled,
                path: None,
                expected_revision: 0,
            },
        )
        .unwrap_err();
    assert_eq!(stale.code, "EDITOR_SETTINGS_CHANGED");
    f.proof.store.connection.execute_batch("CREATE TRIGGER deny_editor BEFORE UPDATE ON settings WHEN OLD.key='editor:application' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;").unwrap();
    assert!(f
        .proof
        .set_editor_settings(
            None,
            EditorUpdate {
                scope: EditorScope::Application,
                mode: EditorMode::Disabled,
                path: None,
                expected_revision: first.revision
            }
        )
        .is_err());
    let after = f.proof.editor_settings(None).unwrap();
    assert_eq!(after.revision, first.revision);
    assert!(after.effective.is_some());
}

#[test]
fn handoff_uses_current_worktree_and_literal_paths_without_review_or_git_writes() {
    let mut f = Fixture::new();
    f.configure();
    git(&f.repo, &["add", "src/code.txt"]);
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "src/code.txt", Side::Staged)
        .unwrap();
    fs::write(f.repo.join("src/code.txt"), "newer than the Staged Diff\n").unwrap();
    let job = f.proof.prepare_editor_open(&diff.id).unwrap();
    let index = fs::read(f.repo.join(".git/index")).unwrap();
    let result = job
        .handoff(|app, path| {
            assert_eq!(app.name, "Fixture Editor");
            assert_eq!(
                fs::read_to_string(path).unwrap(),
                "newer than the Staged Diff\n"
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(
        result.path,
        f.repo
            .join("src/code.txt")
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert_eq!(fs::read(f.repo.join(".git/index")).unwrap(), index);
    for path in ["-option.txt", "中文 空格.txt", "line\nbreak.txt"] {
        fs::write(f.repo.join(path), "literal\n").unwrap();
        let diff = f
            .proof
            .file_diff(&f.workspace.id, path, Side::Unstaged)
            .unwrap();
        f.proof
            .prepare_editor_open(&diff.id)
            .unwrap()
            .handoff(|_, actual| {
                assert_eq!(actual, f.repo.join(path).canonicalize().unwrap());
                Ok(())
            })
            .unwrap();
    }
    let count: i64 = f
        .proof
        .store
        .connection
        .query_row("SELECT count(*) FROM review_marks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn queued_handoff_checks_settings_trust_program_and_target_replacement() {
    let mut f = Fixture::new();
    f.configure();
    let job = f.job();
    let settings = f.proof.editor_settings(None).unwrap();
    f.proof
        .set_editor_settings(
            None,
            EditorUpdate {
                scope: EditorScope::Application,
                mode: EditorMode::Disabled,
                path: None,
                expected_revision: settings.revision,
            },
        )
        .unwrap();
    assert_eq!(
        job.handoff(|_, _| panic!("must not launch"))
            .unwrap_err()
            .code,
        "EDITOR_SETTINGS_CHANGED"
    );
    f.configure();
    let job = f.job();
    f.proof.set_trust(&f.workspace.id, false).unwrap();
    assert_eq!(
        job.handoff(|_, _| panic!("must not launch"))
            .unwrap_err()
            .code,
        "TRUST_REQUIRED"
    );
    f.proof.set_trust(&f.workspace.id, true).unwrap();
    let job = f.job();
    fs::write(
        f.app.join("Contents/MacOS/fixture-editor"),
        "#!/bin/sh\nexit 1\n",
    )
    .unwrap();
    assert_eq!(
        job.handoff(|_, _| panic!("must not launch"))
            .unwrap_err()
            .code,
        "EDITOR_APPLICATION_CHANGED"
    );
    let job = f.job();
    let candidate = f.repo.join("replacement");
    fs::write(&candidate, "replaced\n").unwrap();
    fs::rename(candidate, f.repo.join("src/code.txt")).unwrap();
    assert_eq!(
        job.handoff(|_, _| panic!("must not launch"))
            .unwrap_err()
            .code,
        "EDITOR_FILE_CHANGED"
    );
}

#[test]
fn symlinks_hardlinks_missing_files_and_git_metadata_are_not_handed_off() {
    let mut f = Fixture::new();
    f.configure();
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "src/code.txt", Side::Unstaged)
        .unwrap();
    fs::remove_file(f.repo.join("src/code.txt")).unwrap();
    assert_eq!(
        f.proof.prepare_editor_open(&diff.id).err().unwrap().code,
        "EDITOR_FILE_MISSING"
    );
    let outside = f._root.path().join("outside.txt");
    fs::write(&outside, "outside\n").unwrap();
    symlink(&outside, f.repo.join("src/code.txt")).unwrap();
    assert_eq!(
        f.proof.prepare_editor_open(&diff.id).err().unwrap().code,
        "EDITOR_FILE_PATH"
    );
    fs::remove_file(f.repo.join("src/code.txt")).unwrap();
    fs::hard_link(&outside, f.repo.join("src/code.txt")).unwrap();
    assert_eq!(
        f.proof.prepare_editor_open(&diff.id).err().unwrap().code,
        "EDITOR_FILE_TYPE"
    );
    fs::remove_file(f.repo.join("src/code.txt")).unwrap();
    fs::remove_dir(f.repo.join("src")).unwrap();
    let directory = f._root.path().join("outside");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("code.txt"), "outside\n").unwrap();
    symlink(&directory, f.repo.join("src")).unwrap();
    assert!(f.proof.prepare_editor_open(&diff.id).is_err());
    assert!(inspect_target(&f.workspace, ".git/config").is_err());
    assert!(inspect_target(&f.workspace, "../outside.txt").is_err());
}

#[test]
fn only_configured_applications_are_allowed_and_app_links_keep_workspace_trust() {
    let mut f = Fixture::new();
    let called = Cell::new(false);
    let diff = f
        .proof
        .file_diff(&f.workspace.id, "src/code.txt", Side::Unstaged)
        .unwrap();
    assert_eq!(
        f.proof.prepare_editor_open(&diff.id).err().unwrap().code,
        "EDITOR_NOT_CONFIGURED"
    );
    assert!(inspect_application("relative.app").is_err());
    assert!(inspect_application("/bin/sh").is_err());
    let nested = f.repo.join("Editor.app");
    application(&nested);
    f.proof.set_trust(&f.workspace.id, false).unwrap();
    let link = f._root.path().join("link.app");
    symlink(&nested, &link).unwrap();
    assert_eq!(
        f.proof
            .set_editor_settings(
                None,
                EditorUpdate {
                    scope: EditorScope::Application,
                    mode: EditorMode::Application,
                    path: Some(link.to_str().unwrap().into()),
                    expected_revision: 0
                }
            )
            .unwrap_err()
            .code,
        "TRUST_REQUIRED"
    );
    f.proof.set_trust(&f.workspace.id, true).unwrap();
    f.configure();
    f.job()
        .handoff(|_, _| {
            called.set(true);
            Ok(())
        })
        .unwrap();
    assert!(called.get());
}

#[test]
fn standards_bundle_metadata_target_inside_untrusted_repository_must_be_rejected() {
    let mut f = Fixture::new();
    let metadata = f.app.join("Metadata");
    fs::create_dir(&metadata).unwrap();
    git(&metadata, &["init", "-b", "main"]);
    fs::rename(
        f.app.join("Contents/Info.plist"),
        metadata.join("Info.plist"),
    )
    .unwrap();
    symlink("../Metadata/Info.plist", f.app.join("Contents/Info.plist")).unwrap();
    let metadata_workspace = f.proof.open_workspace(metadata.to_str().unwrap()).unwrap();
    assert!(!metadata_workspace.trusted);
    let result = f.proof.set_editor_settings(
        None,
        EditorUpdate {
            scope: EditorScope::Application,
            mode: EditorMode::Application,
            path: Some(f.app.to_str().unwrap().into()),
            expected_revision: 0,
        },
    );
    eprintln!(
        "metadata workspace trusted={}, setting result={:?}",
        metadata_workspace.trusted, result
    );
    assert_eq!(result.unwrap_err().code, "TRUST_REQUIRED");
}

#[test]
fn shared_binary_metadata_references_are_bounded_before_handoff() {
    let f = Fixture::new();
    let encoded = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fixtures/amplified-info.plist"
    ));
    assert!(encoded.len() < 2048);
    fs::write(f.app.join("Contents/Info.plist"), encoded).unwrap();
    assert_eq!(
        inspect_application(f.app.to_str().unwrap())
            .err()
            .unwrap()
            .code,
        "EDITOR_APPLICATION_INVALID"
    );
}

#[test]
fn metadata_depth_events_and_duplicate_fields_have_explicit_limits() {
    use crate::editor_metadata::application_fields;
    let xml = |body: &str| {
        format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict>{body}</dict></plist>")
    };
    let valid=xml("<key>CFBundleName</key><string>Editor</string><key>extra</key><array><dict><key>nested</key><true/></dict></array>");
    assert_eq!(
        application_fields(valid.as_bytes()).unwrap()["CFBundleName"],
        "Editor"
    );
    let duplicate =
        xml("<key>CFBundleName</key><string>A</string><key>CFBundleName</key><string>B</string>");
    assert!(application_fields(duplicate.as_bytes()).is_err());
    // Real application bundles can repeat metadata that does not affect launch.
    // A nested name must not replace the top-level editor identity.
    let unrelated_duplicates = xml(concat!(
        "<key>CFBundleName</key><string>Editor</string>",
        "<key>CFBundleDocumentTypes</key><array/>",
        "<key>CFBundleDocumentTypes</key><array><dict>",
        "<key>CFBundleName</key><string>Nested</string></dict></array>",
        "<key>NSCameraUsageDescription</key><string>First</string>",
        "<key>NSCameraUsageDescription</key><string>Second</string>"
    ));
    assert_eq!(
        application_fields(unrelated_duplicates.as_bytes()).unwrap()["CFBundleName"],
        "Editor"
    );
    let deep = xml(&format!(
        "<key>extra</key>{}<string>x</string>{}",
        "<array>".repeat(40),
        "</array>".repeat(40)
    ));
    assert!(application_fields(deep.as_bytes()).is_err());
    let many = xml(&format!(
        "<key>extra</key><array>{}</array>",
        "<true/>".repeat(17000)
    ));
    assert!(application_fields(many.as_bytes()).is_err());
}
