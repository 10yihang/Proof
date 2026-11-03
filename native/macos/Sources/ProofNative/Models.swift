import Foundation

struct Workspace: Decodable, Identifiable {
    let id: String
    let name: String
    let path: String
    var trusted: Bool
}
struct ChangedFile: Decodable, Identifiable, Hashable {
    let path: String
    let oldPath: String?
    let status: String
    let side: String
    let conflicted: Bool
    var id: String { side + ":" + path }
}
struct Changes: Decodable {
    let workspace: Workspace
    let head: String?
    let branch: String?
    let operation: String?
    let token: String
    let files: [ChangedFile]
}
struct DiffLine: Decodable {
    let kind: String
    let content: String
    let oldLine: Int?
    let newLine: Int?
}
struct Hunk: Decodable, Identifiable {
    let id: String
    let header: String
    let lines: [DiffLine]
    let reviewState: String
}
struct FileDiff: Decodable, Identifiable {
    let id: String
    let path: String
    let side: String
    let base: String
    let patch: String
    let hunks: [Hunk]
    let additions: Int
    let deletions: Int
    let kind: String
    let notice: String?
    let canStage: Bool
    var reviewed: Bool { !hunks.isEmpty && hunks.allSatisfy { $0.reviewState == "reviewed" } }
}
struct BranchEntry: Decodable, Identifiable, Hashable {
    let name: String
    let current: Bool
    let oid: String
    let remote: Bool
    var id: String { (remote ? "refs/remotes/" : "refs/heads/") + name }
}

enum NativePreferences {
    static let appearance = "proof.native.appearance"
    static let compact = "proof.native.compact"
    static let restoreSidebar = "proof.native.restoreSidebar"
    static let sidebarVisible = "proof.native.sidebarVisible"
    static let codeFontSize = "proof.native.codeFontSize"
}

struct CommitEntry: Decodable, Identifiable {
    let oid: String
    let parents: [String]
    let author: String
    let date: String
    let subject: String
    let refs: String
    var id: String { oid }
}
struct CommitPreview: Decodable, Identifiable {
    let id: String
    let branch: String?
    let head: String?
    let files: [ChangedFile]
    let reviewed: Int
    let total: Int
    let unreadFiles: [String]
}
struct OperationResult: Decodable {
    let ok: Bool
    let message: String
    let warning: String?
}
struct BridgeError: Decodable, LocalizedError {
    let code: String
    let message: String
    let detail: String
    var errorDescription: String? { "\(message) [\(code)]\n\(detail)" }
}
struct Empty: Decodable {}
