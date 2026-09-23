# Proof UI refresh

The September 2026 refresh uses card-style workspaces for Local changes, History
and Files. The user's follow-up retains the original Commit layout: file selection
and the composer in the left sidebar, with a full-height Diff on the right.
Cards frame complete tools rather than individual rows; file lists and the Git
graph retain continuous, dense reading surfaces.

## Visual system

The authoritative application tokens remain in `src/styles/ui.css`. Light mode
uses white content, `#f3f4f6` chrome, `#242833` text and `#386bcb` accents. Dark
mode uses `#202227` content, `#181a1e` chrome, `#292c32` raised surfaces,
`#e9ebef` text and `#94b6fa` accents. Selections share a restrained background;
keyboard focus remains separate. Git additions, deletions and branch-lane colors
retain their meaning.

System fonts remain local. History subjects use 13px type; metadata uses 11px.
Panel headers share a 44px baseline, with wrapping where controls need more room.
Task cards use a 12px radius and subtle borders; controls use smaller radii.
Local changes uses 12px separator gutters shared with the resize model, so saved
panel widths remain accurate. Other workbenches keep their 4px separators.
Virtualized row heights and Git graph coordinates are unchanged.

## Card workspaces

- Local changes: file navigation, the main Diff and Context each have their own
  rounded surface, with a quiet canvas and 12px gaps. Narrow windows use smaller
  outer margins; existing overlay drawers still open above the Diff.
- History: repository navigation, the continuous toolbar/commit graph surface,
  and selected-commit details are distinct cards. Graph scrolling, parent links,
  row heights and selection behavior stay intact.
- Files: the repository file tree, editor and optional file-history pane are
  distinct cards. Editor controls wrap when needed, with the existing code and
  history scroll areas retained.

## Commit composition

Commit keeps its original left-sidebar composition. File selection appears above
the message composer, and the existing Diff fills the right side. The shared
color and motion refinements still apply; the two-card preparation layout has
been removed.

Changes and Commit continue to share the same mounted Diff subtree. The composer
keeps the existing canonical message field, draft ownership, AI lifecycle,
explicit suggestion application, Stage/Amend actions, and submission confirmation.
Focus review hides the sidebar and gives the space back to the Diff.
No Git or AI backend contract changed.

## Motion

`src/styles/motion.css` provides 120ms feedback, 180ms popover entry, 220ms
structural feedback and 100ms exit timing. Tab and segmented-control indicators
move independently of their labels. Base UI retains responsibility for popup
mounting, dismissal and keyboard semantics. The CSS and Motion paths both respect
reduced motion. Whole-page transitions and animations on long lists or the code
surface remain disabled. No new animation library, network font or remote asset
was added.

## Validation

Focused UI coverage checks card bounds, reachable controls, light/dark contrast,
1024×720 layout, History/Files panel separation, preserved drafts and the same
live Diff node across page switching. Existing Stage/Commit/Amend and AI-generation race cases exercise the
unchanged workflow. Validation uses an isolated Vite port and a Rust Core driver
with temporary Git repositories; packaged native WebView performance is a
separate check. Local outputs are under `.artifacts/card-workbench`.
