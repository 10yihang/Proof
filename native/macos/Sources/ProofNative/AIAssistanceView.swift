import SwiftUI

/// User-triggered only. Selected paths are a focus, not a repository-read allowlist.
struct AIAssistanceView: View {
    @ObservedObject var model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var task = "review"
    @State private var provider = ""
    @State private var confirmSend = false
    @State private var confirmReplace = false
    @State private var consent: AIConsent?
    private var paths: [String] {
        task == "review" ? model.diff.map { [$0.path] } ?? [] : model.changes?.files.filter { $0.side == "staged" }.map(\.path) ?? []
    }
    private var selectedProvider: AgentProviderInfo? { model.aiProviders.first { $0.id == provider } }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("AI 辅助").font(.title2.weight(.semibold))
                Spacer()
                Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.aiRunning)
            }
            Picker("任务", selection: $task) {
                Text("评审当前文件").tag("review")
                Text("生成提交说明").tag("commit")
            }.pickerStyle(.segmented).disabled(model.busy)
            HStack {
                Picker("Agent", selection: $provider) {
                    Text("选择 Agent").tag("")
                    ForEach(model.aiProviders) { item in Text(item.name + (item.available ? "" : " · 不可用")).tag(item.id) }
                }.disabled(model.busy)
                Button("读取配置", action: model.loadAgentSettings).disabled(model.busy)
            }
            if let selectedProvider, !selectedProvider.available {
                Text(selectedProvider.reason ?? "请在设置中指定已安装、已登录的 Agent CLI。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(task == "review" ? "评审重点：当前选中文件" : "说明依据：当前已暂存文件")
                .font(.headline)
            ScrollView {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(paths, id: \.self) { Text($0).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                    if paths.isEmpty { Text("当前没有可分析的文件。带有冲突或不支持的差异将由 Core 拒绝。").foregroundStyle(.secondary) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 90).padding(10).workbenchInputSurface()
            Text("仅在确认后调用所选 Agent。它会实时读取整个仓库，可能包括未修改文件和被忽略的配置，并将相关代码、路径和上下文发送给其服务商。下列文件是分析重点，不是读取范围限制。请先移除凭据及不能发送的内容；使用已有登录和配额。不会自动修改代码、标记人工评审或提交。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                if model.aiRunning {
                    ProgressView().controlSize(.small)
                    Text(model.activity)
                    Spacer()
                    Button("取消分析", action: model.cancelRead)
                } else {
                    Button("检查并开始…") {
                        guard let workspace = model.workspace, let changes = model.changes, let selectedProvider else { return }
                        consent = AIConsent(workspace: workspace.id, path: workspace.path, token: changes.token, diff: task == "review" ? model.diff?.id : nil, task: task, provider: provider, providerName: selectedProvider.name, paths: paths)
                        confirmSend = true
                    }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy || paths.isEmpty || selectedProvider?.available != true || model.workspace?.trusted != true)
                    Spacer()
                }
            }
            if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            Divider()
            ScrollView { reportContent }.frame(minHeight: 160, maxHeight: 300)
        }
        .padding(24).frame(width: 650)
        .onAppear { provider = model.agentSettings?.defaultProvider ?? ""; model.loadAgentSettings() }
        .onChange(of: model.agentSettings?.defaultProvider) { value in if provider.isEmpty { provider = value ?? "" } }
        .interactiveDismissDisabled(model.aiRunning)
        .alert("向 \(consent?.providerName ?? "Agent") 发送代码进行分析？", isPresented: $confirmSend) {
            Button("取消", role: .cancel) {}
            Button("发送并分析") {
                guard let consent, consent.workspace == model.workspace?.id, consent.token == model.changes?.token,
                      consent.task != "review" || consent.diff == model.diff?.id else {
                    model.error = "仓库或分析范围已改变，请重新检查并确认。"; return
                }
                if consent.task == "review" { model.requestAIReview(provider: consent.provider) }
                else { model.generateCommitMessage(provider: consent.provider) }
            }
        } message: { Text("\(consent?.path ?? "")\n\((consent?.paths ?? []).joined(separator: "\n"))\n\n上述文件是分析重点。Agent 可以读取整个实时仓库，包括相关未修改文件和被忽略的配置，并向其服务商发送上下文。请先移除凭据及不能发送的信息，确认此仓库适合该访问范围。可能产生配额或费用。") }
        .alert("用 AI 建议替换当前提交说明？", isPresented: $confirmReplace) {
            Button("继续编辑", role: .cancel) {}
            Button("使用建议") { model.applySuggestedCommitMessage() }
        } message: { Text("只替换本地草稿，不会执行提交。") }
    }
    @ViewBuilder private var reportContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let report = model.aiReport {
                Text("最近结果 · \(report.provider)").font(.headline)
                if let review = report.review {
                    Text(review.summary).textSelection(.enabled)
                    Text("风险：\(review.overallRisk)").font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(review.findings.enumerated()), id: \.offset) { _, finding in
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(finding.severity) · \(finding.title)").fontWeight(.semibold)
                            Text("\(finding.file):\(finding.line) · \(finding.lineSide)").font(.caption).foregroundStyle(.secondary)
                            Text(finding.description).textSelection(.enabled)
                            if !finding.suggestion.isEmpty { Text(finding.suggestion).textSelection(.enabled) }
                        }.padding(12).workbenchInputSurface()
                    }
                    reportList("行为变化", review.behaviorChanges)
                    reportList("建议补充测试", review.missingTests)
                    reportList("优先检查", review.reviewPriority)
                }
                if let message = report.commitMessage {
                    Text(message).textSelection(.enabled).padding(12).workbenchInputSurface()
                    Button("使用这份提交说明…") { confirmReplace = true }
                        .disabled(model.busy || model.suggestedCommitMessage == nil)
                }
                reportList("分析限制", report.limitations)
            } else {
                Text("尚未运行分析。AI 结果只是建议，不能替代人工审查。")
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    @ViewBuilder private func reportList(_ title: String, _ items: [String]) -> some View {
        if !items.isEmpty {
            Text(title).font(.headline)
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in Text("• " + item).textSelection(.enabled) }
        }
    }
}

struct NativeAgentSettings: View {
    @ObservedObject var model: WorkspaceModel
    @State private var provider = "codex"
    @State private var executable = ""
    @State private var modelName = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("AI Agent").font(.headline); Spacer(); Button("读取配置", action: model.loadAgentSettings).disabled(model.busy) }
            Text("仅配置本机已安装的 CLI。不会自动安装、登录或运行分析；不读取或保存 API 密钥。")
                .font(.caption).foregroundStyle(.secondary)
            Picker("服务", selection: $provider) {
                Text("Codex").tag("codex"); Text("Claude Code").tag("claude_code")
                Text("Codewiz").tag("codewiz"); Text("OCR").tag("ocr")
            }.onChange(of: provider) { _ in loadFields() }
            TextField("CLI 完整路径（留空自动查找）", text: $executable)
            TextField("模型名称（留空使用 CLI 默认值）", text: $modelName)
            HStack {
                Button("保存并设为默认 Agent") {
                    guard var settings = model.agentSettings else { return }
                    let options = AgentOptions(executablePath: executable.isEmpty ? nil : executable, model: modelName.isEmpty ? nil : modelName)
                    switch provider { case "claude_code": settings.claudeCode = options; case "codewiz": settings.codewiz = options; case "ocr": settings.ocr = options; default: settings.codex = options }
                    settings.defaultProvider = provider
                    model.saveAgentSettings(settings)
                }.disabled(model.busy || model.agentSettings == nil)
                Spacer()
                if let item = model.aiProviders.first(where: { $0.id == provider }) {
                    Text(item.available ? "可用" : "未就绪").foregroundStyle(.secondary)
                        .help(item.reason ?? item.path ?? "")
                }
            }
        }.padding(20).workbenchCard()
        .onAppear { if ScreenshotPreview.outputDirectory == nil { model.loadAgentSettings() } }
        .onChange(of: model.agentSettings?.revision) { _ in loadFields() }
    }
    private func loadFields() {
        guard let settings = model.agentSettings else { return }
        let options: AgentOptions
        switch provider { case "claude_code": options = settings.claudeCode; case "codewiz": options = settings.codewiz; case "ocr": options = settings.ocr; default: options = settings.codex }
        executable = options.executablePath ?? ""; modelName = options.model ?? ""
    }
}

private struct AIConsent {
    let workspace: String
    let path: String
    let token: String
    let diff: String?
    let task: String
    let provider: String
    let providerName: String
    let paths: [String]
}
