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
        // Inline commit uses one model-owned predicate, not a view-only guard.
        let staged = ChangedFile(path: "staged.swift", oldPath: nil, status: "M", side: "staged", conflicted: false)
        model.changes = Changes(workspace: workspace, head: nil, branch: nil, operation: nil,
                                token: "test", files: files + [staged])
        model.workspace = workspace
        model.message = "提交说明草稿"
        assert(!model.requiresDraftConfirmation(for: "/fixture-only"))
        assert(!model.requiresDraftConfirmation(for: "/fixture-only/../fixture-only"))
        assert(model.requiresDraftConfirmation(for: "/different-repository"))
        model.message = " \n "
        assert(!model.requiresDraftConfirmation(for: "/different-repository"))
        model.message = "提交说明草稿"
        model.workspace = nil
        assert(!model.requiresDraftConfirmation(for: "/different-repository"))
        model.workspace = workspace
        model.busy = false
        assert(model.stagedFileCount == 1 && !model.canPrepareCommit) // untrusted
        model.prepareCommit()
        assert(!model.busy && model.preview == nil)
        model.workspace?.trusted = true
        assert(model.canPrepareCommit) // review is not a commit/staging requirement
        model.loadedDiffs = [:]
        assert(model.canPrepareCommit)
        model.message = " \n\t "
        assert(!model.canPrepareCommit)
        model.message = "提交说明草稿"
        model.busy = true
        assert(!model.canPrepareCommit)
        model.prepareCommit()
        assert(model.busy) // blocked prepare must not cancel an existing read
        model.busy = false
        model.writing = true
        assert(!model.canPrepareCommit)
        model.writing = false
        model.changes = Changes(workspace: workspace, head: nil, branch: nil, operation: nil,
                                token: "test", files: files)
        assert(model.stagedFileCount == 0 && !model.canPrepareCommit)

        // A checked preview is retained when commit is blocked; it cannot interrupt a read/write.
        let preview = CommitPreview(id: "checked", branch: nil, head: nil, files: [staged], reviewed: 0, total: 1, unreadFiles: [])
        model.preview = preview
        model.busy = true
        model.commit()
        assert(model.preview?.id == "checked" && model.busy)
        model.busy = false; model.writing = true
        model.commit()
        assert(model.preview?.id == "checked" && model.writing)
        model.writing = false
        model.message = " "
        model.commit()
        assert(model.preview?.id == "checked" && !model.busy)
        model.message = "提交说明草稿"
        model.workspace?.trusted = false
        model.commit()
        assert(model.preview?.id == "checked" && !model.busy)

        // Mode transitions clear snapshots, never the commit draft. No bridge is opened.
        model.workspace = nil
        model.diff = reviewed
        model.loadedDiffs[files[1].id] = reviewed
        model.mode = "history"
        model.changeMode()
        assert(model.message == "提交说明草稿" && model.diff == nil && model.loadedDiffs.isEmpty)
        model.mode = "changes"
        model.changeMode()
        assert(model.message == "提交说明草稿")

        // Guarded staging/review calls cannot mutate a draft or start a bridge request.
        model.workspace = workspace
        model.diff = reviewed // reviewed snapshot is explicitly not stageable
        model.stage()
        assert(!model.busy && model.message == "提交说明草稿")
        model.busy = true
        model.review()
        model.stage()
        assert(model.busy && model.diff?.reviewed == true)
        model.busy = false
        model.workspace = nil
        model.review()
        assert(!model.busy) // missing repository cannot reach an async force unwrap
        model.message = ""
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
        print("Review navigation checks passed: reset, unknown coverage, wrap, draft preservation, inline commit eligibility, independent review/staging, busy/write guards")
    }
}

