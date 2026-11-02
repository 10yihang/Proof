import AppKit
import SwiftUI

/// Deterministic native rendering for CI. Never opens a repository or starts the bridge.
@MainActor
enum ScreenshotPreview {
    private static var captureStarted = false
    static var outputDirectory: URL? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--capture-preview"), args.indices.contains(index + 1) else { return nil }
        return URL(fileURLWithPath: args[index + 1], isDirectory: true)
    }

    static func makeModel() -> WorkspaceModel {
        let model = WorkspaceModel()
        guard outputDirectory != nil else { return model }
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
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            // CI's virtual screen can be only 768 points tall. Preserve the actual
            // production content and toolbar, but remove screen-size clamping for
            // this offscreen-capable render window. Nothing is raster-scaled.
            let window = PreviewRenderWindow(
                contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                styleMask: sourceWindow.styleMask, backing: .buffered, defer: false
            )
            window.title = sourceWindow.title
            window.titleVisibility = sourceWindow.titleVisibility
            window.titlebarAppearsTransparent = sourceWindow.titlebarAppearsTransparent
            window.toolbarStyle = sourceWindow.toolbarStyle
            let toolbar = sourceWindow.toolbar
            sourceWindow.toolbar = nil
            let content = sourceWindow.contentView
            sourceWindow.contentView = nil
            window.contentView = content
            window.toolbar = toolbar
            sourceWindow.orderOut(nil)
            window.setFrame(NSRect(x: 0, y: 0, width: 1440, height: 900), display: true)
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
                window.appearance = NSAppearance(named: appearance)
                try await Task.sleep(nanoseconds: 600_000_000)
                guard let view = window.contentView?.superview else { throw CaptureError.noView }
                view.layoutSubtreeIfNeeded()
                view.displayIfNeeded()
                guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw CaptureError.noBitmap }
                view.cacheDisplay(in: view.bounds, to: bitmap)
                guard let png = bitmap.representation(using: .png, properties: [:]) else { throw CaptureError.noBitmap }
                try png.write(to: directory.appendingPathComponent("changes-\(name).png"))
                print("Native AppKit capture: changes-\(name).png (\(bitmap.pixelsWide) × \(bitmap.pixelsHigh))")
            }
            // Direct exit deliberately avoids normal app close prompts; no bridge exists.
            exit(EXIT_SUCCESS)
        } catch {
            fputs("Native preview capture failed: \(error)\n", stderr)
            exit(EXIT_FAILURE)
        }
    }
    private enum CaptureError: Error { case noView, noBitmap }
}

/// Only screenshot mode uses this window; normal app sizing remains native.
@MainActor
private final class PreviewRenderWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }
}
