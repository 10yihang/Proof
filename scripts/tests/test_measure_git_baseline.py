import importlib.util
import json
import os
import signal
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "measure_git_baseline", Path(__file__).parents[1] / "measure-git-baseline.py"
)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class BenchmarkIsolationTests(unittest.TestCase):
    @unittest.skipUnless(hasattr(signal, "SIGSTOP"), "POSIX process stop required")
    def test_close_kills_and_reaps_a_stopped_owned_driver(self):
        with tempfile.TemporaryDirectory(prefix="proof-benchmark-shutdown-") as temporary:
            directory = Path(temporary)
            executable = directory / "stopped-driver"
            executable.write_text(
                f"#!{sys.executable}\nimport json, signal, sys, time\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "sys.stdin.readline()\n"
                "print(json.dumps({'value': 'ready'}), flush=True)\n"
                "time.sleep(60)\n"
            )
            executable.chmod(0o700)
            core = benchmark.Core(executable, directory / "data", directory / "stderr.log")
            try:
                self.assertEqual(core.request("ready")[0], "ready")
                os.kill(core.child.pid, signal.SIGSTOP)
                _, stopped = os.waitpid(core.child.pid, os.WUNTRACED)
                self.assertTrue(os.WIFSTOPPED(stopped))
                core.close(timeout=.5)
                self.assertEqual(core.child.returncode, -signal.SIGKILL)
                self.assertFalse(core.reader.is_alive())
                self.assertTrue(core.stderr.closed)
            finally:
                if core.child.poll() is None:
                    core.child.kill()
                    core.child.wait(timeout=5)
                core.stderr.close()

    def test_worktree_oracle_detects_non_source_files_and_does_not_follow_links(self):
        with tempfile.TemporaryDirectory(prefix="proof-benchmark-oracle-") as temporary:
            directory = Path(temporary)
            repo = directory / "repo"
            (repo / ".git").mkdir(parents=True)
            (repo / ".git/index").write_bytes(b"index")
            (repo / "source.ts").write_text("source\n")
            outside = directory / "outside"
            outside.mkdir()
            (outside / "private.txt").write_text("outside fixture\n")
            (repo / "linked-directory").symlink_to(outside, target_is_directory=True)
            before = benchmark.worktree_state(repo)
            self.assertEqual(set(before), {"source.ts", "linked-directory"})
            (outside / "private.txt").write_text("changed outside fixture\n")
            (repo / ".git/index").write_bytes(b"new index")
            self.assertEqual(benchmark.worktree_state(repo), before)
            (repo / "unexpected.txt").write_text("unexpected write\n")
            self.assertNotEqual(benchmark.worktree_state(repo), before)
            self.assertIn("unexpected.txt", benchmark.worktree_state(repo))

    def test_inherited_git_routing_cannot_modify_another_repository(self):
        with tempfile.TemporaryDirectory(prefix="proof-benchmark-isolation-") as temporary:
            directory = Path(temporary).resolve()
            decoy = directory / "decoy"
            decoy.mkdir()
            benchmark.git(decoy, "init", "-b", "main")
            benchmark.git(decoy, "config", "user.name", "Proof Test")
            benchmark.git(decoy, "config", "user.email", "test@example.invalid")
            benchmark.git(decoy, "config", "commit.gpgsign", "false")
            benchmark.git(decoy, "config", "core.hooksPath", os.devnull)
            (decoy / "untouched.txt").write_text("preserve this repository\n")
            benchmark.git(decoy, "add", "untouched.txt")
            benchmark.git(decoy, "commit", "-m", "Decoy")
            before = {str(p.relative_to(decoy)): benchmark.digest(p)
                      for p in decoy.rglob("*") if p.is_file()}
            fixture = directory / "fixture"
            fixture.mkdir()
            hostile = {
                "GIT_DIR": str(decoy / ".git"), "GIT_WORK_TREE": str(decoy),
                "GIT_INDEX_FILE": str(decoy / ".git/index"),
                "GIT_COMMON_DIR": str(decoy / ".git"),
                "GIT_OBJECT_DIRECTORY": str(decoy / ".git/objects"),
                "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.bare",
                "GIT_CONFIG_VALUE_0": "true",
            }
            with patch.dict(os.environ, hostile):
                repo, shape = benchmark.create_fixture(fixture, 1)
                self.assertEqual(shape["trackedFiles"], 10000)
                self.assertEqual(benchmark.git(repo, "rev-list", "--count", "HEAD").strip(), b"1")
                self.assertEqual(
                    Path(benchmark.git(repo, "rev-parse", "--show-toplevel").decode().strip()), repo
                )
                # Check the environment received by the persistent Core child too.
                executable = directory / "environment-driver"
                executable.write_text(
                    f"#!{sys.executable}\nimport json, os, sys\n"
                    "for line in sys.stdin:\n"
                    " print(json.dumps({'value': {k:v for k,v in os.environ.items() "
                    "if k.startswith('GIT_')}}), flush=True)\n"
                )
                executable.chmod(0o700)
                core = benchmark.Core(executable, directory / "data", directory / "stderr.log")
                try:
                    actual, _ = core.request("environment")
                    self.assertEqual(actual, {
                        "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
                        "GIT_OPTIONAL_LOCKS": "0", "GIT_ATTR_NOSYSTEM": "1",
                    })
                finally:
                    core.close()
            after = {str(p.relative_to(decoy)): benchmark.digest(p)
                     for p in decoy.rglob("*") if p.is_file()}
            self.assertEqual(after, before)

    def test_report_survives_request_and_close_failures(self):
        with tempfile.TemporaryDirectory(prefix="proof-benchmark-failure-") as temporary:
            directory = Path(temporary)
            repo = directory / "repo"
            (repo / ".git").mkdir(parents=True)
            (repo / ".git/index").write_bytes(b"index")
            (repo / ".git/config").write_bytes(b"config")
            output = directory / "failure.json"
            with patch.object(benchmark, "create_fixture", return_value=(repo, {})), \
                 patch.object(benchmark, "git", return_value=b"fixture\n"), \
                 patch.object(benchmark, "system_value", return_value="test"), \
                 patch.object(benchmark, "Core") as driver, \
                 patch.object(benchmark.tempfile, "mkdtemp", return_value=str(directory)), \
                 patch.object(sys, "argv", ["measure-git-baseline.py", "--driver", sys.executable,
                                            "--output", str(output)]):
                driver.return_value.request.side_effect = RuntimeError("request failure")
                driver.return_value.close.side_effect = RuntimeError("close failure")
                with self.assertRaisesRegex(RuntimeError, "request failure"):
                    benchmark.main()
            report = json.loads(output.read_text())
            self.assertFalse(report["complete"])
            self.assertIn("request failure", report["error"])
            self.assertIn("close failure", report["closeError"])


if __name__ == "__main__":
    unittest.main()
