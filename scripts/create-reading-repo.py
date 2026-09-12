"""Create a separate real repository for native Diff reading acceptance.

Preserves existing fixtures and ignores global Git configuration. No network,
Agent programs or user source repositories are involved.
"""
from pathlib import Path
import hashlib
import json
import os
import subprocess

root = Path(__file__).resolve().parents[1]
repo = root / '.artifacts' / 'reading-fixture' / 'demo-service'
source = root / '.artifacts' / 'history-fixture' / 'demo-service'
if repo.exists():
    raise SystemExit(f'Existing reading fixture preserved: {repo}')
if not source.is_dir():
    raise SystemExit('Run scripts/create-history-repo.py first.')
repo.parent.mkdir(parents=True, exist_ok=True)
environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')


def git(*args):
    return subprocess.check_output(['git', '-C', str(repo), *args], env=environment).decode()


subprocess.run(['git', 'clone', '--no-hardlinks', str(source), str(repo)], env=environment, check=True)
git('config', 'user.name', 'Proof Reading Acceptance')
git('config', 'user.email', 'reading@example.invalid')
git('config', 'commit.gpgsign', 'false')
git('config', 'core.autocrlf', 'false')
git('config', 'core.hooksPath', str(repo / '.git' / 'hooks'))
special = {
    1: '// Fictional source for native Proof reading acceptance.',
    8: 'export function label() {',
    9: '  // Keep the public name explicit.',
    10: '  const value = "original";',
    11: '  return value;',
    12: '}',
    22: 'export const traceFields = "' + 'requestId, route, duration, status, ' * 8 + 'complete";',
    43: 'export function readiness() {',
    44: '  // The second change only changes indentation.',
    45: '  return "ready";',
    46: '}',
}
baseline = ''.join(special.get(n, f'// Stable context line {n:02d}.') + '\n' for n in range(1, 71))
path = repo / 'src' / 'reading.ts'
path.write_text(baseline)
git('add', '--', 'src/reading.ts')
environment['GIT_AUTHOR_DATE'] = '2026-09-12T15:00:00+08:00'
environment['GIT_COMMITTER_DATE'] = environment['GIT_AUTHOR_DATE']
git('commit', '-m', 'Add fictional native reading fixture')
working = baseline.replace('const value = "original"', 'const value = "reviewed"').replace('  return "ready";', '    return "ready";')
path.write_text(working)
readme = repo / 'README.md'
readme.write_text(readme.read_text() + '\nNative acceptance staged note.\n')
git('add', '--', 'README.md')
record = {
    'repository': str(repo),
    'head': git('rev-parse', 'HEAD').strip(),
    'mergeCommit': 'c3537dc32204225182d75b693bc7a399337c30a4',
    'baseline': baseline,
    'working': working,
    'expectedIndexAfterFirstHunk': baseline.replace('const value = "original"', 'const value = "reviewed"'),
    'patchBefore': git('diff', '--no-ext-diff', '--no-textconv', '--', 'src/reading.ts'),
    'indexSha256Before': hashlib.sha256((repo / '.git' / 'index').read_bytes()).hexdigest(),
    'workingSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
    'nativeVerification': 'pending',
}
(repo.parent / 'expected.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'repository':str(repo), 'head':record['head'], 'changes':git('status','--porcelain=v1')}, ensure_ascii=False, indent=2))
