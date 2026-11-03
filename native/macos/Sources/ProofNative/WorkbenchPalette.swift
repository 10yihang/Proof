import AppKit
import SwiftUI

/// Flat native workbench: quiet solid surfaces, one border, no decorative depth.
enum WorkbenchPalette {
    static let canvas = adaptive(light: 0xFFFFFF, dark: 0x1B2230)
    static let navigation = adaptive(light: 0xF0F3F8, dark: 0x191E27)
    static let panel = adaptive(light: 0xF7F8FA, dark: 0x222A36)
    static let raised = adaptive(light: 0xF4F7FC, dark: 0x283448)
    static let selection = adaptive(light: 0xE0EAFE, dark: 0x2D4365)
    static let border = adaptive(light: 0xDCE2EB, dark: 0x384251)
    static let text = adaptive(light: 0x17243D, dark: 0xEDF3FF)
    static let secondary = adaptive(light: 0x536582, dark: 0xB1C1DA)
    static let accent = adaptive(light: 0x0964EC, dark: 0x7BB2FF)
    static let primaryAction = adaptive(light: 0x1559C5, dark: 0x2469CE)
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

// Capture compatibility: opaque mode is already the normal flat design.
private struct WorkbenchOpaqueSurfacesKey: EnvironmentKey {
    static let defaultValue = false
}
extension EnvironmentValues {
    /// Additive opaque-surface preview only; never turns off the user's setting.
    var workbenchOpaqueSurfaces: Bool {
        get { self[WorkbenchOpaqueSurfacesKey.self] }
        set { self[WorkbenchOpaqueSurfacesKey.self] = newValue }
    }
}
struct WorkbenchChromeBackground: View {
    var body: some View { WorkbenchChromeSurface(reduced: true) }
}
struct WorkbenchChromeSurface: View {
    // Kept for existing screenshot variants; both accessibility states are solid.
    let reduced: Bool
    var body: some View { Color(nsColor: WorkbenchPalette.navigation) }
}

private struct WorkbenchCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Color(nsColor: WorkbenchPalette.canvas))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color(nsColor: WorkbenchPalette.border), lineWidth: 0.75))
    }
}
private struct WorkbenchInputSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Color(nsColor: WorkbenchPalette.panel), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: WorkbenchPalette.border), lineWidth: 0.65))
    }
}
private struct WorkbenchSelection: ViewModifier {
    let selected: Bool
    @State private var hovered = false
    func body(content: Content) -> some View {
        content
            .background(selected ? Color(nsColor: WorkbenchPalette.selection) : hovered ? Color(nsColor: WorkbenchPalette.accent).opacity(0.065) : .clear,
                        in: RoundedRectangle(cornerRadius: 7))
            .onHover { hovered = $0 }
    }
}
extension View {
    func workbenchCard() -> some View { modifier(WorkbenchCard()) }
    func workbenchInputSurface() -> some View { modifier(WorkbenchInputSurface()) }
    func workbenchSelection(_ selected: Bool) -> some View { modifier(WorkbenchSelection(selected: selected)) }
    func airyControlSurface() -> some View { modifier(AiryControlSurface()) }
}
private struct AiryControlSurface: ViewModifier {
    func body(content: Content) -> some View {
        content.background(Color(nsColor: WorkbenchPalette.canvas), in: RoundedRectangle(cornerRadius: 6))
    }
}

struct WorkbenchButtonStyle: ButtonStyle {
    var prominent = false
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovered = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: prominent ? 14 : 12, weight: prominent ? .medium : .regular))
            .padding(.horizontal, 12).frame(height: prominent ? 40 : 30)
            .contentShape(RoundedRectangle(cornerRadius: 6))
            .foregroundStyle(prominent ? Color.white : Color(nsColor: WorkbenchPalette.text))
            .background(prominent ? Color(nsColor: WorkbenchPalette.primaryAction) : hovered || configuration.isPressed ? Color(nsColor: WorkbenchPalette.selection) : .clear, in: RoundedRectangle(cornerRadius: 6))
            .onHover { hovered = $0 }
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
