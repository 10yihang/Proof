import AppKit
import SwiftUI

// macOS only. Run from the repository root:
// swiftc native/macos/Sources/ProofNative/{Models,WorkbenchPalette,DiffView}.swift native/macos/Tests/SplitDiffCheck.swift -o /tmp/proof-split-check
// /tmp/proof-split-check
@main
@MainActor
enum SplitDiffCheck {
    static func main() {
        checkRows()
        checkNativeScrolling()
        print("Split diff checks passed: alignment, unequal runs, additions/deletions, notes, CR, hunk boundaries, native selection/find, vertical sync, independent horizontal scrolling and file reset")
    }

    private static func line(_ kind: String, _ content: String, old: Int? = nil, new: Int? = nil) -> DiffLine {
        DiffLine(kind: kind, content: content, oldLine: old, newLine: new)
    }

    private static func hunk(_ lines: [DiffLine], id: String = "hunk") -> Hunk {
        Hunk(id: id, header: "@@ -1,4 +1,5 @@", lines: lines, reviewState: "unreviewed")
    }

    private static func checkRows() {
        let rows = splitDiffRows(hunks: [hunk([
            line("context", "unchanged", old: 1, new: 1),
            line("delete", "old A", old: 2),
            line("delete", "old B\r", old: 3),
            line("add", "new A", new: 2),
            line("context", "", old: 4, new: 3),
            line("add", "new B", new: 4),
            line("add", "new C", new: 5)
        ])])
        assert(rows.before.count == rows.after.count && rows.before.count == 7)
        assert(rows.before[0].kind == "header" && rows.before[0] == rows.after[0])
        assert(rows.before[1] == rows.after[1] && rows.before[1].oldLine == 1)
        assert(rows.before[2].text == "old A" && rows.after[2].text == "new A")
        assert(rows.before[3].text == "old B␍" && rows.after[3].kind == "spacer")
        assert(rows.after[3].oldLine == nil && rows.after[3].newLine == nil)
        assert(rows.before[4].kind == "context" && rows.before[4].text.isEmpty)
        assert(rows.before[4].oldLine == 4 && rows.after[4].newLine == 3)
        assert(rows.before[5].kind == "spacer" && rows.after[5].text == "new B")
        assert(rows.before[6].kind == "spacer" && rows.after[6].text == "new C")

        let note = "\\ No newline at end of file"
        let annotated = splitDiffRows(hunks: [hunk([
            line("delete", "old", old: 10), line("note", note),
            line("add", "new", new: 10), line("add", "last", new: 11), line("note", note)
        ])])
        assert(annotated.before.map(\.kind) == ["header", "delete", "note", "spacer", "spacer"])
        assert(annotated.after.map(\.kind) == ["header", "add", "spacer", "add", "note"])
        assert(annotated.before[2].text == note && annotated.after[4].text == note)
        let sharedNote = splitDiffRows(hunks: [hunk([line("context", "last", old: 1, new: 1), line("note", note)])])
        assert(sharedNote.before == sharedNote.after && sharedNote.before.last?.text == note)

        let boundaries = splitDiffRows(hunks: [
            hunk([line("delete", "removed", old: 1)]),
            Hunk(id: "next", header: "@@ -8,0 +8,1 @@", lines: [line("add", "added", new: 8)], reviewState: "reviewed")
        ])
        assert(boundaries.before.map(\.kind) == ["header", "delete", "header", "spacer"])
        assert(boundaries.after.map(\.kind) == ["header", "spacer", "header", "add"])
        assert(boundaries.before[2].text.hasSuffix("已评阅"))
        let empty = splitDiffRows(hunks: [])
        assert(empty.before.isEmpty && empty.after.isEmpty)
    }

    private static func fixture(id: String) -> FileDiff {
        let longLine = String(repeating: "selectable_text ", count: 80)
        let lines = (1...180).map { line("context", "\($0) \(longLine)", old: $0, new: $0) }
        return FileDiff(id: id, path: "scroll-check.swift", side: "unstaged", base: "HEAD", patch: "",
                        hunks: [hunk(lines)], additions: 0, deletions: 0, kind: "text", notice: nil, canStage: false)
    }

    private static func descendants<T: NSView>(_ view: NSView, of type: T.Type) -> [T] {
        (view as? T).map { [$0] } ?? view.subviews.flatMap { descendants($0, of: type) }
    }

    private static func layout(_ host: NSView) {
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        host.layoutSubtreeIfNeeded()
    }

    private static func scroll(_ view: DiffScrollView, x: CGFloat, y: CGFloat) {
        var bounds = view.contentView.bounds
        bounds.origin = NSPoint(x: x, y: y)
        view.contentView.scroll(to: view.contentView.constrainBoundsRect(bounds).origin)
        view.reflectScrolledClipView(view.contentView)
    }

    private static func checkNativeScrolling() {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 340),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        let host = NSHostingView(rootView: SplitNativeDiffView(diff: fixture(id: "first")))
        window.contentView = host
        layout(host)
        let panes = descendants(host, of: DiffScrollView.self).sorted {
            $0.convert(NSPoint.zero, to: host).x < $1.convert(NSPoint.zero, to: host).x
        }
        assert(panes.count == 2)
        let before = panes[0], after = panes[1]
        assert(before.synchronizedScrollView === after && after.synchronizedScrollView === before)
        for pane in panes {
            let text = pane.documentView as! DiffTextView
            assert(text.isSelectable && !text.isEditable && text.usesFindBar && text.isIncrementalSearchingEnabled)
            assert(text.frame.width > pane.contentView.bounds.width && text.frame.height > pane.contentView.bounds.height)
            assert((pane.verticalRulerView as? DiffRuler)?.ruleThickness == 66)
            assert(pane.isAtDocumentStart, pane.initialViewportDiagnostic)
            text.setSelectedRange(NSRange(location: 0, length: 2))
            assert(text.selectedRange().length == 2)
        }
        let initialBeforeX = before.contentView.bounds.minX
        let initialAfterX = after.contentView.bounds.minX
        scroll(before, x: initialBeforeX + 120, y: 380)
        assert(abs(before.contentView.bounds.minY - 380) < 1)
        assert(abs(before.contentView.bounds.minY - after.contentView.bounds.minY) < 1)
        assert(before.contentView.bounds.minX > initialBeforeX + 100)
        assert(abs(after.contentView.bounds.minX - initialAfterX) < 1)
        let beforeX = before.contentView.bounds.minX
        scroll(after, x: initialAfterX + 180, y: 560)
        assert(abs(before.contentView.bounds.minY - after.contentView.bounds.minY) < 1)
        assert(abs(before.contentView.bounds.minX - beforeX) < 1)
        assert(after.contentView.bounds.minX > initialAfterX + 160)
        for y in [CGFloat(40), 340, 120, 560] {
            scroll(before, x: beforeX, y: y)
            assert(abs(after.contentView.bounds.minY - y) < 1)
        }

        // A new snapshot resets both axes, whereas review/theme updates do not.
        host.rootView = SplitNativeDiffView(diff: fixture(id: "second"))
        layout(host)
        for pane in descendants(host, of: DiffScrollView.self) {
            assert(pane.isAtDocumentStart, pane.initialViewportDiagnostic)
        }

        // Unified remains one selectable/findable surface with its original gutter.
        let unified = NSHostingView(rootView: NativeDiffView(diff: fixture(id: "unified")))
        window.contentView = unified
        layout(unified)
        let single = descendants(unified, of: DiffScrollView.self)
        assert(single.count == 1 && single[0].synchronizedScrollView == nil)
        assert(single[0].verticalRulerView?.ruleThickness == 105)
        assert((single[0].documentView as? DiffTextView)?.usesFindBar == true)
        window.close()
    }
}
