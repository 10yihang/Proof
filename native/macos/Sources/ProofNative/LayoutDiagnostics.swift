import AppKit
import SwiftUI

/// Read-only CI geometry evidence; absent from ordinary application view trees.
extension View {
    @ViewBuilder func captureLayout(_ name: String) -> some View {
        if ScreenshotPreview.outputDirectory != nil {
            background(GeometryReader { proxy in
                LayoutProbe(name: name)
                    .onAppear { print("SwiftUI \(name): size=\(proxy.size) global=\(proxy.frame(in: .global)) safe=\(proxy.safeAreaInsets)") }
                    .onChange(of: proxy.size) { _ in print("SwiftUI \(name): size=\(proxy.size) global=\(proxy.frame(in: .global)) safe=\(proxy.safeAreaInsets)") }
            })
        } else { self }
    }
}
private struct LayoutProbe: NSViewRepresentable {
    let name: String
    func makeNSView(context: Context) -> LayoutProbeView { LayoutProbeView(name: name) }
    func updateNSView(_ view: LayoutProbeView, context: Context) {}
}
private final class LayoutProbeView: NSView {
    let name: String
    init(name: String) { self.name = name; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
}
@MainActor
func dumpNativeLayout(_ window: NSWindow) {
    guard let root = window.contentView else { return }
    func visit(_ view: NSView, depth: Int) {
        let kind = String(describing: type(of: view))
        if view is NSScrollView || view is NSClipView || view is LayoutProbeView || kind.contains("Hosting") || kind.contains("Split") || depth < 2 {
            let label = (view as? LayoutProbeView)?.name ?? kind
            print("Native \(label): frame=\(view.frame) bounds=\(view.bounds) windowRect=\(view.convert(view.bounds, to: root)) safe=\(view.safeAreaInsets) fitting=\(view.fittingSize) intrinsic=\(view.intrinsicContentSize)")
        }
        if depth < 20 { view.subviews.forEach { visit($0, depth: depth + 1) } }
    }
    visit(root, depth: 0)
}

/// Geometry checks supplement native image review; these are not interaction tests.
/// A preview fails if navigation chrome or the requested page is clipped.
@MainActor
func validatePreviewChrome(_ window: NSWindow) throws {
    guard let root = window.contentView else {
        throw NSError(domain: "ProofPreviewLayout", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Preview window has no content view"])
    }
    var frames: [String: NSRect] = [:]
    var diffScrolls: [DiffScrollView] = []
    func visit(_ view: NSView) {
        guard !view.isHiddenOrHasHiddenAncestor else { return }
        if let probe = view as? LayoutProbeView {
            let frame = probe.convert(probe.bounds, to: root)
            if frame.intersection(root.bounds).width > 0.5 && frame.intersection(root.bounds).height > 0.5 {
                frames[probe.name] = frame
            }
        }
        if let scroll = view as? DiffScrollView { diffScrolls.append(scroll) }
        view.subviews.forEach(visit)
    }
    func fail(_ message: String) -> NSError {
        NSError(domain: "ProofPreviewLayout", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "\(ScreenshotPreview.captureName): \(message); frames=\(frames)"])
    }
    func fits(_ frame: NSRect, inside bounds: NSRect) -> Bool {
        frame.width > 0 && frame.height > 0 && frame.minX >= bounds.minX - 1
            && frame.maxX <= bounds.maxX + 1 && frame.minY >= bounds.minY - 1
            && frame.maxY <= bounds.maxY + 1
    }
    visit(root)
    guard let branch = frames["branch-header"], let page = frames["page-content"],
          let status = frames["status-bar"],
          branch.minY >= root.safeAreaInsets.top - 1,
          page.minY >= branch.maxY - 1,
          page.width >= 600, page.height >= 300,
          page.maxY <= status.minY + 1,
          fits(branch, inside: root.bounds), fits(page, inside: root.bounds), fits(status, inside: root.bounds) else {
        throw fail("Page or navigation chrome is clipped or overlaps")
    }
    if ScreenshotPreview.sidebarCollapsed {
        guard frames["sidebar-footer"] == nil else { throw fail("Collapsed sidebar is still visible") }
    } else {
        guard let footer = frames["sidebar-footer"], fits(footer, inside: root.bounds) else {
            throw fail("Expanded sidebar footer is clipped or absent")
        }
    }

    if ScreenshotPreview.pageName == "changes" {
        guard let file = frames["file-header"], let diff = frames["diff-viewport"],
              let commit = frames["commit-editor"], let files = frames["files-column"],
              fits(file, inside: page), fits(diff, inside: page), fits(commit, inside: page), fits(files, inside: page),
              files.width >= 210, files.height >= 160, commit.height >= 100,
              commit.minY >= files.maxY - 1,
              file.minX >= files.maxX - 1,
              diff.minY >= file.maxY - 1,
              diff.height >= 200, file.width >= 340 else {
            throw fail("Changes file card, composer, or usable diff viewport is clipped or overlaps")
        }
    } else if ScreenshotPreview.pageName == "history" {
        guard let list = frames["history-list"], let patch = frames["history-patch"],
              fits(list, inside: page), fits(patch, inside: page),
              list.height >= 120, patch.height >= 120,
              patch.minY >= list.maxY - 1 else {
            throw fail("History list or native commit patch is clipped or overlaps")
        }
    }

    if ["changes", "history"].contains(ScreenshotPreview.pageName) {
        diffScrolls.forEach { print("Initial diff viewport: \($0.initialViewportDiagnostic)") }
        guard !diffScrolls.isEmpty, diffScrolls.allSatisfy({ $0.isAtDocumentStart }) else {
            throw fail("Initial diff text is not visible at the document leading edge")
        }
    }
    print("Preview geometry verified: \(ScreenshotPreview.captureName); page=\(page), status=\(status); rendering only, no interaction claim")
}
