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
        if view is LayoutProbeView || kind.contains("Hosting") || kind.contains("Split") || depth < 2 {
            let label = (view as? LayoutProbeView)?.name ?? kind
            print("Native \(label): frame=\(view.frame) bounds=\(view.bounds) windowRect=\(view.convert(view.bounds, to: root)) safe=\(view.safeAreaInsets) fitting=\(view.fittingSize)")
        }
        if depth < 20 { view.subviews.forEach { visit($0, depth: depth + 1) } }
    }
    visit(root, depth: 0)
}
