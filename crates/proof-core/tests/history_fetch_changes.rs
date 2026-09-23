use proof_core::Proof;
use std::{fs, path::Path, process::Command};

fn git(path: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars().filter(|(key, _)| key.starts_with("GIT_")) {
        command.env_remove(key);
    }
    let output = command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Proof test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Proof test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

struct Fixture {
    temp: tempfile::TempDir,
    repo: std::path::PathBuf,
    remote: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let remote = temp.path().join("remote.git");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        git(&repo, &["config", "core.hooksPath", "/dev/null"]);
        git(&repo, &["commit", "--allow-empty", "-m", "Initial"]);
        git(
            temp.path(),
            &[
                "clone",
                "--bare",
                repo.to_str().unwrap(),
                remote.to_str().unwrap(),
            ],
        );
        git(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        Self { temp, repo, remote }
    }

    fn fetch(&self) -> proof_core::Result<serde_json::Value> {
        // Reopening resets only the process-local one-minute gate; no sleeping
        // and no actual external remotes are needed for a second fetch.
        let mut proof = Proof::open(self.temp.path().join("data"))?;
        let workspace = proof.open_workspace(self.repo.to_str().unwrap())?;
        proof.set_trust(&workspace.id, true)?;
        let result = proof
            .prepare_history_fetch(&workspace.id)?
            .unwrap()
            .execute()?;
        Ok(serde_json::to_value(result).unwrap())
    }

    fn advance_remote(&self) -> String {
        let head = git(&self.remote, &["rev-parse", "refs/heads/main"]);
        let tree = git(&self.remote, &["rev-parse", "refs/heads/main^{tree}"]);
        let next = git(
            &self.remote,
            &["commit-tree", &tree, "-p", &head, "-m", "Remote update"],
        );
        git(&self.remote, &["update-ref", "refs/heads/main", &next]);
        next
    }
}

#[test]
fn unchanged_fetch_does_not_invalidate_the_graph() {
    let f = Fixture::new();
    assert_eq!(f.fetch().unwrap(), serde_json::json!(true));
    assert_eq!(f.fetch().unwrap(), serde_json::json!(false));
}

#[test]
fn changed_remote_refs_invalidate_without_moving_local_head() {
    let f = Fixture::new();
    f.fetch().unwrap();
    let head = git(&f.repo, &["rev-parse", "HEAD"]);
    let next = f.advance_remote();
    assert_eq!(f.fetch().unwrap(), serde_json::json!(true));
    assert_eq!(
        git(&f.repo, &["rev-parse", "refs/remotes/origin/main"]),
        next
    );
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(f.fetch().unwrap(), serde_json::json!(false));
}

#[test]
fn partial_fetch_still_invalidates_changed_refs_and_reports_unchanged_failure() {
    let f = Fixture::new();
    f.fetch().unwrap();
    git(
        &f.repo,
        &[
            "remote",
            "add",
            "broken",
            f.temp.path().join("missing.git").to_str().unwrap(),
        ],
    );
    let next = f.advance_remote();
    assert_eq!(f.fetch().unwrap(), serde_json::json!(true));
    assert_eq!(
        git(&f.repo, &["rev-parse", "refs/remotes/origin/main"]),
        next
    );
    assert!(f.fetch().is_err());
}

#[test]
fn graph_version_tracks_external_branches_tags_and_symbolic_head_without_consuming_changes() {
    let f = Fixture::new();
    let mut proof = Proof::open(f.temp.path().join("data")).unwrap();
    let workspace = proof.open_workspace(f.repo.to_str().unwrap()).unwrap();
    let initial = proof.history_graph_version(&workspace.id).unwrap();
    assert_eq!(initial, proof.history_graph_version(&workspace.id).unwrap());
    let head = git(&f.repo, &["rev-parse", "HEAD"]);
    git(&f.repo, &["branch", "feature"]);
    let branch = proof.history_graph_version(&workspace.id).unwrap();
    assert_ne!(branch, initial);
    git(&f.repo, &["tag", "v-test"]);
    let tag = proof.history_graph_version(&workspace.id).unwrap();
    assert_ne!(tag, branch);
    let tree = git(&f.repo, &["rev-parse", "HEAD^{tree}"]);
    let next = git(&f.repo, &["commit-tree", &tree, "-p", &head, "-m", "Next"]);
    git(&f.repo, &["update-ref", "refs/heads/feature", &next]);
    let moved_branch = proof.history_graph_version(&workspace.id).unwrap();
    assert_ne!(moved_branch, tag);
    git(&f.repo, &["update-ref", "refs/tags/v-test", &next]);
    let moved_tag = proof.history_graph_version(&workspace.id).unwrap();
    assert_ne!(moved_tag, moved_branch);
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]), head);
    git(&f.repo, &["update-ref", "refs/heads/feature", &head]);
    let before_switch = proof.history_graph_version(&workspace.id).unwrap();
    git(&f.repo, &["symbolic-ref", "HEAD", "refs/heads/feature"]);
    let switched = proof.history_graph_version(&workspace.id).unwrap();
    assert_ne!(switched, before_switch);
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]), head);
    // Reads are pure: another window sees the same version, rather than a
    // shared flag that was cleared by the first caller.
    let other = Proof::open(f.temp.path().join("data")).unwrap();
    assert_eq!(
        switched,
        other.history_graph_version(&workspace.id).unwrap()
    );
}
