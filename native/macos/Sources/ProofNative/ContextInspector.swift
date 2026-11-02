import AppKit
import SwiftUI

/// Read-only context for the bridge snapshot currently on screen.
/// The caller owns the 260pt column and its narrow-window presentation.
struct ProofContextInspector: View {
    @ObservedObject var model: WorkspaceModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("上下文").font(.system(size: 12, weight: .semibold))
                Spacer()
            }.padding(.horizontal, 16).frame(height: 40).captureLayout("context-header")
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
                            Label("当前 Diff 快照", systemImage: "clock.arrow.circlepath")
                                .font(.system(size: 12, weight: .medium))
                            Text(model.busy ? "正在读取选中内容…" : "选择一个更改文件以查看快照。")
                                .foregroundStyle(.secondary)
                        }.padding(16)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if let workspace = model.workspace {
                Divider()
                Label(workspace.trusted ? "本地仓库 · 已信任" : "本地仓库 · 只读",
                      systemImage: workspace.trusted ? "checkmark.shield" : "lock")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 12)
            }
        }
        .font(.system(size: 11))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: WorkbenchPalette.panel))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Diff 上下文")
    }

    private func snapshot(_ diff: FileDiff) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("当前 Diff 快照", systemImage: "clock.arrow.circlepath")
                .font(.system(size: 12, weight: .medium))
            Text(diff.path)
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 10) {
                field("比较范围", diff.side == "staged" ? "HEAD → 暂存区" : "暂存区 → 工作区")
                if let head = model.changes?.head {
                    field("HEAD", String(head.prefix(12)), help: head)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("快照 ID").foregroundStyle(.secondary)
                Text(diff.id).font(.system(size: 10, design: .monospaced))
                    .textSelection(.enabled).lineLimit(2).truncationMode(.middle)
                    .help(diff.id)
            }.help("当前快照的不透明标识，不是 Git 提交哈希。")
            Text("刷新以读取最新仓库内容。")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }.padding(16)
    }

    private func review(_ diff: FileDiff) -> some View {
        let reviewed = diff.hunks.filter { $0.reviewState == "reviewed" }.count
        return VStack(alignment: .leading, spacing: 10) {
            Label("人工评审", systemImage: "checkmark.circle")
                .font(.system(size: 12, weight: .medium))
            if diff.hunks.isEmpty {
                Text("此快照没有可评审的区块。").foregroundStyle(.secondary)
            } else {
                Text("\(reviewed) / \(diff.hunks.count) 个区块已评审")
                    .foregroundStyle(Color(nsColor: WorkbenchPalette.accent)).monospacedDigit()
            }
            Text("仅适用于已加载内容。评审与暂存独立，不保证代码正确。")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }.padding(16)
    }

    private var validation: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("验证", systemImage: "checkmark.shield")
                .font(.system(size: 12, weight: .medium))
            Text("此前端未报告验证结果。")
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

