"""Create a separate, real multi-branch repository for History UI acceptance.

All authors and code are fictional. Never overwrite an existing fixture, inherit
user Git configuration, use a remote, or touch the original native Git fixture.
"""
from pathlib import Path
import hashlib
import json
import os
import subprocess

root = Path(__file__).resolve().parents[1]
fixture = root / '.artifacts' / 'history-fixture'
repo = fixture / 'demo-service'
if repo.exists():
    raise SystemExit(f'Fixture already exists; preserved: {repo}')
repo.mkdir(parents=True)
environment = {key: value for key, value in os.environ.items()
               if not key.startswith('GIT_')}
environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
sequence = 0


def git(*args):
    return subprocess.check_output(['git', '-C', str(repo), *args],
                                   env=environment).decode().strip()


def commit(message, file=None, content=None, merge=None):
    global sequence
    sequence += 1
    environment['GIT_AUTHOR_DATE'] = f'2026-09-12T12:{sequence:02d}:00+08:00'
    environment['GIT_COMMITTER_DATE'] = environment['GIT_AUTHOR_DATE']
    if file is not None:
        target = repo / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        git('add', '--', file)
    if merge is not None:
        git('merge', '--no-ff', '-m', message, merge)
    else:
        git('commit', '-m', message)
    return git('rev-parse', 'HEAD')


git('init', '-b', 'main')
git('config', 'user.name', 'Proof History Fixture')
git('config', 'user.email', 'history@example.invalid')
git('config', 'commit.gpgsign', 'false')
git('config', 'core.hooksPath', str(repo / '.git' / 'hooks'))
initial = commit('Initialize request service', 'README.md', '# Fictional request service\n')
commit('Add request entry point', 'src/requests.ts',
       'export function handleRequest(body: unknown) {\n  return { data: body };\n}\n')
commit('Add response helpers', 'src/response.ts',
       'export const response = (data: unknown) => ({ data });\n')
git('switch', '-c', 'docs/api-reference')
commit('Describe request and response contract', 'docs/api.md',
       '# API reference\n\nThe endpoint accepts JSON objects.\n')
docs_tip = commit('Document validation errors', 'docs/api.md',
                  '# API reference\n\nThe endpoint accepts JSON objects.\nErrors use status 400.\n')
git('switch', 'main')
commit('Add local development settings', 'service.json', '{"port":8080}\n')
commit("Merge branch 'docs/api-reference'", merge='docs/api-reference')
git('tag', '-a', 'v0.1.0', '-m', 'Fictional acceptance release')
git('switch', '-c', 'feature/request-validation')
commit('Validate object request payloads', 'src/validation.ts',
       'export function validate(body: unknown) {\n  if (!body || typeof body !== "object") throw new Error("Invalid request");\n  return body;\n}\n')
validation_tip = commit('Apply request validation at the entry point', 'src/requests.ts',
                        'import { validate } from "./validation";\n\nexport function handleRequest(body: unknown) {\n  return { data: validate(body) };\n}\n')
git('switch', '-c', 'feature/input-limits')
commit('Limit request payload size', 'src/limits.ts',
       'export const MAX_REQUEST_BYTES = 1024 * 1024;\n')
limits_tip = commit('Cover oversized payloads', 'tests/limits.test.ts',
                    '// Fictional fixture: tests are history content, not executed evidence.\nexport const oversized = 1024 * 1024 + 1;\n')
git('switch', 'main')
commit('Add request ID forwarding', 'src/request-id.ts',
       'export const requestId = (headers: Headers) => headers.get("x-request-id");\n')
commit('Standardize response metadata', 'src/response.ts',
       'export const response = (data: unknown) => ({ data, version: 1 });\n')
merge = commit("Merge branch 'feature/request-validation'", merge='feature/request-validation')
git('update-ref', 'refs/remotes/origin/main', merge)
parents = git('rev-list', '--parents', '-n', '1', merge).split()[1:]
tracked = git('ls-files').splitlines()
manifest = {
    'repository': str(repo), 'head': merge, 'parents': parents,
    'commits': int(git('rev-list', '--all', '--count')),
    'tips': {'docs': docs_tip, 'validation': validation_tip, 'limits': limits_tip},
    'initial': initial,
    'indexSha256': hashlib.sha256((repo / '.git' / 'index').read_bytes()).hexdigest(),
    'trackedFileSha256': {name: hashlib.sha256((repo / name).read_bytes()).hexdigest()
                          for name in tracked},
    'expectedParentPatch': {str(index): git('diff', '--no-ext-diff', '--no-textconv',
                                          parent, merge, '--')
                            for index, parent in enumerate(parents)},
    'workingTreeStatus': git('status', '--porcelain=v1'),
    'nativeVerification': 'pending',
}
(fixture / 'expected.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'repository': str(repo), 'head': merge, 'parents': parents,
                  'commits': manifest['commits']}, ensure_ascii=False, indent=2))
