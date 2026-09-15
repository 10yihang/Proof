#!/usr/bin/env python3
"""Measure the real release core through its test NDJSON transport.

Creates an owned fixture only, never operates on a supplied source repository.
Reported times include transport/JSON overhead, not native WebView rendering.
No fixture or evidence is silently deleted, including after a failed budget.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import queue
import stat
import subprocess
import tempfile
import threading
import time


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def worktree_state(repo):
    """Include unexpected files and links without traversing links or .git."""
    state = {}
    for parent, directories, files in os.walk(repo, followlinks=False):
        if Path(parent) == repo:
            directories[:] = [name for name in directories if name != ".git"]
            files = [name for name in files if name != ".git"]
        for name in directories + files:
            path = Path(parent) / name
            metadata = path.lstat()
            kind = stat.S_IFMT(metadata.st_mode)
            value = (os.readlink(path) if stat.S_ISLNK(metadata.st_mode) else
                     digest(path) if stat.S_ISREG(metadata.st_mode) else None)
            state[str(path.relative_to(repo))] = (kind, stat.S_IMODE(metadata.st_mode), value)
    return state


def git_environment():
    # -C does not override inherited Git routing/configuration variables.
    # Do not let a caller's hook environment redirect fixture writes.
    return {**{key: value for key, value in os.environ.items() if not key.startswith("GIT_")},
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_OPTIONAL_LOCKS": "0", "GIT_ATTR_NOSYSTEM": "1"}


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-C", str(repo), *args],
        env=git_environment(),
    )


def content(index, changed=0):
    if index >= 99:
        return f"// Fixture {index}\n".encode()
    lines = []
    for line in range(100):
        # The first file has two separated hunks, so partial staging is distinct
        # from staging the entire file while the total remains 10,000 diff lines.
        edited = (line < min(changed, 25) or 75 <= line < 75 + max(0, changed - 25)) if index == 0 else line < changed
        lines.append(f"export const value{line} = '{'changed' if edited else 'base'}-{index}';\n")
    return (f"// Fixture {index}\n" + "".join(lines)).encode()


def create_fixture(directory, commits):
    repo = directory / "repo"
    repo.mkdir()
    git(repo, "init", "-b", "main")
    for key, value in [("user.name", "Proof Benchmark"),
                       ("user.email", "benchmark@example.invalid"),
                       ("commit.gpgsign", "false"), ("core.hooksPath", os.devnull),
                       ("gc.auto", "0"), ("core.attributesFile", os.devnull)]:
        git(repo, "config", key, value)
    importer = subprocess.Popen(
        ["git", "-C", str(repo), "fast-import", "--quiet"], stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        env=git_environment(),
    )
    try:
        for commit in range(1, commits + 1):
            message = f"Benchmark commit {commit}\n".encode()
            importer.stdin.write(
                f"commit refs/heads/main\nmark :{commit}\ncommitter Proof Benchmark <benchmark@example.invalid> {1700000000+commit} +0000\ndata {len(message)}\n".encode()
                + message
            )
            if commit > 1:
                importer.stdin.write(f"from :{commit-1}\n".encode())
            else:
                for index in range(10000):
                    body = content(index)
                    importer.stdin.write(f"M 100644 inline modules/file-{index:05}.ts\ndata {len(body)}\n".encode() + body + b"\n")
            importer.stdin.write(b"\n")
        importer.stdin.write(b"done\n")
        importer.stdin.close()
        if importer.wait(timeout=300):
            raise RuntimeError("Fixture fast-import failed")
    finally:
        if importer.poll() is None:
            importer.terminate()
            importer.wait(timeout=10)
    git(repo, "reset", "--hard", "--quiet", "HEAD")
    for index in range(97):
        (repo / f"modules/file-{index:05}.ts").write_bytes(content(index, 50))
    mixed = repo / "modules/file-00097.ts"
    mixed.write_bytes(content(97, 25))
    git(repo, "add", "--", "modules/file-00097.ts")
    mixed.write_bytes(content(97, 50))
    git(repo, "mv", "--", "modules/file-00098.ts", "modules/renamed-00098.ts")
    (repo / "new-file.ts").write_text("".join(f"export const added{i} = {i};\n" for i in range(200)))
    assert len(git(repo, "ls-files", "-z").split(b"\0")) - 1 == 10000
    assert int(git(repo, "rev-list", "--count", "HEAD")) == commits
    text_lines = 200  # The untracked file is not part of ordinary git diff.
    for extra in [[], ["--cached"]]:
        for row in git(repo, "diff", "--numstat", *extra).splitlines():
            added, removed, _ = row.split(b"\t", 2)
            text_lines += int(added) + int(removed)
    assert text_lines == 10000
    marker = {"schema": 1, "createdAt": time.time(), "repo": str(repo),
              "trackedFiles": 10000, "commits": commits,
              "head": git(repo,"rev-parse","HEAD").decode().strip(),
              "uniqueChangedFiles": 100, "changedTextLines": text_lines,
              "shape": "97 unstaged modifications, 1 mixed staged/unstaged, 1 staged rename, 1 untracked"}
    (directory / "fixture.json").write_text(json.dumps(marker, indent=2))
    return repo, marker


class Core:
    def __init__(self, executable, data, log):
        self.stderr = log.open("wb")
        try:
            self.child = subprocess.Popen([str(executable), str(data)], stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=self.stderr, text=True,
                                          env=git_environment())
        except Exception:
            self.stderr.close()
            raise
        self.responses = queue.Queue()
        def read():
            try:
                with self.child.stdout:
                    for line in self.child.stdout:
                        self.responses.put(line)
            finally:
                self.responses.put(None)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()

    def request(self, command, **args):
        started = time.perf_counter_ns()
        self.child.stdin.write(json.dumps({"command": command, "args": args}) + "\n")
        self.child.stdin.flush()
        line = self.responses.get(timeout=60)
        if line is None:
            raise RuntimeError(f"Owned benchmark core exited {self.child.poll()}")
        response = json.loads(line)
        elapsed = (time.perf_counter_ns() - started) / 1e6
        if "error" in response:
            raise RuntimeError(response["error"])
        return response["value"], elapsed

    def close(self, timeout=10):
        pipe_error = None
        try:
            self.child.stdin.close()
        except OSError as error:
            pipe_error = error
        try:
            try:
                self.child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.child.terminate()
                try:
                    self.child.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=timeout)
        finally:
            self.reader.join(timeout=1)
            self.stderr.close()
        if pipe_error is not None:
            raise pipe_error


class ProcessTreeSamples:
    """Observed RSS only; short-lived children may fall between samples."""
    def __init__(self, child):
        self.child = child
        self.stop = threading.Event()
        self.count = 0
        self.maximum_rss = 0
        self.maximum_processes = 0
        self.error = None
        self.thread = threading.Thread(target=self.collect, daemon=True)

    def collect(self):
        while not self.stop.is_set() and self.child.poll() is None:
            try:
                output = subprocess.check_output(
                    ["ps", "-axo", "pid=,ppid=,rss="], text=True,
                    stderr=subprocess.DEVNULL, timeout=2,
                )
                rows = [tuple(map(int, row.split())) for row in output.splitlines()]
                descendants = {self.child.pid}
                while True:
                    expanded = descendants | {pid for pid, parent, _ in rows if parent in descendants}
                    if expanded == descendants:
                        break
                    descendants = expanded
                live = [(pid, rss) for pid, _, rss in rows if pid in descendants]
                if live:
                    self.count += 1
                    self.maximum_rss = max(self.maximum_rss, sum(rss for _, rss in live) * 1024)
                    self.maximum_processes = max(self.maximum_processes, len(live))
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                self.error = type(error).__name__
                break
            self.stop.wait(.2)

    def finish(self):
        self.stop.set()
        self.thread.join(timeout=3)
        return {"scope": "Release core driver and descendants; excludes WebView and independent collector",
                "intervalMs": 200, "samples": self.count,
                "maxObservedTreeRssBytes": self.maximum_rss if self.count else None,
                "maxObservedProcessCount": self.maximum_processes if self.count else None,
                "note": "Sampled maximum, not an exact peak; short-lived children may be missed",
                "error": self.error}


def index_entries(repo):
    entries = {}
    for row in git(repo, "ls-files", "--stage", "-z").split(b"\0"):
        if row:
            metadata, path = row.split(b"\t", 1)
            mode, oid, stage = metadata.split()
            assert stage == b"0"
            entries[path.decode()] = (mode, oid)
    return entries


def head_entries(repo):
    entries = {}
    for row in git(repo, "ls-tree", "-r", "-z", "HEAD").split(b"\0"):
        if row:
            metadata, path = row.split(b"\t", 1)
            mode, kind, oid = metadata.split()
            assert kind == b"blob"
            entries[path.decode()] = (mode, oid)
    return entries


def blob_id(body):
    return hashlib.sha1(f"blob {len(body)}\0".encode() + body).hexdigest().encode()


def extended_writes(core, workspace, repo, count, reviewed, samples):
    work = workspace["id"]
    original_index = (repo / ".git/index").read_bytes()
    original_entries = index_entries(repo)
    original_head = head_entries(repo)
    source_before = worktree_state(repo)
    path = "modules/file-00000.ts"
    for name in ["stageHunk", "unstageHunk", "stageSelectedFiles", "unstageSelectedFiles", "stageAll", "unstageAll"]:
        samples[name] = []
    print("Measuring selected Hunk and batch file actions", flush=True)
    for _ in range(count):
        diff, _ = core.request("file_diff", workspaceId=work, path=path, side="unstaged")
        assert len(diff["hunks"]) == 2
        if reviewed:
            core.request("mark_reviewed", snapshotId=diff["id"], hunkId=diff["hunks"][0]["id"], reviewed=True)
        result, elapsed = core.request("stage", snapshotId=diff["id"], hunkId=diff["hunks"][0]["id"])
        assert result["ok"] and result["warning"] is None
        samples["stageHunk"].append(elapsed)
        expected = {**original_entries, path: (b"100644", blob_id(content(0, 25)))}
        assert index_entries(repo) == expected
        assert worktree_state(repo) == source_before, "Hunk Stage modified the Worktree"
        staged, _ = core.request("file_diff", workspaceId=work, path=path, side="staged")
        assert len(staged["hunks"]) == 1
        if reviewed:
            assert staged["hunks"][0]["reviewState"] == "reviewed"
        result, elapsed = core.request("stage", snapshotId=staged["id"], hunkId=staged["hunks"][0]["id"])
        assert result["ok"] and result["warning"] is None
        samples["unstageHunk"].append(elapsed)
        assert index_entries(repo) == original_entries
        assert worktree_state(repo) == source_before, "Hunk Unstage modified the Worktree"

    for all_files in [False, True]:
        label = "All" if all_files else "SelectedFiles"
        for _ in range(count):
            changes, _ = core.request("changes", workspaceId=work)
            paths = ([f["path"] for f in changes["files"] if f["side"] == "unstaged"] if all_files else
                     [path, "modules/file-00001.ts", "modules/file-00097.ts", "new-file.ts"])
            expected_stage = dict(original_entries)
            for target in paths:
                expected_stage[target] = (b"100644", blob_id((repo / target).read_bytes()))
            result, elapsed = core.request("stage_files", workspaceId=work, paths=paths, side="unstaged", expectedToken=changes["token"])
            assert result["ok"] and result["warning"] is None
            samples["stage" + label].append(elapsed)
            assert index_entries(repo) == expected_stage
            assert worktree_state(repo) == source_before, "Batch Stage modified the Worktree"
            changes, _ = core.request("changes", workspaceId=work)
            staged_files = [f for f in changes["files"] if f["side"] == "staged" and (all_files or f["path"] in paths)]
            unstage_paths = [f["path"] for f in staged_files]
            targets = set(unstage_paths) | {f["oldPath"] for f in staged_files if f["oldPath"]}
            expected_unstage = dict(expected_stage)
            for target in targets:
                if target in original_head:
                    expected_unstage[target] = original_head[target]
                else:
                    expected_unstage.pop(target, None)
            result, elapsed = core.request("stage_files", workspaceId=work, paths=unstage_paths, side="staged", expectedToken=changes["token"])
            assert result["ok"] and result["warning"] is None
            samples["unstage" + label].append(elapsed)
            assert index_entries(repo) == expected_unstage
            assert worktree_state(repo) == source_before, "Batch Unstage modified the Worktree"
            if all_files:
                assert expected_unstage == original_head
            # Mixed staged content is intentionally unstaged by the selected action.
            # Reset this owned fixture's Index outside the timed interval so every
            # sample starts with the same mixed and staged-rename baseline.
            (repo / ".git/index").write_bytes(original_index)
            assert index_entries(repo) == original_entries


def summary(samples):
    ordered = sorted(samples)
    return {"count": len(samples), "p50Ms": ordered[math.ceil(len(samples)*.5)-1],
            "p95Ms": ordered[math.ceil(len(samples)*.95)-1], "maxMs": ordered[-1]}


def system_value(command):
    try:
        return subprocess.check_output(command, stderr=subprocess.DEVNULL, timeout=5).decode().strip()
    except (OSError, subprocess.SubprocessError):
        return "unavailable"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--driver", type=Path, required=True, help="Release ui-fixture-driver binary")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--commits", type=int, default=100000)
    parser.add_argument("--enforce-budget", action="store_true")
    parser.add_argument("--reviewed", action="store_true", help="Mark captured changes Reviewed and assert observed Review states")
    parser.add_argument("--extended", action="store_true", help="Also measure partial Hunk, four selected files, and Stage/Unstage all")
    args = parser.parse_args()
    if args.samples < 30 or args.commits < 1:
        parser.error("At least 30 samples and a positive commit count are required")
    executable = args.driver.resolve(strict=True)
    script_sha = digest(Path(__file__))
    if args.output.exists():
        parser.error("Output exists; choose a new report path")
    directory = Path(tempfile.mkdtemp(prefix="proof-git-baseline-")).resolve()
    print(f"Preparing owned benchmark fixture: {directory}", flush=True)
    repo, shape = create_fixture(directory, args.commits)
    index_before, head_before = digest(repo/".git/index"), git(repo, "rev-parse", "HEAD")
    source_before = worktree_state(repo)
    config_before = digest(repo/".git/config")
    report = {"schema": 1, "measuredAt": time.time(), "fixture": shape,
              "reviewed": args.reviewed, "extended": args.extended,
              "scriptSha256": script_sha,
              "executable": str(executable), "executableSha256": digest(executable),
              "measurement": "Persistent release core, request write through complete JSON response parse; not native UI timing",
              "hardware": {"platform": platform.platform(), "machine": platform.machine(),
                           "memoryBytes": system_value(["sysctl", "-n", "hw.memsize"]),
                           "cpu": system_value(["sysctl", "-n", "machdep.cpu.brand_string"]),
                           "power": system_value(["pmset", "-g", "batt"])},
              "gitVersion": git(repo, "--version").decode().strip(),
              "reviewValidation": {
                  "statesAsserted": ["file", "hunk"] if args.reviewed and args.extended else ["file"] if args.reviewed else [],
                  "migrationProven": False,
                  "note": "Repeated fixtures may contain existing destination Review markers; isolated core tests prove migration correctness",
              },
              "samples": {"changes": [], "uncachedFileDiff": [], "stage": [], "unstage": []},
              "complete": False}
    core = Core(executable, directory/"data", directory/"core-stderr.log")
    resources = ProcessTreeSamples(core.child)
    try:
        workspace, _ = core.request("open_workspace", path=str(repo))
        core.request("set_trust", workspaceId=workspace["id"], trusted=True)
        changes, _ = core.request("changes", workspaceId=workspace["id"])
        assert len({f["path"] for f in changes["files"]}) == 100
        assert any(f["status"] == "?" for f in changes["files"])
        assert any(f["oldPath"] for f in changes["files"])
        assert len([f for f in changes["files"] if f["path"] == "modules/file-00097.ts"]) == 2
        targets = [f for f in changes["files"] if f["side"] == "unstaged" and f["status"] == "M"]
        resources.thread.start()
        print("Fixture verified; measuring Changes and uncached file reads", flush=True)
        for index in range(args.samples):
            current, elapsed = core.request("changes", workspaceId=workspace["id"])
            report["samples"]["changes"].append(elapsed)
            target = targets[index % len(targets)]["path"]
            diff, elapsed = core.request("file_diff", workspaceId=workspace["id"], path=target, side="unstaged")
            assert diff["path"] == target and diff["hunks"] and "changed-" in diff["patch"]
            report["samples"]["uncachedFileDiff"].append(elapsed)
            if (index + 1) % 10 == 0:
                print(f"Read samples {index+1}/{args.samples}", flush=True)
        assert digest(repo/".git/index") == index_before
        original_entries = index_entries(repo)
        print("Measuring reversible Stage/Unstage in the owned fixture", flush=True)
        for index in range(args.samples):
            diff, _ = core.request("file_diff", workspaceId=workspace["id"], path=targets[0]["path"], side="unstaged")
            if args.reviewed:
                core.request("mark_reviewed",snapshotId=diff["id"],hunkId=None,reviewed=True)
            result, elapsed = core.request("stage", snapshotId=diff["id"], hunkId=None)
            assert result["ok"] and result["warning"] is None
            report["samples"]["stage"].append(elapsed)
            expected = {**original_entries, targets[0]["path"]: (b"100644", blob_id(content(0, 50)))}
            assert index_entries(repo) == expected, "File Stage did not preserve the exact selected scope"
            assert worktree_state(repo) == source_before, "File Stage modified the Worktree"
            staged, _ = core.request("file_diff", workspaceId=workspace["id"], path=targets[0]["path"], side="staged")
            assert len(staged["hunks"]) == 2
            if args.reviewed:
                assert all(h["reviewState"] == "reviewed" for h in staged["hunks"])
            result, elapsed = core.request("stage", snapshotId=staged["id"], hunkId=None)
            assert result["ok"] and result["warning"] is None
            report["samples"]["unstage"].append(elapsed)
            assert index_entries(repo) == original_entries
            assert worktree_state(repo) == source_before, "File Unstage modified the Worktree"
            if args.reviewed:
                restored, _ = core.request("file_diff", workspaceId=workspace["id"], path=targets[0]["path"], side="unstaged")
                assert all(h["reviewState"] == "reviewed" for h in restored["hunks"])
        if args.extended:
            extended_writes(core, workspace, repo, args.samples, args.reviewed, report["samples"])
            report["extendedScope"] = {
                "hunk": "First of two separated hunks; unrelated Index entries and remaining Worktree hunk preserved",
                "selectedFiles": "Two modified files, mixed staged/unstaged file, and untracked file",
                "all": "99 Unstaged paths followed by all 100 Staged paths including a rename",
                "fixtureReset": "Initial mixed/rename Index restored outside timed intervals after each batch roundtrip",
                "batchReviewStatesAsserted": False,
            }
        assert git(repo, "rev-parse", "HEAD") == head_before
        assert digest(repo/".git/config") == config_before
        assert worktree_state(repo) == source_before
        report["summary"] = {name: summary(values) for name, values in report["samples"].items()}
        budgets = {name: 2000 if name == "changes" else 500 for name in report["summary"]}
        report["budgetFailures"] = [name for name, target in budgets.items() if report["summary"][name]["p95Ms"] > target]
        report["complete"] = True
        report["preserved"] = {"source": True, "head": True, "config": True, "indexEntriesAfterRoundTrips": True, "indexBytesDuringReads": True}
    except Exception as error:
        report["error"] = repr(error)
        raise
    finally:
        if resources.thread.ident is not None:
            report["resources"] = resources.finish()
        try:
            core.close()
        except Exception as close_error:
            report["closeError"] = repr(close_error)
            report["complete"] = False
        finally:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x", encoding="utf-8") as output:
                json.dump(report, output, indent=2)
            print(f"Report: {args.output.resolve()}", flush=True)
    if not report["complete"]:
        raise SystemExit("Benchmark did not complete; inspect the saved report")
    print(json.dumps(report["summary"], indent=2), flush=True)
    if args.enforce_budget and report["budgetFailures"]:
        raise SystemExit("Core timing budget exceeded: " + ", ".join(report["budgetFailures"]))


if __name__ == "__main__":
    main()
