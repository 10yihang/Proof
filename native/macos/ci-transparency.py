#!/usr/bin/env python3
"""One explicitly authorized disposable-runner check; never used by the app.

Persist the original preference before a write. Every mutation is checked using
NSWorkspace in a fresh native process. The workflow supplies EXIT and always()
restoration paths. No privilege escalation, process killing, or fallback write
route is attempted when the system rejects the setting.
"""
import json
import pathlib
import subprocess
import sys
import time

DOMAIN = 'com.apple.universalaccess'
KEY = 'reduceTransparency'


def preference():
    result = subprocess.run(['/usr/bin/defaults', 'read', DOMAIN, KEY], text=True, capture_output=True)
    if result.returncode:
        if 'does not exist' in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip() or 'Could not read accessibility preference')
    value = result.stdout.strip().lower()
    if value in ('1', 'true', 'yes'):
        return True
    if value in ('0', 'false', 'no'):
        return False
    raise RuntimeError('Unexpected preference type; no changes made')


def effective(helper):
    result = subprocess.run([helper], check=True, text=True, capture_output=True)
    value = result.stdout.strip()
    if value not in ('true', 'false'):
        raise RuntimeError('Native transparency read did not return a boolean')
    return value == 'true'


def verify_effective(helper, expected):
    for _ in range(5):
        if effective(helper) == expected:
            return
        time.sleep(0.4)
    raise RuntimeError('Native transparency state did not match the requested value; stopping without another write route')


def save(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2) + '\n')


def write(value):
    command = ['/usr/bin/defaults', 'delete', DOMAIN, KEY] if value is None else [
        '/usr/bin/defaults', 'write', DOMAIN, KEY, '-bool', str(value).lower()]
    subprocess.run(command, check=True)


def main():
    action, state_file, helper = sys.argv[1:]
    path = pathlib.Path(state_file)
    if action == 'begin':
        if path.exists():
            raise RuntimeError('A saved preference already exists; restore it before beginning another check')
        state = {'originalPreference': preference(), 'originalEffective': effective(helper),
                 'scope': 'one explicitly approved disposable CI run', 'status': 'original_saved'}
        save(path, state)
        # An unsuccessful write still leaves the original available for cleanup.
        if state['originalPreference'] is not False:
            write(False)
        verify_effective(helper, False)
        state.update(status='applied', captureEffective=False)
        save(path, state)
        print('Native transparency enabled for this capture; NSWorkspace confirms reduceTransparency=false')
    elif action == 'restore':
        if not path.exists():
            return
        state = json.loads(path.read_text())
        if preference() != state['originalPreference']:
            write(state['originalPreference'])
        verify_effective(helper, state['originalEffective'])
        state.update(status='restored', restoredPreference=preference(), restoredEffective=effective(helper))
        save(path, state)
        print('Original accessibility preference restored and native state verified: ' + json.dumps(state))
    else:
        raise RuntimeError('Unknown action')


if __name__ == '__main__':
    main()
