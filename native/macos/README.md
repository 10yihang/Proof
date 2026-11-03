# Proof Native — additive SwiftUI client

An independent macOS frontend for the existing `proof-core`, not a replacement
for the Tauri app. No web view, copied Git implementation or new Rust runtime dependency.
Optional AI uses the existing Core adapters for user-installed Agent CLIs. Runs on macOS 13+. Building requires Xcode 26+ (the preview CI uses Xcode 27), Rust and system Git. New material APIs are availability-guarded for older macOS versions.

## Build and run on a Mac

From the repository root:

```sh
./native/macos/build.sh
open "native/macos/build/Proof Native.app"
```

The script builds the Rust sidecar and Swift executable for the current machine,
packages them together, reuses Proof's existing icon, and ad-hoc signs the local
app. It does not publish, notarize, install or replace the existing Proof app.
Developer ID signing, universal builds and distribution are not implemented.
Do not copy a Linux sidecar into a Mac app.

Development without packaging:

```sh
cargo build -p proof-swift-bridge
PROOF_SWIFT_BRIDGE="$PWD/target/debug/proof-swift-bridge" \
  swift run --package-path native/macos ProofNative
```

`PROOF_SWIFT_BRIDGE` is a developer-only executable-path override. It is never
read from repository content. The default is the bundled sidecar.
The app is not sandboxed: access to arbitrary user-selected Git repositories and
Git hooks is intentional. Trust remains explicit and initially off.

## Implemented workflow

- Local repository picker/recent repositories, Changes, History, Branches and Settings.
- Collapsible native shell, light/dark appearances, native materials with opaque
  accessibility fallback, compact density, system file-type icons and code size.
- Selectable AppKit unified/split diff, aligned change rows, separate gutters,
  synchronized vertical scrolling, independent horizontal scrolling, raw patch,
  lightweight lexical coloring and Cmd-F. Not a full parser/editor.
- Snapshot-checked whole-file and hunk stage/unstage; separate human review for
  files or individual hunks. Hunk popover preserves the captured target.
- Subject/body commit draft, staged-scope preview, human coverage and explicit
  confirmation before committing. Draft remains intact on errors.
- Local/remote-tracking branch browsing and previewed branch switching. Remote
  switching creates a tracking local branch; no force checkout.
- Explicit Fetch/Pull/Push through Core's short-lived previews. No forced push,
  rebasing/merging pull or automatic remote access (pull is fast-forward only). Upstream must already be configured.
- Five-second local refresh while active and idle; skips writes, reads, AI and
  confirmation dialogs, preserves draft/selection, stops with repository closure.
- Explicit AI review of the selected file and commit-message generation from
  staged files. Selected files are analysis focus, not a read allowlist: the Core
  agent reads the live repository, including related unchanged/ignored context.
  Explicit confirmation discloses that access and provider transmission. The
  bridge checks the change token before/after the job, not a frozen filesystem.
  Findings/limitations
  are displayed; generated text replaces the draft only after confirmation.
- Agent CLI path/model/default-provider settings, isolated from the original app.
  No installation, login, token storage, automatic AI, Observer or code edits.
- Cancellable reads/AI, stale-response suppression, write exclusion, error/empty
  states, refresh after writes and uncertain failures, and draft/write quit guards.

## Data and trust boundaries

Native app data: `~/Library/Application Support/ProofNative/`.
Bundle identifier: `dev.proof.native`. It never imports or shares the original
Proof database/settings, and does not read `PROOF_DATA_DIR`. Git repositories and
their index are naturally shared with other Git clients. An idle local poll detects edits in
other applications; this is not a filesystem watcher or automatic fetch. Write guards
in core reject outdated content, index or HEAD rather than silently retrying.

The bundled `proof-swift-bridge <data-directory>` process accepts UTF-8 JSON
lines on stdin, emits only JSON response lines on stdout, and sends diagnostics
to stderr. Each request has a numeric ID; all `Proof` access is serialized on one
worker. Input frames are bounded to 1 MiB. Request schema rejects unknown fields
and unknown operations. There is no arbitrary shell/file-write dispatch. The whitelist permits only
specific Core Git actions, hunk operations and user-requested local AI tasks.
Agent executable paths are validated by the existing Core settings layer. Network
operations require repository trust and a fresh prepared preview.

```json
{"id":1,"command":{"method":"hello"}}
{"id":2,"command":{"method":"open","path":"/absolute/repository"}}
{"cancel":2}
```

Response: `{"id":1,"result":{"protocol":1}}` or
`{"id":2,"error":{"code":"…","message":"…","detail":"…"}}`.
Protocol 1 method schemas live in `crates/proof-swift-bridge/src/lib.rs`; Swift
validates the handshake. JSON encodes paths/messages with embedded newlines.
Cancellation applies to read/preparation methods and explicit AI jobs. Write requests are never
cancelled or automatically retried. EOF cancels reads but lets an accepted write
finish; a process crash still requires the user to inspect actual Git state.
Core snapshots and commit previews remain inside the long-lived Rust process.

## Validation

Actual Linux results and the known unfiltered core-test failure are recorded in
[VALIDATION.md](VALIDATION.md).

```sh
cargo test -p proof-swift-bridge
cargo test -p proof-core
cargo fmt --check -p proof-swift-bridge
swift build --package-path native/macos
```

Bridge tests use disposable real Git repositories and isolated data directories:
trust rejection, stage/unstage, review migration, multiline commit, history and
commit diff, stale stage/review/commit rejection, and closed dispatch whitelist.
No user repository is modified by the tests.

**Native validation:** the preview workflow builds with Xcode 27 and runs bridge,
model, native Diff/window and message-editor checks. New behavior is validated on
that exact workflow commit, not inferred from an older green run. Screenshot
capture uses fixture data and proves rendering, not full user interaction.
macOS 13 remains the deployment target with availability guards; the CI does not
run macOS 13. VoiceOver, real account credentials/Agent inference and full manual
acceptance remain separate checks. This is not notarized or release-ready.

### Mac acceptance checklist

1. Build, launch, open a disposable repository; cancel the picker and reopen.
2. Read modified/new/deleted/renamed files, binary changes and conflicts. Test a
   path containing spaces, quotes, Unicode and a newline. No demo fallback.
3. Switch selected files/history rapidly, cancel a long read, then refresh. No
   obsolete result should replace the latest selection.
4. Trust explicitly; stage/unstage and verify with external `git status`. Edit a
   file externally before staging/reviewing: core must reject stale snapshots.
5. Mark reviewed, change content externally, refresh and verify invalidation.
6. Preview a commit; externally alter index/HEAD, then confirm: reject stale
   preview. Check message retention on error and configured hook failure.
7. Quit/close during a write: block until completion. Quit with a draft: confirm.
8. Kill the bridge only in a disposable test repo: show an error, never retry a
   write; reopen and inspect actual state. Test missing executable at startup.
9. Test Cmd-O/R/F, tab focus, VoiceOver, resize, long paths/messages and both themes.

## Remaining capability gaps

One repository/window at a time; drafts are memory-only. No arbitrary branch
creation/rename/deletion, merge/rebase/cherry-pick/revert/reset, discard/recovery,
stash, tags, amend, full history graph, merge-parent picker, blame, file editor,
full-file/context expansion, logical groups, persisted report browser/finding
resolution, Observer/session evidence, review export, updater or universal build.
History filtering covers loaded rows only. AI reports currently display findings,
not clickable code-range navigation or finding decision workflows. Failed merges
must be resolved with an existing Git tool. Existing Tauri functionality remains
unchanged and should be used for features not yet migrated.

## Native Changes visual preview

The Changes surface now uses a compact collapsible navigation rail, filename/path
hierarchy, a single-line action toolbar and an AppKit diff with a separate gutter,
full-width change bands and lightweight lexical coloring (not a full parser).
No CodeEditSourceEditor dependency is added; its official README warns it is not
yet production-ready. SwiftUI and AppKit remain the only UI frameworks.

The macOS CI build renders the actual app window in light and dark appearances:

```sh
for theme in light dark; do
  "native/macos/build/Proof Native.app/Contents/MacOS/ProofNative" \
    --capture-preview /tmp/proof-captures --preview-theme "$theme"
done
```

This explicit mode uses illustrative data labeled Preview, starts no bridge, and
opens no Git repository. The PNGs are native AppKit captures, not browser mockups.
They prove layout/rendering only, not interactive acceptance or release readiness.
