import SwiftUI

struct RepositoryHomeView: View {
    @ObservedObject var model: WorkspaceModel
    @State private var query = ""
    @AppStorage(NativePreferences.compact) private var compact = true

    private var repositories: [Workspace] {
        model.recent.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.path.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("仓库").font(.system(size: 26, weight: .semibold))
                        Text("从最近打开的本地仓库继续工作。").foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(action: model.pickRepository) { Label("打开仓库…", systemImage: "folder.badge.plus") }
                        .disabled(model.writing)
                }
                if model.recent.isEmpty {
                    VStack(spacing: 14) {
                        Image(systemName: "folder").font(.system(size: 36, weight: .light)).foregroundStyle(Color(nsColor: WorkbenchPalette.accent))
                        Text("打开你的第一个仓库").font(.title3.weight(.semibold))
                        Text("选择一个已有的 Git 仓库，查看更改、阅读历史并准备提交。")
                            .foregroundStyle(.secondary).multilineTextAlignment(.center)
                        Button("选择本地仓库…", action: model.pickRepository).disabled(model.writing)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 60).padding(.horizontal, 24)
                    .workbenchCard()
                } else {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField("搜索仓库名称或路径", text: $query).textFieldStyle(.plain)
                            .accessibilityLabel("搜索仓库")
                        if !query.isEmpty {
                            Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.plain).help("清除搜索").accessibilityLabel("清除仓库搜索")
                        }
                    }
                    .padding(10).background(Color(nsColor: WorkbenchPalette.canvas).opacity(0.75), in: RoundedRectangle(cornerRadius: 8))
                    if repositories.isEmpty {
                        Text("没有匹配的仓库。试试其他名称或路径。")
                            .foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                            .padding(24).workbenchCard()
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 14)], spacing: 14) {
                            ForEach(Array(repositories.prefix(3))) { repository in
                                repositoryCard(repository)
                            }
                        }
                        recentList
                    }
                }
            }
            .padding(22)
        }
        .captureLayout("page-body")
    }

    private func repositoryCard(_ repository: Workspace) -> some View {
        Button { model.open(repository.path) } label: {
            VStack(alignment: .leading, spacing: 15) {
                HStack(spacing: 10) {
                    Image(systemName: "folder").font(.system(size: 21)).foregroundStyle(Color(nsColor: WorkbenchPalette.accent))
                    Text(repository.name).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 0)
                    if repository.id == model.workspace?.id { Text("当前").font(.caption).foregroundStyle(Color(nsColor: WorkbenchPalette.accent)) }
                }
                Text(repository.path).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                Divider()
                if let changes = model.changes, changes.workspace.id == repository.id {
                    HStack(spacing: 12) {
                        Label(changes.branch ?? "分离的 HEAD", systemImage: "arrow.triangle.branch").lineLimit(1)
                        Spacer(minLength: 0)
                        Text(changes.files.isEmpty ? "工作区干净" : "\(Set(changes.files.map(\.path)).count) 个更改文件")
                            .foregroundStyle(.secondary)
                    }
                    .font(.caption)
                } else {
                    Label(repository.trusted ? "已信任的仓库" : "尚未信任", systemImage: repository.trusted ? "checkmark.shield" : "shield")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(model.writing)
        .workbenchCard()
        .help("打开 \(repository.path)")
        .accessibilityLabel("打开仓库 \(repository.name)，\(repository.path)")
    }

    private var recentList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("最近打开").font(.headline)
                Text("\(repositories.count)").foregroundStyle(.secondary)
                Spacer()
            }.padding(18)
            ForEach(repositories) { repository in
                Divider().padding(.horizontal, 18)
                Button { model.open(repository.path) } label: {
                    HStack(spacing: 14) {
                        Image(systemName: "folder").foregroundStyle(Color(nsColor: WorkbenchPalette.accent))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(repository.name).fontWeight(.medium).lineLimit(1)
                            Text(repository.path).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer()
                        if repository.id == model.workspace?.id { Text("当前仓库").font(.caption).foregroundStyle(.secondary) }
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 18).padding(.vertical, compact ? 11 : 17)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.writing).help(repository.path)
            }
        }
        .workbenchCard()
    }
}

struct BranchesView: View {
    @ObservedObject var model: WorkspaceModel
    @State private var query = ""
    @State private var remote = false
    @AppStorage(NativePreferences.compact) private var compact = true

    private var visibleBranches: [BranchEntry] {
        model.branches.filter { $0.remote == remote && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)) }
    }
    private var selected: BranchEntry? { model.branches.first { $0.id == model.selectedBranch } }

    var body: some View {
        GeometryReader { geometry in
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("分支").font(.system(size: 25, weight: .semibold))
                    Text("\(model.branches.count)").foregroundStyle(.secondary)
                    Spacer()
                    Label("只读浏览", systemImage: "eye").font(.caption).foregroundStyle(.secondary)
                    Button(action: model.loadBranches) { Label("刷新", systemImage: "arrow.clockwise") }
                        .disabled(model.busy || model.workspace == nil)
                }
                if geometry.size.width >= 740 {
                    HStack(alignment: .top, spacing: 16) {
                        branchList.frame(maxWidth: .infinity, maxHeight: .infinity)
                        ScrollView { branchDetails }.frame(width: 280)
                    }
                } else {
                    ScrollView {
                        VStack(spacing: 16) {
                            branchList.frame(minHeight: 300, maxHeight: 440)
                            branchDetails
                        }
                    }
                }
            }
            .padding(20)
        }
        .captureLayout("page-body")
        .onAppear { remote = selected?.remote ?? false }
    }

    private var branchList: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("筛选分支", text: $query).textFieldStyle(.plain).accessibilityLabel("筛选分支")
            }
            .padding(9).background(Color(nsColor: WorkbenchPalette.canvas).opacity(0.75), in: RoundedRectangle(cornerRadius: 8))
            Picker("分支范围", selection: $remote) {
                Text("本地 \(model.branches.filter { !$0.remote }.count)").tag(false)
                Text("远程 \(model.branches.filter(\.remote).count)").tag(true)
            }
            .pickerStyle(.segmented)
            .onChange(of: remote) { value in
                let matching = model.branches.filter { $0.remote == value }
                if !matching.contains(where: { $0.id == model.selectedBranch }) {
                    model.selectedBranch = matching.first(where: \.current)?.id ?? matching.first?.id
                }
            }
            Divider()
            if !model.branchesLoaded && model.busy {
                ProgressView("正在读取分支…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !model.branchesLoaded {
                Text("分支尚未载入。点击刷新重试。")
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if visibleBranches.isEmpty {
                Text(query.isEmpty ? (remote ? "没有本地缓存的远程分支。" : "还没有本地分支；首次提交后即可查看。") : "没有匹配的分支。")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).padding(20)
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(visibleBranches) { branch in
                            Button { model.selectedBranch = branch.id } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "arrow.triangle.branch").foregroundStyle(Color(nsColor: WorkbenchPalette.accent))
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack(spacing: 8) {
                                            Text(branch.name).fontWeight(.medium).lineLimit(1).truncationMode(.middle)
                                            if branch.current { Text("当前").font(.caption).foregroundStyle(Color(nsColor: WorkbenchPalette.accent)) }
                                        }
                                        Text(String(branch.oid.prefix(10))).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, 12).padding(.vertical, compact ? 11 : 16)
                                .background(model.selectedBranch == branch.id ? Color(nsColor: WorkbenchPalette.selection) : .clear, in: RoundedRectangle(cornerRadius: 8))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).help(branch.id)
                            .accessibilityLabel("\(branch.name)\(branch.current ? "，当前分支" : "")")
                        }
                    }
                }
            }
        }
        .padding(16).workbenchCard()
    }

    private var branchDetails: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 16) {
                if let branch = selected {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 25, weight: .light)).foregroundStyle(Color(nsColor: WorkbenchPalette.accent))
                    Text(branch.name).font(.system(size: 20, weight: .semibold)).textSelection(.enabled)
                    HStack {
                        Text(branch.remote ? "远程跟踪引用" : "本地分支").foregroundStyle(.secondary)
                        if branch.current { Text("当前分支").foregroundStyle(Color(nsColor: WorkbenchPalette.accent)) }
                    }.font(.caption)
                    Divider()
                    VStack(alignment: .leading, spacing: 7) {
                        Text("提交 ID").font(.caption).foregroundStyle(.secondary)
                        Text(branch.oid).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                    VStack(alignment: .leading, spacing: 7) {
                        Text("引用").font(.caption).foregroundStyle(.secondary)
                        Text(branch.id).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                    if branch.remote {
                        Text("此处显示本地已知的远程引用，刷新不会连接远程仓库。")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Text("选择一个分支").font(.headline)
                    Text("在左侧查看本地与远程引用。")
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(20).frame(maxWidth: .infinity, alignment: .leading).workbenchCard()
            if let changes = model.changes {
                VStack(alignment: .leading, spacing: 14) {
                    Text("当前工作区").font(.headline)
                    Label(changes.branch ?? "分离的 HEAD", systemImage: "arrow.triangle.branch").lineLimit(2)
                    Text(changes.files.isEmpty ? "没有未提交的更改。" : "\(Set(changes.files.map(\.path)).count) 个文件有未提交的更改。")
                        .foregroundStyle(.secondary)
                    Button("查看本地更改") { model.mode = "changes" }.disabled(model.writing)
                }
                .padding(20).frame(maxWidth: .infinity, alignment: .leading).workbenchCard()
            }
        }
    }
}

struct NativeSettingsView: View {
    @ObservedObject var model: WorkspaceModel
    @AppStorage(NativePreferences.appearance) private var appearance = "system"
    @AppStorage(NativePreferences.compact) private var compact = true
    @AppStorage(NativePreferences.restoreSidebar) private var restoreSidebar = true
    @AppStorage(NativePreferences.codeFontSize) private var codeFontSize = 14.0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("偏好设置").font(.system(size: 26, weight: .semibold))
                VStack(alignment: .leading, spacing: 0) {
                    sectionTitle("外观", subtitle: "选择适合你的阅读环境。")
                    settingRow("主题", detail: "跟随系统，或为 Proof 单独选择外观。") {
                        Picker("主题", selection: $appearance) {
                            Text("跟随系统").tag("system")
                            Text("浅色").tag("light")
                            Text("深色").tag("dark")
                        }.labelsHidden().pickerStyle(.segmented).frame(width: 250)
                    }
                    Divider()
                    settingRow("界面密度", detail: "调整导航与列表的留白。") {
                        Picker("界面密度", selection: $compact) {
                            Text("舒适").tag(false)
                            Text("紧凑").tag(true)
                        }.labelsHidden().pickerStyle(.segmented).frame(width: 190)
                    }
                }.padding(20).workbenchCard()

                VStack(alignment: .leading, spacing: 0) {
                    sectionTitle("工作区", subtitle: "保留熟悉的导航方式。")
                    settingRow("记住侧边栏状态", detail: "下次启动时，恢复侧边栏的展开或收起状态。") {
                        Toggle("记住侧边栏状态", isOn: $restoreSidebar).labelsHidden().toggleStyle(.switch)
                            .onChange(of: restoreSidebar) { enabled in
                                if enabled { model.setSidebarVisible(model.sidebarVisible) }
                            }
                    }
                }.padding(20).workbenchCard()

                VStack(alignment: .leading, spacing: 0) {
                    sectionTitle("代码阅读", subtitle: "更改立即应用于差异与原始补丁。")
                    settingRow("代码字号", detail: "使用 macOS 系统等宽字体。") {
                        HStack(spacing: 12) {
                            Text("\(Int(codeFontSize)) pt").monospacedDigit().frame(width: 44)
                            Stepper("代码字号", value: $codeFontSize, in: 11...18, step: 1).labelsHidden()
                        }
                    }
                    Divider()
                    Text("let reviewed = changes.filter { $0.isReviewed }\n// 看清变化，认真审查。")
                        .font(.system(size: CGFloat(codeFontSize), design: .monospaced))
                        .foregroundStyle(Color(nsColor: WorkbenchPalette.text))
                        .lineSpacing(6).padding(.top, 18).frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel("代码字体预览，\(Int(codeFontSize)) 磅")
                }.padding(20).workbenchCard()
                Text("设置仅保存在此 Mac 的 Proof Native 中。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: 1000, alignment: .leading).padding(24).frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .captureLayout("page-body")
    }

    private func sectionTitle(_ title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.headline)
            Text(subtitle).font(.caption).foregroundStyle(.secondary)
        }.padding(.bottom, 14)
    }

    private func settingRow<Control: View>(_ title: String, detail: String, @ViewBuilder control: () -> Control) -> some View {
        HStack(spacing: 24) {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).fontWeight(.medium)
                Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            control()
        }.padding(.vertical, 13)
    }
}
