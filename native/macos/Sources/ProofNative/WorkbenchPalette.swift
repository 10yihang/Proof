import AppKit
import SwiftUI

/// Airy native surfaces: blue-tinted chrome, independent light cards, opaque code.
enum WorkbenchPalette {
    static let canvas = adaptive(light: 0xFFFFFF, dark: 0x1B2230)
    static let navigation = adaptive(light: 0xEAF1FC, dark: 0x151E2D)
    static let panel = adaptive(light: 0xF9FBFF, dark: 0x202A3A)
    static let raised = adaptive(light: 0xF1F5FD, dark: 0x29364A)
    static let selection = adaptive(light: 0xD9E8FF, dark: 0x254777)
    static let border = adaptive(light: 0xD6DFEF, dark: 0x3A4960)
    static let text = adaptive(light: 0x17243D, dark: 0xEDF3FF)
    static let secondary = adaptive(light: 0x536582, dark: 0xB1C1DA)
    static let accent = adaptive(light: 0x0964EC, dark: 0x7BB2FF)
    static let addition = adaptive(light: 0xECF9EF, dark: 0x213B30)
    static let deletion = adaptive(light: 0xFFF0F1, dark: 0x442B35)
    static let hunk = adaptive(light: 0xECF2FD, dark: 0x29374D)
    static let additionInk = adaptive(light: 0x23733D, dark: 0x9DDDAD)
    static let deletionInk = adaptive(light: 0xB2384B, dark: 0xFFACB8)

    private static func adaptive(light: UInt32, dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
                           green: CGFloat((hex >> 8) & 255) / 255,
                           blue: CGFloat(hex & 255) / 255, alpha: 1)
        }
    }
}

struct WorkbenchBackdrop: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .sidebar
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }
    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

private struct WorkbenchCard: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        content
            .background(Color(nsColor: WorkbenchPalette.canvas).opacity(reduceTransparency ? 1 : 0.91))
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.15 : 0.055), radius: 8, x: 0, y: 3)
    }
}
extension View {
    func workbenchCard() -> some View { modifier(WorkbenchCard()) }
    @ViewBuilder func airyControlSurface() -> some View {
        if #available(macOS 26.0, *) {
            self.glassEffect(.regular, in: RoundedRectangle(cornerRadius: 8))
        } else {
            self.background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

struct WorkbenchButtonStyle: ButtonStyle {
    var prominent = false
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: prominent ? 14 : 12, weight: prominent ? .medium : .regular))
            .padding(.horizontal, 12).frame(height: prominent ? 40 : 30)
            .foregroundStyle(prominent ? Color.white : Color(nsColor: WorkbenchPalette.text))
            .background(prominent ? Color(nsColor: NSColor.systemBlue) : Color(nsColor: WorkbenchPalette.panel), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: WorkbenchPalette.border), lineWidth: prominent ? 0 : 0.7))
            .opacity(isEnabled ? (configuration.isPressed ? 0.72 : 1) : 0.4)
    }
}

/// Move the real AppKit controls, including their hit regions, onto the custom
/// title row. No replacement traffic lights or synthetic close actions.
@MainActor
func alignNativeWindowButtons(_ window: NSWindow) {
    for type: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
        guard let button = window.standardWindowButton(type), let parent = button.superview else { continue }
        let desired = NSPoint(x: 0, y: window.frame.height - 27)
        let initialY = parent.convert(desired, from: nil).y - button.frame.height / 2
        if initialY < parent.bounds.minY {
            // Extend the native container downward so the moved controls remain
            // inside their parent's real hit-test and clipping bounds.
            let extra = parent.bounds.minY - initialY
            var frame = parent.frame
            frame.origin.y -= extra
            frame.size.height += extra
            parent.frame = frame
        }
        let center = parent.convert(desired, from: nil)
        let y = center.y - button.frame.height / 2
        if abs(button.frame.origin.y - y) > 0.5 {
            button.setFrameOrigin(NSPoint(x: button.frame.origin.x, y: y))
        }
    }
}
struct NativeWindowChrome: NSViewRepresentable {
    func makeNSView(context: Context) -> NativeWindowChromeView { NativeWindowChromeView() }
    func updateNSView(_ view: NativeWindowChromeView, context: Context) { view.align() }
}
final class NativeWindowChromeView: NSView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        NotificationCenter.default.removeObserver(self)
        if let window {
            NotificationCenter.default.addObserver(self, selector: #selector(resized), name: NSWindow.didResizeNotification, object: window)
            align()
        }
    }
    deinit { NotificationCenter.default.removeObserver(self) }
    @objc private func resized() { align() }
    override func layout() { super.layout(); align() }
    func align() { if let window { alignNativeWindowButtons(window) } }
}
