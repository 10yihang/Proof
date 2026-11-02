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

/// A capture must fail, not merely look green in CI, if application chrome hides actions.
@MainActor
func validatePreviewChrome(_ window: NSWindow) throws {
    guard let root = window.contentView else { return }
    var frames: [String: NSRect] = [:]
    var diffScrolls: [DiffScrollView] = []
    func visit(_ view: NSView) {
        if let probe = view as? LayoutProbeView { frames[probe.name] = probe.convert(probe.bounds, to: root) }
        if let scroll = view as? DiffScrollView { diffScrolls.append(scroll) }
        view.subviews.forEach(visit)
    }
    visit(root)
    diffScrolls.forEach { print("Initial diff viewport: \($0.initialViewportDiagnostic)") }
    guard !diffScrolls.isEmpty, diffScrolls.allSatisfy({ $0.isAtDocumentStart }) else {
        throw NSError(domain: "ProofPreviewLayout", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "Initial diff text is not visible at the document leading edge"])
    }
    guard let branch = frames["branch-header"], let file = frames["file-header"],
          let diff = frames["diff-viewport"], let commit = frames["commit-editor"],
          let status = frames["status-bar"], let files = frames["files-column"],
          branch.minY >= root.safeAreaInsets.top - 0.5,
          file.minY >= branch.maxY - 0.5,
          files.minY >= branch.maxY - 0.5,
          diff.minY >= file.maxY - 0.5,
          diff.height >= 120, file.width >= 340,
          commit.minY >= diff.maxY - 0.5,
          commit.maxY <= status.minY + 0.5,
          status.maxY <= root.bounds.height + 0.5,
          frames["sidebar-footer"].map({ $0.maxY <= root.bounds.height + 0.5 }) ?? false else {
        throw NSError(domain: "ProofPreviewLayout", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Workbench chrome overlaps or usable diff/commit viewport is clipped: \(frames)"])
    }
    print("Preview workbench verified: branch bottom=\(branch.maxY), file top=\(file.minY), diff height=\(diff.height), commit=\(commit), status=\(status)")
}
