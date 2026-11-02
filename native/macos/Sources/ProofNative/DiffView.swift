import AppKit
import SwiftUI

struct NativeDiffView: View {
    let diff: FileDiff
    var body: some View {
        CodeTextView(identity: diff.id) {
            let result = NSMutableAttributedString(string: "")
            for hunk in diff.hunks {
                result.append(CodeTextView.line("        \(hunk.header)  [\(hunk.reviewState)]\n", kind: "header"))
                for line in hunk.lines {
                    let old = line.oldLine.map(String.init) ?? ""
                    let new = line.newLine.map(String.init) ?? ""
                    let sign = line.kind == "add" ? "+" : line.kind == "delete" ? "−" : " "
                    let numbers = old.padding(toLength: 6, withPad: " ", startingAt: 0) + new.padding(toLength: 6, withPad: " ", startingAt: 0)
                    result.append(CodeTextView.line(numbers + sign + " " + line.content.replacingOccurrences(of: "\r", with: "␍") + "\n", kind: line.kind))
                }
            }
            return result
        }
    }
}
struct PatchView: View {
    let patch: String
    var body: some View {
        CodeTextView(identity: patch) {
            let result = NSMutableAttributedString(string: "")
            for line in patch.components(separatedBy: "\n") {
                let kind = line.hasPrefix("@@") || line.hasPrefix("diff ") ? "header" : line.hasPrefix("+") ? "add" : line.hasPrefix("-") ? "delete" : "context"
                result.append(CodeTextView.line(line + "\n", kind: kind))
            }
            return result
        }
    }
}

/// Native selectable, searchable text, no WebView. Explicit +/− and line numbers supplement color.
struct CodeTextView: NSViewRepresentable {
    let identity: String
    let content: () -> NSAttributedString
    final class Coordinator { var identity: String?; var appearance: String? }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true; scroll.borderType = .noBorder
        let text = NSTextView(frame: .zero)
        text.isEditable = false; text.isSelectable = true; text.isRichText = false
        text.usesFindBar = true; text.isIncrementalSearchingEnabled = true
        text.isVerticallyResizable = true; text.isHorizontallyResizable = true
        text.autoresizingMask = [.width]
        text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.textContainer?.widthTracksTextView = false
        text.textContainerInset = NSSize(width: 14, height: 12)
        text.backgroundColor = .textBackgroundColor
        text.setAccessibilityLabel("Read-only Git diff. Use Command F to find text.")
        scroll.documentView = text
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let appearance = scroll.effectiveAppearance.name.rawValue
        guard context.coordinator.identity != identity || context.coordinator.appearance != appearance,
              let text = scroll.documentView as? NSTextView else { return }
        let changed = context.coordinator.identity != identity
        context.coordinator.identity = identity; context.coordinator.appearance = appearance
        text.textStorage?.setAttributedString(content())
        if changed { text.scrollToBeginningOfDocument(nil) }
    }
    static func line(_ text: String, kind: String) -> NSAttributedString {
        var attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
            .foregroundColor: NSColor.textColor
        ]
        if kind == "add" { attrs[.backgroundColor] = NSColor.systemGreen.withAlphaComponent(0.13) }
        if kind == "delete" { attrs[.backgroundColor] = NSColor.systemRed.withAlphaComponent(0.13) }
        if kind == "header" { attrs[.foregroundColor] = NSColor.secondaryLabelColor; attrs[.backgroundColor] = NSColor.quaternaryLabelColor }
        return NSAttributedString(string: text, attributes: attrs)
    }
}
