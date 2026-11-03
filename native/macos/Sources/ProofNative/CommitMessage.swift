import Foundation

/// The composer has two fields, but Git, AI and previews keep one message.
enum CommitMessage {
    static func subject(_ message: String) -> String {
        message.components(separatedBy: "\n").first ?? ""
    }

    static func body(_ message: String) -> String {
        guard let newline = message.firstIndex(of: "\n") else { return "" }
        let remainder = String(message[message.index(after: newline)...])
        return remainder.hasPrefix("\n") ? String(remainder.dropFirst()) : remainder
    }

    static func replacingSubject(in message: String, with subject: String) -> String {
        let suffix = message.firstIndex(of: "\n").map { String(message[$0...]) } ?? ""
        // A pasted multi-line title stays a single subject, never silently moves
        // an existing description or creates a second source of draft state.
        return subject.replacingOccurrences(of: "\r\n", with: " ")
            .replacingOccurrences(of: "\n", with: " ") + suffix
    }

    static func replacingBody(in message: String, with body: String) -> String {
        subject(message) + (body.isEmpty ? "" : "\n\n" + body)
    }
}
