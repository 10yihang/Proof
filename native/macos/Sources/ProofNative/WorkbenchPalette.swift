import AppKit

/// Shared semantic surfaces for the approved gray workbench, not simulated glass.
enum WorkbenchPalette {
    static let canvas = adaptive(light: 0xFFFFFF, dark: 0x1B1B1E)
    static let navigation = adaptive(light: 0xF4F4F6, dark: 0x19191C)
    static let panel = adaptive(light: 0xF8F8FA, dark: 0x202023)
    static let raised = adaptive(light: 0xEEEEF1, dark: 0x29292E)
    static let selection = adaptive(light: 0xE3E1EA, dark: 0x34323B)
    static let border = adaptive(light: 0xDDDDE3, dark: 0x303036)
    static let text = adaptive(light: 0x292830, dark: 0xD3D1DB)
    static let secondary = adaptive(light: 0x65626F, dark: 0xA6A3B0)
    static let accent = adaptive(light: 0x655779, dark: 0xD8D2EC)
    static let addition = adaptive(light: 0xE8F1EB, dark: 0x21342B)
    static let deletion = adaptive(light: 0xF6E9EC, dark: 0x38282D)
    static let hunk = adaptive(light: 0xEFECF5, dark: 0x27232F)
    static let additionInk = adaptive(light: 0x3A6C4C, dark: 0xA4CBB0)
    static let deletionInk = adaptive(light: 0x985662, dark: 0xD5A5AF)

    private static func adaptive(light: UInt32, dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
                           green: CGFloat((hex >> 8) & 255) / 255,
                           blue: CGFloat(hex & 255) / 255, alpha: 1)
        }
    }
}
