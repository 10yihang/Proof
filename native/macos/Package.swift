// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ProofNative",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "ProofNative", targets: ["ProofNative"])],
    targets: [.executableTarget(name: "ProofNative")]
)
