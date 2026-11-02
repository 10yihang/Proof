import SwiftUI

struct WorkspaceView: View {
    @ObservedObject var model: WorkspaceModel
    @State private var trustConfirmation = false
    @State private var stageConfirmation = false
    @State private var rawPatch = false

    var body: some View {
        VStack(spacing: 0) {
            if let workspace = model.workspace {
                HSplitView {
                    navigation(workspace)
                        .frame(minWidth: 170, idealWidth: 190, maxWidth: 240)
                    if model.mode == "commit" {
                        commitEditor
                    } else {
                        HSplitView {
                            fileList.frame(minWidth: 240, idealWidth: 290, maxWidth: 420)
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
            .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14).frame(height: 30)
        }
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button(action: requestOpen) { Label("Open Repository", systemImage: "folder") }
                    .help("Open Repository (⌘O)").disabled(model.writing)
            }
            ToolbarItem(placement: .principal) {
                VStack(spacing: 2) {
                    Text(model.workspace?.name ?? "Proof Native").font(.headline)
                    if let changes = model.changes { Text(changes.branch ?? "Detached HEAD").font(.caption).foregroundStyle(.secondary) }
                }
            }
            ToolbarItem {
                Button { model.refresh() } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .help("Refresh repository (⌘R)").disabled(model.workspace == nil || model.busy)
            }
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
    private func navigation(_ workspace: Workspace) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            List(selection: Binding<String?>(get: { model.mode }, set: { if let mode = $0 { model.mode = mode } })) {
                Label("Changes", systemImage: "square.stack.3d.up").tag("changes")
                Label("Commit", systemImage: "checkmark.circle").tag("commit")
                Label("History", systemImage: "clock").tag("history")
            }.listStyle(.sidebar).disabled(model.writing)
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Label(workspace.trusted ? "Trusted repository" : "Read-only repository", systemImage: workspace.trusted ? "checkmark.shield" : "lock")
                    .font(.caption)
                if !workspace.trusted { Button("Trust for Git Writes…") { trustConfirmation = true }.disabled(model.busy) }
                Text(workspace.path).font(.caption).foregroundStyle(.secondary).lineLimit(3).textSelection(.enabled)
                if let operation = model.changes?.operation { Label(operation, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
            }.padding(12)
        }
    }
    private var fileList: some View {
        VStack(spacing: 0) {
            HStack { Text(model.mode == "history" ? "History" : "Changed files").font(.headline); Spacer() }.padding(12)
            TextField(model.mode == "history" ? "Filter loaded commits" : "Filter files", text: $model.search)
                .textFieldStyle(.roundedBorder).padding(.horizontal, 10).padding(.bottom, 8)
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
                        Section(side == "staged" ? "Staged" : "Unstaged") {
                            ForEach((model.changes?.files ?? []).filter { $0.side == side && (model.search.isEmpty || $0.path.localizedCaseInsensitiveContains(model.search)) }) { file in
                                HStack(alignment: .top, spacing: 8) {
                                    Text(file.conflicted ? "!" : file.status).font(.system(.caption, design: .monospaced).weight(.semibold)).frame(width: 16)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(file.path).lineLimit(2)
                                        if let old = file.oldPath { Text("from \(old)").font(.caption).foregroundStyle(.secondary) }
                                    }
                                }.padding(.vertical, 2).tag(file.id).help(file.path)
                            }
                        }
                    }
                }.listStyle(.inset).disabled(model.writing)
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
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(diff.path).font(.headline).textSelection(.enabled)
                        Spacer()
                        Text("+\(diff.additions) −\(diff.deletions)").font(.system(.caption, design: .monospaced))
                    }
                    HStack {
                        Text(diff.side.capitalized).font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Toggle("Raw patch", isOn: $rawPatch).toggleStyle(.checkbox)
                        Button(diff.reviewed ? "Mark Unread" : "Mark Reviewed") { model.review() }.disabled(model.busy)
                        Button(diff.side == "staged" ? "Unstage…" : "Stage…") { stageConfirmation = true }.disabled(model.busy || !diff.canStage)
                    }.controlSize(.small)
                    if let notice = diff.notice { Text(notice).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                    if diff.reviewed { Label("Reviewed · content-bound", systemImage: "checkmark.circle").font(.caption).foregroundStyle(.blue) }
                }.padding(12)
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
