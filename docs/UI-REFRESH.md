# Proof UI refresh

The September 2026 refresh follows the reviewed Changes/History concept and the
two-card Commit concept. Cards group a complete task: selecting the files for a
commit, writing its message, a change group, or a Context session. File rows and
the Git graph retain continuous, dense reading surfaces.

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
The panel separator still occupies the 4px geometry expected by the resize model,
but paints only a 1px line and highlights during interaction. Virtualized row
heights and Git graph coordinates are unchanged.

## Commit composition

Commit places file selection and the message composer side by side above the
existing Diff. The preparation area is bounded in height, while files and long
AI results can scroll inside their cards. The commit action footer stays visible.
Very narrow windows stack the cards and allow scrolling to the Diff.

Changes and Commit continue to share the same mounted Diff subtree. The composer
keeps the existing canonical message field, draft ownership, AI lifecycle,
explicit suggestion application, Stage/Amend actions, and submission confirmation.
Focus review hides the preparation area and gives the space back to the Diff.
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
1024×720 layout, preserved drafts and the same live Diff node across page
switching. Existing Stage/Commit/Amend and AI-generation race cases exercise the
unchanged workflow. Validation uses an isolated Vite port and a Rust Core driver
with temporary Git repositories; packaged native WebView performance is a
separate check. Local outputs are under `.artifacts/ui-refresh`.
