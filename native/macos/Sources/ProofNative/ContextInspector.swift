import AppKit
import SwiftUI

/// Read-only context for the bridge snapshot currently on screen.
/// The caller owns the 260pt column and its narrow-window presentation.
struct ProofContextInspector: View {
    @ObservedObject var model: WorkspaceModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Context").font(.system(size: 12, weight: .semibold))
                Spacer()
            }.padding(.horizontal, 16).frame(height: 40)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let diff = model.diff {
                        snapshot(diff)
                        Divider()
                        review(diff)
                        Divider()
                        validation
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("Current Diff snapshot", systemImage: "clock.arrow.circlepath")
                                .font(.system(size: 12, weight: .medium))
                            Text(model.busy ? "Reading selected content…" : "Select a changed file to inspect its snapshot.")
                                .foregroundStyle(.secondary)
                        }.padding(16)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if let workspace = model.workspace {
                Divider()
                Label(workspace.trusted ? "Local repository · trusted" : "Local repository · read-only",
                      systemImage: workspace.trusted ? "checkmark.shield" : "lock")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 12)
            }
        }
        .font(.system(size: 11))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .controlBackgroundColor))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Diff context")
    }

    private func snapshot(_ diff: FileDiff) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Current Diff snapshot", systemImage: "clock.arrow.circlepath")
                .font(.system(size: 12, weight: .medium))
            Text(diff.path)
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 10) {
                field("Comparison", diff.side == "staged" ? "HEAD → Index" : "Index → Worktree")
                field("Base", diff.base)
                if let head = model.changes?.head {
                    field("HEAD", String(head.prefix(12)), help: head)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Snapshot ID").foregroundStyle(.secondary)
                Text(diff.id).font(.system(size: 10, design: .monospaced))
                    .textSelection(.enabled).lineLimit(2).truncationMode(.middle)
                    .help(diff.id)
            }.help("An opaque identifier for this loaded snapshot, not a Git commit hash.")
            Text("Refresh to read the latest repository content.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }.padding(16)
    }

    private func review(_ diff: FileDiff) -> some View {
        let reviewed = diff.hunks.filter { $0.reviewState == "reviewed" }.count
        return VStack(alignment: .leading, spacing: 10) {
            Label("Human review", systemImage: "checkmark.circle")
                .font(.system(size: 12, weight: .medium))
            if diff.hunks.isEmpty {
                Text("No reviewable hunks in this snapshot.").foregroundStyle(.secondary)
            } else {
                Text("\(reviewed) of \(diff.hunks.count) hunks reviewed")
                    .foregroundStyle(.blue).monospacedDigit()
            }
            Text("Applies to this loaded content. Review is separate from staging and does not guarantee correctness.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }.padding(16)
    }

    private var validation: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Validation", systemImage: "checkmark.shield")
                .font(.system(size: 12, weight: .medium))
            Text("Not reported by this frontend.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }.padding(16)
    }

    private func field(_ title: String, _ value: String, help: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title).foregroundStyle(.secondary)
            Spacer(minLength: 4)
            Text(value).multilineTextAlignment(.trailing)
                .textSelection(.enabled)
                .help(help ?? value)
        }
    }
}
