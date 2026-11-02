import AppKit
import SwiftUI

@MainActor
final class WorkspaceModel: ObservableObject {
    let bridge = Bridge()
    @Published var workspace: Workspace?
    @Published var recent: [Workspace] = []
    @Published var changes: Changes?
    @Published var diff: FileDiff?
    @Published var commits: [CommitEntry] = []
    @Published var commitPatch: String?
    @Published var selectedFile: String?
    @Published var selectedCommit: String?
    @Published var mode = "changes"
    @Published var search = ""
    @Published var message = ""
    @Published var preview: CommitPreview?
    @Published var busy = false
    @Published var writing = false
    @Published var activity = ""
    @Published var error: String?
    @Published var status = ""
    @Published var hasMoreHistory = false
    private var task: Task<Void, Never>?
    private var generation = 0

    func start() {
        run("Starting Rust service") {
            try self.bridge.start()
            struct Hello: Decodable { let protocolVersion: Int; enum CodingKeys: String, CodingKey { case protocolVersion = "protocol" } }
            let hello: Hello = try await self.bridge.call("hello")
            guard hello.protocolVersion == 1 else { throw BridgeError(code: "VERSION_MISMATCH", message: "Rebuild the app and Rust bridge together.", detail: "Protocol \(hello.protocolVersion)") }
            let recent: [Workspace] = try await self.bridge.call("recent")
            try Task.checkCancellation()
            self.recent = recent
        }
    }
    private func run(_ label: String, write: Bool = false, work: @escaping @MainActor () async throws -> Void) {
        guard !writing else { return }
        task?.cancel()
        generation += 1
        let current = generation
        busy = true; writing = write; activity = label; error = nil
        task = Task {
            do { try await work() }
            catch is CancellationError {}
            catch { if self.generation == current { self.error = error.localizedDescription } }
            if self.generation == current { self.busy = false; self.writing = false; self.task = nil }
        }
    }
    func cancelRead() {
        guard !writing else { return }
        generation += 1; task?.cancel(); task = nil; busy = false
        status = "Read cancelled. Refresh to load the latest state."
    }
    func pickRepository() {
        guard !writing else { return }
        if !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let alert = NSAlert()
            alert.messageText = "Discard the commit message draft if a different repository opens?"
            alert.addButton(withTitle: "Keep Working")
            alert.addButton(withTitle: "Choose Repository")
            guard alert.runModal() == .alertSecondButtonReturn else { return }
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.allowsMultipleSelection = false; panel.prompt = "Open Repository"
        if panel.runModal() == .OK, let url = panel.url { open(url.path) }
    }
    func open(_ path: String) {
        guard !writing else { return }
        // Draft is per selected repository; preserve it on a failed open.
        run("Opening repository") {
            let workspace: Workspace = try await self.bridge.call("open", ["path": path])
            let changes: Changes = try await self.bridge.call("changes", ["workspace": workspace.id])
            try Task.checkCancellation()
            if self.workspace?.id != workspace.id { self.message = "" }
            self.workspace = changes.workspace; self.changes = changes
            self.diff = nil; self.selectedFile = nil; self.selectedCommit = nil
            self.commitPatch = nil; self.commits = []; self.preview = nil; self.mode = "changes"
            self.status = "Repository loaded"
            self.recent.removeAll { $0.id == workspace.id }; self.recent.insert(changes.workspace, at: 0)
        }
    }
    func refresh() {
        guard let workspace else { return }
        preview = nil
        run("Refreshing repository") { try await self.reload(workspace.id) }
    }
    private func reload(_ id: String) async throws {
        let changes: Changes = try await bridge.call("changes", ["workspace": id], cancellable: !writing)
        try Task.checkCancellation()
        self.changes = changes; workspace = changes.workspace
        diff = nil; selectedFile = nil; commitPatch = nil; selectedCommit = nil; preview = nil
        if mode == "history" {
            let rows: [CommitEntry] = try await bridge.call("history", ["workspace": id, "offset": 0], cancellable: !writing)
            try Task.checkCancellation()
            commits = rows; hasMoreHistory = !rows.isEmpty
        }
    }
    func changeMode() {
        guard !writing else { return }
        search = ""
        cancelRead()
        diff = nil; selectedFile = nil; commitPatch = nil; selectedCommit = nil; preview = nil
        if mode == "history" { loadHistory(reset: true) }
    }
    func loadHistory(reset: Bool) {
        guard let workspace else { return }
        let offset = reset ? 0 : commits.count
        run("Reading history") {
            let rows: [CommitEntry] = try await self.bridge.call("history", ["workspace": workspace.id, "offset": offset])
            try Task.checkCancellation()
            self.commits = reset ? rows : self.commits + rows
            self.hasMoreHistory = !rows.isEmpty
        }
    }
    func loadFile() {
        guard let workspace, let file = changes?.files.first(where: { $0.id == selectedFile }) else { return }
        diff = nil
        run("Reading \(file.path)") {
            let diff: FileDiff = try await self.bridge.call("diff", ["workspace": workspace.id, "path": file.path, "side": file.side])
            try Task.checkCancellation(); self.diff = diff
        }
    }
    func loadCommit() {
        guard let workspace, let oid = selectedCommit else { return }
        commitPatch = nil
        run("Reading commit") {
            let patch: String = try await self.bridge.call("commit_diff", ["workspace": workspace.id, "oid": oid, "parent": 0])
            try Task.checkCancellation(); self.commitPatch = patch
        }
    }
    func trust() {
        guard let workspace else { return }
        run("Trusting repository", write: true) {
            let _: Empty = try await self.bridge.call("trust", ["workspace": workspace.id, "trusted": true], cancellable: false)
            try await self.reload(workspace.id)
        }
    }
    func stage() {
        guard let diff, let workspace else { return }
        run(diff.side == "staged" ? "Unstaging file" : "Staging file", write: true) {
            do {
                let result: OperationResult = try await self.bridge.call("stage", ["snapshot": diff.id], cancellable: false)
                self.show(result)
            } catch {
                // A write error may mean applied-but-unverified. Never retry automatically.
                try? await self.reload(workspace.id)
                throw error
            }
            try await self.reload(workspace.id)
        }
    }
    func review() {
        guard let diff else { return }
        run("Saving human review", write: true) {
            let _: Empty = try await self.bridge.call("review", ["snapshot": diff.id, "reviewed": !diff.reviewed], cancellable: false)
            let updated: FileDiff = try await self.bridge.call("diff", ["workspace": self.workspace!.id, "path": diff.path, "side": diff.side], cancellable: false)
            self.diff = updated
            self.status = updated.reviewed ? "Human review recorded for this content" : "Marked unread"
        }
    }
    func prepareCommit() {
        guard let workspace, let changes else { return }
        run("Checking staged content") {
            let preview: CommitPreview = try await self.bridge.call("prepare_commit", ["workspace": workspace.id, "token": changes.token])
            try Task.checkCancellation(); self.preview = preview
        }
    }
    func commit() {
        guard let preview, let workspace else { return }
        let message = message
        self.preview = nil
        run("Committing staged content", write: true) {
            do {
                let result: OperationResult = try await self.bridge.call("commit", ["preview": preview.id, "message": message], cancellable: false)
                self.show(result)
                if result.ok { self.message = "" }
            } catch {
                try? await self.reload(workspace.id)
                throw error
            }
            try await self.reload(workspace.id)
        }
    }
    private func show(_ result: OperationResult) {
        status = result.message
        if let warning = result.warning { error = warning }
        if !result.ok { error = result.warning ?? result.message }
    }
}
