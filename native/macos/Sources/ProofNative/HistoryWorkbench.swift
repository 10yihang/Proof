import SwiftUI

/// A read-only history table. An ancestry stroke is drawn only for a proven
/// adjacent parent relation; this is not a fabricated full repository graph.
struct HistoryWorkbench: View {
    @ObservedObject var model: WorkspaceModel
    let size: CGSize
    @AppStorage(NativePreferences.compact) private var compact = true
    private var commits: [CommitEntry] {
        model.commits.filter { model.search.isEmpty || ($0.subject + $0.author + $0.oid).localizedCaseInsensitiveContains(model.search) }
    }
    private var selected: CommitEntry? { model.commits.first { $0.oid == model.selectedCommit } }

    var body: some View {
        VStack(spacing: 12) {
            VStack(spacing: 0) {
                HStack(spacing: 16) {
                    Text("提交历史").font(.system(size: 17, weight: .semibold))
                    Label("当前 HEAD", systemImage: "arrow.triangle.branch").foregroundStyle(.secondary)
                    HStack(spacing: 7) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField("搜索已加载的提交…", text: $model.search).textFieldStyle(.plain)
                    }.padding(9).workbenchInputSurface()
                    Spacer(minLength: 0)
                }.padding(14)
                tableHeader
                Divider()
                List(selection: $model.selectedCommit) {
                    ForEach(Array(commits.enumerated()), id: \.element.id) { index, commit in
                        HStack(spacing: 12) {
                            ancestry(commit, index: index)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(commit.subject).lineLimit(1).fontWeight(model.selectedCommit == commit.id ? .medium : .regular)
                                if !commit.refs.isEmpty { Text(commit.refs).font(.system(size: 10)).foregroundStyle(Color(nsColor: WorkbenchPalette.accent)).lineLimit(1) }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            Text(commit.author).lineLimit(1).frame(width: 90, alignment: .leading)
                            Text(String(commit.oid.prefix(8))).font(.system(size: 11, design: .monospaced)).frame(width: 76, alignment: .leading)
                            if size.width > 900 { Text(displayDate(commit.date)).lineLimit(1).frame(width: 110, alignment: .leading) }
                        }.frame(height: compact ? 33 : 43).contentShape(Rectangle()).tag(commit.oid)
                            .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 14))
                            .listRowBackground(model.selectedCommit == commit.oid ? Color(nsColor: WorkbenchPalette.selection) : .clear)
                    }
                }.listStyle(.plain).scrollContentBackground(.hidden).environment(\.defaultMinListRowHeight, compact ? 33 : 43)
                    .disabled(model.writing)
                    .overlay { if commits.isEmpty { Text(model.busy ? "正在读取历史…" : "没有匹配的提交").foregroundStyle(.secondary) } }
                if model.hasMoreHistory {
                    Button("加载更多提交") { model.loadHistory(reset: false) }.disabled(model.busy).buttonStyle(.plain).font(.caption).padding(8)
                }
            }.frame(height: max(200, min(330, size.height * 0.44))).workbenchCard().captureLayout("history-list")
            HStack(alignment: .top, spacing: 12) {
                commitDetails.frame(width: size.width < 1000 ? 210 : 270).frame(maxHeight: .infinity, alignment: .top).workbenchCard()
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text(selected?.subject ?? "提交差异").font(.system(size: 14, weight: .semibold)).lineLimit(1)
                        Spacer()
                        if (selected?.parents.count ?? 0) > 1 { Text("与第一个父提交比较").font(.caption).foregroundStyle(.secondary) }
                    }.padding(14)
                    Divider()
                    if let patch = model.commitPatch { PatchView(patch: patch) }
                    else { Text(model.busy ? "正在读取提交差异…" : "选择一条提交以阅读真实补丁")
                        .foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity).workbenchCard().captureLayout("history-patch")
            }.frame(maxHeight: .infinity)
        }
    }
    private var tableHeader: some View {
        HStack(spacing: 12) {
            Text("关系").frame(width: 32)
            Text("提交说明").frame(maxWidth: .infinity, alignment: .leading)
            Text("作者").frame(width: 90, alignment: .leading)
            Text("提交 ID").frame(width: 76, alignment: .leading)
            if size.width > 900 { Text("时间").frame(width: 110, alignment: .leading) }
        }.font(.system(size: 10, weight: .medium)).foregroundStyle(Color(nsColor: WorkbenchPalette.secondary))
            .padding(.leading, 10).padding(.trailing, 14).frame(height: 28)
    }
    private func ancestry(_ commit: CommitEntry, index: Int) -> some View {
        let previousLinked = index > 0 && commits[index - 1].parents.contains(commit.oid)
        let nextLinked = index + 1 < commits.count && commit.parents.contains(commits[index + 1].oid)
        return GeometryReader { geometry in
            Path { path in
                if previousLinked { path.move(to: CGPoint(x: 16, y: 0)); path.addLine(to: CGPoint(x: 16, y: geometry.size.height / 2)) }
                if nextLinked { path.move(to: CGPoint(x: 16, y: geometry.size.height / 2)); path.addLine(to: CGPoint(x: 16, y: geometry.size.height)) }
            }.stroke(Color(nsColor: WorkbenchPalette.accent).opacity(0.65), lineWidth: 1.5)
            Circle().fill(Color(nsColor: WorkbenchPalette.accent)).frame(width: 7, height: 7)
                .position(x: 16, y: geometry.size.height / 2)
        }.frame(width: 32).accessibilityHidden(true)
    }
    private var commitDetails: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("提交信息").font(.system(size: 15, weight: .semibold))
                if let commit = selected {
                    Text(commit.subject).fontWeight(.medium).textSelection(.enabled)
                    Divider()
                    detail("作者", commit.author)
                    detail("时间", commit.date)
                    detail("提交 ID", commit.oid)
                    if !commit.parents.isEmpty { detail("父提交", commit.parents.map { String($0.prefix(12)) }.joined(separator: "\n")) }
                    if !commit.refs.isEmpty { detail("引用", commit.refs) }
                } else { Text("选择一条提交").foregroundStyle(.secondary) }
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func detail(_ name: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(name).font(.system(size: 10)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 11)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }
    private func displayDate(_ value: String) -> String {
        // Keep the source timestamp when it is not ISO8601; never invent relative age.
        guard let date = ISO8601DateFormatter().date(from: value) else { return value }
        return date.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour().minute())
    }
}
