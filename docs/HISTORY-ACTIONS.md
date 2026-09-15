# History Git operations

History is the entry point for repository, Branch and Commit actions. The graph and ref sidebar use the same action menu and native preview/execute service. Clicking a Branch badge opens its menu; the sidebar also offers a visible more button and double-click to Switch. The selected Commit has a visible more button, and the graph supports the context-menu key or Shift+F10. Menu arrow keys, Home/End and Escape work without a mouse. Comparing versions still opens a separate Diff tab.

| Entry | Operations |
| --- | --- |
| History toolbar | Fetch, Pull, Push, create Branch |
| Local Branch | Switch, create Branch here, Merge into current, Rebase current onto target, rename, delete, copy name, compare |
| Remote Branch | Create and Switch to a local tracking Branch, create Branch here, Merge, Rebase, copy name, compare |
| Commit | Detached checkout, create Branch / lightweight Tag, Cherry-pick, Revert, Rebase, Reset soft/mixed/hard, copy full SHA / full message, compare |
| In-progress operation | Stage each conflict resolution, Continue, Abort for Merge, Rebase, Cherry-pick and Revert |

Pull offers an explicit Remote, remote Branch and fast-forward-only / Merge / Rebase strategy. Its default is fast-forward-only; divergence produces an actionable Git failure, not an implicit Merge or Rebase. Push uses one explicit local-to-remote Branch refspec, updates upstream on success, and never forces. Configured mirror, follow-tags and extra push refspecs cannot broaden this action. Multiple push URLs require using a Remote with a single destination. Fetch updates remote-tracking Branches without checking out files, pruning refs or fetching tags. Network credentials come from existing Git configuration; Proof does not collect a token or wait for terminal prompts.

Merge, Rebase, Cherry-pick, Revert and Pull require a clean Index and Worktree. No implicit Stash is created. Switch lets Git preserve non-conflicting edits and reject overwrites. Branch deletion uses `git branch --delete`, so Git retains unmerged or checked-out Branches. Rebase disables automatic updates of other Branch refs. Merge-Commit Cherry-pick/Revert explicitly selects a mainline parent. Reset and Abort describe their effects and require acknowledgment; Hard Reset explicitly warns about overwritten uncommitted and obstructing untracked files.

## Native boundary

`history_actions.rs` owns a typed `HistoryActionRequest` and bounded, ten-minute, single-use previews. Preparation validates trust, operation state, literal ref names, full Commit IDs, Remote membership, parent selection and clean-state requirements. It reads but does not mutate Git. The preview captures HEAD, current Branch, target OID, affected-Commit count, changed-file count and the exact argument vector. The renderer supplies neither a shell command nor arbitrary flags.

Execution re-reads the workspace identity/trust and checks the Worktree token, refs, Git configuration and sequencer state before consuming the native-owned argument vector. A changed target, config, Index, Worktree or operation invalidates the preview. Git still owns its locks: the final check is not a global lock against other terminals. Git hooks and signing remain the user's configured behavior. Commands run in an owned process group with a bounded output buffer and a 180-second timeout; terminal credential prompts are disabled and editor steps accept the prepared Git message. No Coding Agent is involved.

After execution, including failures and timeouts, Proof reads the actual HEAD, Branch, operation and conflicted paths. Successful ref operations verify the resulting refs; an unexpected hook-induced result is shown as incomplete. There is no automatic retry, rollback, force push, forced Branch deletion or conflict choice. History and Local changes refresh; a cross-window invalidation causes peers to read Git again. Only the action kind and observed outcome are recorded in SQLite, not command output or potentially credential-bearing Remote URLs.

Conflicts remain visible in a History banner. Clicking a conflicted path opens that file in Local changes. Users edit the file with their editor, then explicitly Stage its current contents and Continue, or Abort with a preview. A staged resolution is a user decision, not AI Review. Existing immutable Diff tabs and human Review semantics are retained.

## References and verification

The Branch/Commit menu organization follows the examples in [GitKraken's Branching and Merging guide](https://help.gitkraken.com/gitkraken-desktop/branching-and-merging/) and [Fork's release notes](https://git-fork.com/releasenotes). Pull strategies and Rebase behavior were checked against the [Git Pull documentation](https://git-scm.com/docs/git-pull) and [Git Rebase documentation](https://git-scm.com/docs/git-rebase) on 2026-09-15.

`crates/proof-core/tests/history_actions.rs` exercises the public API against owned temporary repositories, linked Worktrees and local bare remotes. `tests/ui/history-actions.spec.ts` drives the real native fixture through History menus, clipboard, Branch operations, Pull/Push, conflict resolution and Reset confirmation. UI fixtures are isolated; these tests do not mutate the developer's repository or contact a hosted remote.
