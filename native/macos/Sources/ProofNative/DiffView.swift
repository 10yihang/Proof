import AppKit
import SwiftUI

struct NativeDiffView: View {
    let diff: FileDiff
    var body: some View {
        CodeTextView(identity: diff.id, rows: diff.hunks.flatMap { hunk in
            [CodeRow(text: hunk.header + "   ·   " + (hunk.reviewState == "reviewed" ? "已评阅" : "待评阅"), kind: "header")] + hunk.lines.map {
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
        case "add": return WorkbenchPalette.addition
        case "delete": return WorkbenchPalette.deletion
        case "header": return WorkbenchPalette.hunk
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

    func makeNSView(context: Context) -> DiffScrollView {
        let scroll = DiffScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.drawsBackground = true
        scroll.backgroundColor = WorkbenchPalette.canvas
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
        text.backgroundColor = WorkbenchPalette.canvas
        text.selectedTextAttributes = [.backgroundColor: WorkbenchPalette.selection, .foregroundColor: WorkbenchPalette.text]
        text.setAccessibilityLabel("只读 Git 差异。按 Command F 查找文本，左侧显示行号。")
        scroll.documentView = text
        if numbered {
            scroll.hasVerticalRuler = true
            scroll.verticalRulerView = DiffRuler(scrollView: scroll, orientation: .verticalRuler)
            scroll.rulersVisible = true
        }
        return scroll
    }

    func updateNSView(_ scroll: DiffScrollView, context: Context) {
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
        if changed { scroll.scrollToDocumentStartOnNextLayout() }
    }

    private static func attributedLine(_ row: CodeRow) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 22
        paragraph.maximumLineHeight = 22
        paragraph.tabStops = []
        paragraph.defaultTabInterval = 31.2
        let result = NSMutableAttributedString(string: row.text + "\n", attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
            .foregroundColor: row.kind == "header" ? WorkbenchPalette.secondary : WorkbenchPalette.text,
            .paragraphStyle: paragraph
        ])
        guard row.kind != "header" else { return result }
        // Lightweight lexical accents, not a language parser. Git text remains authoritative.
        let rules: [(String, NSColor)] = [
            (#"\b(import|from|export|default|const|let|var|func|fn|pub|struct|enum|class|impl|return|if|else|guard|throw|throws|try|await|async|for|in|match|case|switch|self|Self|true|false|nil|null|None|Some|mut|use|where|private|static)\b"#, DiffPalette.keyword),
            (#"\b[0-9]+(?:\.[0-9]+)?\b"#, DiffPalette.number),
            (#"\"(?:\\.|[^\"\\])*\""#, DiffPalette.string),
            (#"//.*$"#, WorkbenchPalette.secondary)
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

/// Reset a newly selected diff's viewport, not its insertion point. AppKit lays
/// out ruler/content insets before this runs; theme and review updates keep the
/// user's scroll position because only an identity change requests a reset.
final class DiffScrollView: NSScrollView {
    private var needsInitialScroll = false

    func scrollToDocumentStartOnNextLayout() {
        needsInitialScroll = true
        needsLayout = true
    }

    /// Native clip bounds at the document's leading/top edge, including rulers.
    var initialDocumentBounds: NSRect? {
        guard let document = documentView else { return nil }
        let clip = contentView
        var proposed = clip.bounds
        proposed.origin = NSPoint(x: document.frame.minX - clip.contentInsets.left,
                                  y: document.frame.minY - clip.contentInsets.top)
        return clip.constrainBoundsRect(proposed)
    }

    /// Used by native preview QA; checks the text edge too, not just its box.
    var isAtDocumentStart: Bool {
        guard let expected = initialDocumentBounds, let text = documentView as? NSTextView,
              abs(contentView.bounds.minX - expected.minX) <= 0.5,
              abs(contentView.bounds.minY - expected.minY) <= 0.5 else { return false }
        guard rulersVisible, let ruler = verticalRulerView else { return true }
        let textStart = text.convert(text.textContainerOrigin, to: self).x
        let rulerEnd = ruler.convert(ruler.bounds, to: self).maxX
        return textStart >= rulerEnd - 0.5 && textStart <= rulerEnd + text.textContainerInset.width + 1
    }

    var initialViewportDiagnostic: String {
        "bounds=\(contentView.bounds), insets=\(contentView.contentInsets), document=\(String(describing: documentView?.frame)), expected=\(String(describing: initialDocumentBounds)), startsVisible=\(isAtDocumentStart)"
    }

    override func layout() {
        super.layout()
        guard needsInitialScroll, contentView.bounds.width > 0,
              contentView.bounds.height > 0, let expected = initialDocumentBounds else { return }
        needsInitialScroll = false
        contentView.scroll(to: expected.origin)
        reflectScrolledClipView(contentView)
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
        setAccessibilityLabel("原始与修改后的行号")
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
        WorkbenchPalette.canvas.setFill()
        bounds.fill()
        guard let text = scrollView?.documentView as? DiffTextView else { return }
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .right
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: WorkbenchPalette.secondary,
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
            signAttrs[.foregroundColor] = row.kind == "add" ? WorkbenchPalette.additionInk : WorkbenchPalette.deletionInk
            sign.draw(in: NSRect(x: 82, y: y, width: 13, height: 18), withAttributes: signAttrs)
        }
        WorkbenchPalette.border.setFill()
        NSRect(x: bounds.maxX - 1, y: bounds.minY, width: 1, height: bounds.height).fill()
    }
}

/// Quiet, readable lexical ink in both appearances; diff backgrounds own red/green state.
private enum DiffPalette {
    static let keyword = adaptive(light: (0.43, 0.25, 0.57), dark: (0.74, 0.65, 0.85))
    static let number = adaptive(light: (0.52, 0.32, 0.13), dark: (0.71, 0.78, 0.86))
    static let string = adaptive(light: (0.58, 0.25, 0.18), dark: (0.86, 0.83, 0.68))

    private static func adaptive(light: (CGFloat, CGFloat, CGFloat), dark: (CGFloat, CGFloat, CGFloat)) -> NSColor {
        NSColor(name: nil) { appearance in
            let rgb = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: rgb.0, green: rgb.1, blue: rgb.2, alpha: 1)
        }
    }
}

