import Foundation

// Run with swiftc Sources/ProofNative/{Models,ChangesTree}.swift Tests/ChangesTreeCheck.swift -o /tmp/proof-tree-check
@main
enum ChangesTreeCheck {
    static func main() {
        func file(_ path: String, _ side: String = "unstaged") -> ChangedFile {
            ChangedFile(path: path, oldPath: nil, status: "M", side: side, conflicted: false)
        }
        let files = [file("src/main/swift/Z.swift"), file("src/main/swift/A.swift"),
                     file("docs/deep/note.md"), file("docs/README.md"), file("README.md"),
                     file("src/main/swift/A.swift", "staged")]
        let rows = changesTreeRows(files: files)
        assert(rows.filter(\.isGroup).map(\.label) == ["Unstaged", "Staged"])
        assert(rows.filter(\.isGroup).map(\.count) == [5, 1])
        assert(rows.contains { $0.id == "folder:unstaged:src/main/swift" && $0.label == "src/main/swift" && $0.depth == 1 })
        assert(rows.contains { $0.id == "folder:unstaged:docs" && $0.label == "docs" })
        assert(rows.contains { $0.id == "folder:unstaged:docs/deep" && $0.depth == 2 })
        assert(rows.filter { $0.file != nil }.map(\.id) == [
            "unstaged:docs/deep/note.md", "unstaged:docs/README.md",
            "unstaged:src/main/swift/A.swift", "unstaged:src/main/swift/Z.swift",
            "unstaged:README.md", "staged:src/main/swift/A.swift"
        ])
        assert(Set(rows.map(\.id)).count == rows.count)

        let collapsed: Set<String> = ["group:staged", "folder:unstaged:src/main/swift"]
        let hidden = changesTreeRows(files: files, collapsed: collapsed)
        assert(hidden.filter { $0.file != nil }.count == 3)
        assert(hidden.last?.id == "group:staged" && hidden.last?.isExpanded == false)
        let searched = changesTreeRows(files: files, search: "A.SWIFT", collapsed: collapsed)
        assert(searched.filter { $0.file != nil }.count == 2)
        assert(searched.filter(\.isGroup).allSatisfy(\.isExpanded))

        let flat = changesTreeRows(files: files, scope: "staged", tree: false)
        assert(flat.count == 2 && flat[1].label == "src/main/swift/A.swift" && flat[1].depth == 1)
        assert(changesTreeRows(files: [], scope: "unstaged").count == 1)
        assert(changesTreeRows(files: files, search: "missing").allSatisfy { $0.isGroup && $0.count == 0 })
        let unicode = changesTreeRows(files: [file("源码/目录/文件.swift")])
        assert(unicode.contains { $0.label == "源码/目录" })
        assert(unicode.contains { $0.label == "文件.swift" && $0.file != nil })
        print("Changes tree checks passed: compression, ordering, sides, filters, collapse, list, empty and Unicode")
    }
}
