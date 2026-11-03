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

    static var pageName: String {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--preview-page"), args.indices.contains(index + 1) else { return "changes" }
        let page = args[index + 1]
        precondition(["changes", "history", "branches", "repositories", "settings"].contains(page), "Unknown preview page: \(page)")
        return page
    }

    static var sidebarCollapsed: Bool {
        ProcessInfo.processInfo.arguments.contains("--preview-collapsed")
    }

    static var captureName: String {
        "\(pageName)-\(themeName)-\(sizeName)" + (sidebarCollapsed ? "-collapsed" : "")
    }

    static var sizeName: String {
        ProcessInfo.processInfo.arguments.contains("--preview-wide") ? "wide" : "compact"
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
        let workspace = Workspace(id: "preview-only", name: "atlas-demo", path: "/Preview/atlas-demo", trusted: true)
        let files = [
            ChangedFile(path: "native/macos/Sources/ProofNative/WorkspaceModel.swift", oldPath: nil, status: "M", side: "unstaged", conflicted: false),
            ChangedFile(path: "native/macos/Sources/ProofNative/WorkspaceView.swift", oldPath: nil, status: "M", side: "unstaged", conflicted: false),
            ChangedFile(path: "native/macos/Sources/ProofNative/DiffView.swift", oldPath: nil, status: "M", side: "unstaged", conflicted: false),
            ChangedFile(path: "native/macos/Tests/ReviewSnapshotTests.swift", oldPath: nil, status: "A", side: "unstaged", conflicted: false),
            ChangedFile(path: "crates/proof-core/src/review.rs", oldPath: nil, status: "M", side: "staged", conflicted: false),
            ChangedFile(path: "docs/REVIEW-WORKFLOW.md", oldPath: nil, status: "M", side: "staged", conflicted: false)
        ]
        model.workspace = workspace
        model.recent = [
            workspace,
            Workspace(id: "preview-design", name: "design-system", path: "/Preview/design-system", trusted: false),
            Workspace(id: "preview-docs", name: "atlas-docs", path: "/Preview/atlas-docs", trusted: true)
        ]
        model.setSidebarVisible(!sidebarCollapsed, persist: false)
        model.mode = pageName
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
        model.loadedDiffs[files[0].id] = model.diff
        model.commits = [
            CommitEntry(oid: "f3a81d27c06bca8d45bc2c1c9426a2ddc723101a", parents: ["c9e42b687893f1f522d071aa621bb03e2181a4d2"], author: "Alex Chen", date: "2026-11-02T10:42:00Z", subject: "Keep review snapshots tied to file content", refs: "HEAD -> feature/content-bound-review"),
            CommitEntry(oid: "c9e42b687893f1f522d071aa621bb03e2181a4d2", parents: ["b2a71c091cca7cf02b9a65dfd903a6520a4d1728"], author: "Morgan Lee", date: "2026-11-02T09:18:00Z", subject: "Refine native workspace spacing and typography", refs: ""),
            CommitEntry(oid: "b2a71c091cca7cf02b9a65dfd903a6520a4d1728", parents: ["a8f03d567aa621bb03678a1a4d2718f522d071ab2"], author: "Alex Chen", date: "2026-11-01T16:35:00Z", subject: "Guard staged commits against changed snapshots", refs: "main"),
            CommitEntry(oid: "a8f03d567aa621bb03678a1a4d2718f522d071ab2", parents: ["e4c61f03c9426a2ddc723101a5bc2c1c27c06bca8"], author: "Sam Rivera", date: "2026-11-01T14:06:00Z", subject: "Add clear review coverage to the change list", refs: ""),
            CommitEntry(oid: "e4c61f03c9426a2ddc723101a5bc2c1c27c06bca8", parents: [], author: "Morgan Lee", date: "2026-10-31T11:24:00Z", subject: "Build the first native review workspace", refs: "v0.1.0")
        ]
        model.selectedCommit = model.commits[0].oid
        model.commitPatch = "diff --git a/\(files[0].path) b/\(files[0].path)\n--- a/\(files[0].path)\n+++ b/\(files[0].path)\n" + patch
        model.hasMoreHistory = true
        model.branches = [
            BranchEntry(name: "feature/content-bound-review", current: true, oid: model.commits[0].oid, remote: false),
            BranchEntry(name: "main", current: false, oid: model.commits[2].oid, remote: false),
            BranchEntry(name: "feature/native-workspace", current: false, oid: model.commits[1].oid, remote: false),
            BranchEntry(name: "origin/main", current: false, oid: model.commits[2].oid, remote: true),
            BranchEntry(name: "origin/feature/content-bound-review", current: false, oid: model.commits[0].oid, remote: true)
        ]
        model.selectedBranch = model.branches[0].id
        model.branchesLoaded = true
        model.status = "Preview · 演示数据，不执行 Git 操作"
        model.message = "fix: preserve content-bound review snapshots"
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
            // One capture-only request. Never change display configuration or normal app sizing.
            let requested = sizeName == "wide" ? NSSize(width: 1440, height: 900) : NSSize(width: 1024, height: 674)
            window.setFrame(NSRect(origin: window.frame.origin, size: requested), display: true)
            print("Requested preview size: \(requested); actual frame: \(window.frame)")
            NSApp.setActivationPolicy(.regular)
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            let name = captureName
            window.appearance = NSAppearance(named: themeAppearance)
            try await Task.sleep(nanoseconds: 600_000_000)
            window.makeFirstResponder(nil)
            guard let view = window.contentView?.superview else { throw CaptureError.noView }
            view.layoutSubtreeIfNeeded()
            view.displayIfNeeded()
            dumpNativeLayout(window)
            var layoutError: Error?
            do { try validatePreviewChrome(window) }
            catch { layoutError = error }
            // Keep visual evidence even when a geometry assertion fails, so the
            // full CI batch can be inspected and corrected together.
            guard #available(macOS 14.0, *) else { throw CaptureError.requiresScreenCaptureKit }
            // Capture the WindowServer-composited native window. cacheDisplay and
            // ImageRenderer omit GPU-composited glass and are not visual evidence.
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            guard let capturedWindow = content.windows.first(where: { $0.windowID == CGWindowID(window.windowNumber) }) else {
                throw CaptureError.noWindow
            }
            print("Shareable window frame: \(capturedWindow.frame)")
            let filter = SCContentFilter(desktopIndependentWindow: capturedWindow)
            let configuration = SCStreamConfiguration()
            configuration.width = Int(window.frame.width)
            configuration.height = Int(window.frame.height)
            configuration.showsCursor = false
            configuration.ignoreShadowsSingleWindow = true
            configuration.ignoreGlobalClipSingleWindow = true
            print("Scene window frame: \(window.frame); content=\(window.contentView?.frame ?? .zero); layout=\(window.contentLayoutRect); key=\(window.isKeyWindow) active=\(NSApp.isActive); SDK capture is unscaled")
            let capturedImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            let bitmap = NSBitmapImageRep(cgImage: capturedImage)
            guard let png = bitmap.representation(using: .png, properties: [:]) else { throw CaptureError.noBitmap }
            try png.write(to: directory.appendingPathComponent("sck-\(name).png"))
            let screenshot = Process()
            screenshot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            screenshot.arguments = ["-x", "-o", "-l", String(window.windowNumber), directory.appendingPathComponent("\(name).png").path]
            try screenshot.run()
            screenshot.waitUntilExit()
            guard screenshot.terminationStatus == 0 else { throw CaptureError.noBitmap }
            let evidence: [String: Any] = [
                "page": pageName, "theme": themeName, "size": sizeName,
                "sidebar": sidebarCollapsed ? "collapsed" : "expanded",
                "fixtureData": true, "bridgeStarted": false, "gitOperations": false,
                "geometryPassed": layoutError == nil,
                "geometryError": layoutError?.localizedDescription ?? "",
                "evidenceScope": "Native WindowServer rendering and geometry only; not interaction testing",
                "renderer": "screencapture and ScreenCaptureKit",
                "windowWidth": Int(window.frame.width), "windowHeight": Int(window.frame.height),
                "screenCaptureKitWidth": bitmap.pixelsWide, "screenCaptureKitHeight": bitmap.pixelsHigh,
                "operatingSystem": ProcessInfo.processInfo.operatingSystemVersionString
            ]
            try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])
                .write(to: directory.appendingPathComponent("\(name).json"))
            print("WindowServer capture: \(name).png; ScreenCaptureKit companion: sck-\(name).png (\(bitmap.pixelsWide) × \(bitmap.pixelsHigh)); \(ProcessInfo.processInfo.operatingSystemVersionString)")
            if let layoutError { throw layoutError }

            // Direct exit deliberately avoids normal app close prompts; no bridge exists.
            exit(EXIT_SUCCESS)
        } catch {
            fputs("Native preview capture failed: \(error)\n", stderr)
            exit(EXIT_FAILURE)
        }
    }
    private enum CaptureError: Error { case noView, noBitmap, noWindow, requiresScreenCaptureKit }
}


