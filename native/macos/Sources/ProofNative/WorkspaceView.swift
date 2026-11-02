import AppKit
import SwiftUI

struct WorkspaceView: View {
    @ObservedObject var model: WorkspaceModel
    @State private var trustConfirmation = false
    @State private var stageConfirmation = false
    @State private var rawPatch = false
    @State private var scope = "all"
    @State private var tree = true
    @State private var collapsed: Set<String> = []
    @State private var showsContext = true
    @State private var contextPopover = false
    @State private var availableWidth: CGFloat = 1000
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            GeometryReader { column in
                HStack(spacing: 0) {
                    navigationRail
                    VStack(spacing: 0) {
                        HStack {
                            Text(model.mode == "history" ? "History" : model.mode == "commit" ? "Commit files" : "Changed files")
                                .font(.system(size: 12, weight: .semibold))
                            Spacer()
                        }.padding(.horizontal, 12).frame(height: 36)
                        if model.workspace != nil { fileList }
                        else { Spacer(minLength: 0) }
                        sidebarStatus.captureLayout("sidebar-footer")
                    }
                }.frame(width: column.size.width, height: column.size.height, alignment: .topLeading)
                    .captureLayout("sidebar-column")
            }
            .navigationSplitViewColumnWidth(min: 294, ideal: 324, max: 384)
        } detail: {
            HStack(spacing: 0) {
                Group {
                    if model.workspace == nil { welcome }
                    else if model.mode == "commit" { commitEditor }
                    else { detail }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    .captureLayout("detail-column")
                    .background(Color(nsColor: .textBackgroundColor))
                if availableWidth >= 1200 && showsContext && model.mode == "changes" {
                    Divider()
                    ProofContextInspector(model: model).frame(width: 260)
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        // Keep the native split at scene root. Communicate the tab strip as an
        // inset instead of relocating its AppKit toolbar-exclusion coordinates.
        .safeAreaInset(edge: .top, spacing: 0) { repositoryTabs }
        .background(GeometryReader { viewport in
            Color.clear
                .onAppear { availableWidth = viewport.size.width }
                .onChange(of: viewport.size.width) { availableWidth = $0 }
        })
        .navigationTitle(model.workspace?.name ?? "Proof")
        .toolbar { documentToolbar }
        .alert("Repository needs your trust", isPresented: $trustConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Trust Repository") { model.trust() }
        } message: {
            Text("Enable Git writes for \(model.workspace?.path ?? "this repository")? Repository configuration, filters and hooks may run local programs. Trust only code you control or have inspected.")
        }
        .alert(model.diff?.side == "staged" ? "Unstage this file?" : "Stage this file?", isPresented: $stageConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button(model.diff?.side == "staged" ? "Unstage File" : "Stage File") { model.stage() }
        } message: { Text("\(model.diff?.path ?? "")\nThe entire selected file change will be applied to the index. Worktree content is preserved. Core will reject an outdated snapshot.") }
        .alert("Proof needs your attention", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") { model.error = nil }
        } message: { Text(model.error ?? "") }
        .sheet(item: $model.preview) { preview in commitConfirmation(preview) }
        .onChange(of: model.mode) { _ in model.changeMode() }
        .onChange(of: model.selectedFile) { _ in model.loadFile() }
        .onChange(of: model.selectedCommit) { _ in model.loadCommit() }
    }

    private func requestOpen() {
        model.pickRepository()
    }
    private var welcome: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "text.badge.checkmark").font(.system(size: 36)).foregroundStyle(.blue)
            Text("Look closely. Commit deliberately.").font(.title2.weight(.semibold))
            Text("Open a local Git repository to read changes and record human review.\nYour existing Proof app and its data stay separate.")
                .foregroundStyle(.secondary)
            Button("Open Repository…", action: requestOpen).keyboardShortcut("o").disabled(model.busy)
            if !model.recent.isEmpty {
                Divider().padding(.vertical, 8)
                Text("Recent repositories").font(.headline)
                ForEach(model.recent.prefix(6)) { workspace in
                    Button { model.open(workspace.path) } label: {
                        HStack { Image(systemName: "folder"); VStack(alignment: .leading) { Text(workspace.name); Text(workspace.path).font(.caption).foregroundStyle(.secondary).lineLimit(1) }; Spacer() }
                    }.buttonStyle(.plain).disabled(model.busy)
                }
            }
        }.frame(maxWidth: 540, alignment: .leading).padding(40).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var repositoryTabs: some View {
        HStack(spacing: 0) {
            if let workspace = model.workspace {
                HStack(spacing: 8) {
                    Image(systemName: "folder")
                    Text(workspace.name).lineLimit(1)
                    Spacer(minLength: 12)
                    Button { model.closeRepository() } label: { Image(systemName: "xmark").font(.system(size: 9)) }
                        .buttonStyle(.plain).disabled(model.writing)
                        .help("Close repository").accessibilityLabel("Close repository")
                }.font(.system(size: 11, weight: .medium)).padding(.horizontal, 12)
                    .frame(width: 220, height: 32)
                    .background(Color.blue.opacity(0.07), ignoresSafeAreaEdges: [])
                    .overlay(alignment: .bottom) { Rectangle().fill(Color.blue.opacity(0.65)).frame(height: 1) }
                    .help(workspace.path)
            }
            Spacer(minLength: 0)
            Button(action: requestOpen) { Image(systemName: "plus") }
                .buttonStyle(.plain).frame(width: 36, height: 32).disabled(model.writing)
                .help("Open repository (replaces the current repository)").accessibilityLabel("Open repository")
        }.frame(height: 32).background(Color(nsColor: .windowBackgroundColor), ignoresSafeAreaEdges: [])
    }
    private var navigationRail: some View {
        VStack(spacing: 8) {
            railButton("Changes", icon: "doc.on.doc", mode: "changes", key: "1")
            railButton("Commit", icon: "checkmark.rectangle", mode: "commit", key: "2")
            railButton("History", icon: "clock.arrow.circlepath", mode: "history", key: "3")
            Spacer(minLength: 0)
        }.padding(.top, 8).frame(width: 44)
    }
    private func railButton(_ title: String, icon: String, mode: String, key: KeyEquivalent) -> some View {
        Button { model.mode = mode } label: {
            Image(systemName: icon).font(.system(size: 15)).frame(width: 34, height: 34)
                .foregroundStyle(model.mode == mode ? Color.blue : Color.secondary)
                .background(model.mode == mode ? Color.blue.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain).disabled(model.writing).keyboardShortcut(key)
            .help(title).accessibilityLabel(title)
            .accessibilityAddTraits(model.mode == mode ? .isSelected : [])
    }
    private var repositoryIdentity: some View {
        HStack(spacing: 8) {
            ProofMark().frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.workspace?.name ?? "Proof").font(.system(size: 12, weight: .semibold))
                if let changes = model.changes {
                    Label(changes.branch ?? "Detached HEAD", systemImage: "arrow.triangle.branch")
                        .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                        .help(changes.branch ?? "Detached HEAD")
                }
            }
        }.frame(width: 260, alignment: .leading)
    }
    @ToolbarContentBuilder private var documentToolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) { repositoryIdentity }
        ToolbarItemGroup(placement: .primaryAction) {
            if model.mode == "changes" {
            Button {
                if availableWidth >= 1200 { showsContext.toggle() }
                else { contextPopover.toggle() }
            } label: { Image(systemName: "sidebar.right") }
                .help("Change context").accessibilityLabel("Change context")
                .popover(isPresented: $contextPopover) {
                    ProofContextInspector(model: model).frame(width: 300, height: 470)
                }
            }
            Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                .help("Refresh repository (⌘R)").accessibilityLabel("Refresh repository")
                .disabled(model.workspace == nil || model.busy)
        }
    }
    private var sidebarStatus: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.mode == "changes", let changes = model.changes {
                reviewCoverage(changes)
            }
            if model.busy {
                HStack {
                    ProgressView().controlSize(.small)
                    Text(model.activity).lineLimit(2)
                    if !model.writing { Button("Cancel") { model.cancelRead() }.buttonStyle(.link) }
                }
            } else if !model.status.isEmpty {
                Text(model.status).fixedSize(horizontal: false, vertical: true)
            }
            if let workspace = model.workspace {
                HStack {
                    if workspace.trusted {
                        Label("Trusted repository", systemImage: "checkmark.shield").help(workspace.path)
                    } else {
                        Button { trustConfirmation = true } label: {
                            Label("Read-only · Trust…", systemImage: "lock")
                        }.buttonStyle(.plain).disabled(model.busy).help(workspace.path)
                    }
                    Spacer()
                    if let operation = model.changes?.operation {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange).help(operation)
                    }
                }
            }
        }.font(.system(size: 11)).foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading).padding(10)
    }
    private var fileList: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                TextField(model.mode == "history" ? "Filter loaded commits" : "Filter files…", text: $model.search)
                    .textFieldStyle(.roundedBorder).controlSize(.small)
                if model.mode != "history" {
                    Button { tree.toggle() } label: { Image(systemName: tree ? "list.bullet" : "list.bullet.indent") }
                        .buttonStyle(.plain).help(tree ? "Show flat list" : "Show folder tree")
                        .accessibilityLabel(tree ? "Show flat list" : "Show folder tree")
                }
            }.padding(.horizontal, 10).padding(.bottom, 8)
            if model.mode == "history" {
                List(selection: $model.selectedCommit) {
                    ForEach(model.commits.filter { model.search.isEmpty || ($0.subject + $0.author + $0.oid).localizedCaseInsensitiveContains(model.search) }) { commit in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(commit.subject).lineLimit(2)
                            Text("\(commit.oid.prefix(8)) · \(commit.author)").font(.caption).foregroundStyle(.secondary)
                            if !commit.refs.isEmpty { Text(commit.refs).font(.caption).foregroundStyle(.blue).lineLimit(1) }
                        }.padding(.vertical, 3).tag(commit.oid)
                    }
                }.listStyle(.inset).frame(minHeight: 0, maxHeight: .infinity).disabled(model.writing)
                if model.commits.isEmpty && !model.busy { Text("No commits to display").foregroundStyle(.secondary).padding() }
                if model.hasMoreHistory { Button("Load More") { model.loadHistory(reset: false) }.disabled(model.busy).padding(8) }
            } else {
                Picker("Change scope", selection: $scope) {
                    Text("All").tag("all")
                    Text("Unstaged").tag("unstaged")
                    Text("Staged").tag("staged")
                }.pickerStyle(.segmented).labelsHidden().controlSize(.small)
                    .padding(.horizontal, 10).padding(.bottom, 6)
                List(selection: Binding<String?>(get: { model.selectedFile }, set: { selection in
                    // Only a user's deselection cancels the active file read;
                    // programmatic refresh/mode resets must not cancel their own work.
                    if selection == nil, model.selectedFile != nil { model.cancelRead() }
                    model.selectedFile = selection
                })) {
                    ForEach(changesTreeRows(files: model.changes?.files ?? [], scope: scope,
                                            search: model.search, tree: tree, collapsed: collapsed)) { row in
                        if let file = row.file {
                            changedFileRow(file, depth: row.depth).tag(file.id)
                                .listRowBackground(model.selectedFile == file.id ? Color.blue.opacity(0.14) : Color.clear)
                                .listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 6))
                        } else {
                            Button {
                                if collapsed.contains(row.id) { collapsed.remove(row.id) }
                                else { collapsed.insert(row.id) }
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: row.isExpanded ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 9, weight: .semibold)).frame(width: 10)
                                    if !row.isGroup { Image(systemName: "folder").foregroundStyle(.secondary) }
                                    Text(row.label).lineLimit(1).truncationMode(.middle)
                                    Spacer(minLength: 2)
                                    Text("\(row.count)").foregroundStyle(.secondary).monospacedDigit()
                                }.font(.system(size: 11, weight: row.isGroup ? .semibold : .regular))
                                .padding(.leading, CGFloat(row.depth) * 12).frame(height: 30)
                                .contentShape(Rectangle())
                            }.buttonStyle(.plain).tag(Optional<String>.none)
                                .accessibilityLabel("\(row.label), \(row.count) files, \(row.isExpanded ? "expanded" : "collapsed")")
                                .listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 6))
                        }
                    }
                }.listStyle(.sidebar).environment(\.defaultMinListRowHeight, 32)
                    .frame(minHeight: 0, maxHeight: .infinity).disabled(model.writing)
                if model.changes?.files.isEmpty == true { Text("Working tree clean").foregroundStyle(.secondary).padding() }
                else if !model.search.isEmpty && !(model.changes?.files.contains { $0.path.localizedCaseInsensitiveContains(model.search) && (scope == "all" || $0.side == scope) } ?? false) {
                    Text("No matching files").font(.caption).foregroundStyle(.secondary).padding(8)
                }
            }
        }
    }
    private func changedFileRow(_ file: ChangedFile, depth: Int) -> some View {
        HStack(spacing: 6) {
            Image(systemName: file.path.hasSuffix(".md") ? "doc.text" : "chevron.left.forwardslash.chevron.right")
                .font(.system(size: 12)).foregroundStyle(.secondary).frame(width: 15)
            Text(tree ? (file.path as NSString).lastPathComponent : file.path)
                .font(.system(size: 12)).lineLimit(1).truncationMode(.middle)
                .foregroundStyle(model.selectedFile == file.id ? Color.blue : Color.primary)
            Spacer(minLength: 2)
            if model.loadedDiffs[file.id]?.reviewed == true {
                Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(.blue)
                    .accessibilityLabel("Manually reviewed loaded content")
            }
            Text(file.conflicted ? "!" : file.status == "?" ? "U" : file.status)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(file.conflicted ? Color.orange : Color.secondary)
        }.padding(.leading, CGFloat(depth) * 12 + 10).frame(height: 32)
            .help(file.path + (file.oldPath.map { "\nRenamed from " + $0 } ?? ""))
    }
    private func reviewCoverage(_ changes: Changes) -> some View {
        let snapshots = changes.files.compactMap { model.loadedDiffs[$0.id] }
        let hunks = snapshots.flatMap(\.hunks)
        let reviewed = hunks.filter { $0.reviewState == "reviewed" }.count
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("\(changes.files.count) files").foregroundStyle(.secondary)
                Spacer()
                Label("\(reviewed)/\(hunks.count) hunks reviewed", systemImage: "checkmark.circle")
                    .foregroundStyle(.blue)
            }
            HStack {
                Text("\(snapshots.count)/\(changes.files.count) files loaded · manual review")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                Spacer(minLength: 2)
                Button { model.nextReviewFile() } label: { Image(systemName: "arrow.right") }
                    .buttonStyle(.plain).foregroundStyle(.blue)
                    .help("Next file needing review, including unloaded files")
                    .accessibilityLabel("Next file needing review")
                    .disabled(model.busy || !changes.files.contains { model.loadedDiffs[$0.id]?.reviewed != true })
            }
        }.help("Review coverage includes only loaded content. Unloaded files are unknown, not reviewed. Review is separate from staging.")
    }
    @ViewBuilder private var detail: some View {
        if model.mode == "history", let patch = model.commitPatch {
            VStack(spacing: 0) {
                if let commit = model.commits.first(where: { $0.oid == model.selectedCommit }) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(commit.subject).font(.headline)
                        Text("\(commit.author) · \(commit.date)").font(.caption).foregroundStyle(.secondary)
                        Text(commit.oid).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        if commit.parents.count > 1 { Text("Merge commit · showing first-parent comparison").font(.caption).foregroundStyle(.secondary) }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
                    Divider()
                }
                PatchView(patch: patch)
            }
        } else if let diff = model.diff, model.mode == "changes" {
            VStack(spacing: 0) {
                fileHeader(diff).captureLayout("file-header")
                if let notice = diff.notice {
                    Text(notice).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                }
                if rawPatch || diff.hunks.allSatisfy({ $0.lines.isEmpty }) { PatchView(patch: diff.patch) }
                else { NativeDiffView(diff: diff) }
            }
        } else {
            VStack(spacing: 12) {
                Image(systemName: model.mode == "history" ? "clock" : "doc.text.magnifyingglass").font(.system(size: 30)).foregroundStyle(.secondary)
                Text(model.busy ? "Reading repository…" : model.mode == "history" ? "Select a commit" : "Select a changed file").font(.headline)
                Text("Real Git content. Human decisions.").foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
    private func fileHeader(_ diff: FileDiff) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "chevron.left.forwardslash.chevron.right").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text((diff.path as NSString).lastPathComponent).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                HStack(spacing: 8) {
                    Text(diff.path).lineLimit(1).truncationMode(.middle)
                    Text(diff.side == "staged" ? "HEAD → Index" : "Index → Worktree").fixedSize()
                }.font(.system(size: 10)).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading).help(diff.path)
            HStack(spacing: 5) {
                Text("+\(diff.additions)").foregroundStyle(Color(nsColor: .systemGreen))
                Text("−\(diff.deletions)").foregroundStyle(Color(nsColor: .systemRed))
            }.font(.system(size: 10)).fixedSize()
            Button { model.review() } label: {
                Label(diff.reviewed ? "Reviewed" : "Review", systemImage: diff.reviewed ? "checkmark.circle.fill" : "checkmark.circle")
            }.foregroundStyle(.blue).disabled(model.busy)
                .accessibilityLabel(diff.reviewed ? "Mark file unread" : "Mark file reviewed")
                .help("Toggle manual review for this exact file content; separate from staging")
            Button(diff.side == "staged" ? "Unstage…" : "Stage…") { stageConfirmation = true }
                .disabled(model.busy || !diff.canStage)
            Menu {
                Toggle("Show Raw Patch", isOn: $rawPatch)
            } label: { Image(systemName: "text.alignleft") }
                .menuStyle(.borderlessButton).fixedSize().help("Reading tools").accessibilityLabel("Reading tools")
        }.buttonStyle(.bordered).controlSize(.small)
            .padding(.horizontal, 12).frame(height: 56)
            .background(Color(nsColor: .windowBackgroundColor), ignoresSafeAreaEdges: [])
    }
    private var commitEditor: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Commit staged changes").font(.title2.weight(.semibold))
            Text("Only the index is committed. Review and staging are separate decisions.").foregroundStyle(.secondary)
            List((model.changes?.files ?? []).filter { $0.side == "staged" }) { file in Text(file.path).font(.system(.body, design: .monospaced)) }
                .frame(minHeight: 120, maxHeight: 230)
            Text("Commit message").font(.headline)
            TextEditor(text: $model.message).font(.system(.body, design: .monospaced)).frame(minHeight: 130).border(Color.secondary.opacity(0.25))
                .accessibilityLabel("Commit message").disabled(model.writing)
            HStack {
                Text("A checked preview is required before committing.").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Review Commit…") { model.prepareCommit() }
                    .disabled(model.busy || model.workspace?.trusted != true || model.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(model.changes?.files.contains(where: { $0.side == "staged" }) ?? false))
            }
        }.padding(24).frame(maxWidth: .infinity)
    }
    private func commitConfirmation(_ preview: CommitPreview) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Commit \(preview.files.count) staged files?").font(.title2.weight(.semibold))
            Text("Branch: \(preview.branch ?? "Detached HEAD")").font(.headline)
            Text("Human review: \(preview.reviewed) of \(preview.total) units. Reviewed does not guarantee correctness.").foregroundStyle(.secondary)
            if !preview.unreadFiles.isEmpty { Text("Coverage could not be computed for: \(preview.unreadFiles.joined(separator: ", "))").foregroundStyle(.orange) }
            ScrollView { VStack(alignment: .leading, spacing: 6) { ForEach(preview.files) { Text($0.path).font(.system(.body, design: .monospaced)) } }.frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 160)
            Text(model.message).lineLimit(6).textSelection(.enabled)
            Text("Creates a local commit. Configured Git hooks may run. No push, amend or AI invocation. Changed index or HEAD will invalidate this preview.").font(.caption).foregroundStyle(.secondary)
            HStack { Spacer(); Button("Cancel", role: .cancel) { model.preview = nil }; Button("Commit") { model.commit() }.keyboardShortcut(.defaultAction) }
        }.padding(24).frame(width: 560)
    }
}

/// The existing assets/proof.svg mark, drawn as native vector geometry.
private struct ProofMark: View {
    var body: some View {
        GeometryReader { geometry in
            let scale = geometry.size.width / 512
            ZStack {
                RoundedRectangle(cornerRadius: 108 * scale).fill(Color(red: 49 / 255, green: 91 / 255, blue: 206 / 255))
                    .padding(32 * scale)
                Path { path in
                    path.move(to: CGPoint(x: 169 * scale, y: 151 * scale))
                    path.addLines([CGPoint(x: 131 * scale, y: 151 * scale), CGPoint(x: 131 * scale, y: 361 * scale), CGPoint(x: 169 * scale, y: 361 * scale)])
                    path.move(to: CGPoint(x: 343 * scale, y: 151 * scale))
                    path.addLines([CGPoint(x: 381 * scale, y: 151 * scale), CGPoint(x: 381 * scale, y: 361 * scale), CGPoint(x: 343 * scale, y: 361 * scale)])
                }.stroke(.white, style: StrokeStyle(lineWidth: 24 * scale, lineCap: .round, lineJoin: .round))
                Path { path in
                    path.move(to: CGPoint(x: 192 * scale, y: 258 * scale))
                    path.addLines([CGPoint(x: 239 * scale, y: 304 * scale), CGPoint(x: 324 * scale, y: 196 * scale)])
                }.stroke(.white, style: StrokeStyle(lineWidth: 29 * scale, lineCap: .round, lineJoin: .round))
            }
        }.accessibilityHidden(true)
    }
}
