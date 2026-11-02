# Validation record — Linux cloud, 2026-11-02

Base: `cc4f546075c4358f3c4fab0d464e46f232ddbbdc` (`v0.1.17`).
No user Mac, Codex installation, agent CLI, push, PR or publication was used.
Rust 1.99.1 was installed from the official Rust source in isolated
`/tmp/proof-rust` with user approval; no shell profile changes.

## Passed

- `cargo test -p proof-swift-bridge`: **4 passed**. Disposable real repositories
  cover full manual workflow, stale writes, trust, closed dispatch and actual
  stdin/stdout framing with escaped paths. A failing unknown-field test exposed
  Serde's unit-variant behavior; empty struct variants fixed it before rerun.
- `cargo test -p proof-core -- --skip ai::tests::ocr_review_output_maps_onto_the_shared_review_schema`:
  **281 passed, 5 ignored, 1 filtered** across unit/integration/doc test suites.
- `cargo fmt --check -p proof-swift-bridge`, `git diff --check`.
- `bash -n native/macos/build.sh`; Info.plist parsed with Python `plistlib`.
- Linux invocation of build.sh correctly refuses to build a Mac app.
- Independent read-only review and executable transport smoke: malformed request
  rejection, spaces/quotes/newline/Unicode filenames, untrusted-stage rejection
  with unchanged index, request IDs, unknown cancellation and clean EOF exit.
- Static Swift review fixed optional List selection binding, MainActor App
  initialization, centralized draft confirmation and visible CR characters.

## Failed / environment-dependent

The **unfiltered** `cargo test -p proof-core` is not green: 76 unit tests passed,
2 were ignored and the existing OCR test failed at `ai/tests.rs:1873`, expecting
`AI_ISOLATION_UNAVAILABLE` but observing `AI_AGENT_MISSING`. The cloud has no OCR
agent. No agent was installed or invoked to work around it. The separate run
above excludes exactly that test; this is not a claim of a full-suite pass.

Existing core did not compile on Linux because `editor_applications()` creates
an untyped empty Vec populated only under macOS/Windows cfg. The only core code
change is an explicit `Vec<PathBuf>` annotation, without a behavior change.
Existing Linux-only unused import/dead-code warnings remain.

## Not run

No Swift compiler, AppKit or macOS runtime is present. Native compilation,
rendered UI review, screenshots, signing execution, accessibility and real Mac
acceptance remain **unverified**. The independent review is static, not a
substitute for a build. In particular, test actual window delegate installation,
red-close/Cmd-W/Cmd-Q guards, SwiftUI lifecycle, file-picker focus, and system
find-bar behavior on Mac. Follow the checklist in README.md before release.

No macOS binary, signed distribution package or publication was produced.

## Native redesign verification — 2026-11-02

Commit `ef4e2e85ffe2a23d6d42dde563d5e76cefe51a5a`,
[macOS run 41385923344](https://github.com/10yihang/Proof/actions/runs/41385923344):
Swift release compilation, 4 Rust bridge tests, ad-hoc bundle signature and bridge
protocol smoke passed on macOS 15.8.2 arm64. Capture produced light/dark native
images, but the runner screen constrained them to 1440×708; the size assertion
correctly failed. These are not accepted visual evidence.

Linux bridge tests rerun after redesign: 4 passed. Rust core and bridge source
were not modified by the visual redesign. No interactive acceptance is claimed.

### Confirmed visual preview

Commit `a2bcf427fd4193de74ab34f1e61f4e6b3a8e6cb3`,
[macOS run 41386931187](https://github.com/10yihang/Proof/actions/runs/41386931187),
passed every step: Swift 6.1.2 release build, 4 real-Git bridge tests, bundle
signature, protocol smoke, native light/dark capture and artifact packaging.
Both PNGs are 1440×900 actual AppKit window renders with labeled illustrative
data. They are not HTML/image-generation mockups or interactive testing.

One independent visual pass found blank gutter, mixed dark surfaces and an
over-wide file pane. One batched fix and confirmation pass resolved those three
findings. The reviewer approved the Changes-screen visual preview at this scope.
No other screens were expanded and no broader usability/accessibility claim is made.

Artifacts for that exact commit:
- Screenshots: `13115563110`
- Ad-hoc signed macOS build: `13115299607` (not notarized, not a release)
- Light PNG SHA-256: `1fba9527b0f137eb13987d50429492d1addd8e088e439f0c5af03eedd9a19c63`
- Dark PNG SHA-256: `08e72e15df9db1e71bdcb47ab6e6ea3d4972945a8e9b700c50148651b0b14ac2`

Keyboard/focus, scrolling, resizing, interactive Git flows, VoiceOver, hooks and
close/cancel acceptance remain outstanding. Rust write guards were unchanged.
