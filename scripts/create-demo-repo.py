"""Create an isolated, fictional Git repository for native Proof acceptance.

Never overwrites an existing directory and never touches the user's Git config.
"""
from pathlib import Path
import os
import subprocess

root = Path(__file__).resolve().parents[1]
repo = root / '.artifacts' / 'demo-service'
if repo.exists():
    raise SystemExit(f'Fixture already exists; preserved: {repo}')
repo.mkdir(parents=True)
environment = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')

def git(*args):
    subprocess.run(['git', '-C', str(repo), *args], env=environment, check=True, capture_output=True)

git('init', '-b', 'main')
git('config', 'user.name', 'Proof Acceptance')
git('config', 'user.email', 'proof@example.invalid')
git('config', 'commit.gpgsign', 'false')
git('config', 'core.hooksPath', str(repo / '.git' / 'hooks'))
(repo / 'src' / 'api').mkdir(parents=True)
source = """import { createResponse } from './response';

export async function handleRequest(request: Request) {
  const body = await request.json();
  return createResponse(body);
}

// A fictional service used only for Proof acceptance.
// Request processing is intentionally kept simple here.
// The following helpers keep two edits in separate hunks.

export function requestId(headers: Headers) {
  return headers.get('x-request-id');
}

export function isJson(headers: Headers) {
  return headers.get('content-type') === 'application/json';
}

export function onError(error: Error) {
  return createResponse({ message: 'Internal error' });
}
"""
(repo / 'src' / 'api' / 'requests.ts').write_text(source)
(repo / 'README.md').write_text('# Demo service\n\nFictional acceptance repository for Proof.\n')
git('add', '--', '.')
git('commit', '-m', 'Initialize fictional service')
git('switch', '-c', 'feat/request-validation')
(repo / 'src' / 'api' / 'requests.ts').write_text(source.replace(
    '  const body = await request.json();',
    "  const payload = await request.json();\n  const body = validateRequest(payload);"
).replace("  return createResponse({ message: 'Internal error' });", "  return createResponse({ message: error.message }, { status: 400 });"))
(repo / 'README.md').write_text('# Demo service\n\nFictional acceptance repository for Proof.\n\nValidate incoming requests before processing.\n')
git('add', '--', 'README.md')
print(repo)
