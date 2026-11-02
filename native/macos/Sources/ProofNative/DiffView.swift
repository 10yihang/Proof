import AppKit
import SwiftUI

struct NativeDiffView: View {
    let diff: FileDiff
    var body: some View {
        CodeTextView(identity: diff.id, rows: diff.hunks.flatMap { hunk in
            [CodeRow(text: hunk.header + "   ·   " + hunk.reviewState, kind: "header")] + hunk.lines.map {
                CodeRow(text: $0.content.replacingOccurrences(of: "\r", with: "␍"), kind: $0.kind,
                        oldLine: $0.oldLine, newLine: $0.newLine)
            }
        }, numbered: true)
    }
}

struct PatchView: View {
    let patch: String
    var body: some View {
        CodeTextView(identity: patch, rows: patch.components(separatedBy: "\n").map { line in
            let kind = line.hasPrefix("@@") || line.hasPrefix("diff ") ? "header" : line.hasPrefix("+") ? "add" : line.hasPrefix("-") ? "delete" : "context"
            return CodeRow(text: line, kind: kind)
        }, numbered: false)
    }
}

struct CodeRow: Equatable {
    let text: String
    let kind: String
    var oldLine: Int? = nil
    var newLine: Int? = nil
    var range = NSRange(location: 0, length: 0)

    var background: NSColor? {
        switch kind {
        case "add": return NSColor.systemGreen.withAlphaComponent(0.10)
        case "delete": return NSColor.systemRed.withAlphaComponent(0.09)
        case "header": return NSColor.unemphasizedSelectedContentBackgroundColor.withAlphaComponent(0.45)
        default: return nil
        }
    }
}

/// Real AppKit text selection and find, with a separate non-copying line-number ruler.
struct CodeTextView: NSViewRepresentable {
    let identity: String
    let rows: [CodeRow]
    let numbered: Bool
    final class Coordinator {
        var identity: String?
        var appearance: String?
        var rows: [CodeRow] = []
    }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        let text = DiffTextView(frame: .zero)
        text.isEditable = false
        text.isSelectable = true
        text.isRichText = false
        text.usesFindBar = true
        text.isIncrementalSearchingEnabled = true
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = true
        text.autoresizingMask = [.width]
        text.minSize = .zero
        text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.textContainer?.widthTracksTextView = false
        text.textContainerInset = NSSize(width: 14, height: 14)
        text.textContainer?.lineFragmentPadding = 0
        text.backgroundColor = .textBackgroundColor
        text.setAccessibilityLabel("Read-only Git diff. Use Command F to find text. Line numbers are in the adjacent gutter.")
        scroll.documentView = text
        if numbered {
            scroll.hasVerticalRuler = true
            scroll.verticalRulerView = DiffRuler(scrollView: scroll, orientation: .verticalRuler)
            scroll.rulersVisible = true
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let appearance = scroll.effectiveAppearance.name.rawValue
        guard context.coordinator.identity != identity || context.coordinator.appearance != appearance || context.coordinator.rows != rows,
              let text = scroll.documentView as? DiffTextView else { return }
        let changed = context.coordinator.identity != identity
        context.coordinator.identity = identity
        context.coordinator.appearance = appearance
        context.coordinator.rows = rows
        let result = NSMutableAttributedString(string: "")
        var laidOut: [CodeRow] = []
        for var row in rows {
            row.range = NSRange(location: result.length, length: (row.text as NSString).length + 1)
            result.append(Self.attributedLine(row))
            laidOut.append(row)
        }
        text.rows = laidOut
        text.textStorage?.setAttributedString(result)
        text.layoutManager?.ensureLayout(for: text.textContainer!)
        text.needsDisplay = true
        scroll.verticalRulerView?.needsDisplay = true
        if changed { text.scrollToBeginningOfDocument(nil) }
    }

    private static func attributedLine(_ row: CodeRow) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 21
        paragraph.maximumLineHeight = 21
        paragraph.tabStops = []
        paragraph.defaultTabInterval = 31.2
        let result = NSMutableAttributedString(string: row.text + "\n", attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
            .foregroundColor: row.kind == "header" ? NSColor.secondaryLabelColor : NSColor.textColor,
            .paragraphStyle: paragraph
        ])
        guard row.kind != "header" else { return result }
        // Lightweight lexical accents, not a language parser. Git text remains authoritative.
        let rules: [(String, NSColor)] = [
            (#"\b(import|from|export|default|const|let|var|func|fn|pub|struct|enum|class|impl|return|if|else|guard|throw|throws|try|await|async|for|in|match|case|switch|self|Self|true|false|nil|null|None|Some|mut|use|where|private|static)\b"#, DiffPalette.keyword),
            (#"\b[0-9]+(?:\.[0-9]+)?\b"#, DiffPalette.number),
            (#"\"(?:\\.|[^\"\\])*\""#, DiffPalette.string),
            (#"//.*$"#, .secondaryLabelColor)
        ]
        let range = NSRange(location: 0, length: (row.text as NSString).length)
        for (pattern, color) in rules {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            for match in regex.matches(in: row.text, range: range) {
                result.addAttribute(.foregroundColor, value: color, range: match.range)
            }
        }
        return result
    }
}

final class DiffTextView: NSTextView {
    var rows: [CodeRow] = []

    func rowRect(_ row: CodeRow) -> NSRect? {
        guard let manager = layoutManager, row.range.location < (string as NSString).length else { return nil }
        let glyph = manager.glyphIndexForCharacter(at: row.range.location)
        var rect = manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        rect.origin.x += textContainerOrigin.x
        rect.origin.y += textContainerOrigin.y
        return rect
    }

    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        for row in rows {
            guard let color = row.background, let line = rowRect(row) else { continue }
            let band = NSRect(x: bounds.minX, y: line.minY, width: bounds.width, height: line.height)
            if band.intersects(rect) { color.setFill(); band.fill() }
        }
    }
}

final class DiffRuler: NSRulerView {
    override init(scrollView: NSScrollView?, orientation: NSRulerView.Orientation) {
        super.init(scrollView: scrollView, orientation: orientation)
        ruleThickness = 105
        clientView = scrollView?.documentView
        setAccessibilityLabel("Original and changed line numbers")
        scrollView?.contentView.postsBoundsChangedNotifications = true
        if let clip = scrollView?.contentView {
            NotificationCenter.default.addObserver(self, selector: #selector(viewportDidChange(_:)),
                name: NSView.boundsDidChangeNotification, object: clip)
        }
    }
    required init(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    deinit { NotificationCenter.default.removeObserver(self) }
    @objc private func viewportDidChange(_ notification: Notification) { needsDisplay = true }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
        guard let text = scrollView?.documentView as? DiffTextView else { return }
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .right
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor.secondaryLabelColor,
            .paragraphStyle: paragraph
        ]
        for row in text.rows {
            guard let line = text.rowRect(row) else { continue }
            let local = convert(line, from: text)
            // The text rectangle lives to the right of this ruler, so only its
            // vertical interval is relevant; a 2D intersection hides every row.
            guard local.maxY >= bounds.minY && local.minY <= bounds.maxY else { continue }
            if let color = row.background {
                color.setFill()
                NSRect(x: 0, y: local.minY, width: bounds.width, height: local.height).fill()
            }
            let y = local.minY + 3
            (row.oldLine.map(String.init) ?? "").draw(in: NSRect(x: 4, y: y, width: 34, height: 18), withAttributes: attrs)
            (row.newLine.map(String.init) ?? "").draw(in: NSRect(x: 43, y: y, width: 34, height: 18), withAttributes: attrs)
            let sign = row.kind == "add" ? "+" : row.kind == "delete" ? "−" : ""
            var signAttrs = attrs
            signAttrs[.foregroundColor] = row.kind == "add" ? NSColor.systemGreen : NSColor.systemRed
            sign.draw(in: NSRect(x: 82, y: y, width: 13, height: 18), withAttributes: signAttrs)
        }
        NSColor.separatorColor.setFill()
        NSRect(x: bounds.maxX - 1, y: bounds.minY, width: 1, height: bounds.height).fill()
    }
}

/// Quiet, readable lexical ink in both appearances; diff backgrounds own red/green state.
private enum DiffPalette {
    static let keyword = adaptive(light: (0.43, 0.25, 0.57), dark: (0.77, 0.61, 0.89))
    static let number = adaptive(light: (0.52, 0.32, 0.13), dark: (0.85, 0.70, 0.47))
    static let string = adaptive(light: (0.58, 0.25, 0.18), dark: (0.88, 0.65, 0.53))

    private static func adaptive(light: (CGFloat, CGFloat, CGFloat), dark: (CGFloat, CGFloat, CGFloat)) -> NSColor {
        NSColor(name: nil) { appearance in
            let rgb = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: rgb.0, green: rgb.1, blue: rgb.2, alpha: 1)
        }
    }
}
