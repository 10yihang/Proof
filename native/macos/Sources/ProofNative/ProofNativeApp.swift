import AppKit
import SwiftUI

@main
@MainActor
struct ProofNativeApp: App {
    @StateObject private var model = ScreenshotPreview.makeModel()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene {
        Window("Proof Native", id: "main") {
            WorkspaceView(model: model)
                .preferredColorScheme(ScreenshotPreview.colorScheme)
                .frame(minWidth: 1000, minHeight: 680)
                .task {
                    if let window = NSApp.windows.first {
                        // VStack column headers are document content, not titlebar
                        // accessories. Let AppKit reserve its actual toolbar height;
                        // the system still owns the transparent unified chrome.
                        window.styleMask.remove(.fullSizeContentView)
                        window.titlebarAppearsTransparent = true
                        window.titlebarSeparatorStyle = .none
                    }
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
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Open Repository…") { model.pickRepository() }.keyboardShortcut("o")
                    .disabled(model.writing)
            }
            CommandGroup(after: .toolbar) {
                Button("Refresh Repository") { model.refresh() }.keyboardShortcut("r")
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
            alert.messageText = "A Git or review operation is still running"
            alert.informativeText = "Wait for it to finish before quitting. Do not interrupt a Git write."
            alert.runModal()
            return .terminateCancel
        }
        if let model, !model.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let alert = NSAlert()
            alert.messageText = "Discard the commit message draft?"
            alert.addButton(withTitle: "Keep Working"); alert.addButton(withTitle: "Quit")
            guard alert.runModal() == .alertSecondButtonReturn else { return .terminateCancel }
        }
        model?.cancelRead(); model?.bridge.stop()
        return .terminateNow
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
