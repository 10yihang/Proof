import Foundation

/// One process per window, serialized core access; no shell or arbitrary command API.
@MainActor
final class Bridge {
    private var process: Process?
    private var input: FileHandle?
    private var nextID = 0
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var writable = false

    func start() throws {
        guard process == nil else { return }
        let executable: URL
        if let override = ProcessInfo.processInfo.environment["PROOF_SWIFT_BRIDGE"] {
            executable = URL(fileURLWithPath: override)
        } else {
            executable = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/proof-swift-bridge")
        }
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw BridgeError(code: "BRIDGE_MISSING", message: "Build the native app with native/macos/build.sh first.", detail: executable.path)
        }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let data = support.appendingPathComponent("ProofNative", isDirectory: true)
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        let task = Process()
        let stdin = Pipe(), stdout = Pipe()
        task.executableURL = executable
        task.arguments = [data.path]
        task.standardInput = stdin
        task.standardOutput = stdout
        // stderr deliberately never enters the JSON protocol.
        task.standardError = FileHandle.standardError
        task.terminationHandler = { [weak self] task in
            Task { @MainActor in
                self?.failAll(BridgeError(code: "BRIDGE_EXITED", message: "Rust service stopped. Reopen the app; inspect Git state before retrying a write.", detail: "Exit \(task.terminationStatus)"))
            }
        }
        try task.run()
        process = task
        input = stdin.fileHandleForWriting
        writable = true
        let output = stdout.fileHandleForReading
        // Blocking pipe reads run off the UI thread. One line is one response, including escaped newlines.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var buffer = Data()
            while true {
                let chunk = output.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 10) {
                    let line = Data(buffer[..<newline])
                    buffer.removeSubrange(...newline)
                    Task { @MainActor in self?.receive(line) }
                }
            }
            try? output.close()
        }
    }

    func call<T: Decodable>(_ method: String, _ parameters: [String: Any] = [:], cancellable: Bool = true) async throws -> T {
        try Task.checkCancellation()
        guard writable else { throw BridgeError(code: "NOT_CONNECTED", message: "Rust service is unavailable. Reopen the app.", detail: "") }
        nextID += 1
        let id = nextID
        var command = parameters
        command["method"] = method
        let bytes = try JSONSerialization.data(withJSONObject: ["id": id, "command": command]) + Data([10])
        guard bytes.count <= 1024 * 1024 else { throw BridgeError(code: "REQUEST_TOO_LARGE", message: "Request exceeds 1 MiB.", detail: "Shorten the commit message.") }
        let response: Data = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending[id] = continuation
                do { try input?.write(contentsOf: bytes) }
                catch { pending.removeValue(forKey: id)?.resume(throwing: error) }
            }
        } onCancel: {
            if cancellable { Task { @MainActor in self.cancel(id) } }
        }
        return try JSONDecoder().decode(T.self, from: response)
    }
    private func cancel(_ id: Int) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        try? input?.write(contentsOf: Data("{\"cancel\":\(id)}\n".utf8))
        continuation.resume(throwing: CancellationError())
    }
    private func receive(_ data: Data) {
        do {
            guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = envelope["id"] as? Int else { throw CocoaError(.fileReadCorruptFile) }
            guard let continuation = pending.removeValue(forKey: id) else { return }
            do {
                if let error = envelope["error"] {
                    let bytes = try JSONSerialization.data(withJSONObject: error)
                    continuation.resume(throwing: try JSONDecoder().decode(BridgeError.self, from: bytes))
                } else {
                    let result = envelope["result"] ?? NSNull()
                    // Void core methods return null; normalize only that to our empty response type.
                    continuation.resume(returning: try JSONSerialization.data(withJSONObject: result is NSNull ? [:] : result, options: [.fragmentsAllowed]))
                }
            } catch { continuation.resume(throwing: error) }
        } catch { failAll(error) }
    }
    private func failAll(_ error: Error) {
        writable = false
        let callbacks = pending.values
        pending.removeAll()
        for callback in callbacks { callback.resume(throwing: error) }
    }
    func stop() {
        writable = false
        try? input?.close() // EOF lets an in-progress write finish; never kill a Git write.
        input = nil
    }
}
