import Foundation
import ZenithCore

enum GuardrailFailure: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self {
        case .failed(let message): message
        }
    }
}

func assert(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw GuardrailFailure.failed(message) }
}

func checkTextPresenceGateBehavior() throws {
    var gate = ZTextPresenceGate()

    try assert(gate.shouldPublish(""), "initial empty state should publish")
    try assert(!gate.shouldPublish(""), "repeated empty state must not publish")
    try assert(gate.shouldPublish("h"), "first non-empty character should publish")
    try assert(!gate.shouldPublish("he"), "continued typing must not publish")
    try assert(!gate.shouldPublish("hello"), "continued typing must not publish")
    try assert(gate.shouldPublish(""), "transition back to empty should publish")
    try assert(!gate.shouldPublish(""), "repeated empty state must not publish")

    gate.reset()
    try assert(gate.shouldPublish("reset"), "reset should allow initial state to publish again")
    try assert(!gate.shouldPublish("reset again"), "post-reset continued typing must not publish")
}

func checkComposerUsesPresenceGate() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let composerURL = cwd.appendingPathComponent("Sources/ZenithDock/Views/ComposerView.swift")
    let source = try String(contentsOf: composerURL, encoding: .utf8)

    try assert(source.contains("private var presenceGate = ZTextPresenceGate()"), "Composer coordinator must keep a ZTextPresenceGate")
    guard let guardRange = source.range(of: "guard presenceGate.shouldPublish(value) else { return }"),
          let callbackRange = source.range(of: "parent.onTextPresenceChange(!value.isEmpty)") else {
        throw GuardrailFailure.failed("Composer publishPresence must gate SwiftUI callbacks")
    }
    try assert(guardRange.lowerBound < callbackRange.lowerBound, "Composer must gate text presence before calling SwiftUI")
}

func checkEndpointCacheKeysAreServerScoped() throws {
    let sessionID = "sess_same_after_copy"
    let fallback = "http://127.0.0.1:7850"
    let first = ZEndpointCache.key(serverURL: "http://100.88.206.6:7850", sessionID: sessionID, default: fallback)
    let second = ZEndpointCache.key(serverURL: "100.73.184.23:7850/api/health", sessionID: sessionID, default: fallback)

    try assert(first != second, "cloned servers with the same session ID must not share chat cache keys")
    try assert(first.hasSuffix("|\(sessionID)"), "cache key should preserve session ID suffix")
    try assert(second == "http___100_73_184_23_7850|\(sessionID)", "cache key should normalize host and strip health path")
}

func checkRuntimeDefaultLabels() throws {
    let catalog = ZRuntimeCatalogSnapshot(backends: [
        "codex": ZRuntimeBackendCatalog(
            models: [ZRuntimeOption(value: "gpt-5.5", label: "GPT-5.5")],
            efforts: [ZRuntimeOption(value: "xhigh", label: "XHigh")],
            default_model: "gpt-5.5",
            default_effort: "xhigh"
        )
    ])
    let sessionData = Data(#"{"id":"sess","title":"Chat","backend":"codex"}"#.utf8)
    let session = try JSONDecoder().decode(ZSession.self, from: sessionData)

    try assert(catalog.modelLabel(nil, backend: "codex") == "Server default (GPT-5.5)", "model default label should show actual server default")
    try assert(catalog.effortLabel(nil, backend: "codex") == "Server default (XHigh)", "effort default label should show actual server default")
    try assert(catalog.compactSummary(for: session) == "Codex · Server default (GPT-5.5) · Server default (XHigh)", "runtime summary should include resolved defaults")
}

func checkServerURLNormalization() throws {
    let fallback = "http://127.0.0.1:7850"

    try assert(
        ZenithServerURL.normalized("100.73.184.23:7850/api/health", default: fallback) == "http://100.73.184.23:7850",
        "health endpoint paste should normalize to server root"
    )
    try assert(
        ZenithServerURL.normalized("http://100.73.184.23:7850/", default: fallback) == "http://100.73.184.23:7850",
        "trailing slash should be stripped"
    )
}

func checkShellCopyNormalization() throws {
    let input = "python train.py \\\\\n  --checkpoint_path \"$MODEL\" \\\\\n  --port 6666"
    let expected = "python train.py \\\n  --checkpoint_path \"$MODEL\" \\\n  --port 6666"
    let normalized = ZClipboardText.normalizedForCopy(input, language: "bash")

    try assert(normalized == expected, "shell copy should collapse accidental double continuations")
    try assert(
        ZClipboardText.normalizedForCopy("\\begin{tabular}\\\\", language: nil) == "\\begin{tabular}\\\\",
        "LaTeX-looking text should not be normalized as shell"
    )
}

do {
    try checkTextPresenceGateBehavior()
    try checkComposerUsesPresenceGate()
    try checkEndpointCacheKeysAreServerScoped()
    try checkRuntimeDefaultLabels()
    try checkServerURLNormalization()
    try checkShellCopyNormalization()
    print("ZenithGuardrails passed")
} catch {
    fputs("ZenithGuardrails failed: \(error)\n", stderr)
    exit(1)
}
