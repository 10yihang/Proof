import Foundation

/// The native counterpart of src/file-tree.ts; file identities remain side + path.
struct ChangesTreeRow: Identifiable {
    let id: String
    let label: String
    let depth: Int
    let file: ChangedFile?
    let count: Int
    let isExpanded: Bool
    let isGroup: Bool
}

func changesTreeRows(
    files: [ChangedFile],
    scope: String = "all",
    search: String = "",
    tree: Bool = true,
    collapsed: Set<String> = []
) -> [ChangesTreeRow] {
    var rows: [ChangesTreeRow] = []
    for side in ["unstaged", "staged"] {
        guard scope == "all" || scope == side else { continue }
        let visible = files.filter {
            $0.side == side && (search.isEmpty || $0.path.localizedCaseInsensitiveContains(search))
        }
        let groupID = "group:\(side)"
        let expanded = !search.isEmpty || !collapsed.contains(groupID)
        rows.append(ChangesTreeRow(id: groupID, label: side == "staged" ? "Staged" : "Unstaged",
                                   depth: 0, file: nil, count: visible.count, isExpanded: expanded, isGroup: true))
        guard expanded else { continue }

        func walk(_ children: [ChangedFile], prefix: String, depth: Int) {
            var folders: [String: [ChangedFile]] = [:]
            var direct: [ChangedFile] = []
            for file in children {
                let rest = file.path.dropFirst(prefix.count)
                if tree, let slash = rest.firstIndex(of: "/") {
                    folders[String(rest[..<slash]), default: []].append(file)
                } else {
                    direct.append(file)
                }
            }
            for name in folders.keys.sorted(by: { $0.localizedCompare($1) == .orderedAscending }) {
                let children = folders[name]!
                var path = prefix + name
                var label = name
                // Match Proof's compressed single-folder chains, stopping at files or branches.
                while true {
                    var subfolders: Set<String> = []
                    var hasDirectFile = false
                    for file in children {
                        let rest = file.path.dropFirst(path.count + 1)
                        guard let slash = rest.firstIndex(of: "/") else {
                            hasDirectFile = true
                            break
                        }
                        subfolders.insert(String(rest[..<slash]))
                        if subfolders.count > 1 { break }
                    }
                    guard !hasDirectFile, subfolders.count == 1, let child = subfolders.first else { break }
                    label += "/" + child
                    path += "/" + child
                }
                let id = "folder:\(side):\(path)"
                let expanded = !search.isEmpty || !collapsed.contains(id)
                rows.append(ChangesTreeRow(id: id, label: label, depth: depth, file: nil,
                                           count: children.count, isExpanded: expanded, isGroup: false))
                if expanded { walk(children, prefix: path + "/", depth: depth + 1) }
            }
            for file in direct.sorted(by: { $0.path.localizedCompare($1.path) == .orderedAscending }) {
                rows.append(ChangesTreeRow(id: file.id,
                                           label: tree ? (file.path as NSString).lastPathComponent : file.path,
                                           depth: depth, file: file, count: 1, isExpanded: false, isGroup: false))
            }
        }
        walk(visible, prefix: "", depth: 1)
    }
    return rows
}
