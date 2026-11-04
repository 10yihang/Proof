import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct WorkspaceView: View {
    @ObservedObject var model: WorkspaceModel
    @AppStorage("proof.native.compact") private var compact = true
    @State private var trustConfirmation = false
    @State private var stageConfirmation = false
    @State private var pendingStage: FileDiff?
    @State private var pendingHunk: Hunk?
    @State private var hunkPopover = false
    @State private var rawPatch = false
    @State private var splitDiff = true
    @State private var collapsed: Set<String> = []
    @State private var fileScope = "all"
    @State private var treeLayout = true
    @State private var contextPopover = false
    @State private var aiPanel = false
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var fileListFocused: Bool

    private var activeMode: String { model.workspace == nil && model.mode != "settings" ? "repositories" : model.mode }

    var body: some View {
        GeometryReader { window in
            VStack(spacing: 0) {
                titleBar(width: window.size.width).captureLayout("branch-header")
                HStack(spacing: 0) {
                    if model.sidebarVisible {
                        repositoryNavigation.frame(width: window.size.width >= 1250 ? 176 : 160)
                    }
                    GeometryReader { viewport in
                        VStack(spacing: 0) {
                            pageContent(size: viewport.size)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .captureLayout("page-content")
                            statusBar
                        }
                    }
                }
            }.frame(width: window.size.width, height: window.size.height)
        }
        .background(WorkbenchChromeBackground(glass: activeMode == "changes"))
        .background(NativeWindowChrome())
        .ignoresSafeArea(.container, edges: .top)
        .tint(Color(nsColor: WorkbenchPalette.accent))
        .foregroundStyle(Color(nsColor: WorkbenchPalette.text))
        .font(.system(size: 13))
        .alert("信任此仓库？", isPresented: $trustConfirmation) {
            Button("取消", role: .cancel) {}
            Button("信任仓库") { model.trust() }
        } message: {
            Text("启用 \(model.workspace?.path ?? "此仓库") 的 Git 写操作？仓库配置、过滤器和 hooks 可能运行本地程序。请仅信任你控制或检查过的代码。")
        }
        .alert(pendingStage?.side == "staged" ? "取消暂存所选变化？" : "暂存所选变化？", isPresented: $stageConfirmation) {
            Button("取消", role: .cancel) { pendingStage = nil; pendingHunk = nil }
            Button(pendingStage?.side == "staged" ? "取消暂存" : "暂存") {
                guard let snapshot = pendingStage else { return }
                if let hunk = pendingHunk { model.stageHunk(snapshot: snapshot.id, hunk: hunk.id) }
                else { model.stage(snapshot: snapshot.id) }
                pendingStage = nil; pendingHunk = nil
            }
        } message: {
            Text("\(pendingStage?.path ?? "")\n\(pendingHunk?.header ?? "整个文件")\n只应用所选范围，保留工作区内容。若快照已过期，Core 将拒绝操作。人工评审状态不等于暂存状态。")
        }
        .alert("操作未完成", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("好") { model.error = nil }
        } message: { Text(model.error ?? "") }
        .sheet(item: $model.preview) { commitConfirmation($0) }
        .sheet(item: $model.operationPreview, onDismiss: { model.cancelOperation() }) { RepositoryOperationConfirmation(model: model, preview: $0) }
        .sheet(isPresented: $aiPanel) { AIAssistanceView(model: model) }
        .onAppear {
            if ScreenshotPreview.outputDirectory == nil { model.startAutoRefresh() }
            else { fileScope = ScreenshotPreview.fileScope; treeLayout = !ScreenshotPreview.fileList }
        }
        .onDisappear { model.stopAutoRefresh() }
        .onChange(of: scenePhase) { model.setWorkspaceActive($0 == .active) }
        .onChange(of: stageConfirmation || trustConfirmation || hunkPopover || aiPanel) { model.dialogPresented = $0 }
        .onChange(of: model.workspace?.id) { _ in fileScope = "all"; collapsed = [] }
        .onChange(of: model.mode) { _ in model.changeMode() }
        .onChange(of: model.selectedFile) { _ in model.loadFile() }
        .onChange(of: model.selectedCommit) { _ in model.loadCommit() }
    }

    private var rule: some View { Rectangle().fill(Color(nsColor: WorkbenchPalette.border)).frame(width: 1) }
    private var horizontalRule: some View { Rectangle().fill(Color(nsColor: WorkbenchPalette.border)).frame(height: 1) }

    @ViewBuilder private func pageContent(size: CGSize) -> some View {
        if model.mode == "settings" {
            NativeSettingsView(model: model).padding(12)
        } else if model.mode == "repositories" || model.workspace == nil {
            RepositoryHomeView(model: model).padding(12)
        } else if model.mode == "branches" {
            BranchesView(model: model).padding(12)
        } else if model.mode == "history" {
            HistoryWorkbench(model: model, size: size).padding(12)
        } else {
            HStack(alignment: .top, spacing: 14) {
                VStack(spacing: 12) {
                    filesPanel.workbenchCard()
                        .frame(maxHeight: .infinity)
                    inlineCommit.captureLayout("commit-editor").workbenchCard()
                        .frame(height: max(220, min(300, size.height * 0.34)))
                }.frame(width: size.width < 1000 ? 280 : 300)
                selectedContent.workbenchCard()
            }.padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 10)
        }
    }
    private func titleBar(width: CGFloat) -> some View {
        HStack(spacing: width < 1250 ? 12 : 18) {
            Color.clear.frame(width: 72).accessibilityHidden(true)
            HStack(spacing: 8) {
                Image(nsImage: ProofBrand.image).resizable().interpolation(.high).frame(width: 28, height: 28).accessibilityHidden(true)
                Text("Proof").font(.system(size: 19, weight: .semibold))
            }
            Button { model.setSidebarVisible(!model.sidebarVisible, persist: ScreenshotPreview.outputDirectory == nil) } label: {
                Image(systemName: "sidebar.left").font(.system(size: 17)).frame(width: 30, height: 30)
            }.buttonStyle(.plain).airyControlSurface().help("展开或收起侧边栏 ⌘⌥S").keyboardShortcut("s", modifiers: [.command, .option])
            Divider().frame(height: 24)
            repositoryTab
            if model.workspace != nil {
                Divider().frame(height: 24)
                Button { model.mode = "branches" } label: {
                    Label(model.changes?.branch ?? "分离的 HEAD", systemImage: "arrow.triangle.branch")
                        .lineLimit(1).truncationMode(.middle).frame(maxWidth: width < 1250 ? 145 : 215, alignment: .leading)
                }.buttonStyle(.plain).disabled(model.writing).help("查看当前仓库分支")
            }
            Spacer(minLength: 12)
            if model.workspace != nil {
                RepositorySyncControls(model: model, compact: width < 1250)
                Button { aiPanel = true } label: { Label("AI", systemImage: "sparkles") }
                    .buttonStyle(.plain).disabled(model.busy || model.workspace?.trusted != true).help("评审文件或生成提交说明，仅在确认后运行")
                Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).disabled(model.busy)
            }
            Button { contextPopover.toggle() } label: { Image(systemName: "info.circle") }
                .buttonStyle(.plain).help("仓库与评审状态")
                .popover(isPresented: $contextPopover) { ProofContextInspector(model: model).frame(width: 300, height: 470) }
            openRepositoryButton
        }.font(.system(size: 14)).padding(.horizontal, 16).frame(height: 64)
            .background(Color(nsColor: WorkbenchPalette.canvas).opacity(0.32))
            .overlay(alignment: .bottom) { horizontalRule.opacity(0.55) }
    }
    private var repositoryTab: some View {
        Menu {
            Button("所有仓库") { model.mode = "repositories" }
            Divider()
            ForEach(model.recent) { workspace in Button(workspace.name) { model.open(workspace.path) } }
            Divider()
            Button("打开仓库…") { model.pickRepository() }
            if model.workspace != nil { Button("关闭当前仓库") { model.closeRepository() } }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "shippingbox")
                Text(model.workspace?.name ?? "选择仓库")
            }
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(Color(nsColor: WorkbenchPalette.text)).lineLimit(1)
                .frame(minWidth: 110, maxWidth: 180, alignment: .leading)
        }.menuStyle(.borderlessButton).fixedSize().disabled(model.writing)
            .help(model.workspace?.path ?? "本地仓库")
    }
    private var openRepositoryButton: some View {
        Button { model.pickRepository() } label: { Label("打开仓库", systemImage: "folder.badge.plus") }
            .disabled(model.writing).help("打开仓库 ⌘O")
    }
    private var repositoryNavigation: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(spacing: 4) {
                navigationButton("工作区", icon: "tray", mode: "changes", key: "1", count: model.changes?.files.count)
                navigationButton("提交历史", icon: "clock.arrow.circlepath", mode: "history", key: "2", count: nil)
                navigationButton("分支", icon: "arrow.triangle.branch", mode: "branches", key: "3", count: nil)
            }.padding(.top, 14)
            if let workspace = model.workspace {
                VStack(alignment: .leading, spacing: 10) {
                    Text(workspace.name).font(.system(size: 15, weight: .semibold))
                        .lineLimit(1).truncationMode(.middle).help(workspace.path)
                    Label(model.changes?.branch ?? "分离的 HEAD", systemImage: "arrow.triangle.branch")
                        .font(.system(size: 12)).foregroundStyle(Color(nsColor: WorkbenchPalette.accent))
                        .lineLimit(1).truncationMode(.middle).help(model.changes?.branch ?? "分离的 HEAD")
                    if let upstream = model.remoteState?.upstream {
                        Label(upstream, systemImage: "cloud").font(.system(size: 11))
                            .foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                            .lineLimit(1).truncationMode(.middle).help(upstream)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    .background(Color(nsColor: WorkbenchPalette.canvas).opacity(0.48), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(nsColor: WorkbenchPalette.border).opacity(0.6), lineWidth: 0.65))
                    .padding(.top, 22)
            }
            Spacer(minLength: 12)
            if model.busy {
                HStack(spacing: 6) { ProgressView().controlSize(.mini); Text(model.activity).lineLimit(2) }
                    .font(.system(size: 11)).padding(.horizontal, 8)
                if !model.writing { Button("取消读取") { model.cancelRead() }.buttonStyle(.plain).padding(8) }
            }
            if let workspace = model.workspace {
                Group {
                    if workspace.trusted { Label("已信任仓库", systemImage: "checkmark.shield") }
                    else { Button { trustConfirmation = true } label: { Label("只读 · 信任仓库…", systemImage: "lock") }.buttonStyle(.plain).disabled(model.busy) }
                }.font(.system(size: 11)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                    .padding(.horizontal, 10).padding(.bottom, 12)
            }
            navigationButton("设置", icon: "gearshape", mode: "settings", key: ",", count: nil)
                .padding(.bottom, 12).captureLayout("sidebar-footer")
        }.padding(.leading, 12).padding(.trailing, 6)
    }
    private func navigationButton(_ title: String, icon: String, mode: String, key: KeyEquivalent, count: Int?) -> some View {
        Button { model.mode = mode } label: {
            HStack(spacing: 9) { Image(systemName: icon).frame(width: 16); Text(title).font(.system(size: 14, weight: activeMode == mode ? .semibold : .regular)); Spacer(minLength: 2); if let count { Text("\(count)").font(.system(size: 11)) } }
                .padding(.horizontal, 10).frame(height: compact ? 40 : 46).contentShape(Rectangle())
                .foregroundStyle(Color(nsColor: activeMode == mode ? WorkbenchPalette.text : WorkbenchPalette.secondary))
                .workbenchSelection(activeMode == mode)
        }.buttonStyle(.plain).disabled(model.writing).keyboardShortcut(key)
            .accessibilityAddTraits(activeMode == mode ? .isSelected : []).padding(.bottom, 3)
    }
    private var filesPanel: some View {
        VStack(spacing: 0) {
            HStack {
                Text(model.mode == "history" ? "历史" : "更改").font(.system(size: 17, weight: .semibold))
                countBadge(model.mode == "history" ? model.commits.count : model.changes?.files.count ?? 0)
                Spacer()
                if model.mode != "history" {
                    Menu {
                        Picker("文件显示方式", selection: $treeLayout) {
                            Text("目录树").tag(true)
                            Text("文件列表").tag(false)
                        }
                    } label: { Image(systemName: treeLayout ? "list.bullet.indent" : "list.bullet") }
                    .menuStyle(.borderlessButton).fixedSize().disabled(model.writing)
                    .help("文件显示方式：目录树或文件列表")
                    .accessibilityLabel("文件显示方式")
                }
            }.padding(.horizontal, 14).frame(height: 46)
                .background(Color(nsColor: WorkbenchPalette.cardHeader))
                .overlay(alignment: .bottom) { horizontalRule }
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(model.mode == "history" ? "筛选已加载提交…" : "筛选文件…", text: $model.search)
                    .textFieldStyle(.plain).font(.system(size: 13))
            }.padding(9).workbenchInputSurface()
                .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 8)
            if model.mode == "history" { historyList }
            else {
                HStack(spacing: 3) {
                    scopeButton("全部", value: "all", count: model.changes?.files.count ?? 0)
                    scopeButton("未暂存", value: "unstaged", count: fileCount("unstaged"))
                    scopeButton("已暂存", value: "staged", count: fileCount("staged"))
                }.padding(.horizontal, 12).padding(.bottom, 8).disabled(model.writing)
                    .help("只筛选文件列表；不改变当前 Diff、暂存状态或提交范围")
                changedFiles
            }
            if model.mode != "history" { reviewProgress }
        }.frame(maxHeight: .infinity).captureLayout("files-column")
    }
    private func scopeButton(_ title: String, value: String, count: Int) -> some View {
        Button { fileScope = value } label: {
            HStack(spacing: 4) {
                Text(title)
                Text("\(count)").monospacedDigit().font(.system(size: 11))
            }.font(.system(size: 12, weight: fileScope == value ? .semibold : .regular))
                .frame(maxWidth: .infinity).frame(height: 30)
                .foregroundStyle(Color(nsColor: fileScope == value ? WorkbenchPalette.accent : WorkbenchPalette.secondary))
                .contentShape(Rectangle()).workbenchSelection(fileScope == value)
        }.buttonStyle(.plain).accessibilityLabel("\(title)，\(count) 个文件")
            .accessibilityAddTraits(fileScope == value ? .isSelected : [])
    }
    private func fileCount(_ side: String) -> Int {
        model.changes?.files.filter { $0.side == side }.count ?? 0
    }
    private var visibleTreeRows: [ChangesTreeRow] {
        changesTreeRows(files: model.changes?.files ?? [], scope: fileScope, search: model.search, tree: treeLayout, collapsed: collapsed)
    }
    private var matchingFileCount: Int {
        visibleTreeRows.filter(\.isGroup).reduce(0) { $0 + $1.count }
    }
    private var changedFiles: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(visibleTreeRows) { row in
                        if let file = row.file {
                            Button { model.selectedFile = file.id; fileListFocused = true } label: {
                                changedFileRow(file, depth: row.depth)
                                    .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain).id(file.id)
                                .workbenchSelection(model.selectedFile == file.id)
                                .overlay(alignment: .bottom) { horizontalRule.opacity(0.45).padding(.leading, 28) }
                                .accessibilityAddTraits(model.selectedFile == file.id ? .isSelected : [])
                        } else {
                            Button {
                                if collapsed.contains(row.id) { collapsed.remove(row.id) } else { collapsed.insert(row.id) }
                            } label: {
                                HStack(spacing: 7) {
                                    Image(systemName: row.isExpanded ? "chevron.down" : "chevron.right").font(.system(size: 8))
                                    if !row.isGroup { Image(systemName: "folder").font(.system(size: 11)) }
                                    Text(row.isGroup ? (row.label == "Staged" ? "已暂存" : "未暂存") : row.label).lineLimit(1).truncationMode(.middle)
                                    if row.isGroup { Text("\(row.count)").font(.system(size: 10)) }
                                    Spacer(minLength: 0)
                                }.font(.system(size: 12)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                                    .padding(.leading, CGFloat(row.depth) * 8 + 6).frame(height: row.isGroup ? 34 : 28).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                                .accessibilityLabel("\(row.label)，\(row.count) 个文件，\(row.isExpanded ? "展开" : "折叠")")
                        }
                    }
                }.padding(.horizontal, 8)
            }.focusable().focused($fileListFocused)
                .task(id: model.selectedFile) {
                    // Reveal the actual selection after lazy rows have laid out,
                    // including restored selections in short windows.
                    await Task.yield()
                    if let selected = model.selectedFile { proxy.scrollTo(selected, anchor: .center) }
                }
                .onMoveCommand { direction in
                    guard !model.writing, direction == .up || direction == .down else { return }
                    let files = visibleTreeRows.compactMap(\.file)
                    guard !files.isEmpty else { return }
                    let current = files.firstIndex { $0.id == model.selectedFile }
                    let next = current.map { min(files.count - 1, max(0, $0 + (direction == .down ? 1 : -1))) } ?? 0
                    model.selectedFile = files[next].id
                    proxy.scrollTo(files[next].id)
                }
        }.frame(minHeight: 0, maxHeight: .infinity).disabled(model.writing)
            .overlay {
                if model.changes?.files.isEmpty == true { Text("工作区干净").foregroundStyle(.secondary) }
                else if matchingFileCount == 0 {
                    VStack(spacing: 8) {
                        Text(model.search.isEmpty ? "此范围暂无文件" : "没有匹配的文件").foregroundStyle(.secondary)
                        Button("显示全部文件") { fileScope = "all"; model.search = ""; collapsed = [] }
                            .buttonStyle(.plain).foregroundStyle(Color(nsColor: WorkbenchPalette.accent))
                    }.font(.system(size: 12)).disabled(model.writing)
                }
            }
    }
    private func changedFileRow(_ file: ChangedFile, depth: Int) -> some View {
        HStack(spacing: 8) {
            FileTypeIcon(path: file.path)
            VStack(alignment: .leading, spacing: 4) {
                Text((file.path as NSString).lastPathComponent).font(.system(size: 15)).lineLimit(1).truncationMode(.middle)
                if !treeLayout {
                    Text((file.path as NSString).deletingLastPathComponent.isEmpty ? "仓库根目录" : (file.path as NSString).deletingLastPathComponent)
                        .font(.system(size: 11)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 2)
            if model.loadedDiffs[file.id]?.reviewed == true { Image(systemName: "checkmark").font(.system(size: 10)).accessibilityLabel("已人工评审此快照") }
            Text(file.conflicted ? "!" : file.status == "?" ? "U" : file.status)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .frame(width: 18, height: 18)
                .foregroundStyle(Color(nsColor: file.conflicted || file.status == "D" ? WorkbenchPalette.deletionInk : file.status == "A" || file.status == "?" ? WorkbenchPalette.additionInk : WorkbenchPalette.modificationInk))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color(nsColor: WorkbenchPalette.border)))
                .accessibilityLabel(file.conflicted ? "冲突" : "Git 状态 \(file.status)")
        }.padding(.leading, CGFloat(depth) * 8 + 6).padding(.trailing, 6)
            .frame(height: treeLayout ? 38 : 48).help(file.path)
    }
    private var historyList: some View {
        VStack(spacing: 0) {
            List(selection: $model.selectedCommit) {
                ForEach(model.commits.filter { model.search.isEmpty || ($0.subject + $0.author + $0.oid).localizedCaseInsensitiveContains(model.search) }) { commit in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(commit.subject).font(.system(size: 11)).lineLimit(2)
                        Text("\(commit.oid.prefix(8)) · \(commit.author)").font(.system(size: 10)).foregroundStyle(.secondary)
                    }.padding(.vertical, 6).tag(commit.oid)
                }
            }.listStyle(.plain).scrollContentBackground(.hidden).frame(minHeight: 0, maxHeight: .infinity).disabled(model.writing)
            if model.hasMoreHistory { Button("加载更多") { model.loadHistory(reset: false) }.disabled(model.busy).padding(8) }
        }
    }
    private var reviewProgress: some View {
        let snapshots = (model.changes?.files ?? []).compactMap { model.loadedDiffs[$0.id] }
        return VStack(alignment: .leading, spacing: 7) {
            horizontalRule
            HStack {
                Label("已评审 \(snapshots.filter(\.reviewed).count) / \(snapshots.count) 个已加载文件", systemImage: "checkmark")
                Spacer(minLength: 0)
                Button { fileScope = "all"; model.search = ""; collapsed = []; model.nextReviewFile() } label: { Image(systemName: "arrow.right") }
                    .buttonStyle(.plain).disabled(model.busy || !(model.changes?.files.contains { model.loadedDiffs[$0.id]?.reviewed != true } ?? false))
                    .help("全工作区下一个待评审文件（显示全部文件，含未加载）").accessibilityLabel("下一个待评审文件")
            }.padding(.top, 7)
        }.font(.system(size: 11)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
            .padding(.horizontal, 18).padding(.bottom, 14).padding(.top, 5)
    }
    @ViewBuilder private var selectedContent: some View {
        if model.mode == "history", let patch = model.commitPatch {
            VStack(spacing: 0) {
                if let commit = model.commits.first(where: { $0.oid == model.selectedCommit }) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(commit.subject).fontWeight(.semibold).lineLimit(2)
                        Text("\(commit.oid.prefix(10)) · \(commit.author) · \(commit.date)").font(.system(size: 10)).foregroundStyle(.secondary)
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                }
                PatchView(patch: patch)
            }
        } else if let diff = model.diff, model.mode != "history" {
            VStack(spacing: 0) {
                fileHeader(diff).captureLayout("file-header")
                if let notice = diff.notice { Text(notice).font(.caption).foregroundStyle(.secondary).padding(8) }
                Group {
                    if rawPatch || diff.hunks.allSatisfy({ $0.lines.isEmpty }) { PatchView(patch: diff.patch) }
                    else if splitDiff { SplitNativeDiffView(diff: diff) }
                    else { NativeDiffView(diff: diff) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity).captureLayout("diff-viewport")
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 10) {
                Image(systemName: "doc.text.magnifyingglass").font(.system(size: 25))
                Text(model.busy ? "正在读取…" : model.mode == "history" ? "选择一条提交" : "选择一个更改文件")
            }.foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
    private func countBadge(_ count: Int) -> some View {
        Text("\(count)").font(.system(size: 11, weight: .semibold)).monospacedDigit()
            .foregroundStyle(Color(nsColor: WorkbenchPalette.canvas))
            .padding(.horizontal, 6).frame(minWidth: 21, minHeight: 21)
            .background(Color(nsColor: WorkbenchPalette.text), in: Capsule())
    }
    private func fileHeader(_ diff: FileDiff) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                FileTypeIcon(path: diff.path)
                VStack(alignment: .leading, spacing: 4) {
                    Text((diff.path as NSString).lastPathComponent).font(.system(size: 16, weight: .semibold))
                    Text((diff.path as NSString).deletingLastPathComponent)
                        .font(.system(size: 12)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                }.lineLimit(1).truncationMode(.middle).help(diff.path)
                Spacer(minLength: 8)
                Text("+\(diff.additions)").foregroundStyle(Color(nsColor: WorkbenchPalette.additionInk))
                Text("−\(diff.deletions)").foregroundStyle(Color(nsColor: WorkbenchPalette.deletionInk))
            }.padding(.horizontal, 16).frame(height: 48)
                .background(Color(nsColor: WorkbenchPalette.cardHeader))
            horizontalRule
            HStack(spacing: 4) {
                Text(diff.side == "staged" ? "已暂存" : "未暂存")
                    .font(.system(size: 11, weight: .medium)).padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Color(nsColor: WorkbenchPalette.panel), in: RoundedRectangle(cornerRadius: 4))
                    .help("当前 Diff 的 Git 侧别；人工评审不会改变暂存状态")
                Menu {
                    Button("左右对照") { rawPatch = false; splitDiff = true }
                    Button("统一差异") { rawPatch = false; splitDiff = false }
                    Button("原始补丁") { rawPatch = true }
                } label: { Text(rawPatch ? "补丁" : splitDiff ? "左右对照" : "统一差异") }
                    .menuStyle(.borderlessButton).fixedSize().padding(.leading, 6)
                Button { hunkPopover.toggle() } label: {
                    Label("\(diff.hunks.count)", systemImage: "line.3.horizontal.decrease")
                }.help("逐块阅读、人工评审与暂存")
                    .accessibilityLabel("打开 \(diff.hunks.count) 个变更块")
                    .disabled(model.busy || diff.hunks.isEmpty)
                    .popover(isPresented: $hunkPopover) {
                        HunkActionsView(model: model, diff: diff) { hunk in
                            pendingStage = diff; pendingHunk = hunk
                            hunkPopover = false; stageConfirmation = true
                        }.id(diff.id)
                    }
                Spacer(minLength: 0)
                Button { model.review() } label: {
                    Label(diff.reviewed ? "已评审" : "待评审", systemImage: diff.reviewed ? "checkmark.circle.fill" : "circle")
                }.accessibilityLabel(diff.reviewed ? "已评审，切换评审状态" : "待评审，切换评审状态")
                    .disabled(model.busy).help("切换此内容快照的人工评审状态，不改变暂存区")
                Button { pendingStage = diff; pendingHunk = nil; stageConfirmation = true } label: {
                    Text(diff.side == "staged" ? "取消暂存" : "暂存文件")
                }.help(diff.side == "staged" ? "取消暂存文件…" : "暂存文件…")
                    .disabled(model.busy || !diff.canStage)
            }.buttonStyle(WorkbenchButtonStyle()).padding(.horizontal, 12).frame(height: 36)
            horizontalRule
        }
    }
    private var inlineCommit: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "square.and.pencil").foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                Text("提交").font(.system(size: 16, weight: .semibold))
                Spacer()
                Text("已暂存").font(.system(size: 11)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                countBadge(model.stagedFileCount)
            }.padding(.horizontal, 14).frame(height: 42)
                .background(Color(nsColor: WorkbenchPalette.cardHeader))
            horizontalRule
            TextField("提交标题", text: commitSubject, axis: .vertical)
                .lineLimit(2...2).textFieldStyle(.plain).font(.system(size: 14, weight: .medium))
                .padding(.horizontal, 14).padding(.vertical, 10)
                .disabled(model.writing).accessibilityLabel("提交标题")
            horizontalRule.padding(.horizontal, 14)
            ZStack(alignment: .topLeading) {
                if commitBody.wrappedValue.isEmpty {
                    Text("补充说明（可选）…").foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                        .padding(.horizontal, 14).padding(.top, 10).allowsHitTesting(false)
                }
                TextEditor(text: commitBody).font(.system(size: 13)).scrollContentBackground(.hidden)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .disabled(model.writing).accessibilityLabel("提交详细说明，可选")
            }.frame(minHeight: 32, maxHeight: .infinity)
            VStack(spacing: 0) {
                horizontalRule
                Button { model.prepareCommit() } label: {
                    Text("检查并提交 \(model.stagedFileCount) 个文件…").frame(maxWidth: .infinity)
                }.buttonStyle(WorkbenchButtonStyle(prominent: true)).padding(10)
                    .help("仅提交暂存区，下一步确认范围。")
                    .disabled(!model.canPrepareCommit).keyboardShortcut(.return, modifiers: .command)
            }.background(Color(nsColor: WorkbenchPalette.panel))
        }
    }
    // Both fields edit the same Git message; previews, AI drafts and repository
    // draft protection continue to use model.message as their single source.
    private var commitSubject: Binding<String> {
        Binding(get: { CommitMessage.subject(model.message) }, set: {
            model.message = CommitMessage.replacingSubject(in: model.message, with: $0)
        })
    }
    private var commitBody: Binding<String> {
        Binding(get: { CommitMessage.body(model.message) }, set: {
            model.message = CommitMessage.replacingBody(in: model.message, with: $0)
        })
    }
    private var statusBar: some View {
        HStack {
            Text(ScreenshotPreview.outputDirectory != nil ? "演示数据 · 不执行 Git 操作" : model.status.isEmpty ? "\(model.changes?.files.count ?? 0) 个更改" : model.status).lineLimit(1)
            Spacer()
            if model.diff != nil { Text("只读 Diff") }
        }.font(.system(size: 10)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
            .padding(.horizontal, 18).frame(height: 24)
            .overlay(alignment: .top) { horizontalRule }.captureLayout("status-bar")
    }
    private var welcome: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("看清变化，认真审查。").font(.system(size: 22, weight: .semibold))
            Text("打开本地 Git 仓库，阅读差异并记录人工评审。\n原版 Proof 的数据保持独立。").foregroundStyle(.secondary)
            Button("打开仓库…") { model.pickRepository() }.buttonStyle(WorkbenchButtonStyle(prominent: true)).keyboardShortcut("o").disabled(model.busy)
        }.padding(30).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }
    private func commitConfirmation(_ preview: CommitPreview) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("提交 \(preview.files.count) 个已暂存文件？").font(.title2.weight(.semibold))
            Text("分支：\(preview.branch ?? "分离的 HEAD")")
            Text("人工评审：\(preview.reviewed) / \(preview.total)。评审不保证代码正确。").foregroundStyle(.secondary)
            if !preview.unreadFiles.isEmpty { Text("无法计算评审覆盖率：\(preview.unreadFiles.joined(separator: ", "))").foregroundStyle(.orange) }
            ScrollView { VStack(alignment: .leading, spacing: 6) { ForEach(preview.files) { Text($0.path).font(.system(size: 11, design: .monospaced)) } }.frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 160)
            Text(model.message).lineLimit(6).textSelection(.enabled)
            Text("仅创建本地提交。配置的 Git hooks 可能运行；不推送、不修改上次提交、不调用 AI。暂存区或 HEAD 改变将使此预览失效。").font(.caption).foregroundStyle(.secondary)
            HStack { Spacer(); Button("取消", role: .cancel) { model.preview = nil }; Button("确认提交") { model.commit() }.keyboardShortcut(.defaultAction) }
        }.padding(24).frame(width: 560)
    }
}

private extension View {
    @ViewBuilder func hideAutomaticSidebarToggle() -> some View {
        if #available(macOS 14.0, *) { self.toolbar(removing: .sidebarToggle) }
        else { self }
    }

    @ViewBuilder func hideAutomaticToolbarTitle() -> some View {
        if #available(macOS 15.0, *) { self.toolbar(removing: .title) }
        else { self }
    }
}

/// Ask Launch Services for the actual extension's native document icon rather
/// than presenting every source file as the same generic text document.
private struct FileTypeIcon: View {
    let path: String
    var body: some View {
        let type = UTType(filenameExtension: (path as NSString).pathExtension) ?? .data
        Image(nsImage: NSWorkspace.shared.icon(for: type))
            .resizable().aspectRatio(contentMode: .fit).frame(width: 18, height: 18)
            .accessibilityHidden(true)
    }
}

private struct HunkActionsView: View {
    @ObservedObject var model: WorkspaceModel
    let diff: FileDiff
    let onStage: (Hunk) -> Void
    @State private var selectedID = ""
    private var selected: Hunk? { diff.hunks.first { $0.id == selectedID } ?? diff.hunks.first }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("变更块 · \((diff.path as NSString).lastPathComponent)")
                .font(.headline).lineLimit(1).truncationMode(.middle)
            Picker("所选变更块", selection: Binding(get: { selected?.id ?? "" }, set: { selectedID = $0 })) {
                ForEach(Array(diff.hunks.enumerated()), id: \.element.id) { index, hunk in
                    Text("\(index + 1). \(hunk.header)").tag(hunk.id)
                }
            }
            if let hunk = selected {
                CodeTextView(identity: diff.id + hunk.id, rows:
                    [CodeRow(text: hunk.header, kind: "header")] + hunk.lines.map {
                        CodeRow(text: $0.content, kind: $0.kind, oldLine: $0.oldLine, newLine: $0.newLine)
                    }, numbered: true)
                    .frame(height: 260).clipShape(RoundedRectangle(cornerRadius: 6))
                HStack {
                    Text(hunk.reviewState == "reviewed" ? "已人工评审" : "待人工评审")
                        .font(.caption).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                    Spacer()
                    Button(hunk.reviewState == "reviewed" ? "标为待评审" : "标为已评审") {
                        model.reviewHunk(snapshot: diff.id, hunk: hunk.id)
                    }
                    Button(diff.side == "staged" ? "取消暂存此块…" : "暂存此块…") { onStage(hunk) }
                        .disabled(!diff.canStage || diff.kind != "text")
                }.buttonStyle(WorkbenchButtonStyle())
                    .disabled(model.busy || model.diff?.id != diff.id)
            }
            Text("人工评审只记录当前内容；暂存操作会单独确认。")
                .font(.caption).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
        }.padding(16).frame(width: 600)
    }
}
