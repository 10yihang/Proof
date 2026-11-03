import Foundation

@main
enum CommitMessageCheck {
    static func main() {
        assert(CommitMessage.subject("").isEmpty && CommitMessage.body("").isEmpty)
        assert(CommitMessage.body("Subject").isEmpty)
        assert(CommitMessage.subject("修复 👩🏽‍💻\n\nDetails\n\nMore") == "修复 👩🏽‍💻")
        assert(CommitMessage.body("Subject\n\nDetails\n\nMore\n") == "Details\n\nMore\n")
        assert(CommitMessage.body("Subject\nLegacy body") == "Legacy body")
        assert(CommitMessage.replacingSubject(in: "Old\nLegacy body\n", with: "New") == "New\nLegacy body\n")
        assert(CommitMessage.replacingSubject(in: "Old\n\nBody", with: "New\nTitle") == "New Title\n\nBody")
        assert(CommitMessage.replacingBody(in: "Subject\nLegacy body", with: "New\n\nParagraph") == "Subject\n\nNew\n\nParagraph")
        assert(CommitMessage.replacingBody(in: "Subject\n\nOld", with: "") == "Subject")
        let bodyOnly = CommitMessage.replacingBody(in: "", with: "Draft first")
        assert(bodyOnly == "\n\nDraft first")
        assert(CommitMessage.replacingSubject(in: bodyOnly, with: "Title") == "Title\n\nDraft first")
        for message in ["Subject", "Subject\n\nBody", "Subject\n\n\nLeading blank\n", "标题\n\n说明 🎉"] {
            assert(CommitMessage.replacingBody(in: message, with: CommitMessage.body(message)) == message)
            assert(CommitMessage.replacingSubject(in: message, with: CommitMessage.subject(message)) == message)
        }
        print("Commit message field checks passed")
    }
}
