# Proof Native — additive SwiftUI client

An independent macOS frontend for the existing `proof-core`, not a replacement
for the Tauri app. No web view, copied Git implementation, agent CLI or new Rust
runtime dependency. Requires macOS 13+, Swift 5.9+ (Xcode 15+), Rust and system Git.

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

- Native directory picker and recent repositories; Changes / Commit / History.
- Unstaged and staged file lists with search, status and rename origin.
- Native selectable unified diff, line numbers, +/- markers, human review state,
  raw patch, and system find bar (focus the diff and press Cmd-F).
- Read-only history with incremental paging and first-parent commit patches.
- Explicit repository trust; snapshot-validated whole-file stage/unstage.
- Content-bound whole-file manual review, separate from Git staging.
- Dedicated commit page and checked preview: staged file scope, human coverage,
  branch, message, unread coverage and hook warning before explicit confirmation.
- Error/empty/loading states, cancellable reads, stale-response suppression, write
  exclusion, refresh after writes (including uncertain failures), and quit guards.
- No automatic AI, observer, push, discard, reset, amend or remote operation.

The three native columns prioritize code over chrome: a system sidebar, compact
file navigation and a selectable AppKit text surface. System typography, semantic
colors and standard controls support light/dark mode and keyboard navigation.
Red/green only supplement explicit diff markers; reviewed uses a blue label.
This is a native adaptation of `docs/DESIGN.md`, not a redesign of the Tauri UI.

## Data and trust boundaries

Native app data: `~/Library/Application Support/ProofNative/`.
Bundle identifier: `dev.proof.native`. It never imports or shares the original
Proof database/settings, and does not read `PROOF_DATA_DIR`. Git repositories and
their index are naturally shared with other Git clients. Refresh after edits in
other applications; this first version has no filesystem watcher. Write guards
in core reject outdated content, index or HEAD rather than silently retrying.

The bundled `proof-swift-bridge <data-directory>` process accepts UTF-8 JSON
lines on stdin, emits only JSON response lines on stdout, and sends diagnostics
to stderr. Each request has a numeric ID; all `Proof` access is serialized on one
worker. Input frames are bounded to 1 MiB. Request schema rejects unknown fields
and unknown operations. There is no shell command, configurable executable,
file-write, AI, network, preference or destructive-operation dispatch.

```json
{"id":1,"command":{"method":"hello"}}
{"id":2,"command":{"method":"open","path":"/absolute/repository"}}
{"cancel":2}
```

Response: `{"id":1,"result":{"protocol":1}}` or
`{"id":2,"error":{"code":"…","message":"…","detail":"…"}}`.
Protocol 1 method schemas live in `crates/proof-swift-bridge/src/lib.rs`; Swift
validates the handshake. JSON encodes paths/messages with embedded newlines.
Cancellation only applies to read/preparation methods. Write requests are never
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

**Native validation limitation:** implementation was authored in a Linux cloud
workspace without Swift/Xcode/AppKit. Swift compilation, app launch, screenshots,
VoiceOver, keyboard focus, light/dark contrast, window-close behavior and actual
macOS Git-hook behavior must be checked on a Mac before calling this releasable.
This is source plus a reproducible build path, not a verified macOS binary.

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

## Deliberate first-version limits

One repository/window at a time; commit drafts are memory-only. No split diff,
full parser-based syntax highlighting, hunk-level actions, graph layout, branch switching, merge
parent picker, blame, file editor, logical groups, evidence/AI panels, recovery,
stash, remotes, settings or updater. History filters only loaded rows. No working
copy auto-refresh. Large diff limits come from core. Use the existing Tauri app
for features beyond this focused read/review/stage/commit workflow.

## Native Changes visual preview

The Changes surface now uses a compact collapsible navigation rail, filename/path
hierarchy, a single-line action toolbar and an AppKit diff with a separate gutter,
full-width change bands and lightweight lexical coloring (not a full parser).
No CodeEditSourceEditor dependency is added; its official README warns it is not
yet production-ready. SwiftUI and AppKit remain the only UI frameworks.

The macOS CI build renders the actual app window in light and dark appearances:

```sh
"native/macos/build/Proof Native.app/Contents/MacOS/ProofNative" --capture-preview /tmp/proof-captures
```

This explicit mode uses illustrative data labeled Preview, starts no bridge, and
opens no Git repository. The PNGs are native AppKit captures, not browser mockups.
They prove layout/rendering only, not interactive acceptance or release readiness.
