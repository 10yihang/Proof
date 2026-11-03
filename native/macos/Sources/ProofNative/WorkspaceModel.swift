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
    @Published var operationPreview: HistoryActionPreview?
    @Published var remoteState: HistoryRepositoryState?
    @Published var agentSettings: AgentSettings?
    @Published var aiProviders: [AgentProviderInfo] = []
    @Published var aiReport: AIReport?
    @Published var suggestedCommitMessage: String?
    @Published var aiRunning = false
    @Published var autoRefreshEnabled: Bool {
        didSet { defaults.set(autoRefreshEnabled, forKey: NativePreferences.autoRefresh) }
    }
    @Published var dialogPresented = false
    private var workspaceActive = true
    private var refreshTask: Task<Void, Never>?
    private var operationWorkspace: String?
    private var suggestionToken: String?
    // Injection is only for model regression tests; production always uses Bridge.
    typealias Request = @MainActor (String, [String: Any], Bool) async throws -> Data
    private let request: Request?
    private var task: Task<Void, Never>?
    private var generation = 0
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard, request: Request? = nil) {
        self.defaults = defaults
        self.request = request
        self.autoRefreshEnabled = defaults.object(forKey: NativePreferences.autoRefresh) as? Bool ?? true
        let restore = defaults.object(forKey: NativePreferences.restoreSidebar) as? Bool ?? true
        sidebarVisible = restore ? (defaults.object(forKey: NativePreferences.sidebarVisible) as? Bool ?? true) : true
    }

    private func call<T: Decodable>(_ method: String, _ parameters: [String: Any] = [:], cancellable: Bool = true) async throws -> T {
        if let request { return try JSONDecoder().decode(T.self, from: await request(method, parameters, cancellable)) }
        return try await bridge.call(method, parameters, cancellable: cancellable)
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
            let hello: Hello = try await self.call("hello")
            guard hello.protocolVersion == 1 else { throw BridgeError(code: "VERSION_MISMATCH", message: "请同时重新构建应用和 Rust 桥接服务。", detail: "协议 \(hello.protocolVersion)") }
            let recent: [Workspace] = try await self.call("recent")
            try Task.checkCancellation()
            self.recent = recent
        }
    }
    private func run(_ label: String, write: Bool = false, clearError: Bool = true, work: @escaping @MainActor () async throws -> Void) {
        guard !writing else { return }
        task?.cancel()
        generation += 1
        let current = generation
        busy = true; writing = write; activity = label
        if clearError { error = nil }
        task = Task {
            do { try await work() }
            catch is CancellationError {}
            catch { if self.generation == current { self.error = error.localizedDescription } }
            if self.generation == current { self.busy = false; self.writing = false; self.aiRunning = false; self.task = nil }
        }
    }
    func cancelRead() {
        guard !writing else { return }
        generation += 1; task?.cancel(); task = nil; busy = false; aiRunning = false
        status = "已取消读取。刷新以载入最新状态。"
    }
    func pickRepository() {
        guard !writing else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.allowsMultipleSelection = false; panel.prompt = "打开仓库"
        dialogPresented = true
        let response = panel.runModal()
        dialogPresented = false
        if response == .OK, let url = panel.url { open(url.path) }
    }
    func closeRepository() {
        guard !writing else { return }
        if !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let alert = NSAlert()
            alert.messageText = "丢弃提交说明草稿并关闭此仓库？"
            alert.addButton(withTitle: "继续编辑")
            alert.addButton(withTitle: "关闭仓库")
            dialogPresented = true
            let response = alert.runModal()
            dialogPresented = false
            guard response == .alertSecondButtonReturn else { return }
        }
        stopAutoRefresh()
        cancelRead()
        operationPreview = nil; operationWorkspace = nil; remoteState = nil
        aiReport = nil; suggestedCommitMessage = nil; suggestionToken = nil
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
            dialogPresented = true
            let response = alert.runModal()
            dialogPresented = false
            guard response == .alertSecondButtonReturn else { return }
        }
        // Draft is per selected repository; preserve it on a failed open.
        run("正在打开仓库") {
            let workspace: Workspace = try await self.call("open", ["path": path])
            let changes: Changes = try await self.call("changes", ["workspace": workspace.id])
            let remoteState: HistoryRepositoryState = try await self.call("history_state", ["workspace": workspace.id])
            try Task.checkCancellation()
            if self.workspace?.id != workspace.id { self.message = "" }
            self.workspace = changes.workspace; self.changes = changes
            self.loadedDiffs = [:]
            self.branches = []; self.selectedBranch = nil; self.branchesLoaded = false
            self.diff = nil; self.selectedFile = nil; self.selectedCommit = nil
            self.commitPatch = nil; self.commits = []; self.preview = nil; self.mode = "changes"
            self.operationPreview = nil; self.remoteState = remoteState; self.aiReport = nil
            self.suggestedCommitMessage = nil; self.suggestionToken = nil
            self.startAutoRefresh()
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
        let selected = selectedFile
        let commit = selectedCommit
        let currentMode = mode
        let previousToken = changes?.token
        let fresh: Changes = try await call("changes", ["workspace": id], cancellable: !writing)
        try Task.checkCancellation()
        let state: HistoryRepositoryState = try await call("history_state", ["workspace": id], cancellable: !writing)
        try Task.checkCancellation()
        guard workspace?.id == id else { return }
        changes = fresh; workspace = fresh.workspace; remoteState = state
        if previousToken != fresh.token {
            loadedDiffs = [:]; preview = nil; operationPreview = nil
            aiReport = nil; suggestedCommitMessage = nil; suggestionToken = nil
        }
        if selectedFile == selected {
            if let file = fresh.files.first(where: { $0.id == selected }) {
                let updated: FileDiff = try await call("diff", ["workspace": id, "path": file.path, "side": file.side], cancellable: !writing)
                try Task.checkCancellation()
                if workspace?.id == id, selectedFile == selected {
                    diff = updated; loadedDiffs[file.id] = updated
                }
            } else { diff = nil; selectedFile = nil }
        }
        if currentMode == "history", mode == currentMode {
            let rows: [CommitEntry] = try await call("history", ["workspace": id, "offset": 0], cancellable: !writing)
            try Task.checkCancellation()
            guard workspace?.id == id, mode == currentMode else { return }
            // Keep older loaded rows only when HEAD is unchanged.
            if rows.first?.oid == commits.first?.oid, commits.count > rows.count {
                commits.replaceSubrange(0..<rows.count, with: rows)
            } else { commits = rows }
            hasMoreHistory = !rows.isEmpty
            if selectedCommit == commit, !commits.contains(where: { $0.oid == commit }) {
                selectedCommit = nil; commitPatch = nil
            }
        } else if currentMode == "branches", mode == currentMode {
            try await reloadBranches(id)
        }
    }

    func startAutoRefresh() {
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                guard let self else { return }
                self.autoRefreshTick()
            }
        }
    }
    func stopAutoRefresh() { refreshTask?.cancel(); refreshTask = nil }
    func setWorkspaceActive(_ active: Bool) { workspaceActive = active }
    func autoRefreshTick() {
        // Never cancel an explicit read, write, confirmation, or AI request.
        guard autoRefreshEnabled, workspaceActive, let workspace, !busy, !writing,
              !aiRunning, !dialogPresented, preview == nil, operationPreview == nil else { return }
        run("正在自动刷新", clearError: false) { try await self.reload(workspace.id) }
    }
    func changeMode() {
        guard !writing else { return }
        search = ""
        operationPreview = nil
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
        let rows: [BranchEntry] = try await call("branches", ["workspace": id], cancellable: !writing)
        try Task.checkCancellation()
        guard workspace?.id == id else { return }
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
            let rows: [CommitEntry] = try await self.call("history", ["workspace": workspace.id, "offset": offset])
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
            let diff: FileDiff = try await self.call("diff", ["workspace": workspace.id, "path": file.path, "side": file.side])
            try Task.checkCancellation()
            guard self.workspace?.id == workspace.id, self.selectedFile == file.id else { return }
            self.diff = diff
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
            let patch: String = try await self.call("commit_diff", ["workspace": workspace.id, "oid": oid, "parent": 0])
            try Task.checkCancellation()
            guard self.workspace?.id == workspace.id, self.selectedCommit == oid else { return }
            self.commitPatch = patch
        }
    }
    func trust() {
        guard let workspace else { return }
        run("正在信任仓库", write: true) {
            let _: Empty = try await self.call("trust", ["workspace": workspace.id, "trusted": true], cancellable: false)
            try await self.reload(workspace.id)
        }
    }
    func stage(snapshot: String? = nil) {
        if let snapshot, snapshot != diff?.id { return }
        guard !busy, !writing, let diff, diff.canStage, let workspace else { return }
        run(diff.side == "staged" ? "正在取消暂存文件" : "正在暂存文件", write: true) {
            do {
                let result: OperationResult = try await self.call("stage", ["snapshot": diff.id], cancellable: false)
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
            let _: Empty = try await self.call("review", ["snapshot": diff.id, "reviewed": !diff.reviewed], cancellable: false)
            let updated: FileDiff = try await self.call("diff", ["workspace": workspace.id, "path": diff.path, "side": diff.side], cancellable: false)
            self.diff = updated
            self.loadedDiffs[diff.side + ":" + diff.path] = updated
            self.status = updated.reviewed ? "已记录此内容的人工评审" : "已标记为待评审"
        }
    }
    func prepareCommit() {
        guard canPrepareCommit, let workspace, let changes else { return }
        run("正在检查已暂存内容") {
            let preview: CommitPreview = try await self.call("prepare_commit", ["workspace": workspace.id, "token": changes.token])
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
                let result: OperationResult = try await self.call("commit", ["preview": preview.id, "message": message], cancellable: false)
                self.show(result)
                if result.ok { self.message = "" }
            } catch {
                try? await self.reload(workspace.id)
                throw error
            }
            try await self.reload(workspace.id)
        }
    }
    func stageHunk(_ hunk: Hunk) { if let diff { stageHunk(snapshot: diff.id, hunk: hunk.id) } }
    func stageHunk(snapshot: String, hunk: String) {
        guard !busy, !writing, let diff, diff.id == snapshot, diff.canStage,
              diff.hunks.contains(where: { $0.id == hunk }), let workspace else { return }
        run("正在暂存区块", write: true) {
            do {
                let result: OperationResult = try await self.call("stage", ["snapshot": snapshot, "hunk": hunk], cancellable: false)
                self.show(result)
            } catch {
                try? await self.reload(workspace.id)
                throw error
            }
            try await self.reload(workspace.id)
        }
    }
    func reviewHunk(_ hunk: Hunk) { if let diff { reviewHunk(snapshot: diff.id, hunk: hunk.id) } }
    func reviewHunk(snapshot: String, hunk: String) {
        guard !busy, !writing, let diff, diff.id == snapshot,
              let selected = diff.hunks.first(where: { $0.id == hunk }), let workspace else { return }
        run("正在保存区块评审", write: true) {
            let _: Empty = try await self.call("review", ["snapshot": snapshot, "hunk": hunk, "reviewed": selected.reviewState != "reviewed"], cancellable: false)
            let updated: FileDiff = try await self.call("diff", ["workspace": workspace.id, "path": diff.path, "side": diff.side], cancellable: false)
            self.diff = updated; self.loadedDiffs[diff.side + ":" + diff.path] = updated
            self.status = "已更新此区块的人工评审"
        }
    }
    func loadRemoteState() {
        guard !busy, let workspace else { return }
        run("正在读取远程状态") {
            let state: HistoryRepositoryState = try await self.call("history_state", ["workspace": workspace.id])
            try Task.checkCancellation(); self.remoteState = state
        }
    }
    func prepareSwitchBranch(_ branch: BranchEntry) {
        guard !branch.current else { return }
        var request: [String: Any] = ["kind": "switch", "target": branch.id]
        if branch.remote {
            request["name"] = branch.name.split(separator: "/").dropFirst().joined(separator: "/")
        }
        prepareOperation(request)
    }
    func prepareSync(_ kind: String, remote: String? = nil) {
        guard ["fetch", "pull", "push"].contains(kind), !busy, !writing else { return }
        var request: [String: Any] = ["kind": kind]
        if kind == "fetch" {
            guard let remote = remote ?? remoteState?.upstreamRemote, !remote.isEmpty else {
                error = "请选择需要获取的远程仓库。"; return
            }
            request["remote"] = remote
        } else {
            // The core defaults an omitted name to the local branch, which may differ
            // from its upstream. Always bind both destination components explicitly.
            guard let state = remoteState, state.upstream != nil,
                  let upstreamRemote = state.upstreamRemote, !upstreamRemote.isEmpty,
                  let upstreamBranch = state.upstreamBranch, !upstreamBranch.isEmpty,
                  state.remotes.contains(upstreamRemote),
                  remote == nil || remote == upstreamRemote else {
                error = "此分支没有可用的上游分支，请先在 Git 中配置并刷新。"; return
            }
            request["remote"] = upstreamRemote
            request["name"] = upstreamBranch
        }
        prepareOperation(request)
    }
    private func prepareOperation(_ request: [String: Any]) {
        guard !busy, !writing, let workspace, workspace.trusted, let changes else { return }
        operationPreview = nil
        run("正在检查 Git 操作") {
            let value: HistoryActionPreview = try await self.call("prepare_history_action", ["workspace": workspace.id, "token": changes.token, "request": request])
            try Task.checkCancellation()
            self.operationWorkspace = workspace.id; self.operationPreview = value
        }
    }
    func cancelOperation() { guard !writing else { return }; operationPreview = nil; operationWorkspace = nil }
    func executeOperation() {
        guard !busy, !writing, let workspace, workspace.trusted,
              operationWorkspace == workspace.id, let operationPreview else { return }
        self.operationPreview = nil; operationWorkspace = nil
        run("正在执行 Git 操作", write: true) {
            do {
                let result: HistoryActionResult = try await self.call("execute_history_action", ["workspace": workspace.id, "preview": operationPreview.id], cancellable: false)
                self.status = result.detail
                if !result.ok || result.warning != nil { self.error = result.warning ?? result.detail }
            } catch {
                try? await self.reload(workspace.id)
                throw error // Never retry a network/write with an uncertain outcome.
            }
            try await self.reload(workspace.id)
        }
    }
    func loadAgentSettings() {
        guard !busy, !writing else { return }
        run("正在读取 Agent 设置") {
            let settings: AgentSettings = try await self.call("agent_settings")
            let providers: [AgentProviderInfo] = try await self.call("agent_providers")
            try Task.checkCancellation()
            self.agentSettings = settings; self.aiProviders = providers
        }
    }
    func saveAgentSettings(_ settings: AgentSettings) {
        guard !busy, !writing, let current = agentSettings, current.revision == settings.revision else { return }
        run("正在保存 Agent 设置", write: true) {
            guard var update = try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any] else {
                throw CocoaError(.coderInvalidValue)
            }
            update.removeValue(forKey: "revision"); update["expectedRevision"] = current.revision
            let saved: AgentSettings = try await self.call("set_agent_settings", ["update": update], cancellable: false)
            self.agentSettings = saved
            let providers: [AgentProviderInfo] = try await self.call("agent_providers", cancellable: false)
            self.aiProviders = providers; self.status = "Agent 设置已保存"
        }
    }
    // These methods are explicit user actions. Refresh/navigation never call AI.
    // Review requests the selected path; commit uses core all-staged semantics.
    // Core reads live local content; this is not a frozen-content sandbox.
    func requestAIReview(provider: String? = nil) { requestAI(task: "review", provider: provider) }
    func generateCommitMessage(provider: String? = nil) { requestAI(task: "commit", provider: provider) }
    private func requestAI(task kind: String, provider: String?) {
        guard !busy, !writing, let workspace, workspace.trusted, let changes,
              let provider = provider ?? agentSettings?.defaultProvider,
              aiProviders.contains(where: { $0.id == provider && $0.available }) else { return }
        let reviewSelection = selectedFile
        let reviewSnapshot = diff?.id
        var scope: [String: Any] = ["kind": "local", "workspaceId": workspace.id, "expectedToken": changes.token]
        if kind == "review" {
            guard let diff, selectedFile == diff.side + ":" + diff.path else { return }
            scope["files"] = [["path": diff.path, "side": diff.side]]
        } else {
            guard changes.files.contains(where: { $0.side == "staged" }) else { return }
            // Commit generation explicitly requires files:null/omitted in core.
            // A non-null selection is not accepted even if it lists every staged file.
        }
        let request: [String: Any] = ["provider": provider, "task": kind, "amend": false, "scope": scope]
        run(kind == "review" ? "正在进行 AI Review" : "正在生成提交说明") {
            self.aiRunning = true
            let report: AIReport = try await self.call("run_ai_task", ["request": request])
            try Task.checkCancellation()
            guard self.workspace?.id == workspace.id, self.changes?.token == changes.token else { return }
            if kind == "review", self.selectedFile != reviewSelection || self.diff?.id != reviewSnapshot { return }
            self.aiReport = report
            if kind == "commit" { self.suggestedCommitMessage = report.commitMessage; self.suggestionToken = changes.token }
            self.status = "AI 建议已就绪；不会自动标记人工评审或提交"
        }
    }
    func applySuggestedCommitMessage() {
        guard !writing, let suggestion = suggestedCommitMessage, suggestionToken == changes?.token else { return }
        message = suggestion; suggestedCommitMessage = nil; suggestionToken = nil
    }
    private func show(_ result: OperationResult) {
        status = result.message
        if let warning = result.warning { error = warning }
        if !result.ok { error = result.warning ?? result.message }
    }
}

