import AppKit
import SwiftUI

@main
@MainActor
enum WindowChromeCheck {
    static func main() {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 700),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        for height: CGFloat in [700, 600, 760] {
            window.setFrame(NSRect(x: 0, y: 0, width: 1100, height: height), display: false)
            let controls = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap(window.standardWindowButton)
            let actions = controls.map(\.action)
            alignNativeWindowButtons(window)
            for (index, button) in controls.enumerated() {
                let parent = button.superview!
                let center = parent.convert(NSPoint(x: button.frame.midX, y: button.frame.midY), to: nil)
                assert(abs(center.y - (window.frame.height - 27)) < 0.5)
                assert(parent.bounds.contains(button.frame), "Native traffic-light hit region must stay inside its parent")
                assert(button.action == actions[index] && !button.isHidden && button.isEnabled)
            }
        }
        window.close()
        checkMaterials()
        print("Native window chrome checks passed: real controls retain actions and hit regions aligned after resize")
    }
    private static func checkMaterials() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: AnyView(WorkbenchChromeSurface(reduced: false)))
        window.contentView = host
        func effects(_ view: NSView) -> [NSVisualEffectView] {
            (view as? NSVisualEffectView).map { [$0] } ?? view.subviews.flatMap(effects)
        }
        func layout() {
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            host.layoutSubtreeIfNeeded()
        }
        layout()
        let materials = effects(host)
        assert(materials.count == 1, "Workspace must use one continuous native material")
        assert(materials[0].material == .underWindowBackground && materials[0].blendingMode == .behindWindow)
        assert(materials[0].state == .followsWindowActiveState)
        host.rootView = AnyView(WorkbenchChromeSurface(reduced: true))
        layout()
        assert(effects(host).isEmpty, "Reduced transparency must use the opaque fallback without live blur")
        // The system accessibility environment is read-only. Exercise the
        // resolved surface's false → true → false transition without changing it.
        host.rootView = AnyView(WorkbenchChromeSurface(reduced: false))
        layout()
        assert(effects(host).count == 1, "Restoring transparency must recreate the native material")
        host.rootView = AnyView(WorkbenchChromeBackground(glass: true))
        layout()
        assert(effects(host).count == (NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency ? 0 : 1),
               "The production wrapper must follow the current system preference")
        host.rootView = AnyView(WorkbenchChromeBackground(glass: true).environment(\.workbenchOpaqueSurfaces, true))
        layout()
        assert(effects(host).isEmpty, "The opaque screenshot option must never enable blur")
        host.rootView = AnyView(WorkbenchChromeBackground(glass: false))
        layout()
        assert(effects(host).isEmpty, "Other pages must retain the flat shell")
        print("Native surface checks passed: one native workspace backdrop, opaque fallback and flat other pages; systemReduceTransparency=\(NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency)")
        window.close()
    }

}
