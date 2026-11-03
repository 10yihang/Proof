import AppKit

/// Same production image rendered by the original App.tsx ProofMark.
/// Packaged apps use their signed resource; swift run uses the SwiftPM resource.
enum ProofBrand {
    static let image: NSImage = {
        let url = Bundle.main.url(forResource: "ProofMark", withExtension: "png")
            ?? Bundle.module.url(forResource: "ProofMark", withExtension: "png")
        guard let url, let image = NSImage(contentsOf: url) else {
            preconditionFailure("The production Proof logo is missing from the app resources")
        }
        return image
    }()
}
