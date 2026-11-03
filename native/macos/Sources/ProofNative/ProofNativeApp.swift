import AppKit
import SwiftUI

@main
@MainActor
struct ProofNativeApp: App {
    @StateObject private var model = ScreenshotPreview.makeModel()
    @AppStorage("proof.native.appearance") private var appearance = "system"
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene {
        Window("Proof Native", id: "main") {
            WorkspaceView(model: model)
                .preferredColorScheme(ScreenshotPreview.colorScheme ?? (appearance == "light" ? .light : appearance == "dark" ? .dark : nil))
                .frame(minWidth: 1000, minHeight: 560, alignment: .topLeading)
                .task {
                    // Preserve the window title for accessibility and Window menus;
                    // the unified toolbar already presents repository identity.
                    NSApp.windows.first?.titleVisibility = .hidden
                    if ScreenshotPreview.outputDirectory != nil {
                        if let window = NSApp.windows.first {
                            // Capture outlives the view task when its hosting view moves windows.
                            Task { await ScreenshotPreview.capture(window: window) }
                        }
                        return
                    }
                    delegate.model = model
                    NSApp.windows.first?.delegate = delegate
                    model.start()
                }
        }
        .defaultSize(width: 1440, height: 900)
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("打开仓库…") { model.pickRepository() }.keyboardShortcut("o")
                    .disabled(model.writing)
            }
            CommandGroup(after: .toolbar) {
                Button("刷新仓库") { model.refresh() }.keyboardShortcut("r")
                    .disabled(model.workspace == nil || model.busy)
            }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    weak var model: WorkspaceModel?
    private var approvedClose = false
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        let allowed = applicationShouldTerminate(NSApp) == .terminateNow
        approvedClose = allowed
        return allowed
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if approvedClose { return .terminateNow }
        if model?.writing == true {
            let alert = NSAlert()
            alert.messageText = "Git 或评审操作仍在运行"
            alert.informativeText = "请等待操作完成后退出，不要中断 Git 写操作。"
            alert.runModal()
            return .terminateCancel
        }
        if let model, !model.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let alert = NSAlert()
            alert.messageText = "放弃提交信息草稿？"
            alert.addButton(withTitle: "继续编辑"); alert.addButton(withTitle: "退出")
            guard alert.runModal() == .alertSecondButtonReturn else { return .terminateCancel }
        }
        model?.cancelRead(); model?.bridge.stop()
        return .terminateNow
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

