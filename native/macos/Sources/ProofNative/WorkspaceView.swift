import AppKit
import SwiftUI

struct WorkspaceView: View {
    @ObservedObject var model: WorkspaceModel
    @State private var trustConfirmation = false
    @State private var stageConfirmation = false
    @State private var rawPatch = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        GeometryReader { geometry in
        NavigationSplitView(columnVisibility: $columnVisibility) {
            VStack(spacing: 0) {
                repositoryIdentity
                Picker("Workspace section", selection: $model.mode) {
                    Text("Changes").tag("changes")
                    Text("Commit").tag("commit")
                    Text("History").tag("history")
                }
                .pickerStyle(.segmented).labelsHidden()
                .disabled(model.writing).padding(.horizontal, 16).padding(.bottom, 16)
                if model.workspace != nil { fileList.layoutPriority(-1) }
                Spacer(minLength: 0)
                sidebarStatus
            }
            .navigationSplitViewColumnWidth(min: 250, ideal: 290, max: 340)
        } detail: {
            Group {
                if model.workspace == nil { welcome }
                else if model.mode == "commit" { commitEditor }
                else { detail }
            }
            .background(Color(nsColor: .textBackgroundColor))
            .navigationTitle(documentTitle)
            .toolbar { documentToolbar }
        }
        .navigationSplitViewStyle(.balanced)
        .frame(width: geometry.size.width, height: geometry.size.height)
        }
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
    private var documentTitle: String {
        if model.mode == "commit" { return "Commit" }
        if model.mode == "history" { return "History" }
        return model.diff.map { ($0.path as NSString).lastPathComponent } ?? "Changes"
    }
    private var repositoryIdentity: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Image(systemName: "folder").foregroundStyle(.secondary)
                Text(model.workspace?.name ?? "Proof").font(.system(size: 18, weight: .semibold))
                Spacer()
                Menu {
                    Button("Open Repository…", action: requestOpen).disabled(model.writing)
                    Button("Refresh") { model.refresh() }.disabled(model.workspace == nil || model.busy)
                } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton).fixedSize().help("Repository actions")
            }
            if let changes = model.changes {
                Label(changes.branch ?? "Detached HEAD", systemImage: "arrow.triangle.branch")
                    .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    .help(changes.branch ?? "Detached HEAD")
            }
        }.padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 20)
    }
    @ToolbarContentBuilder private var documentToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if let diff = model.diff, model.mode == "changes" {
                Menu {
                    Toggle("Show Raw Patch", isOn: $rawPatch)
                } label: { Image(systemName: "text.alignleft") }
                .help("Reading options").accessibilityLabel("Reading options")
                Button { model.review() } label: {
                    Label(diff.reviewed ? "Reviewed" : "Mark Reviewed", systemImage: diff.reviewed ? "checkmark.circle.fill" : "checkmark.circle")
                }.labelStyle(.titleAndIcon).nativeGlassControl().disabled(model.busy).help("Human review of this content; separate from staging")
                Button(diff.side == "staged" ? "Unstage…" : "Stage…") { stageConfirmation = true }
                    .nativeGlassControl().disabled(model.busy || !diff.canStage)
            }
            Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                .help("Refresh repository (⌘R)").accessibilityLabel("Refresh repository")
                .disabled(model.workspace == nil || model.busy)
        }
    }
    private var sidebarStatus: some View {
        VStack(alignment: .leading, spacing: 10) {
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
        .frame(maxWidth: .infinity, alignment: .leading).padding(18)
    }
    private var fileList: some View {
        VStack(spacing: 0) {
            TextField(model.mode == "history" ? "Filter loaded commits" : "Filter files", text: $model.search)
                .textFieldStyle(.roundedBorder).controlSize(.regular)
                .padding(.horizontal, 16).padding(.bottom, 12)
            if model.mode == "history" {
                List(selection: $model.selectedCommit) {
                    ForEach(model.commits.filter { model.search.isEmpty || ($0.subject + $0.author + $0.oid).localizedCaseInsensitiveContains(model.search) }) { commit in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(commit.subject).lineLimit(2)
                            Text("\(commit.oid.prefix(8)) · \(commit.author)").font(.caption).foregroundStyle(.secondary)
                            if !commit.refs.isEmpty { Text(commit.refs).font(.caption).foregroundStyle(.blue).lineLimit(1) }
                        }.padding(.vertical, 3).tag(commit.oid)
                    }
                }.listStyle(.inset).disabled(model.writing)
                if model.commits.isEmpty && !model.busy { Text("No commits to display").foregroundStyle(.secondary).padding() }
                if model.hasMoreHistory { Button("Load More") { model.loadHistory(reset: false) }.disabled(model.busy).padding(8) }
            } else {
                List(selection: $model.selectedFile) {
                    ForEach(["unstaged", "staged"], id: \.self) { side in
                        Section {
                            ForEach((model.changes?.files ?? []).filter { $0.side == side && (model.search.isEmpty || $0.path.localizedCaseInsensitiveContains(model.search)) }) { file in
                                HStack(spacing: 8) {
                                    Image(systemName: file.path.hasSuffix(".swift") ? "swift" : "doc.text")
                                        .font(.system(size: 14)).foregroundStyle(.secondary).frame(width: 18)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text((file.path as NSString).lastPathComponent).font(.system(size: 13, weight: model.selectedFile == file.id ? .medium : .regular)).lineLimit(1)
                                        Text((file.path as NSString).deletingLastPathComponent.isEmpty ? "." : (file.path as NSString).deletingLastPathComponent)
                                            .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                        if let old = file.oldPath { Text("from \(old)").font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                                    }
                                    Spacer(minLength: 2)
                                    Text(file.conflicted ? "!" : file.status)
                                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                        .foregroundStyle(file.conflicted ? Color.orange : Color.secondary)
                                }.padding(.vertical, 7).tag(file.id).help(file.path)
                            }
                        } header: {
                            HStack {
                                Text(side == "staged" ? "Staged" : "Unstaged")
                                Spacer()
                                Text("\((model.changes?.files ?? []).filter { $0.side == side }.count)").monospacedDigit()
                            }.font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                        }
                    }
                }.listStyle(.sidebar).disabled(model.writing)
                if model.changes?.files.isEmpty == true { Text("Working tree clean").foregroundStyle(.secondary).padding() }
            }
        }
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
                HStack(spacing: 8) {
                    Text((diff.path as NSString).deletingLastPathComponent)
                        .lineLimit(1).truncationMode(.middle).help(diff.path)
                    Image(systemName: "chevron.right").font(.system(size: 8))
                    Text(diff.side == "staged" ? "Index" : "Working tree")
                    Spacer(minLength: 12)
                    Text("+\(diff.additions)").foregroundStyle(Color(nsColor: .systemGreen))
                    Text("−\(diff.deletions)").foregroundStyle(Color(nsColor: .systemRed))
                }.font(.system(size: 11)).foregroundStyle(.secondary)
                .padding(.horizontal, 20).frame(height: 40)
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

private extension View {
    @ViewBuilder func nativeGlassControl() -> some View {
        if #available(macOS 26.0, *) {
            self.buttonStyle(.glass)
        } else {
            self.buttonStyle(.bordered)
        }
    }
}

