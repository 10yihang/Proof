import AppKit
import SwiftUI

struct WorkspaceView: View {
    @ObservedObject var model: WorkspaceModel
    @State private var trustConfirmation = false
    @State private var stageConfirmation = false
    @State private var rawPatch = false
    @State private var navigationExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            workspaceToolbar
            Divider()
            if let workspace = model.workspace {
                HStack(spacing: 0) {
                    navigation(workspace)
                        .frame(width: navigationExpanded ? 136 : 46)
                    Divider()
                    if model.mode == "commit" {
                        commitEditor
                    } else {
                        HSplitView {
                            fileList.frame(minWidth: 220, idealWidth: 260, maxWidth: 280)
                            detail.frame(minWidth: 460, maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                }
            } else {
                welcome
            }
            Divider()
            HStack(spacing: 10) {
                if model.busy {
                    ProgressView().controlSize(.small)
                    Text(model.activity).lineLimit(1)
                    if !model.writing { Button("Cancel") { model.cancelRead() }.buttonStyle(.link) }
                } else { Text(model.status.isEmpty ? "Local Git · Human review · No AI running" : model.status).lineLimit(1) }
                Spacer()
                if let changes = model.changes { Text("\(changes.files.count) changes").monospacedDigit() }
            }
            .font(.system(size: 10)).foregroundStyle(.secondary).padding(.horizontal, 12).frame(height: 24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
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
    private var workspaceToolbar: some View {
        HStack(spacing: 12) {
            Button { navigationExpanded.toggle() } label: {
                Image(systemName: "sidebar.left").frame(width: 22, height: 22)
            }.buttonStyle(.borderless).help("Toggle navigation").accessibilityLabel("Toggle navigation")
            Image(systemName: "folder").foregroundStyle(.secondary)
            Text(model.workspace?.name ?? "Proof").font(.system(size: 13, weight: .semibold))
            if let changes = model.changes {
                Divider().frame(height: 14)
                Label(changes.branch ?? "Detached HEAD", systemImage: "arrow.triangle.branch")
                    .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Button(action: requestOpen) { Image(systemName: "folder.badge.plus") }
                .help("Open Repository (⌘O)").accessibilityLabel("Open Repository").disabled(model.writing)
            Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                .help("Refresh repository (⌘R)").accessibilityLabel("Refresh repository").disabled(model.workspace == nil || model.busy)
        }
        .buttonStyle(.borderless).controlSize(.small)
        .padding(.horizontal, 13).frame(height: 42)
        .background(Color(nsColor: .windowBackgroundColor))
    }
    private func navigation(_ workspace: Workspace) -> some View {
        VStack(spacing: 6) {
            navigationItem("Changes", mode: "changes", symbol: "square.stack.3d.up")
            navigationItem("Commit", mode: "commit", symbol: "checkmark.circle")
            navigationItem("History", mode: "history", symbol: "clock")
            Spacer()
            if let operation = model.changes?.operation {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange).help(operation)
            }
            Button { if !workspace.trusted { trustConfirmation = true } } label: {
                HStack(spacing: 8) {
                    Image(systemName: workspace.trusted ? "checkmark.shield" : "lock").frame(width: 20)
                    if navigationExpanded { Text(workspace.trusted ? "Trusted" : "Read-only").font(.caption); Spacer(minLength: 0) }
                }.frame(height: 28)
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)
            .help(workspace.trusted ? "Trusted repository\n" + workspace.path : "Trust repository for Git writes…")
            .accessibilityLabel(workspace.trusted ? "Trusted repository" : "Trust repository for Git writes")
            .disabled(model.busy || workspace.trusted)
        }
        .padding(.horizontal, 7).padding(.vertical, 10)
        .background(Color(nsColor: .windowBackgroundColor))
    }
    private func navigationItem(_ title: String, mode: String, symbol: String) -> some View {
        Button { model.mode = mode } label: {
            HStack(spacing: 8) {
                Image(systemName: symbol).font(.system(size: 15)).frame(width: 20)
                if navigationExpanded { Text(title).font(.system(size: 12, weight: .medium)); Spacer(minLength: 0) }
            }
            .frame(maxWidth: .infinity).frame(height: 32)
            .foregroundStyle(model.mode == mode ? Color.accentColor : Color.secondary)
            .background(model.mode == mode ? Color.accentColor.opacity(0.11) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(model.writing).help(title).accessibilityLabel(title)
        .accessibilityAddTraits(model.mode == mode ? .isSelected : [])
    }
    private var fileList: some View {
        VStack(spacing: 0) {
            HStack {
                Text(model.mode == "history" ? "History" : "Changes").font(.system(size: 12, weight: .semibold))
                Spacer()
                if model.mode == "changes", let changes = model.changes { Text("\(changes.files.count)").font(.system(size: 11)).foregroundStyle(.secondary) }
            }.padding(.horizontal, 14).frame(height: 36)
            TextField(model.mode == "history" ? "Filter loaded commits" : "Filter files", text: $model.search)
                .textFieldStyle(.roundedBorder).controlSize(.small).padding(.horizontal, 10).padding(.bottom, 10)
            Divider()
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
                                        Text((file.path as NSString).lastPathComponent).font(.system(size: 12, weight: model.selectedFile == file.id ? .medium : .regular)).lineLimit(1)
                                        Text((file.path as NSString).deletingLastPathComponent.isEmpty ? "." : (file.path as NSString).deletingLastPathComponent)
                                            .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                        if let old = file.oldPath { Text("from \(old)").font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                                    }
                                    Spacer(minLength: 2)
                                    Text(file.conflicted ? "!" : file.status)
                                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                        .foregroundStyle(file.conflicted ? Color.orange : Color.secondary)
                                }.padding(.vertical, 5).tag(file.id).help(file.path)
                            }
                        } header: {
                            HStack {
                                Text(side == "staged" ? "Staged" : "Unstaged")
                                Spacer()
                                Text("\((model.changes?.files ?? []).filter { $0.side == side }.count)").monospacedDigit()
                            }.font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                        }
                    }
                }.listStyle(.sidebar).disabled(model.writing)
                if model.changes?.files.isEmpty == true { Text("Working tree clean").foregroundStyle(.secondary).padding() }
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
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
                    Image(systemName: "doc.text").foregroundStyle(.secondary)
                    Text((diff.path as NSString).lastPathComponent).font(.system(size: 12, weight: .semibold)).lineLimit(1).help(diff.path)
                    Text(diff.side == "staged" ? "Index" : "Working tree").font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Text("+\(diff.additions)").foregroundStyle(Color(nsColor: .systemGreen))
                    Text("−\(diff.deletions)").foregroundStyle(Color(nsColor: .systemRed))
                    Divider().frame(height: 14)
                    Toggle("Patch", isOn: $rawPatch).toggleStyle(.checkbox).help("Show raw Git patch")
                    Button { model.review() } label: {
                        Label(diff.reviewed ? "Reviewed" : "Mark Reviewed", systemImage: diff.reviewed ? "checkmark.circle.fill" : "checkmark.circle")
                    }.disabled(model.busy).help("Human review only; separate from staging")
                    Button(diff.side == "staged" ? "Unstage…" : "Stage…") { stageConfirmation = true }
                        .disabled(model.busy || !diff.canStage)
                }
                .font(.system(size: 11)).controlSize(.small)
                .padding(.horizontal, 14).frame(height: 40)
                .background(Color(nsColor: .controlBackgroundColor))
                HStack(spacing: 6) {
                    Text((diff.path as NSString).deletingLastPathComponent).lineLimit(1).truncationMode(.middle)
                    Image(systemName: "chevron.right").font(.system(size: 8))
                    Text((diff.path as NSString).lastPathComponent).lineLimit(1)
                    Spacer()
                    Text(diff.reviewed ? "Reviewed · content-bound" : "Not reviewed")
                        .foregroundStyle(diff.reviewed ? Color.accentColor : Color.secondary)
                }.font(.system(size: 10)).foregroundStyle(.secondary).padding(.horizontal, 14).frame(height: 27)
                .background(Color(nsColor: .windowBackgroundColor))
                if let notice = diff.notice {
                    Text(notice).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                }
                Divider()
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
