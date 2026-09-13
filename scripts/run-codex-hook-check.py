#!/usr/bin/env python3
"""Opt-in real Codex/Proof compatibility check in a new, disposable repository.

Build proof-observer and its codex_hook_fixture example first. This runs a model
only with --allow-model-run. It does not install hooks into the user's config.
"""
import atexit
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import shlex
import signal
import sqlite3
import subprocess
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path)
parser.add_argument("--allow-model-run", action="store_true", required=True)
parser.add_argument("--synchronous-stop", action="store_true", help="Compatibility experiment: wait for the bounded Stop bridge")
parser.add_argument("--capture-schema", action="store_true", help="Capture field names/types, never string content, for compatibility diagnosis")
args = parser.parse_args()
project = Path(__file__).resolve().parents[1]
fixture_root = args.directory.resolve()
subprocess.run([str(project / "target/debug/examples/codex_hook_fixture"),
                str(fixture_root), str(project / "target/debug/proof-observer"), shutil.which("codex")], check=True)
fixture = json.loads((fixture_root / "fixture.json").read_text())
repo = Path(fixture["workspace"]["path"])
if args.synchronous_stop:
    config_path = Path(fixture["hookConfiguration"])
    config = json.loads(config_path.read_text())
    config["hooks"]["Stop"][0]["hooks"][0]["async"] = False
    config_path.write_text(json.dumps(config, indent=2) + "\n")
if args.capture_schema:
    schema_script = fixture_root / "capture-schema.py"
    schema_script.write_text('''import json, sys, uuid
from pathlib import Path
def shape(value, depth=0):
    if depth > 5: return "depth-limit"
    if isinstance(value, dict): return {key: shape(v, depth+1) for key,v in list(value.items())[:100]}
    if isinstance(value, list): return [shape(v,depth+1) for v in value[:4]]
    if isinstance(value, str): return {"type":"string","length":len(value)}
    return value
try:
    raw=json.loads(sys.stdin.buffer.read(2097153))
    label=raw.get("tool_name") if raw.get("tool_name") in ["Bash","apply_patch"] else "other"
    (Path(__file__).parent/("schema-"+label+"-"+str(uuid.uuid4())+".json")).write_text(json.dumps(shape(raw),indent=2))
except Exception:
    pass
''')
    config_path = Path(fixture["hookConfiguration"])
    config = json.loads(config_path.read_text())
    config["hooks"]["PostToolUse"].append({"hooks":[{"type":"command","command":shlex.quote(shutil.which("python3"))+" "+shlex.quote(str(schema_script)),"async":False,"timeout":1}]})
    config_path.write_text(json.dumps(config, indent=2) + "\n")
data = Path(fixture["dataDirectory"])
auth_directory = fixture_root / "codex-config"
auth_directory.mkdir(mode=0o700, exist_ok=True)


def private_write(path, body):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(body)


# Reuse only an unexpired access credential. Never copy or rotate the user's
# refresh token, and remove the temporary access credential in finally.
credential = json.loads((Path.home() / ".codex/auth.json").read_text())
assert credential.get("auth_mode") == "chatgpt", "This check expects an existing ChatGPT login"
encoded = credential["tokens"]["access_token"].split(".")[1]
claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
assert claims["exp"] > time.time() + 600, "Refresh the normal Codex login before running this check"
credential["tokens"]["refresh_token"] = ""
credential_path = auth_directory / "auth.json"
atexit.register(lambda: credential_path.unlink(missing_ok=True))
private_write(credential_path, json.dumps(credential).encode())
del credential, claims, encoded
private_write(auth_directory / "config.toml", (
    'model = "gpt-6-astra"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\n'
    'sandbox_mode = "workspace-write"\n[features]\nhooks = true\nunbounded_connection_retries = false\n'
    f'[projects.{json.dumps(str(repo))}]\ntrust_level = "trusted"\n'
).encode())
runtime = data / "observer"
runtime.mkdir(exist_ok=True, mode=0o700)
lease = runtime / "foreground.json"
stopping = threading.Event()


def renew_lease():
    while not stopping.is_set():
        pending = runtime / "fixture-lease.pending"
        private_write(pending, json.dumps({"validUntil": int(time.time() * 1000) + 5000}).encode())
        pending.replace(lease)
        stopping.wait(1)


collector = None
codex = None
started = time.monotonic()
result = {}
try:
    renewer = threading.Thread(target=renew_lease, daemon=True)
    renewer.start()
    while not lease.exists():
        time.sleep(0.01)
    with (fixture_root / "collector.log").open("wb") as output:
        collector = subprocess.Popen([fixture["helper"], "serve", "--data-dir", str(data)],
                                     stdout=output, stderr=output, start_new_session=True)
    health = {}
    for _ in range(100):
        health_path = runtime / "runtime.json"
        if health_path.exists():
            health = json.loads(health_path.read_text())
            if health.get("pid") == collector.pid and not health.get("cleanShutdown"):
                break
        assert collector.poll() is None, "Collector did not start"
        time.sleep(0.05)
    assert health.get("pid") == collector.pid and not health.get("cleanShutdown"), "Collector health unavailable"
    prompt = (
        "This is an isolated Proof hook compatibility test. Work only in the current repository. "
        "Read answer.py. Use apply_patch to change return 41 to return 42. Then use the shell to run "
        "python3 -c 'import answer; assert answer.answer() == 42; print(\"HOOK_CHECK_OK\")'. "
        "Do not modify .codex or .git, do not inspect parent directories or credentials, do not use "
        "network tools, and do not create a commit. Reply only 'Hook fixture completed' after the check."
    )
    environment = dict(os.environ)
    environment["CODEX_HOME"] = str(auth_directory)
    for key in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_THREAD_ID"):
        environment.pop(key, None)
    with (fixture_root / "codex-events.jsonl").open("wb") as output, (fixture_root / "codex-stderr.log").open("wb") as error:
        # Only this isolated, freshly generated hook source is enabled. The
        # one-run trust option does not bypass command approvals or sandboxing.
        codex = subprocess.Popen([shutil.which("codex"), "exec", "-C", str(repo), "--json", "--color", "never",
                                  "--dangerously-bypass-hook-trust", "--ephemeral", "-o", str(fixture_root / "last-message.txt"), prompt],
                                 env=environment, stdout=output, stderr=error, stdin=subprocess.DEVNULL, start_new_session=True)
        result["codexExitCode"] = codex.wait(timeout=180)
    time.sleep(0.5)
    connection = sqlite3.connect("file:" + str(data / "proof.sqlite3") + "?mode=ro", uri=True)
    events = [json.loads(row[0]) for row in connection.execute("SELECT payload FROM observer_events ORDER BY received_at")]
    connection.close()
    result.update({
        "durationSeconds": round(time.monotonic() - started, 3), "codexVersion": "0.153.4",
        "synchronousStopExperiment": args.synchronous_stop,
        "schemaCaptureExperiment": args.capture_schema,
        "sourceChangedAsExpected": (repo / "answer.py").read_text() == fixture["expectedSource"],
        "events": [{key: event.get(key) for key in ("kind", "toolName", "paths", "commandState", "exitCode", "fieldStatus")} for event in events],
        "nativeSessionIds": sorted({event["nativeSessionId"] for event in events if event.get("nativeSessionId")}),
        "helperSha256": hashlib.sha256(Path(fixture["helper"]).read_bytes()).hexdigest(),
        "hookConfigurationSha256": hashlib.sha256(Path(fixture["hookConfiguration"]).read_bytes()).hexdigest(),
        "installer": "ObserverManager",
    })
    assert result["codexExitCode"] == 0 and result["sourceChangedAsExpected"]
    assert any(event["kind"] == "PostToolUse" and event.get("toolName") == "apply_patch" for event in events), "No actual patch event reached Proof"
    assert any(event["kind"] == "UserPromptSubmit" for event in events), "No actual prompt event reached Proof"
finally:
    for child in (codex, collector):
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
    stopping.set()
    credential_path.unlink(missing_ok=True)
    lease.unlink(missing_ok=True)
    result["credentialCopyRemoved"] = not credential_path.exists()
    (fixture_root / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
