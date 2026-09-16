# Signed application updates

Proof 0.1.1 uses the official Tauri updater with a public verification key in
`src-tauri/tauri.conf.json`. The stable feed is the `latest.json` asset of the
latest public GitHub Release. Checks first resolve GitHub's public latest-release redirect
and compare its stable tag, then pin the manifest URL to that tag. This avoids
requiring login or depending on the anonymous GitHub API rate quota. Legacy 0.1.0
has no updater manifest: an equal/newer installed version is current; a newer
release without its manifest is reported as not yet available for in-app update.
Network failures, GitHub rate limits and invalid feeds remain explicit errors.
Only newer compatible versions are offered; package signature checks are unchanged.
The current distribution target is macOS Apple Silicon.

The initial private signing key is stored locally at `.release-keys/updater.key`
(directory 0700, key 0600, excluded from Git). Back up this key securely before
moving or deleting this checkout. Reuse it for subsequent releases: regenerating
the key prevents installed clients from accepting future updates. Never commit
the key, include it in artifacts, or print it in CI logs.

## Local build

Run `npm run release:build`. It reads `TAURI_SIGNING_PRIVATE_KEY` (key content or
path), or the local key above. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional.
The build creates the DMG, `Proof.app.tar.gz`, its `.sig`, and
`.artifacts/releases/<version>/latest.json`. The script builds packages only;
it does not publish or modify Git branches/tags.

Upload the DMG, updater archive, signature and `latest.json` to the same draft
release `v<version>`. Verify the archive URL in `latest.json` matches the uploaded
filename. Publish only after validation; do not make a release latest before all
its update assets are present. Never overwrite a published version's packages.

## GitHub Actions

Configure the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY` with the
existing local key, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if encrypted. Run
the **Build signed release** workflow from `main`. It runs checks and builds a
draft release with Tauri's signed updater assets and `latest.json`; review the
draft before publishing. Repository secrets and release publication are separate
from implementing this feature locally.

Tauri's updater signature and Apple's Developer ID notarization are separate.
Current macOS bundles retain the project's existing ad-hoc code signing.
Users of 0.1.0 must manually install 0.1.1 once because 0.1.0 has no updater.

References: [Tauri updater](https://v2.tauri.app/plugin/updater/),
[Tauri release action](https://github.com/tauri-apps/tauri-action).
