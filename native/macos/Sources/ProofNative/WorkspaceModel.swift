import AppKit
import SwiftUI

@MainActor
final class WorkspaceModel: ObservableObject {
    let bridge = Bridge()
    @Published var workspace: Workspace?
    @Published var recent: [Workspace] = []
    @Published var changes: Changes?
    @Published var diff: FileDiff?
    // Only bridge-returned snapshots count toward loaded review coverage.
    @Published var loadedDiffs: [String: FileDiff] = [:]
    @Published var commits: [CommitEntry] = []
    @Published var branches: [BranchEntry] = []
    @Published var selectedBranch: String?
    @Published var branchesLoaded = false
    @Published var sidebarVisible: Bool
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
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let restore = defaults.object(forKey: NativePreferences.restoreSidebar) as? Bool ?? true
        sidebarVisible = restore ? (defaults.object(forKey: NativePreferences.sidebarVisible) as? Bool ?? true) : true
    }

    func setSidebarVisible(_ visible: Bool, persist: Bool = true) {
        sidebarVisible = visible
        if persist, defaults.object(forKey: NativePreferences.restoreSidebar) as? Bool ?? true {
            defaults.set(visible, forKey: NativePreferences.sidebarVisible)
        }
    }

    func toggleSidebar() { setSidebarVisible(!sidebarVisible) }

    var stagedFileCount: Int { changes?.files.filter { $0.side == "staged" }.count ?? 0 }
    var canPrepareCommit: Bool {
        !busy && !writing && workspace?.trusted == true && stagedFileCount > 0
            && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func start() {
        run("正在启动 Rust 服务") {
            try self.bridge.start()
            struct Hello: Decodable { let protocolVersion: Int; enum CodingKeys: String, CodingKey { case protocolVersion = "protocol" } }
            let hello: Hello = try await self.bridge.call("hello")
            guard hello.protocolVersion == 1 else { throw BridgeError(code: "VERSION_MISMATCH", message: "请同时重新构建应用和 Rust 桥接服务。", detail: "协议 \(hello.protocolVersion)") }
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
        status = "已取消读取。刷新以载入最新状态。"
    }
    func pickRepository() {
        guard !writing else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.allowsMultipleSelection = false; panel.prompt = "打开仓库"
        if panel.runModal() == .OK, let url = panel.url { open(url.path) }
    }
    func closeRepository() {
        guard !writing else { return }
        if !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let alert = NSAlert()
            alert.messageText = "丢弃提交说明草稿并关闭此仓库？"
            alert.addButton(withTitle: "继续编辑")
            alert.addButton(withTitle: "关闭仓库")
            guard alert.runModal() == .alertSecondButtonReturn else { return }
        }
        cancelRead()
        workspace = nil; changes = nil; diff = nil; loadedDiffs = [:]
        selectedFile = nil; selectedCommit = nil; commitPatch = nil
        commits = []; branches = []; selectedBranch = nil; branchesLoaded = false
        preview = nil; message = ""; search = ""; status = ""
        mode = "changes"
    }
    func requiresDraftConfirmation(for path: String) -> Bool {
        guard let workspace, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return URL(fileURLWithPath: workspace.path).standardizedFileURL.path
            != URL(fileURLWithPath: path).standardizedFileURL.path
    }
    func open(_ path: String) {
        guard !writing else { return }
        if requiresDraftConfirmation(for: path) {
            let alert = NSAlert()
            alert.messageText = "打开其他仓库时，丢弃当前提交说明草稿？"
            alert.addButton(withTitle: "继续编辑")
            alert.addButton(withTitle: "打开仓库")
            guard alert.runModal() == .alertSecondButtonReturn else { return }
        }
        // Draft is per selected repository; preserve it on a failed open.
        run("正在打开仓库") {
            let workspace: Workspace = try await self.bridge.call("open", ["path": path])
            let changes: Changes = try await self.bridge.call("changes", ["workspace": workspace.id])
            try Task.checkCancellation()
            if self.workspace?.id != workspace.id { self.message = "" }
            self.workspace = changes.workspace; self.changes = changes
            self.loadedDiffs = [:]
            self.branches = []; self.selectedBranch = nil; self.branchesLoaded = false
            self.diff = nil; self.selectedFile = nil; self.selectedCommit = nil
            self.commitPatch = nil; self.commits = []; self.preview = nil; self.mode = "changes"
            self.status = "仓库已载入"
            self.recent.removeAll { $0.id == workspace.id }; self.recent.insert(changes.workspace, at: 0)
        }
    }
    func refresh() {
        guard let workspace, !writing else { return }
        preview = nil
        run("正在刷新仓库") { try await self.reload(workspace.id) }
    }
    private func reload(_ id: String) async throws {
        let changes: Changes = try await bridge.call("changes", ["workspace": id], cancellable: !writing)
        try Task.checkCancellation()
        self.changes = changes; workspace = changes.workspace
        loadedDiffs = [:]
        diff = nil; selectedFile = nil; commitPatch = nil; selectedCommit = nil; preview = nil
        if mode == "history" {
            let rows: [CommitEntry] = try await bridge.call("history", ["workspace": id, "offset": 0], cancellable: !writing)
            try Task.checkCancellation()
            commits = rows; hasMoreHistory = !rows.isEmpty
        } else if mode == "branches" {
            try await reloadBranches(id)
        }
    }
    func changeMode() {
        guard !writing else { return }
        search = ""
        cancelRead()
        loadedDiffs = [:]
        diff = nil; selectedFile = nil; commitPatch = nil; selectedCommit = nil; preview = nil
        if mode == "history" { loadHistory(reset: true) }
        if mode == "branches" { loadBranches() }
    }
    func loadBranches() {
        guard let workspace, !writing else { return }
        branchesLoaded = false
        run("正在读取分支") { try await self.reloadBranches(workspace.id) }
    }
    private func reloadBranches(_ id: String) async throws {
        let rows: [BranchEntry] = try await bridge.call("branches", ["workspace": id], cancellable: !writing)
        try Task.checkCancellation()
        branches = rows
        branchesLoaded = true
        if !rows.contains(where: { $0.id == selectedBranch }) {
            selectedBranch = rows.first(where: \.current)?.id ?? rows.first?.id
        }
    }
    func loadHistory(reset: Bool) {
        guard let workspace else { return }
        let offset = reset ? 0 : commits.count
        run("正在读取提交历史") {
            let rows: [CommitEntry] = try await self.bridge.call("history", ["workspace": workspace.id, "offset": offset])
            try Task.checkCancellation()
            self.commits = reset ? rows : self.commits + rows
            self.hasMoreHistory = !rows.isEmpty
        }
    }
    func loadFile() {
        guard !writing else { return }
        diff = nil
        guard let workspace, let file = changes?.files.first(where: { $0.id == selectedFile }) else { return }
        loadedDiffs.removeValue(forKey: file.id)
        run("正在读取 \(file.path)") {
            let diff: FileDiff = try await self.bridge.call("diff", ["workspace": workspace.id, "path": file.path, "side": file.side])
            try Task.checkCancellation(); self.diff = diff
            self.loadedDiffs[file.id] = diff
        }
    }
    func nextReviewFile() {
        guard !busy, let files = changes?.files, !files.isEmpty else { return }
        let start = files.firstIndex { $0.id == selectedFile }.map { $0 + 1 } ?? 0
        for offset in 0..<files.count {
            let file = files[(start + offset) % files.count]
            if loadedDiffs[file.id]?.reviewed != true {
                selectedFile = file.id
                return
            }
        }
    }
    func loadCommit() {
        guard !writing, let workspace, let oid = selectedCommit else { return }
        commitPatch = nil
        run("正在读取提交") {
            let patch: String = try await self.bridge.call("commit_diff", ["workspace": workspace.id, "oid": oid, "parent": 0])
            try Task.checkCancellation(); self.commitPatch = patch
        }
    }
    func trust() {
        guard let workspace else { return }
        run("正在信任仓库", write: true) {
            let _: Empty = try await self.bridge.call("trust", ["workspace": workspace.id, "trusted": true], cancellable: false)
            try await self.reload(workspace.id)
        }
    }
    func stage() {
        guard !busy, !writing, let diff, diff.canStage, let workspace else { return }
        run(diff.side == "staged" ? "正在取消暂存文件" : "正在暂存文件", write: true) {
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
        guard !busy, !writing, let diff, let workspace else { return }
        run("正在保存人工评审", write: true) {
            let _: Empty = try await self.bridge.call("review", ["snapshot": diff.id, "reviewed": !diff.reviewed], cancellable: false)
            let updated: FileDiff = try await self.bridge.call("diff", ["workspace": workspace.id, "path": diff.path, "side": diff.side], cancellable: false)
            self.diff = updated
            self.loadedDiffs[diff.side + ":" + diff.path] = updated
            self.status = updated.reviewed ? "已记录此内容的人工评审" : "已标记为待评审"
        }
    }
    func prepareCommit() {
        guard canPrepareCommit, let workspace, let changes else { return }
        run("正在检查已暂存内容") {
            let preview: CommitPreview = try await self.bridge.call("prepare_commit", ["workspace": workspace.id, "token": changes.token])
            try Task.checkCancellation(); self.preview = preview
        }
    }
    func commit() {
        guard !busy, !writing, let preview, !preview.files.isEmpty,
              let workspace, workspace.trusted,
              !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let message = message
        self.preview = nil
        run("正在提交已暂存内容", write: true) {
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

