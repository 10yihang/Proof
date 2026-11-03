import AppKit
import SwiftUI

struct WorkspaceView: View {
    @ObservedObject var model: WorkspaceModel
    @AppStorage("proof.native.compact") private var compact = true
    @State private var trustConfirmation = false
    @State private var stageConfirmation = false
    @State private var rawPatch = false
    @State private var collapsed: Set<String> = []
    @State private var contextPopover = false

    private var activeMode: String { model.workspace == nil && model.mode != "settings" ? "repositories" : model.mode }

    var body: some View {
        NavigationSplitView(columnVisibility: Binding(
            get: { model.sidebarVisible ? .all : .detailOnly },
            set: { model.setSidebarVisible($0 != .detailOnly, persist: ScreenshotPreview.outputDirectory == nil) }
        )) {
            GeometryReader { column in
                repositoryNavigation
                    .frame(width: column.size.width, height: column.size.height, alignment: .topLeading)
            }
            .navigationSplitViewColumnWidth(min: 176, ideal: 208, max: 250)
            .hideAutomaticSidebarToggle()
        } detail: {
            GeometryReader { viewport in
                VStack(spacing: 0) {
                    branchBar.captureLayout("branch-header")
                    pageContent(size: viewport.size)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .captureLayout("page-content")
                    statusBar
                }.frame(width: viewport.size.width, height: viewport.size.height, alignment: .topLeading)
                    .background(Color(nsColor: WorkbenchPalette.navigation).opacity(0.55))
                    .background(WorkbenchBackdrop())
            }
        }
        .navigationSplitViewStyle(.balanced)
        .navigationTitle(model.workspace?.name ?? "Proof")
        .toolbar { workbenchToolbar }
        .toolbarBackground(.visible, for: .windowToolbar)
        .hideAutomaticToolbarTitle()
        .hideAutomaticSidebarToggle()
        .tint(Color(nsColor: WorkbenchPalette.accent))
        .foregroundStyle(Color(nsColor: WorkbenchPalette.text))
        .font(.system(size: 12))
        .alert("信任此仓库？", isPresented: $trustConfirmation) {
            Button("取消", role: .cancel) {}
            Button("信任仓库") { model.trust() }
        } message: {
            Text("启用 \(model.workspace?.path ?? "此仓库") 的 Git 写操作？仓库配置、过滤器和 hooks 可能运行本地程序。请仅信任你控制或检查过的代码。")
        }
        .alert(model.diff?.side == "staged" ? "取消暂存此文件？" : "暂存此文件？", isPresented: $stageConfirmation) {
            Button("取消", role: .cancel) {}
            Button(model.diff?.side == "staged" ? "取消暂存" : "暂存文件") { model.stage() }
        } message: {
            Text("\(model.diff?.path ?? "")\n应用整个文件的变化，保留工作区内容。若快照已过期，Core 将拒绝操作。人工评审状态不等于暂存状态。")
        }
        .alert("操作未完成", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("好") { model.error = nil }
        } message: { Text(model.error ?? "") }
        .sheet(item: $model.preview) { commitConfirmation($0) }
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
            HStack(alignment: .top, spacing: 12) {
                VStack(spacing: 12) {
                    filesPanel.workbenchCard()
                    inlineCommit.captureLayout("commit-editor").workbenchCard()
                }.frame(width: size.width < 1000 ? 248 : 292)
                selectedContent.workbenchCard()
            }.padding(12)
        }
    }
    @ToolbarContentBuilder private var workbenchToolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            HStack(spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.seal.fill").foregroundStyle(Color(nsColor: WorkbenchPalette.accent))
                    Text("Proof").font(.system(size: 14, weight: .semibold))
                }
                Button { model.toggleSidebar() } label: {
                    Image(systemName: "sidebar.left").frame(width: 28, height: 28)
                }.buttonStyle(.plain).airyControlSurface()
                    .help(model.sidebarVisible ? "收起侧边栏 ⌘⌥S" : "展开侧边栏 ⌘⌥S")
                    .accessibilityLabel(model.sidebarVisible ? "收起侧边栏" : "展开侧边栏")
                    .keyboardShortcut("s", modifiers: [.command, .option])
            }
        }
        ToolbarItem(placement: .navigation) { repositoryTab }
        ToolbarItem(placement: .primaryAction) { openRepositoryButton }
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
                .font(.system(size: 12, weight: .medium)).lineLimit(1)
                .frame(minWidth: 80, maxWidth: 210, alignment: .leading)
        }.menuStyle(.borderlessButton).fixedSize().disabled(model.writing)
            .help(model.workspace?.path ?? "本地仓库")
    }
    private var openRepositoryButton: some View {
        Button { model.pickRepository() } label: { Label("打开仓库", systemImage: "folder.badge.plus") }
            .disabled(model.writing).help("打开仓库 ⌘O")
    }
    private var repositoryNavigation: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("工作空间").font(.system(size: 11)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                .padding(.horizontal, 10).padding(.top, 20).padding(.bottom, 12)
            navigationButton("所有仓库", icon: "square.stack.3d.up", mode: "repositories", key: "0", count: model.recent.count)
            navigationButton("工作区", icon: "tray", mode: "changes", key: "1", count: model.changes?.files.count)
            navigationButton("提交历史", icon: "clock.arrow.circlepath", mode: "history", key: "2", count: nil)
            navigationButton("分支", icon: "arrow.triangle.branch", mode: "branches", key: "3", count: nil)
            if let branch = model.changes?.branch {
                Label(branch, systemImage: "arrow.triangle.branch")
                    .font(.system(size: 11)).foregroundStyle(Color(nsColor: WorkbenchPalette.accent))
                    .lineLimit(2).padding(.leading, 28).padding(.vertical, 12).help(branch)
            }
            Divider().padding(.horizontal, 10).padding(.vertical, 14)
            VStack(alignment: .leading, spacing: 16) {
                unavailableNavigation("远程仓库", icon: "network")
                unavailableNavigation("标签", icon: "tag")
                unavailableNavigation("储藏", icon: "archivebox")
            }.padding(.horizontal, 10)
            Spacer(minLength: 12)
            if model.busy {
                HStack(spacing: 6) { ProgressView().controlSize(.mini); Text(model.activity).lineLimit(2) }
                    .font(.caption).padding(.horizontal, 10)
                if !model.writing { Button("取消读取") { model.cancelRead() }.buttonStyle(.plain).padding(10) }
            }
            if let workspace = model.workspace {
                Group {
                    if workspace.trusted { Label("已信任仓库", systemImage: "checkmark.shield") }
                    else { Button { trustConfirmation = true } label: { Label("只读 · 信任仓库…", systemImage: "lock") }.buttonStyle(.plain).disabled(model.busy) }
                }.font(.system(size: 10)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                    .padding(.horizontal, 10).padding(.bottom, 16)
            }
            navigationButton("设置", icon: "gearshape", mode: "settings", key: ",", count: nil)
                .padding(.bottom, 12).captureLayout("sidebar-footer")
        }.padding(.horizontal, 12)
            .background(Color(nsColor: WorkbenchPalette.navigation).opacity(0.35))
            .background(.ultraThinMaterial)
    }
    private func unavailableNavigation(_ title: String, icon: String) -> some View {
        HStack(spacing: 9) {
            Image(systemName: icon).frame(width: 16)
            Text(title)
            Spacer()
            Text("未接入").font(.system(size: 9))
        }.foregroundStyle(Color(nsColor: WorkbenchPalette.secondary).opacity(0.7))
            .help("此原生版本尚未接入该功能，请使用现有 Git 工具。")
            .accessibilityLabel("\(title)，此原生版本未接入")
    }
    private func navigationButton(_ title: String, icon: String, mode: String, key: KeyEquivalent, count: Int?) -> some View {
        Button { model.mode = mode } label: {
            HStack(spacing: 9) { Image(systemName: icon).frame(width: 16); Text(title); Spacer(minLength: 2); if let count { Text("\(count)").font(.system(size: 11)) } }
                .padding(.horizontal, 10).frame(height: compact ? 36 : 42).contentShape(Rectangle())
                .background(activeMode == mode ? Color(nsColor: WorkbenchPalette.selection) : .clear, in: RoundedRectangle(cornerRadius: 8))
        }.buttonStyle(.plain).disabled(model.writing).keyboardShortcut(key)
            .accessibilityAddTraits(activeMode == mode ? .isSelected : []).padding(.bottom, 3)
    }
    private var branchBar: some View {
        HStack(spacing: 18) {
            if let workspace = model.workspace {
                Label(model.changes?.branch ?? "分离的 HEAD", systemImage: "arrow.triangle.branch")
                    .lineLimit(1).help(workspace.path)
                Button { model.refresh() } label: { Label("刷新", systemImage: "arrow.clockwise") }
                    .buttonStyle(.plain).disabled(model.busy).help("刷新仓库 ⌘R")
            } else {
                Text(model.mode == "settings" ? "偏好设置" : "本地 Git 仓库").fontWeight(.medium)
            }
            Spacer(minLength: 4)
            if model.workspace != nil {
                Button { contextPopover.toggle() } label: { Label("上下文", systemImage: "sidebar.right") }
                    .buttonStyle(.plain).help("当前快照与人工评审状态")
                    .popover(isPresented: $contextPopover) { ProofContextInspector(model: model).frame(width: 300, height: 470) }
            }
        }.font(.system(size: 11)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
            .padding(.horizontal, 20).frame(height: 38)
    }
    private var filesPanel: some View {
        VStack(spacing: 0) {
            HStack {
                Text(model.mode == "history" ? "历史" : "更改").font(.system(size: 13, weight: .semibold))
                Text(model.mode == "history" ? "\(model.commits.count) 条提交" : "\(model.changes?.files.count ?? 0) 个文件")
                    .font(.system(size: 10)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                Spacer()
            }.padding(.horizontal, 18).frame(height: 44)
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(model.mode == "history" ? "筛选已加载提交…" : "筛选文件…", text: $model.search)
                    .textFieldStyle(.plain).font(.system(size: 11))
            }.padding(8).background(Color(nsColor: WorkbenchPalette.raised), in: RoundedRectangle(cornerRadius: 8))
                .padding(.horizontal, 12).padding(.bottom, 10)
            if model.mode == "history" { historyList }
            else { changedFiles }
            if model.mode != "history" { reviewProgress }
        }.frame(maxHeight: .infinity).captureLayout("files-column")
    }
    private var changedFiles: some View {
        List(selection: Binding<String?>(get: { model.selectedFile }, set: { selection in
            if selection == nil, model.selectedFile != nil { model.cancelRead() }
            model.selectedFile = selection
        })) {
            ForEach(changesTreeRows(files: model.changes?.files ?? [], scope: "all", search: model.search, tree: true, collapsed: collapsed)) { row in
                if let file = row.file {
                    changedFileRow(file, depth: row.depth).tag(file.id)
                        .listRowBackground(model.selectedFile == file.id ? Color(nsColor: WorkbenchPalette.selection) : .clear)
                        .listRowInsets(EdgeInsets(top: 0, leading: 3, bottom: 0, trailing: 3))
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
                        }.font(.system(size: 11)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
                            .padding(.leading, CGFloat(row.depth) * 10).frame(height: row.isGroup ? 34 : 28).contentShape(Rectangle())
                    }.buttonStyle(.plain).tag(Optional<String>.none)
                        .accessibilityLabel("\(row.label)，\(row.count) 个文件，\(row.isExpanded ? "展开" : "折叠")")
                        .listRowInsets(EdgeInsets(top: 0, leading: 3, bottom: 0, trailing: 3))
                }
            }
        }.listStyle(.plain).scrollContentBackground(.hidden).environment(\.defaultMinListRowHeight, 32)
            .frame(minHeight: 0, maxHeight: .infinity).disabled(model.writing)
            .overlay {
                if model.changes?.files.isEmpty == true { Text("工作区干净").foregroundStyle(.secondary) }
                else if !model.search.isEmpty && !(model.changes?.files.contains { $0.path.localizedCaseInsensitiveContains(model.search) } ?? false) { Text("没有匹配的文件").foregroundStyle(.secondary) }
            }
    }
    private func changedFileRow(_ file: ChangedFile, depth: Int) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.text").font(.system(size: 12)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
            VStack(alignment: .leading, spacing: 4) {
                Text((file.path as NSString).lastPathComponent).font(.system(size: 11)).lineLimit(1).truncationMode(.middle)
                if model.selectedFile == file.id, let snapshot = model.loadedDiffs[file.id] {
                    Text("+\(snapshot.additions)   −\(snapshot.deletions)").font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 2)
            if model.loadedDiffs[file.id]?.reviewed == true { Image(systemName: "checkmark").font(.system(size: 10)).accessibilityLabel("已人工评审此快照") }
            Text(file.conflicted ? "!" : file.status == "?" ? "U" : file.status).font(.system(size: 9, design: .monospaced)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
        }.padding(.leading, CGFloat(depth) * 10 + 6).padding(.trailing, 6)
            .frame(height: model.selectedFile == file.id ? 46 : 34).help(file.path)
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
                Button { model.nextReviewFile() } label: { Image(systemName: "arrow.right") }
                    .buttonStyle(.plain).disabled(model.busy || !(model.changes?.files.contains { model.loadedDiffs[$0.id]?.reviewed != true } ?? false))
                    .help("下一个待评审文件（含未加载文件）").accessibilityLabel("下一个待评审文件")
            }.padding(.top, 7)
            Text("先审阅差异，再选择暂存范围。")
        }.font(.system(size: 10)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
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
                HStack {
                    Text(diff.side == "staged" ? "暂存区" : "工作区")
                    Text(diff.side == "staged" ? "与 HEAD 比较" : "与暂存区比较").foregroundStyle(.secondary)
                    Spacer()
                    Text("+\(diff.additions)").foregroundStyle(Color(nsColor: WorkbenchPalette.additionInk))
                    Text("−\(diff.deletions)").foregroundStyle(Color(nsColor: WorkbenchPalette.deletionInk))
                    Menu { Toggle("显示原始补丁", isOn: $rawPatch) } label: { Text(rawPatch ? "补丁" : "统一 Diff") }
                        .menuStyle(.borderlessButton).fixedSize().padding(.leading, 12)
                }.font(.system(size: 10)).padding(.horizontal, 18).frame(height: 34)
                    .overlay(alignment: .bottom) { horizontalRule }
                if let notice = diff.notice { Text(notice).font(.caption).foregroundStyle(.secondary).padding(8) }
                Group {
                    if rawPatch || diff.hunks.allSatisfy({ $0.lines.isEmpty }) { PatchView(patch: diff.patch) }
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
    private func fileHeader(_ diff: FileDiff) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.text").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text((diff.path as NSString).lastPathComponent).font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                Text((diff.path as NSString).deletingLastPathComponent).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }.help(diff.path)
            Spacer(minLength: 8)
            Button { model.review() } label: { Label(diff.reviewed ? "已评审" : "待评审", systemImage: diff.reviewed ? "checkmark.circle" : "circle") }
                .disabled(model.busy).help("切换此内容快照的人工评审状态，不改变暂存区")
            Button(diff.side == "staged" ? "取消暂存" : "暂存此文件") { stageConfirmation = true }
                .disabled(model.busy || !diff.canStage)
        }.buttonStyle(WorkbenchButtonStyle()).padding(.horizontal, 18).frame(height: 50)
            .overlay(alignment: .bottom) { horizontalRule }
    }
    private var inlineCommit: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("提交").font(.system(size: 12, weight: .semibold))
                Spacer()
                Text("已暂存 \(model.stagedFileCount) 个文件").font(.system(size: 10)).foregroundStyle(.secondary)
            }
            ZStack(alignment: .topLeading) {
                if model.message.isEmpty { Text("填写提交说明…").foregroundStyle(.secondary).padding(8).allowsHitTesting(false) }
                TextEditor(text: $model.message).font(.system(size: 12)).scrollContentBackground(.hidden)
                    .padding(4).disabled(model.writing).accessibilityLabel("提交信息")
            }.frame(height: compact ? 76 : 94)
                .background(Color(nsColor: WorkbenchPalette.panel), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: WorkbenchPalette.border), lineWidth: 0.7))
            Button { model.prepareCommit() } label: {
                Text("检查并提交 \(model.stagedFileCount) 个文件…").frame(maxWidth: .infinity)
            }.buttonStyle(WorkbenchButtonStyle(prominent: true))
                .disabled(!model.canPrepareCommit).keyboardShortcut(.return, modifiers: .command)
            Text("仅提交暂存区，下一步确认范围。")
                .font(.system(size: 9)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
        }.padding(12)
    }
    private var statusBar: some View {
        HStack {
            Text(ScreenshotPreview.outputDirectory != nil ? "演示数据 · 不执行 Git 操作" : model.status.isEmpty ? "\(model.changes?.files.count ?? 0) 个更改" : model.status).lineLimit(1)
            Spacer()
            if model.diff != nil { Text("只读 Diff") }
        }.font(.system(size: 9)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
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
