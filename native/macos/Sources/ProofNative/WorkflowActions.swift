import SwiftUI

struct RepositorySyncControls: View {
    @ObservedObject var model: WorkspaceModel
    var compact = false
    var body: some View {
        Menu {
            if let state = model.remoteState {
                if state.remotes.isEmpty { Text("尚未配置远程仓库") }
                ForEach(state.remotes, id: \.self) { remote in
                    Button("获取 \(remote)…") { model.prepareSync("fetch", remote: remote) }
                }
                Divider()
                Button("拉取当前分支…") { model.prepareSync("pull") }
                    .disabled(state.upstream == nil)
                Button("推送当前分支…") { model.prepareSync("push") }
                    .disabled(state.upstream == nil)
                if let upstream = state.upstream { Text("\(upstream) · ↑\(state.ahead) ↓\(state.behind)") }
                else { Text("请先在 Git 中配置当前分支的上游") }
            } else {
                Button("读取远程状态") { model.refresh() }
            }
        } label: {
            if compact { Image(systemName: "arrow.up.arrow.down") }
            else { Label("同步", systemImage: "arrow.up.arrow.down") }
        }
        .menuStyle(.borderlessButton).fixedSize()
        .disabled(model.busy || model.workspace?.trusted != true)
        .help("获取、拉取或推送；先检查范围再确认执行")
    }
}

struct RepositoryOperationConfirmation: View {
    @ObservedObject var model: WorkspaceModel
    let preview: HistoryActionPreview
    private var title: String {
        switch preview.request.kind {
        case "switch": return "切换分支"
        case "fetch": return "获取远程更新"
        case "pull": return "拉取当前分支"
        case "push": return "推送当前分支"
        default: return "检查 Git 操作"
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.title2.weight(.semibold))
            Text(model.workspace?.path ?? "").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 9) {
                GridRow { Text("当前分支"); Text(preview.branch ?? "分离的 HEAD") }
                if let target = preview.request.target { GridRow { Text("目标"); Text(target).textSelection(.enabled) } }
                if let name = preview.request.name { GridRow { Text("本地分支"); Text(name) } }
                if let remote = preview.request.remote { GridRow { Text("远程"); Text(remote) } }
                if let upstream = preview.remoteBranch { GridRow { Text("远程分支"); Text(upstream) } }
                GridRow { Text("未提交文件"); Text("\(preview.dirtyFiles)") }
            }.font(.system(size: 13))
            Text("git " + preview.arguments.joined(separator: " "))
                .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                .padding(12).frame(maxWidth: .infinity, alignment: .leading).workbenchInputSurface()
            Text(explanation).font(.callout).fixedSize(horizontal: false, vertical: true)
            Text("Core 会重新验证仓库状态；状态变化时拒绝执行。操作开始后不可取消，请等待结果。失败后先检查仓库状态，不自动重试。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("取消", role: .cancel) { model.cancelOperation() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("确认\(title)") { model.executeOperation() }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 540)
        .interactiveDismissDisabled(model.writing)
    }
    private var explanation: String {
        switch preview.request.kind {
        case "switch": return "这会更新工作区和当前分支。Git 将拒绝会覆盖未提交内容的切换；提交说明草稿会保留。"
        case "fetch": return "连接仓库配置的远程服务，下载对象并更新远程跟踪引用。可能使用此 Mac 已有的 Git 凭据。"
        case "pull": return "连接当前分支的上游，只允许快进更新；历史分叉时拒绝执行，不自动合并或 rebase。可能运行已信任仓库的 hooks。"
        case "push": return "将当前分支的提交及相关文件内容发送到配置的远程仓库。不会强制推送；可能使用已有 Git 凭据并运行 hooks。"
        default: return "请确认以上操作范围。"
        }
    }
}
