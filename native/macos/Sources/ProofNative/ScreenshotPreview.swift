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

    static var forceReducedTransparency: Bool {
        ProcessInfo.processInfo.arguments.contains("--preview-reduced-transparency")
    }

    static var fileList: Bool { ProcessInfo.processInfo.arguments.contains("--preview-file-list") }
    static var fileScope: String {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--preview-file-scope"), args.indices.contains(index + 1) else { return "all" }
        let scope = args[index + 1]
        precondition(["all", "unstaged", "staged"].contains(scope))
        return scope
    }

    /// Explicit preview-only fixture. This is another real window, never app content.
    static var backdropName: String? {
        guard outputDirectory != nil else { return nil }
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--preview-backdrop") else { return nil }
        precondition(args.indices.contains(index + 1), "--preview-backdrop requires A or B")
        let name = args[index + 1].uppercased()
        precondition(["A", "B"].contains(name), "Unknown preview backdrop: \(name)")
        return name
    }

    static var captureName: String {
        "\(pageName)-\(themeName)-\(sizeName)" + (sidebarCollapsed ? "-collapsed" : "") + (forceReducedTransparency ? "-reduced" : "") + (fileList ? "-\(fileScope)-list" : "") + (backdropName.map { "-backdrop-\($0)" } ?? "")
    }

    static var sizeName: String {
        // Behind-window comparison needs the complete app on the real display.
        // Ordinary wide/off-screen layout captures retain their existing behavior.
        backdropName == nil && ProcessInfo.processInfo.arguments.contains("--preview-wide") ? "wide" : "compact"
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
            // Ordinary previews retain their off-screen framing. The optional
            // backdrop comparison instead fits a compact app on the actual display.
            // Both modes use the same live content and production titlebar styling.
            let requested = sizeName == "wide" ? NSSize(width: 1440, height: 900) : NSSize(width: 1024, height: 674)
            let backdrop = backdropName.flatMap { makeBackdrop(named: $0, requested: requested) }
            let window = PreviewWindow(contentRect: NSRect(origin: .zero, size: requested),
                                       styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                                       backing: .buffered, defer: false)
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.isOpaque = false
            window.backgroundColor = .clear
            window.isMovableByWindowBackground = true
            window.appearance = NSAppearance(named: themeAppearance)
            let liveContent = sourceWindow.contentView
            sourceWindow.contentView = nil
            window.contentView = liveContent
            sourceWindow.orderOut(nil)
            window.setFrame(backdrop?.appFrame ?? NSRect(origin: .zero, size: requested), display: true)
            print("Requested preview size: \(requested); actual frame: \(window.frame)")
            NSApp.setActivationPolicy(.regular)
            window.makeKeyAndOrderFront(nil)
            // Keep two independent WindowServer surfaces. Adding a patterned view
            // inside the app would only imitate transparency and is not evidence.
            backdrop?.window.order(.below, relativeTo: window.windowNumber)
            NSApp.activate(ignoringOtherApps: true)
            let name = captureName
            window.appearance = NSAppearance(named: themeAppearance)
            try await Task.sleep(nanoseconds: 600_000_000)
            window.makeFirstResponder(nil)
            guard let view = window.contentView?.superview else { throw CaptureError.noView }
            view.layoutSubtreeIfNeeded()
            alignNativeWindowButtons(window)
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
            var backdropEvidence: [String: Any] = ["requested": backdropName != nil, "id": backdropName ?? "none"]
            if let backdrop {
                backdropEvidence = await captureBackdrop(backdrop, appWindow: capturedWindow,
                                                         liveAppWindow: window, content: content, directory: directory, name: name)
                backdropEvidence["appWindowPixelSamples"] = pixelSamples(capturedImage,
                    appFrame: NSRect(origin: .zero, size: window.frame.size), captureSize: window.frame.size)
            } else if backdropName != nil {
                backdropEvidence["limitation"] = "No display available; app-window capture alone does not verify behind-window compositing."
            }
            let evidence: [String: Any] = [
                "page": pageName, "theme": themeName, "size": sizeName,
                "captureName": name, "previewBackdrop": backdropName ?? "none",
                "diagnosticBackdrop": backdropEvidence,
                "fileScope": fileScope, "fileLayout": fileList ? "list" : "tree",
                "sidebar": sidebarCollapsed ? "collapsed" : "expanded",
                "fixtureData": true, "bridgeStarted": false, "gitOperations": false,
                "geometryPassed": layoutError == nil,
                "geometryError": layoutError?.localizedDescription ?? "",
                "evidenceScope": "Native WindowServer rendering and geometry only; not interaction testing",
                "renderer": "screencapture and ScreenCaptureKit",
                "windowWidth": Int(window.frame.width), "windowHeight": Int(window.frame.height),
                "screenCaptureKitWidth": bitmap.pixelsWide, "screenCaptureKitHeight": bitmap.pixelsHigh,
                "systemReduceTransparency": NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency,
                "forcedReducedTransparency": forceReducedTransparency,
                "materialScope": "Workspace: native behind-window material with uniform blue tint, opaque when reduced transparency; other pages flat; content cards solid without shadows",
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
    private struct BackdropSetup {
        let name: String
        let window: NSWindow
        let screen: NSScreen
        let appFrame: NSRect
        let fitsDisplay: Bool
    }

    private static func makeBackdrop(named name: String, requested: NSSize) -> BackdropSetup? {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return nil }
        // Leave a 48pt labeled strip above the app. Never shrink below the existing
        // 1000pt app minimum or the 600pt capture checks to manufacture a passing fit.
        let visible = screen.visibleFrame
        let width = min(requested.width + 48, floor(visible.width))
        let height = min(requested.height + 64, floor(visible.height))
        let frame = NSRect(x: floor(visible.midX - width / 2), y: floor(visible.midY - height / 2),
                           width: width, height: height)
        let appSize = NSSize(width: min(requested.width, width), height: min(requested.height, height - 48))
        let fitsDisplay = appSize.width >= 1000 && appSize.height >= 600
        let appFrame = NSRect(origin: NSPoint(x: floor(frame.midX - (fitsDisplay ? appSize.width : requested.width) / 2),
                                               y: frame.minY), size: fitsDisplay ? appSize : requested)
        let window = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.title = "诊断背景 \(name)"
        window.isReleasedWhenClosed = false
        window.isOpaque = true
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.backgroundColor = .white
        window.contentView = PreviewBackdropView(name: name, frame: NSRect(origin: .zero, size: frame.size))
        window.orderFront(nil)
        window.contentView?.displayIfNeeded()
        print("Diagnostic backdrop \(name): independent window=\(window.windowNumber), frame=\(frame), app=\(appFrame), fitsDisplay=\(fitsDisplay)")
        return BackdropSetup(name: name, window: window, screen: screen, appFrame: appFrame, fitsDisplay: fitsDisplay)
    }

    @available(macOS 14.0, *)
    private static func captureBackdrop(_ backdrop: BackdropSetup, appWindow: SCWindow,
                                        liveAppWindow: NSWindow, content: SCShareableContent,
                                        directory: URL, name: String) async -> [String: Any] {
        var evidence: [String: Any] = [
            "requested": true, "id": backdrop.name, "separateNativeWindow": true,
            "patternInsideApp": false, "fixtureChangesSystemSettings": false,
            "screenBoundedApp": backdrop.fitsDisplay, "compositeCaptured": false,
            "appFrame": NSStringFromRect(liveAppWindow.frame),
            "appWindowID": liveAppWindow.windowNumber, "backdropWindowID": backdrop.window.windowNumber,
            "appIsKeyWindow": liveAppWindow.isKeyWindow, "appIsActive": NSApp.isActive,
            "windowOrderFrontToBack": NSApp.orderedWindows.map { $0.windowNumber },
            "backdropFrame": NSStringFromRect(backdrop.window.frame),
            "screenVisibleFrame": NSStringFromRect(backdrop.screen.visibleFrame),
            "label": "诊断背景 \(backdrop.name)",
            "captureScope": "Only the app and its synthetic diagnostic background window; no desktop or other application windows."
        ]
        guard let background = content.windows.first(where: { $0.windowID == CGWindowID(backdrop.window.windowNumber) }) else {
            evidence["limitation"] = "Diagnostic window unavailable to ScreenCaptureKit; app-window capture alone cannot verify backdrop compositing."
            return evidence
        }
        do {
            // Independent background evidence stays useful if display capture is
            // unavailable. It is never pasted underneath an app screenshot.
            let backgroundConfiguration = SCStreamConfiguration()
            backgroundConfiguration.width = Int(backdrop.window.frame.width)
            backgroundConfiguration.height = Int(backdrop.window.frame.height)
            backgroundConfiguration.showsCursor = false
            backgroundConfiguration.ignoreShadowsSingleWindow = true
            backgroundConfiguration.ignoreGlobalClipSingleWindow = true
            let backgroundImage = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(desktopIndependentWindow: background), configuration: backgroundConfiguration)
            let backgroundFile = "backdrop-\(name).png"
            try writePNG(backgroundImage, to: directory.appendingPathComponent(backgroundFile))
            evidence["backgroundFile"] = backgroundFile
            guard backdrop.fitsDisplay else {
                evidence["limitation"] = "Display is too small for a >=1000×600 app plus a visible labeled background strip. Saved separate app/background windows only; no complete display-composite claim."
                return evidence
            }
            guard let number = backdrop.screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
                  let display = content.displays.first(where: { $0.displayID == number.uint32Value }) else {
                evidence["limitation"] = "Matching display unavailable; saved separate app/background windows only."
                return evidence
            }
            // Record the actual WindowServer order, not just the requested order.
            if let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] {
                let ids = windows.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue }
                evidence["diagnosticWindowOrderFrontToBack"] = ids.filter {
                    $0 == liveAppWindow.windowNumber || $0 == backdrop.window.windowNumber
                }
                let front = ids.firstIndex(of: liveAppWindow.windowNumber)
                let back = ids.firstIndex(of: backdrop.window.windowNumber)
                guard let front, let back, front < back else {
                    evidence["limitation"] = "Could not verify the app is above the diagnostic background; saved separate windows only."
                    return evidence
                }
            } else {
                evidence["limitation"] = "WindowServer order unavailable; saved separate windows only."
                return evidence
            }
            guard backdrop.window.frame.contains(liveAppWindow.frame),
                  liveAppWindow.frame.maxY <= backdrop.window.frame.maxY - 44 else {
                evidence["limitation"] = "Actual app frame does not leave the diagnostic label visible; saved separate windows only."
                return evidence
            }
            // Display-style capture preserves the real z-order and behind-window
            // material. The allowlist excludes desktop, menu bar and unrelated apps.
            // Use SCK's own top-left coordinate space, not AppKit's bottom-left space.
            let source = background.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
            let configuration = SCStreamConfiguration()
            configuration.sourceRect = source
            configuration.width = Int(backdrop.window.frame.width)
            configuration.height = Int(backdrop.window.frame.height)
            configuration.showsCursor = false
            let filter = SCContentFilter(display: display, including: [background, appWindow])
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            let compositeFile = "composite-\(name).png"
            try writePNG(image, to: directory.appendingPathComponent(compositeFile))
            evidence["compositeCaptured"] = true
            evidence["compositeFile"] = compositeFile
            evidence["compositeWidth"] = image.width
            evidence["compositeHeight"] = image.height
            evidence["compositeSourceRect"] = NSStringFromRect(source)
            evidence["appFrameInComposite"] = NSStringFromRect(appWindow.frame.offsetBy(dx: -background.frame.minX, dy: -background.frame.minY))
            evidence["compositePixelSamples"] = pixelSamples(image,
                appFrame: appWindow.frame.offsetBy(dx: -background.frame.minX, dy: -background.frame.minY),
                captureSize: backdrop.window.frame.size)
            evidence["comparisonScope"] = "Compare A/B shell pixels with opaque cards as a control; captures alone do not prove blur strength or interaction behavior."
            print("Real two-window display composite: \(compositeFile); standalone backdrop: \(backgroundFile)")
        } catch {
            // Do not request permissions, change settings or retry through a broader
            // capture route. Preserve existing app evidence and report the limit.
            evidence["limitation"] = "Diagnostic capture failed: \(error.localizedDescription). App-window evidence does not establish display compositing."
            print("Diagnostic backdrop capture limitation: \(error)")
        }
        return evidence
    }

    /// Measured screenshot pixels only. Means compare A/B response; range and
    /// standard deviation distinguish spatial detail from one flat tint. Fixed
    /// app-local regions keep comparisons aligned even when display crops move.
    private static func pixelSamples(_ image: CGImage, appFrame: NSRect, captureSize: NSSize) -> [String: Any] {
        guard pageName == "changes" else { return ["limitation": "Regions are defined for the Changes fixture only."] }
        var regions = ["opaqueCard": NSRect(x: appFrame.width - 80, y: 400, width: 40, height: 50)]
        if !sidebarCollapsed {
            regions["sidebar"] = NSRect(x: 30, y: 400, width: 110, height: 50)
            regions["sidebarSpatial"] = NSRect(x: 30, y: 340, width: 110, height: 140)
        }
        let scaleX = CGFloat(image.width) / captureSize.width
        let scaleY = CGFloat(image.height) / captureSize.height
        var result: [String: Any] = ["colorSpace": "sRGB", "channelRange": "0...255", "coordinates": "app-local top-left points"]
        for (name, rect) in regions {
            let pixels = NSRect(x: (appFrame.minX + rect.minX) * scaleX, y: (appFrame.minY + rect.minY) * scaleY,
                                width: rect.width * scaleX, height: rect.height * scaleY).integral
            guard NSRect(origin: .zero, size: appFrame.size).contains(rect),
                  NSRect(x: 0, y: 0, width: image.width, height: image.height).contains(pixels),
                  let crop = image.cropping(to: pixels) else { continue }
            let bitmap = NSBitmapImageRep(cgImage: crop)
            var sum = [Double](repeating: 0, count: 3)
            var squared = sum
            var minimum = [Double](repeating: 255, count: 3)
            var maximum = [Double](repeating: 0, count: 3)
            var count = 0
            for y in 0..<bitmap.pixelsHigh {
                for x in 0..<bitmap.pixelsWide {
                    guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                    let rgb = [Double(color.redComponent) * 255, Double(color.greenComponent) * 255, Double(color.blueComponent) * 255]
                    for channel in 0..<3 {
                        sum[channel] += rgb[channel]
                        squared[channel] += rgb[channel] * rgb[channel]
                        minimum[channel] = min(minimum[channel], rgb[channel])
                        maximum[channel] = max(maximum[channel], rgb[channel])
                    }
                    count += 1
                }
            }
            guard count > 0 else { continue }
            let mean = sum.map { $0 / Double(count) }
            let deviation = (0..<3).map { sqrt(max(0, squared[$0] / Double(count) - mean[$0] * mean[$0])) }
            result[name] = ["rect": NSStringFromRect(rect), "sampleCount": count,
                            "meanRGB": mean, "minRGB": minimum, "maxRGB": maximum, "standardDeviationRGB": deviation]
        }
        return result
    }

    private static func writePNG(_ image: CGImage, to url: URL) throws {
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw CaptureError.noBitmap
        }
        try png.write(to: url)
    }

    private enum CaptureError: Error { case noView, noBitmap, noWindow, requiresScreenCaptureKit }
}



/// Only preview framing differs from the normal window. Its live native views,
/// material compositing, titlebar controls, and pixel density remain unchanged.
private final class PreviewWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

/// Test fixture drawn only in a separate, opaque NSWindow behind the preview app.
/// Broad A/B color regions and sharp lines make actual material response measurable.
private final class PreviewBackdropView: NSView {
    private let name: String

    init(name: String, frame: NSRect) {
        self.name = name
        super.init(frame: frame)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override var isOpaque: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let colors: [NSColor] = name == "A"
            ? [NSColor(srgbRed: 0.10, green: 0.56, blue: 0.93, alpha: 1),
               NSColor(srgbRed: 0.20, green: 0.83, blue: 0.65, alpha: 1),
               NSColor(srgbRed: 0.38, green: 0.27, blue: 0.78, alpha: 1)]
            : [NSColor(srgbRed: 0.97, green: 0.40, blue: 0.16, alpha: 1),
               NSColor(srgbRed: 0.78, green: 0.18, blue: 0.48, alpha: 1),
               NSColor(srgbRed: 0.96, green: 0.75, blue: 0.18, alpha: 1)]
        for index in colors.indices {
            colors[index].setFill()
            NSBezierPath(rect: NSRect(x: CGFloat(index) * bounds.width / 3, y: 0,
                                      width: bounds.width / 3 + 1, height: bounds.height)).fill()
        }
        // Hard fixture edges remain outside the app's view tree; any blur seen
        // through its shell must be produced by the real native material.
        NSColor.white.withAlphaComponent(0.85).setFill()
        NSBezierPath(rect: NSRect(x: 0, y: bounds.height * 0.34, width: bounds.width, height: 20)).fill()
        NSColor.black.withAlphaComponent(0.5).setFill()
        NSBezierPath(rect: NSRect(x: bounds.width * 0.18, y: 0, width: 14, height: bounds.height)).fill()
        NSColor.white.setFill()
        NSBezierPath(rect: NSRect(x: 0, y: bounds.height - 44, width: bounds.width, height: 44)).fill()
        ("诊断背景 \(name) · 独立原生窗口" as NSString).draw(
            at: NSPoint(x: 16, y: bounds.height - 25),
            withAttributes: [.font: NSFont.systemFont(ofSize: 16, weight: .semibold), .foregroundColor: NSColor.black])
        ("Diagnostic fixture only; not part of the app interface" as NSString).draw(
            at: NSPoint(x: 16, y: bounds.height - 40),
            withAttributes: [.font: NSFont.systemFont(ofSize: 10), .foregroundColor: NSColor.darkGray])
    }
}
