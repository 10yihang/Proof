# Proof UI refresh

The September 2026 refresh uses resizable card workspaces for Local changes,
Commit, History and Files. Commit retains its original arrangement: file selection
and the composer stacked in the left sidebar, with a full-height Diff on the right.
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
These card workspaces use 12px separator gutters shared with the resize model, so
saved panel dimensions remain accurate. Unchanged comparison workbenches retain
their existing separators.
Virtualized row heights and Git graph coordinates are unchanged.

## Card workspaces

- Local changes: file navigation, the main Diff and Context each have their own
  rounded surface. The file and docked Context widths remain adjustable. Narrow
  windows use smaller outer margins; existing overlay drawers still open above
  the Diff.
- History: repository navigation, the continuous toolbar/commit graph surface,
  and selected-commit details are distinct cards. A horizontal split adjusts
  navigation width; a vertical split adjusts the details card's height. Graph
  scrolling, parent links, row heights and selection behavior stay intact.
- Files: the repository file tree, editor and optional file-history pane are
  distinct cards. File-tree and history widths resize independently. Closing and
  reopening file history keeps the same editor mounted, including unsaved text.
  Editor controls wrap when needed, with existing scroll areas retained.

## Commit composition

Commit keeps its original left-sidebar composition. File selection appears above
the message composer, and the existing Diff fills the right side. These are three
separate cards: the horizontal split changes sidebar width, and the vertical
split within the sidebar changes composer height. The full-width preparation
layout has been removed.

Changes and Commit continue to share the same mounted Diff subtree. The composer
keeps the existing canonical message field, draft ownership, AI lifecycle,
explicit suggestion application, Stage/Amend actions, and submission confirmation.
Focus review hides the sidebar and gives the space back to the Diff.
Git and AI operation contracts are unchanged.

## Resize behavior and persistence

`ResizableWorkbench` retains the shared Changes/Commit sidebar and Context
controls. `CardSplit` supplies the additional History, Files and Commit splits,
using the same repository layout controller and native SQLite persistence.
Dimensions are saved per repository, not globally. The new fields and defaults
are:

| Field                  | Panel dimension                | Default |
| ---------------------- | ------------------------------ | ------- |
| `historySidebarWidth`  | History navigation width       | 224px   |
| `historyDetailsHeight` | Selected-commit details height | 180px   |
| `filesSidebarWidth`    | Files navigation width         | 240px   |
| `filesHistoryWidth`    | File-history width             | 248px   |
| `commitDetailsHeight`  | Commit composer height         | 280px   |

The existing `sidebarWidth` and `contextWidth` fields remain in use. Older saved
layouts receive defaults for missing fields without an automatic write. Native
validation bounds persisted dimensions; frontend fitting also preserves room for
the main reading surface. Temporarily narrowing or shortening a window adjusts
the displayed sizes without overwriting saved dimensions. Returning to a larger
window restores the user's saved size.

Drag a divider to resize its panel, or focus it and use the matching arrow keys:
Left/Right for widths and Up/Down for heights. Home and End reach the available
bounds. Escape cancels an active adjustment; double-click restores that panel's
default size. Keyboard adjustments are saved on key release or focus departure,
and cancelled adjustments do not persist. Existing Changes/Commit sidebar and
Context dividers retain their Enter-to-collapse behavior. Hiding file history
removes its divider and gives the space back to the same mounted editor.

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
switching. `tests/ui/card-resize.spec.ts` covers resizing on both axes, native
saved dimensions, reload restoration, temporary window fitting, keyboard
completion/cancellation, and unsaved editor state while file history opens and
closes. Repository-layout unit tests and Rust layout tests cover compatibility
with older saved layouts and native dimension validation.

Existing Stage/Commit/Amend and AI-generation race cases exercise the unchanged
workflow. Validation uses an isolated Vite port and a Rust Core driver with
temporary Git repositories. This describes the coverage; run results belong to
the current change's validation record. Packaged native WebView performance is a
separate check. Earlier card-layout outputs remain under
`.artifacts/card-workbench`.
