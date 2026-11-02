import Foundation

/// Model-level regression checks only: no bridge process or repository is opened.
@main
@MainActor
enum ReviewNavigationCheck {
    static func main() {
        let model = WorkspaceModel()
        model.status = "Repository loaded"
        model.busy = true
        model.loadFile() // programmatic reset during refresh / history transition
        assert(model.status == "Repository loaded" && model.busy)
        assert(model.diff == nil)
        model.busy = false
        let workspace = Workspace(id: "test", name: "Test", path: "/fixture-only", trusted: false)
        let files = ["a.swift", "b.swift", "c.swift"].map {
            ChangedFile(path: $0, oldPath: nil, status: "M", side: "unstaged", conflicted: false)
        }
        model.changes = Changes(workspace: workspace, head: nil, branch: nil, operation: nil, token: "test", files: files)
        let reviewed = FileDiff(id: "test", path: "b.swift", side: "unstaged", base: "HEAD", patch: "", hunks: [Hunk(id: "h", header: "", lines: [], reviewState: "reviewed")], additions: 0, deletions: 0, kind: "text", notice: nil, canStage: false)
        model.loadedDiffs[files[1].id] = reviewed
        model.selectedFile = files[0].id
        model.nextReviewFile()
        assert(model.selectedFile == files[2].id) // skip reviewed; unloaded is unknown
        model.nextReviewFile()
        assert(model.selectedFile == files[0].id) // wraps
        model.busy = true
        model.nextReviewFile()
        assert(model.selectedFile == files[0].id)
        model.writing = true
        model.diff = reviewed
        model.selectedFile = nil
        model.loadFile()
        assert(model.diff?.id == "test") // a write cannot lose its active snapshot
        model.workspace = workspace
        model.closeRepository()
        assert(model.workspace?.id == workspace.id) // writing blocks tab close
        model.writing = false; model.busy = false
        model.closeRepository() // no draft: closes without a prompt
        assert(model.workspace == nil && model.changes == nil && model.loadedDiffs.isEmpty)
        print("Review navigation checks passed: reset does not cancel, unknown coverage, wrap, busy/write guards")
    }
}
