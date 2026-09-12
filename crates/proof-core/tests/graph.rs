use proof_core::Proof;
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn commit(stream: &mut String, branch: &str, mark: usize, parents: &[usize]) {
    let subject = format!("Commit {mark}");
    stream.push_str(&format!("commit refs/heads/{branch}\nmark :{mark}\nauthor Graph Fixture <graph@example.test> {} +0000\ncommitter Graph Fixture <graph@example.test> {} +0000\ndata {}\n{subject}\n", 1_789_200_000 + mark, 1_789_200_000 + mark, subject.len()));
    for (index, parent) in parents.iter().enumerate() {
        stream.push_str(&format!(
            "{} :{parent}\n",
            if index == 0 { "from" } else { "merge" }
        ));
    }
    stream.push('\n');
}
fn fixture() -> (tempfile::TempDir, Proof, proof_core::Workspace) {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    let mut stream = String::new();
    for i in 1..=130 {
        let parent = i - 1;
        commit(
            &mut stream,
            "main",
            i,
            if i == 1 {
                &[]
            } else {
                std::slice::from_ref(&parent)
            },
        );
    }
    commit(&mut stream, "feature", 201, &[30]);
    commit(&mut stream, "feature", 202, &[201]);
    commit(&mut stream, "main", 301, &[130, 202]);
    commit(&mut stream, "orphan", 400, &[]);
    let mut process = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["fast-import", "--quiet"])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(stream.as_bytes())
        .unwrap();
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    git(&repo, &["update-ref", "refs/remotes/origin/main", "main"]);
    git(&repo, &["tag", "v0.1", "main"]);
    let mut proof = Proof::open(temp.path().join("data")).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    (temp, proof, workspace)
}

#[test]
fn graph_contains_all_branches_real_parents_and_paged_topological_order() {
    let (_temp, mut proof, workspace) = fixture();
    let page = proof.commit_graph(&workspace.id, None, 0, "all").unwrap();
    assert_eq!(page.commits.len(), 100);
    assert!(page.has_more);
    assert!(page.commits.iter().any(|commit| commit.parents.len() == 2));
    assert!(page.branches.iter().any(|branch| branch.remote));
    let next = proof
        .commit_graph(&workspace.id, Some(&page.snapshot_id), 100, "all")
        .unwrap();
    assert!(!next.has_more);
    let commits: Vec<_> = page.commits.iter().chain(&next.commits).collect();
    assert_eq!(commits.len(), 134);
    let expected = git(
        Path::new(&workspace.path),
        &["log", "--topo-order", "--all", "--format=%H"],
    );
    assert_eq!(
        commits
            .iter()
            .map(|commit| commit.oid.as_str())
            .collect::<Vec<_>>(),
        expected.lines().collect::<Vec<_>>()
    );
    for (index, commit) in commits.iter().enumerate() {
        for parent in &commit.parents {
            assert!(
                commits
                    .iter()
                    .position(|entry| &entry.oid == parent)
                    .unwrap()
                    > index
            );
        }
    }
    let current = proof
        .commit_graph(&workspace.id, None, 0, "current")
        .unwrap();
    assert!(!current
        .commits
        .iter()
        .any(|commit| commit.refs.contains("orphan")));
}

#[test]
fn later_pages_keep_captured_commits_and_labels_after_refs_change() {
    let (_temp, mut proof, workspace) = fixture();
    let page = proof.commit_graph(&workspace.id, None, 0, "all").unwrap();
    let expected = proof
        .commit_graph(&workspace.id, Some(&page.snapshot_id), 100, "all")
        .unwrap();
    let repo = Path::new(&workspace.path);
    git(repo, &["update-ref", "refs/heads/main", "main~40"]);
    git(repo, &["update-ref", "-d", "refs/heads/orphan"]);
    let actual = proof
        .commit_graph(&workspace.id, Some(&page.snapshot_id), 100, "all")
        .unwrap();
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
    let new_page = proof.commit_graph(&workspace.id, None, 0, "all").unwrap();
    assert_ne!(new_page.snapshot_id, page.snapshot_id);
    assert_ne!(new_page.head, page.head);
    let feature = page
        .branches
        .iter()
        .find(|branch| branch.name == "feature")
        .unwrap();
    let selected = proof
        .commit_graph(&workspace.id, None, 0, &feature.oid)
        .unwrap();
    assert_eq!(selected.commits[0].oid, feature.oid);
    assert!(!selected.has_more);
}

#[test]
fn empty_repository_and_invalid_cursor_are_explicit() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    let mut proof = Proof::open(temp.path().join("data")).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    assert!(proof
        .commit_graph(&workspace.id, None, 0, "all")
        .unwrap()
        .commits
        .is_empty());
    assert_eq!(
        proof
            .commit_graph(&workspace.id, Some("missing"), 100, "all")
            .unwrap_err()
            .code,
        "GRAPH_SNAPSHOT"
    );
    assert_eq!(
        proof
            .commit_graph(&workspace.id, None, 0, "--all")
            .unwrap_err()
            .code,
        "GRAPH_RANGE"
    );
}

#[test]
fn shallow_boundary_changes_require_a_new_graph_snapshot() {
    let (_temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    let boundary = git(repo, &["rev-parse", "main~20"]);
    fs::write(repo.join(".git/shallow"), format!("{boundary}\n")).unwrap();
    let page = proof.commit_graph(&workspace.id, None, 0, "all").unwrap();
    assert!(page.shallow);
    let boundary_commit = page
        .commits
        .iter()
        .find(|commit| commit.oid == boundary)
        .unwrap();
    assert_eq!(boundary_commit.boundary.as_deref(), Some("shallow"));
    assert_eq!(
        proof
            .graph_commit_diff(&workspace.id, &page.snapshot_id, &boundary, 0)
            .unwrap_err()
            .code,
        "GRAPH_SHALLOW_BOUNDARY"
    );
    fs::remove_file(repo.join(".git/shallow")).unwrap();
    assert_eq!(
        proof
            .commit_graph(&workspace.id, Some(&page.snapshot_id), 100, "all")
            .unwrap_err()
            .code,
        "GRAPH_CHANGED"
    );
}

#[test]
fn named_reference_refreshes_its_tip_and_existing_rewrites_are_explicit() {
    let (_temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    let first = proof
        .commit_graph(&workspace.id, None, 0, "refs/heads/feature")
        .unwrap();
    let new_tip = git(repo, &["rev-parse", "main"]);
    git(repo, &["update-ref", "refs/heads/feature", &new_tip]);
    let next = proof
        .commit_graph(&workspace.id, None, 0, "refs/heads/feature")
        .unwrap();
    assert_eq!(next.commits[0].oid, new_tip);
    assert_ne!(next.commits[0].oid, first.commits[0].oid);
    git(repo, &["replace", "--graft", "HEAD", "orphan"]);
    assert_eq!(
        proof
            .commit_graph(&workspace.id, None, 0, "all")
            .unwrap_err()
            .code,
        "GRAPH_REWRITTEN_HISTORY"
    );
}

#[test]
fn spec_current_scope_keeps_reachable_branch_and_tag_labels() {
    let (_temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    git(repo, &["tag", "historic-tag", "main~5"]);
    let all = proof.commit_graph(&workspace.id, None, 0, "all").unwrap();
    let current = proof
        .commit_graph(&workspace.id, None, 0, "current")
        .unwrap();
    let feature = all
        .commits
        .iter()
        .find(|c| c.refs.contains("feature"))
        .unwrap();
    let actual = current
        .commits
        .iter()
        .find(|c| c.oid == feature.oid)
        .unwrap();
    assert!(
        actual.refs.contains("feature"),
        "reachable feature ref disappeared: all={:?} current={:?}",
        feature.refs,
        actual.refs
    );
    let tagged = all
        .commits
        .iter()
        .find(|c| c.refs.contains("historic-tag"))
        .unwrap();
    let actual = current
        .commits
        .iter()
        .find(|c| c.oid == tagged.oid)
        .unwrap();
    assert!(
        actual.refs.contains("historic-tag"),
        "reachable historical tag disappeared"
    );
}

#[test]
fn spec_single_branch_with_1100_commits_is_not_a_1100_tip_repository() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    let mut stream = String::new();
    for i in 1..=1100 {
        let previous = i - 1;
        commit(
            &mut stream,
            "main",
            i,
            if i == 1 {
                &[]
            } else {
                std::slice::from_ref(&previous)
            },
        );
    }
    let mut process = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(stream.as_bytes())
        .unwrap();
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut proof = Proof::open(temp.path().join("data")).unwrap();
    let workspace = proof.open_workspace(repo.to_str().unwrap()).unwrap();
    let mut errors = Vec::new();
    for scope in ["all", "current"] {
        match proof.commit_graph(&workspace.id, None, 0, scope) {
            Ok(page) => {
                assert_eq!(page.commits.len(), 100);
                assert!(page.has_more);
            }
            Err(error) => errors.push(format!("{scope}: {}", error.code)),
        }
    }
    assert!(
        errors.is_empty(),
        "one branch must not exceed a 1024-tip limit: {errors:?}"
    );
}

#[cfg(unix)]
#[test]
fn standards_review_graph_must_not_execute_repository_signature_program() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    assert!(!workspace.trusted);
    let marker = temp.path().join("signature-program-ran");
    let program = temp.path().join("signature-program");
    fs::write(
        &program,
        format!("#!/bin/sh\n: > '{}'\nexit 1\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    let tree = git(repo, &["rev-parse", "HEAD^{tree}"]);
    let parent = git(repo, &["rev-parse", "HEAD"]);
    let commit = format!("tree {tree}\nparent {parent}\nauthor Review Fixture <review@example.test> 1789200600 +0000\ncommitter Review Fixture <review@example.test> 1789200600 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n YQ==\n -----END PGP SIGNATURE-----\n\nSigned-shaped fixture\n");
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["hash-object", "-t", "commit", "-w", "--stdin"])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(commit.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let oid = String::from_utf8(output.stdout).unwrap();
    git(repo, &["update-ref", "refs/heads/main", oid.trim()]);
    git(repo, &["config", "log.showSignature", "true"]);
    git(repo, &["config", "gpg.program", program.to_str().unwrap()]);
    let result = proof.commit_graph(&workspace.id, None, 0, "all");
    assert!(
        !marker.exists(),
        "untrusted graph query executed configured gpg program; result_ok={}",
        result.is_ok()
    );
}

#[test]
fn standards_review_graph_detail_does_not_cross_captured_parent_shape() {
    let (_temp, mut proof, workspace) = fixture();
    let repo = Path::new(&workspace.path);
    for (index, content) in ["one\n", "one\ntwo\n", "one\ntwo\nthree\n"]
        .iter()
        .enumerate()
    {
        fs::write(repo.join("file.txt"), content).unwrap();
        git(repo, &["add", "file.txt"]);
        git(
            repo,
            &[
                "-c",
                "user.name=Review Fixture",
                "-c",
                "user.email=review@example.test",
                "commit",
                "-m",
                &format!("content {index}"),
            ],
        );
    }
    let page = proof
        .commit_graph(&workspace.id, None, 0, "current")
        .unwrap();
    let selected = &page.commits[0];
    let before = proof
        .graph_commit_diff(&workspace.id, &page.snapshot_id, &selected.oid, 0)
        .unwrap();
    assert!(!before.contains("+two\n"));
    git(
        repo,
        &[
            "-c",
            "user.name=Review Fixture",
            "-c",
            "user.email=review@example.test",
            "replace",
            "--graft",
            &selected.oid,
            "HEAD~2",
        ],
    );
    assert_eq!(
        proof
            .commit_graph(&workspace.id, Some(&page.snapshot_id), 100, "current")
            .unwrap_err()
            .code,
        "GRAPH_CHANGED"
    );
    let detail = proof.graph_commit_diff(&workspace.id, &page.snapshot_id, &selected.oid, 0);
    match detail {
        Err(error) => assert_eq!(error.code, "GRAPH_CHANGED"),
        Ok(actual) => assert_eq!(
            actual, before,
            "graph detail changed its baseline while selected.parents remains {:?}",
            selected.parents
        ),
    }
}
