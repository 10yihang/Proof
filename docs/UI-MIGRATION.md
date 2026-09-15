# Proof UI migration

## Direction

Proof is a desktop Git workbench. The central code surface, its source positions and visible comparison must stay stable while controls open, data loads or panels collapse. The visual reference is the compact, keyboard-friendly workflow of Fork and GitKraken. This is a full component migration, with Tailwind carrying the shared design vocabulary and Base UI handling primitive interaction semantics.

Proof uses light and dark modes, system typography and a compact desktop layout. The dominant code surface, readable source positions and predictable keyboard behavior guide the visual design.

## Tokens and composition

- Light: canvas `#ffffff`, chrome `#f3f4f6`, raised surface `#fafbfc`, ink `#202631`, muted ink `#626b78`, selection `#2563eb`.
- Dark: canvas `#17191d`, chrome `#202329`, raised surface `#252a32`, ink `#e8edf5`, muted ink `#a8b2c1`, selection `#8bb8ff`.
- Git colors keep their established roles: added green, deleted red, branch-lane colors distinct from action accents. Meaning never depends on color alone.
- UI type: macOS system sans, 12–13 px controls, 11 px metadata, 15 px panel headings. Code keeps the user's chosen monospace face and font size.
- Spacing: 4 px rhythm, 28–32 px controls, 28–34 px tree/history rows, 6–8 px control radii. Dialogs and menus have stronger elevation than the flat workbench.
- Action motion: 120 ms feedback, 180–220 ms panel/dialog transitions, reduced-motion support. Avoid animating long virtual lists or changing code positions to decorate an action.

```
Repository / Branch / Commands
Local changes | Commit | History | Diff tabs
Files or Change Groups | dominant Diff surface | Context or AI Review
Git status and durable operation feedback
```

## Implemented scope

1. Add Tailwind, shadcn-style source-owned primitives on Base UI, semantic tokens and shared motion. Migrate controls, menus, dialogs, popovers, tooltips, tabs and toast feedback across existing pages.
2. Use maintained panel and drag/drop primitives for resizing, tab ordering and logical file grouping. Retain keyboard/button alternatives and existing repository-scoped persistence.
3. Centralize window UI state and shortcut handling without moving Git/SQLite authority into browser stores.
4. Integrate locally bundled Monaco where it can preserve Git-owned patches, Stage, range Review, comments, full-file/context reading and cancellation. Keep explicit handling for binary, conflict, symlink, submodule and oversized content.
5. Validate keyboard, light/dark themes, reduced motion, narrow windows, all original Git/Review workflows, no-agent operation and disconnected/offline resource loading. Build the native application without replacing or quitting the user's running window.

## Constraints

No model/API integration changes, automatic AI runs, user-repository Git mutations, schema authority changes, new external asset requests or loss of draft/review/layout data. Phosphor and TanStack Virtual already serve the product and remain available. React Flow and a second full UI framework have no role in this workbench migration.

## Sources

Implementation follows [Tailwind's Vite integration](https://tailwindcss.com/docs/installation/using-vite), [shadcn's Base UI components](https://ui.shadcn.com/docs/components/base/dialog), [Rhea's density direction](https://ui.shadcn.com/docs/changelog/2026-05-rhea), [Base UI](https://base-ui.com/react/components/menu), [dnd kit](https://dndkit.com/react/quickstart), [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) and [Monaco's local Vite/worker configuration](https://github.com/suren-atoyan/monaco-react#loader-config).


## Implementation

- `src/components/ui` contains owned shadcn/Base UI components and compatibility adapters. Tailwind 4 compiles through Vite. Existing Git-specific layout and row styles are kept in an explicit `legacy` CSS layer; semantic component styles and utilities take precedence.
- Controls use the same focus, disabled, field, overlay and compact spacing rules. Menus, searchable Branch selection, Settings/workspace tabs and the command palette use Base UI interaction primitives. Notifications share one toast manager; critical errors and operation previews remain durable panels.
- `ResizableWorkbench` keeps panel content mounted and saves only user resize operations. `ChangeGroups` uses dnd kit with snapshot/revision checks and an explicit Select alternative. Diff tabs can be dragged or reordered with Cmd/Ctrl+Shift+Left/Right.
- `window-ui.ts` creates a Zustand store for each App lifetime. SQLite, Git state, drafts and data-session epochs retain their existing ownership. Hotkey handlers keep composing-input, modal, editing, window and active-page guards.
- `MonacoDiffSurface` builds one unified model or two synchronized side models from canonical Git reading rows. Source line numbers, additions/deletions, word ranges, search and Review targets are decorations. Hunk controls, EOF metadata and Review comments are view zones. Missing split cells never become synthetic copied code lines.
- The existing Prism tokenization keeps old/new histories separate while Monaco provides editor selection, scrolling, wrapping, brackets and rendering. A bounded language slot pool and disposal on hide/raw/model replacement prevent old source text from being retained in token providers.
- Monaco is loaded lazily from the local bundle with a local Worker and no CDN. The Tauri policy allows local/blob workers without adding remote script origins or `unsafe-eval`. Native Git Patch bytes and Hunk IDs remain authoritative.

## Deliberately retained

Phosphor already provides consistent icons. TanStack Virtual already handles long file/history lists. The existing commit graph models Git parent/lane relationships directly; a general node graph library would add a second layout engine without improving that behavior. A second UI framework, React Flow and a second drag/drop file-tree system are therefore not introduced.

## Validation record

Results and screenshots are recorded under `.artifacts/ui-migration`. The native app is built without launching, replacing or closing an existing Proof window. Browser fixtures exercise the Rust core through a test transport; this does not by itself prove packaged WebView behavior.


## Final checks — 2026-09-15

| Check | Result |
| --- | --- |
| Formatting / lint and TypeScript | Passed |
| Frontend unit tests | 60 passed |
| Complete headless UI suite | 98 passed; real Rust Core/Git fixture enabled |
| Reading-position race regression | 30 repeated runs passed |
| Built frontend under the desktop CSP | 1 passed; no external resource requests |
| Rust workspace tests | 255 passed; 5 existing opt-in tests ignored |
| Cargo check / all-target workspace Clippy | Passed |
| macOS release app | Built; local ad-hoc signing |

Text models and bookmarks carry the exact reading scope. Restoration waits for the current model to finish initialization; a premature no-op restore cannot replace a saved bookmark with position zero. Search entered during loading waits for the matching model. Review view zones retain their DOM nodes while their height changes, and their buttons remain inside the visible pane.

The full UI suite covers Stage / Commit / Amend, Branch actions, actual temporary Git repositories, readonly editor input and copying, AI grouping and Review decisions, large-file/context cancellation, locale changes, saved panel widths, drag and keyboard ordering, data deletion and cross-window epochs. No live model inference was performed. The current packaged native window was not launched; packaged WebView/OS interaction and the complete PRD performance budget remain separate acceptance work.

Monaco is a separate lazy chunk. The build still reports large-chunk warnings (approximately 1.61 MB for the application and 2.74 MB for Monaco before gzip); no browser or native process-memory claim is made from those asset sizes.
