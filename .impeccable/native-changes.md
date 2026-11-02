# Native Changes — Operate

## Direction contract
THESIS: Preserve Proof’s compact review workbench, not a generic native editor. The user found the first glass rewrite too unlike their original.
AUTHORITY: Current src/components/FileTree.tsx, WorkspaceTabs.tsx, src/styles/density.css and original docs/DESIGN.md establish identity. No live original screenshot is available in this cloud workspace.
FIRST VIEWPORT: Native unified titlebar and solid 13pt / 22pt code remain. Compact repository / branch identity uses the original Proof mark. Changes uses a 32pt single-line compressed folder tree, All / Unstaged / Staged scope, tree/list toggle, blue selection and manual review. A 280pt native sidebar retains existing Changes / Commit / History navigation. Review coverage counts only loaded snapshots and explicitly labels unloaded coverage unknown.
SAFETY: Retain the sidebar-local GeometryReader sizing boundary, trust/write confirmations, content-bound review, stale guards and cancellations. No Rust change. No fake multi-repository tabs, Files editor, history graph, Context inspector, split diff, or hunk navigation.
EVIDENCE: Build source and real WindowServer light/dark capture on standard xcode-27. Use actual runner screen dimensions, not scaled 1440×900 proxies; larger display setup is outside scope. Synthetic Preview is clearly labeled and has no Git operations. macOS13 deployment remains; old-OS runtime untested.
FINISH: One batched native inspection, one correction/confirmation if needed, no open-ended aesthetic loops. User acceptance remains separate.
