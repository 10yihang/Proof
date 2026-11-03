import Foundation

/// Model-only regression checks. No AppKit interactions, bridge, or Git repositories.
@main
@MainActor
enum WorkspaceNavigationCheck {
    static func main() {
        let suite = "dev.proof.native.navigation-check.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suite) else { fatalError("Could not create isolated preferences") }
        defer { defaults.removePersistentDomain(forName: suite) }

        // Default, collapsed, and expanded state survive a fresh model instance.
        let model = WorkspaceModel(defaults: defaults)
        assert(model.sidebarVisible)
        model.toggleSidebar()
        assert(!model.sidebarVisible)
        assert(defaults.object(forKey: NativePreferences.sidebarVisible) as? Bool == false)
        let restored = WorkspaceModel(defaults: defaults)
        assert(!restored.sidebarVisible)
        restored.toggleSidebar()
        assert(restored.sidebarVisible && WorkspaceModel(defaults: defaults).sidebarVisible)

        // CI fixtures can collapse the sidebar without changing normal startup.
        restored.setSidebarVisible(false, persist: false)
        assert(!restored.sidebarVisible && WorkspaceModel(defaults: defaults).sidebarVisible)
        restored.setSidebarVisible(true, persist: false)
        assert(restored.sidebarVisible)

        // Turning restore off starts expanded and does not overwrite the saved choice.
        defaults.set(false, forKey: NativePreferences.sidebarVisible)
        defaults.set(false, forKey: NativePreferences.restoreSidebar)
        let noRestore = WorkspaceModel(defaults: defaults)
        assert(noRestore.sidebarVisible)
        noRestore.toggleSidebar()
        noRestore.toggleSidebar()
        assert(noRestore.sidebarVisible)
        assert(defaults.object(forKey: NativePreferences.sidebarVisible) as? Bool == false)
        assert(WorkspaceModel(defaults: defaults).sidebarVisible)
        defaults.set(true, forKey: NativePreferences.restoreSidebar)
        assert(!WorkspaceModel(defaults: defaults).sidebarVisible)

        let workspace = Workspace(id: "fixture", name: "Fixture", path: "/fixture-only", trusted: true)
        let file = ChangedFile(path: "review.swift", oldPath: nil, status: "M", side: "staged", conflicted: false)
        let snapshot = FileDiff(id: "snapshot", path: file.path, side: file.side, base: "HEAD", patch: "@@ test @@",
                                hunks: [Hunk(id: "hunk", header: "@@ test @@", lines: [], reviewState: "unread")],
                                additions: 1, deletions: 0, kind: "text", notice: nil, canStage: true)
        let commitPreview = CommitPreview(id: "preview", branch: "main", head: "abc", files: [file], reviewed: 0, total: 1, unreadFiles: [file.path])
        let localBranch = BranchEntry(name: "main", current: true, oid: "abc", remote: false)
        let remoteBranch = BranchEntry(name: "main", current: false, oid: "abc", remote: true)
        assert(localBranch.id != remoteBranch.id) // identical labels must not collide in selection
        model.recent = [workspace]
        model.message = "Keep this commit draft"
        model.branches = [localBranch, remoteBranch]
        model.selectedBranch = localBranch.id
        model.setSidebarVisible(false)

        // Repeat navigation as well as the first transition. With no open workspace,
        // history/branch loading returns synchronously and never contacts the bridge.
        for mode in ["changes", "history", "branches", "repositories", "settings", "changes", "history"] {
            model.diff = snapshot
            model.loadedDiffs[file.id] = snapshot
            model.selectedFile = file.id
            model.selectedCommit = "abc"
            model.commitPatch = "selected patch"
            model.preview = commitPreview
            model.search = "old page filter"
            model.mode = mode
            model.changeMode()
            assert(model.mode == mode && !model.busy && !model.writing)
            assert(model.search.isEmpty && model.diff == nil && model.loadedDiffs.isEmpty)
            assert(model.selectedFile == nil && model.selectedCommit == nil && model.commitPatch == nil)
            assert(model.preview == nil && model.message == "Keep this commit draft")
            assert(model.recent.first?.id == workspace.id && !model.sidebarVisible)
        }
        model.loadBranches()
        assert(!model.busy && model.branches.count == 2)

        // A write blocks snapshot invalidation, branch reads, and repository closure.
        model.workspace = workspace
        model.changes = Changes(workspace: workspace, head: "abc", branch: "main", operation: nil, token: "fixture", files: [file])
        model.diff = snapshot
        model.loadedDiffs[file.id] = snapshot
        model.selectedFile = file.id
        model.selectedCommit = "abc"
        model.commitPatch = "active patch"
        model.preview = commitPreview
        model.search = "active filter"
        model.branchesLoaded = true
        model.busy = true
        model.writing = true
        model.changeMode()
        model.loadFile()
        model.loadCommit()
        model.refresh()
        model.loadBranches()
        model.closeRepository()
        assert(model.workspace?.id == workspace.id && model.diff?.id == snapshot.id)
        assert(model.commitPatch == "active patch" && model.loadedDiffs[file.id]?.id == snapshot.id)
        assert(model.preview?.id == commitPreview.id && model.search == "active filter")
        assert(model.branchesLoaded && model.selectedBranch == localBranch.id)
        assert(model.busy && model.writing && model.message == "Keep this commit draft")

        // Sidebar toggling is presentation-only, even with active work and selections.
        model.toggleSidebar()
        model.toggleSidebar()
        assert(!model.sidebarVisible && model.selectedFile == file.id && model.selectedCommit == "abc")
        assert(model.diff?.id == snapshot.id && model.preview?.id == commitPreview.id)
        model.busy = false
        model.writing = false
        model.message = "" // no modal confirmation is involved in this model check
        model.closeRepository()
        assert(model.workspace == nil && model.mode == "changes")
        assert(model.branches.isEmpty && model.selectedBranch == nil && !model.branchesLoaded)
        assert(model.selectedFile == nil && model.selectedCommit == nil && model.commitPatch == nil)
        assert(!model.sidebarVisible && model.recent.count == 1)
        print("Workspace navigation model checks passed: sidebar collapse/restore/opt-out, isolated preview state, five-page repeat navigation, selection reset, draft retention, write guards")
    }
}
