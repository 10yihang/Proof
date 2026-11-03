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
    var token: String? = nil
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
    static let autoRefresh = "proof.native.autoRefresh"
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

// Closed, typed display models. No credentials or arbitrary command execution.
struct HistoryActionRequest: Decodable {
    let kind: String
    let target: String?
    let name: String?
    let remote: String?
    let mode: String?
    let mainline: Int?
}
struct HistoryActionPreview: Decodable, Identifiable {
    let id: String
    let request: HistoryActionRequest
    let head: String?
    let branch: String?
    let targetOid: String?
    let remoteBranch: String?
    let expectedRemoteOid: String?
    let dirtyFiles: Int
    let affectedCommits: Int
    let operation: String?
    let arguments: [String]
    let destructive: Bool
}
struct HistoryActionResult: Decodable {
    let ok: Bool
    let head: String?
    let branch: String?
    let operation: String?
    let conflicts: [String]
    let detail: String
    let warning: String?
}
struct HistoryRepositoryState: Decodable {
    let remotes: [String]
    let upstream: String?
    let upstreamRemote: String?
    let upstreamBranch: String?
    let ahead: Int
    let behind: Int
    let operation: String?
    let conflicts: [String]
}
struct AgentOptions: Codable {
    var executablePath: String?
    var model: String?
}
struct AgentPrompts: Codable {
    var grouping: String
    var review: String
    var commit: String
}
struct AgentSettings: Codable {
    let revision: UInt64
    var defaultProvider: String
    var codex: AgentOptions
    var claudeCode: AgentOptions
    var codewiz: AgentOptions
    var ocr: AgentOptions
    var prompts: AgentPrompts
}
struct AgentProviderInfo: Decodable, Identifiable {
    let id: String
    let name: String
    let available: Bool
    let path: String?
    let reason: String?
    let model: String?
    let isDefault: Bool
}
struct AIFinding: Decodable {
    let severity: String
    let title: String
    let description: String
    let file: String
    let side: String
    let line: Int
    let endLine: Int?
    let lineSide: String
    let suggestion: String
}
struct AIReview: Decodable {
    let summary: String
    let overallRisk: String
    let findings: [AIFinding]
    let behaviorChanges: [String]
    let missingTests: [String]
    let reviewPriority: [String]
}
struct AIReport: Decodable, Identifiable {
    let id: String
    let provider: String
    let task: String
    let fingerprint: String
    let capturedAt: UInt64
    let review: AIReview?
    let commitMessage: String?
    let limitations: [String]
}
