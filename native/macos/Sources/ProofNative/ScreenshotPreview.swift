import AppKit
import SwiftUI
import ScreenCaptureKit

/// Deterministic native rendering for CI. Never opens a repository or starts the bridge.
@MainActor
enum ScreenshotPreview {
    private static var captureStarted = false
    static var outputDirectory: URL? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--capture-preview"), args.indices.contains(index + 1) else { return nil }
        return URL(fileURLWithPath: args[index + 1], isDirectory: true)
    }

    static var themeName: String {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--preview-theme"), args.indices.contains(index + 1) else { return "light" }
        return args[index + 1] == "dark" ? "dark" : "light"
    }
    static var themeAppearance: NSAppearance.Name { themeName == "dark" ? .darkAqua : .aqua }
    static var colorScheme: ColorScheme? {
        outputDirectory == nil ? nil : (themeName == "dark" ? .dark : .light)
    }

    static func makeModel() -> WorkspaceModel {
        let model = WorkspaceModel()
        guard outputDirectory != nil else { return model }
        // One process per appearance: establish AppKit appearance before SwiftUI
        // creates any toolbar, text view or semantic-color-backed native surface.
        NSApplication.shared.appearance = NSAppearance(named: themeAppearance)
        let workspace = Workspace(id: "preview-only", name: "Proof", path: "/Preview/Proof", trusted: true)
        let files = [
            ChangedFile(path: "native/macos/Sources/ProofNative/WorkspaceModel.swift", oldPath: nil, status: "M", side: "unstaged", conflicted: false),
            ChangedFile(path: "native/macos/Sources/ProofNative/WorkspaceView.swift", oldPath: nil, status: "M", side: "unstaged", conflicted: false),
            ChangedFile(path: "native/macos/Sources/ProofNative/DiffView.swift", oldPath: nil, status: "M", side: "unstaged", conflicted: false),
            ChangedFile(path: "native/macos/Tests/ReviewSnapshotTests.swift", oldPath: nil, status: "A", side: "unstaged", conflicted: false),
            ChangedFile(path: "crates/proof-core/src/review.rs", oldPath: nil, status: "M", side: "staged", conflicted: false),
            ChangedFile(path: "docs/REVIEW-WORKFLOW.md", oldPath: nil, status: "M", side: "staged", conflicted: false)
        ]
        model.workspace = workspace
        model.changes = Changes(workspace: workspace, head: "preview", branch: "feature/content-bound-review", operation: nil, token: "preview", files: files)
        model.selectedFile = files[0].id
        let first: [(String, String)] = [
            ("context", "    func loadFile() {"),
            ("context", "        guard let workspace, let file = selectedChange else { return }"),
            ("context", ""),
            ("delete", "        Task {"),
            ("delete", "            diff = try await bridge.readDiff(file)"),
            ("add", "        // A newer selection must never receive an older response."),
            ("add", "        let selection = file.id"),
            ("add", "        run(\"Reading changes\") {"),
            ("add", "            let snapshot = try await self.bridge.readDiff(file)"),
            ("add", "            try Task.checkCancellation()"),
            ("add", "            guard self.selectedFile == selection else { return }"),
            ("add", "            self.diff = snapshot"),
            ("context", "        }"),
            ("context", "    }"),
            ("context", "")
        ]
        let second: [(String, String)] = [
            ("context", "    func markReviewed() {"),
            ("context", "        guard let diff else { return }"),
            ("context", ""),
            ("delete", "        reviewStore.markReviewed(path: diff.path)"),
            ("add", "        // Human review belongs to this exact content, not the path."),
            ("add", "        run(\"Saving review\", write: true) {"),
            ("add", "            try await self.bridge.review(snapshot: diff.id)"),
            ("add", "            self.status = \"Review saved for this version\""),
            ("add", "        }"),
            ("context", "    }")
        ]
        func hunk(_ id: String, _ source: [(String, String)], old: Int, new: Int) -> Hunk {
            var oldLine = old, newLine = new
            let lines = source.map { kind, content -> DiffLine in
                let line = DiffLine(kind: kind, content: content, oldLine: kind == "add" ? nil : oldLine, newLine: kind == "delete" ? nil : newLine)
                if kind != "add" { oldLine += 1 }
                if kind != "delete" { newLine += 1 }
                return line
            }
            return Hunk(id: id, header: "@@ -\(old),\(oldLine - old) +\(new),\(newLine - new) @@", lines: lines, reviewState: "unread")
        }
        let hunks = [hunk("preview-1", first, old: 84, new: 84), hunk("preview-2", second, old: 126, new: 131)]
        let patch = hunks.map { hunk in
            hunk.header + "\n" + hunk.lines.map { ($0.kind == "add" ? "+" : $0.kind == "delete" ? "-" : " ") + $0.content }.joined(separator: "\n")
        }.joined(separator: "\n")
        model.diff = FileDiff(id: "preview-snapshot", path: files[0].path, side: "unstaged", base: "HEAD", patch: patch, hunks: hunks, additions: 12, deletions: 3, kind: "text", notice: nil, canStage: true)
        model.status = "Preview · illustrative repository · no Git operations"
        return model
    }

    static func capture(window sourceWindow: NSWindow) async {
        guard !captureStarted, let directory = outputDirectory else { return }
        captureStarted = true
        do {
            // Let SwiftUI finish installing its scene, safe areas and toolbar.
            try await Task.sleep(nanoseconds: 1_000_000_000)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            // Keep the scene-owned window: moving its toolbar into another window
            // breaks SwiftUI validation and loses the system's glass integration.
            let window = sourceWindow
            window.appearance = NSAppearance(named: themeAppearance)
            NSApp.setActivationPolicy(.regular)
            // Use the runner's real usable screen rather than an offscreen clone.
            let visible = window.screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let height = min(900, visible.height)
            window.setFrame(NSRect(x: visible.minX, y: visible.minY, width: 1440, height: height), display: true)
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            for (name, appearance) in [(themeName, themeAppearance)] {
                window.appearance = NSAppearance(named: appearance)
                try await Task.sleep(nanoseconds: 600_000_000)
                window.makeFirstResponder(nil)
                guard let view = window.contentView?.superview else { throw CaptureError.noView }
                view.layoutSubtreeIfNeeded()
                view.displayIfNeeded()
                guard #available(macOS 14.0, *) else { throw CaptureError.requiresScreenCaptureKit }
                // Capture the WindowServer-composited native window. cacheDisplay and
                // ImageRenderer omit GPU-composited glass and are not visual evidence.
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                guard let capturedWindow = content.windows.first(where: { $0.windowID == CGWindowID(window.windowNumber) }) else {
                    throw CaptureError.noWindow
                }
                let filter = SCContentFilter(desktopIndependentWindow: capturedWindow)
                let configuration = SCStreamConfiguration()
                configuration.width = Int(window.frame.width)
                configuration.height = Int(window.frame.height)
                configuration.showsCursor = false
                configuration.ignoreShadowsSingleWindow = true
                configuration.ignoreGlobalClipSingleWindow = true
                print("Scene window frame: \(window.frame); key=\(window.isKeyWindow) active=\(NSApp.isActive); SDK capture is unscaled")
                let capturedImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                let bitmap = NSBitmapImageRep(cgImage: capturedImage)
                guard let png = bitmap.representation(using: .png, properties: [:]) else { throw CaptureError.noBitmap }
                try png.write(to: directory.appendingPathComponent("changes-\(name).png"))
                print("WindowServer ScreenCaptureKit: changes-\(name).png (\(bitmap.pixelsWide) × \(bitmap.pixelsHigh)); \(ProcessInfo.processInfo.operatingSystemVersionString)")

            }
            // Direct exit deliberately avoids normal app close prompts; no bridge exists.
            exit(EXIT_SUCCESS)
        } catch {
            fputs("Native preview capture failed: \(error)\n", stderr)
            exit(EXIT_FAILURE)
        }
    }
    private enum CaptureError: Error { case noView, noBitmap, noWindow, requiresScreenCaptureKit }
}

