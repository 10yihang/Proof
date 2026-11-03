import Foundation

/// Fully synthetic bridge: these checks never launch Git or an AI executable.
@main
@MainActor
enum WorkspaceRefreshCheck {
    static func bytes(_ object: Any) -> Data { try! JSONSerialization.data(withJSONObject: object) }
    static func settle(_ model: WorkspaceModel) async {
        for _ in 0..<1000 {
            if !model.busy { return }
            await Task.yield()
        }
        fatalError("Model did not settle")
    }
    static func main() async {
        let workspace = Workspace(id: "fixture", name: "Fixture", path: "/fixture", trusted: true)
        let a = ChangedFile(path: "a.swift", oldPath: nil, status: "M", side: "unstaged", conflicted: false)
        let b = ChangedFile(path: "b.swift", oldPath: nil, status: "M", side: "unstaged", conflicted: false)
        let changesJSON: [String: Any] = ["workspace": ["id": workspace.id, "name": workspace.name, "path": workspace.path, "trusted": true], "token": "new", "files": [a, b].map { ["path": $0.path, "status": "M", "side": "unstaged", "conflicted": false] }]
        func diffJSON(_ path: String) -> [String: Any] {
            ["id": path, "token": "content-token", "path": path, "side": "unstaged", "base": "HEAD", "patch": "", "hunks": [], "additions": 1, "deletions": 0, "kind": "text", "canStage": true]
        }
        var requests: [String] = []
        var suspended: CheckedContinuation<Data, Error>?
        var suspendChanges = false
        let suite = "dev.proof.native.refresh-check.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = WorkspaceModel(defaults: defaults, request: { method, parameters, cancellable in
            requests.append(method)
            switch method {
            case "changes":
                if suspendChanges {
                    return try await withCheckedThrowingContinuation { suspended = $0 }
                }
                return bytes(changesJSON)
            case "history_state": return bytes(["remotes": [], "ahead": 0, "behind": 0, "conflicts": []])
            case "diff": return bytes(diffJSON(parameters["path"] as! String))
            default: fatalError("Unexpected operation \(method). Refresh must never invoke AI or writes.")
            }
        })
        model.workspace = workspace
        model.changes = Changes(workspace: workspace, head: nil, branch: nil, operation: nil, token: "old", files: [a, b])
        model.selectedFile = a.id
        model.message = "Preserve this draft"
        model.search = "swift"
        model.autoRefreshTick()
        await settle(model)
        assert(model.selectedFile == a.id && model.diff?.path == a.path)
        assert(model.message == "Preserve this draft" && model.search == "swift")
        assert(model.diff?.token == "content-token")

        let before = requests.count
        model.dialogPresented = true; model.autoRefreshTick(); model.dialogPresented = false
        model.setWorkspaceActive(false); model.autoRefreshTick(); model.setWorkspaceActive(true)
        model.autoRefreshEnabled = false; model.autoRefreshTick(); model.autoRefreshEnabled = true
        model.writing = true; model.autoRefreshTick(); model.writing = false
        model.aiRunning = true; model.autoRefreshTick(); model.aiRunning = false
        await Task.yield()
        assert(requests.count == before)

        // An in-flight auto refresh cannot replace a newer explicit file selection.
        suspendChanges = true
        model.autoRefreshTick()
        while suspended == nil { await Task.yield() }
        let inFlight = requests.count
        model.autoRefreshTick() // coalesced; cannot cancel its own in-flight request
        await Task.yield()
        assert(requests.count == inFlight)
        model.selectedFile = b.id
        model.loadFile()
        await settle(model)
        suspended?.resume(returning: bytes(changesJSON)); suspended = nil
        for _ in 0..<20 { await Task.yield() }
        assert(model.selectedFile == b.id && model.diff?.path == b.path)
        assert(model.message == "Preserve this draft")

        // Invalid captured hunk/file IDs never become a write against a new selection.
        let count = requests.count
        model.stage(snapshot: "obsolete")
        model.stageHunk(snapshot: "obsolete", hunk: "old")
        model.reviewHunk(snapshot: "obsolete", hunk: "old")
        await Task.yield()
        assert(requests.count == count)
        model.message = ""; model.closeRepository(); model.autoRefreshTick()
        await Task.yield()
        assert(model.workspace == nil && requests.count == count)
        var operations: [(String, Bool)] = []
        var pendingWrite: CheckedContinuation<Data, Error>?
        var aiCalls = 0
        var suspendAI = false
        var pendingAI: CheckedContinuation<Data, Error>?
        var preparedRequests: [[String: Any]] = []
        let actionModel = WorkspaceModel(defaults: defaults, request: { method, parameters, cancellable in
            operations.append((method, cancellable))
            switch method {
            case "prepare_history_action":
                preparedRequests.append(parameters["request"] as! [String: Any])
                return bytes(["id": "preview", "request": parameters["request"]!, "dirtyFiles": 0, "affectedCommits": 1, "arguments": ["fetch", "origin"], "destructive": false])
            case "execute_history_action":
                assert(!cancellable)
                return try await withCheckedThrowingContinuation { pendingWrite = $0 }
            case "changes": return bytes(changesJSON)
            case "history_state": return bytes(["remotes": ["origin"], "ahead": 0, "behind": 0, "conflicts": []])
            case "run_ai_task":
                aiCalls += 1
                assert(cancellable)
                let request = parameters["request"] as! [String: Any]
                let scope = request["scope"] as! [String: Any]
                assert(request["task"] as? String == "commit")
                assert(scope["workspaceId"] as? String == workspace.id)
                assert(scope["files"] == nil) // core commit scope means all staged files
                assert(scope["expectedToken"] as? String == "new")
                if suspendAI { return try await withCheckedThrowingContinuation { pendingAI = $0 } }
                return bytes(["id": "report", "provider": "codex", "task": "commit", "fingerprint": "f", "capturedAt": 1, "commitMessage": "Suggested draft", "limitations": []])
            default: fatalError("Unexpected action \(method)")
            }
        })
        actionModel.workspace = workspace
        actionModel.changes = Changes(workspace: workspace, head: nil, branch: nil, operation: nil, token: "old", files: [a, b])
        actionModel.prepareSync("fetch", remote: "origin")
        await settle(actionModel)
        assert(actionModel.operationPreview != nil)
        assert(operations.map { $0.0 } == ["prepare_history_action"])
        actionModel.executeOperation()
        while pendingWrite == nil { await Task.yield() }
        actionModel.cancelRead(); actionModel.closeRepository(); actionModel.autoRefreshTick()
        assert(actionModel.writing && actionModel.workspace != nil)
        pendingWrite?.resume(returning: bytes(["ok": true, "conflicts": [], "detail": "Fetched"]))
        await settle(actionModel)
        assert(!actionModel.writing && actionModel.operationPreview == nil)
        assert(operations.filter { $0.0 == "execute_history_action" }.count == 1)
        assert(aiCalls == 0)

        // A local feature branch may track a differently named remote branch.
        actionModel.remoteState = HistoryRepositoryState(remotes: ["origin"], upstream: "origin/release", upstreamRemote: "origin", upstreamBranch: "release", ahead: 1, behind: 0, operation: nil, conflicts: [])
        actionModel.changes = Changes(workspace: workspace, head: "head", branch: "feature", operation: nil, token: "new", files: [])
        for kind in ["pull", "push"] {
            actionModel.prepareSync(kind)
            await settle(actionModel)
            assert(preparedRequests.last?["kind"] as? String == kind)
            assert(preparedRequests.last?["remote"] as? String == "origin")
            assert(preparedRequests.last?["name"] as? String == "release")
            assert(preparedRequests.last?["mode"] == nil)
            actionModel.cancelOperation()
        }
        let preparedCount = preparedRequests.count
        actionModel.remoteState = HistoryRepositoryState(remotes: ["origin"], upstream: nil, upstreamRemote: nil, upstreamBranch: nil, ahead: 0, behind: 0, operation: nil, conflicts: [])
        actionModel.prepareSync("pull"); actionModel.prepareSync("push")
        await Task.yield()
        assert(preparedRequests.count == preparedCount)

        let staged = ChangedFile(path: "staged.swift", oldPath: nil, status: "M", side: "staged", conflicted: false)
        actionModel.changes = Changes(workspace: workspace, head: nil, branch: nil, operation: nil, token: "new", files: [staged])
        actionModel.aiProviders = [AgentProviderInfo(id: "codex", name: "Codex", available: true, path: nil, reason: nil, model: nil, isDefault: true)]
        actionModel.message = "User draft"
        actionModel.generateCommitMessage(provider: "codex")
        await settle(actionModel)
        assert(aiCalls == 1 && actionModel.message == "User draft")
        assert(actionModel.suggestedCommitMessage == "Suggested draft")
        actionModel.applySuggestedCommitMessage()
        assert(actionModel.message == "Suggested draft" && actionModel.suggestedCommitMessage == nil)
        // A cancelled AI job cannot publish its late result over newer user work.
        suspendAI = true
        actionModel.generateCommitMessage(provider: "codex")
        while pendingAI == nil { await Task.yield() }
        actionModel.cancelRead()
        actionModel.message = "New user draft"
        pendingAI?.resume(returning: bytes(["id": "old-report", "provider": "codex", "task": "commit", "fingerprint": "old", "capturedAt": 1, "commitMessage": "Obsolete suggestion", "limitations": []]))
        for _ in 0..<20 { await Task.yield() }
        assert(actionModel.message == "New user draft")
        assert(actionModel.suggestedCommitMessage == nil && actionModel.aiReport?.id != "old-report")
        print("Workspace refresh checks passed: selection/draft retention, coalescing, idle gates, newer read wins, stale captured actions, close, no implicit AI or writes")
    }
}
