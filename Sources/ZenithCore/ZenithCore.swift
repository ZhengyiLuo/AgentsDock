import Foundation
import Security
import UniformTypeIdentifiers

public struct ZSession: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public var title: String
    public var folder: String?
    public var cwd: String?
    public var backend: String
    public var model: String?
    public var effort: String?
    public var session_id: String?
    public var claude_session_id: String?
    public var codex_thread_id: String?
    public var parent_id: String?
    public var pinned: Bool?
    public var pinned_at: String?
    public var archived: Bool?
    public var archived_at: String?
    public var sort_order: Double?
    public var created_at: String?
    public var updated_at: String?
    public var latest_event_seq: Int?
    public var latest_event_at: String?
    public var latest_event_type: String?
    public var latest_agent_event_seq: Int?
    public var latest_agent_event_at: String?
    public var latest_agent_event_type: String?

    public var isBackendLocked: Bool {
        [session_id, claude_session_id, codex_thread_id]
            .contains { value in
                !(value?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
            }
    }
}

public struct ZRuntimeOption: Codable, Identifiable, Hashable, Sendable {
    public let value: String
    public let label: String

    public var id: String { value }

    public init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

public struct ZRuntimeBackendCatalog: Codable, Hashable, Sendable {
    public var models: [ZRuntimeOption]
    public var efforts: [ZRuntimeOption]
    public var model_source: String?
    public var effort_source: String?
    public var default_model: String?
    public var default_effort: String?

    public init(
        models: [ZRuntimeOption] = [ZRuntimeCatalog.serverDefaultOption],
        efforts: [ZRuntimeOption] = [ZRuntimeCatalog.serverDefaultOption],
        model_source: String? = nil,
        effort_source: String? = nil,
        default_model: String? = nil,
        default_effort: String? = nil
    ) {
        self.models = models
        self.efforts = efforts
        self.model_source = model_source
        self.effort_source = effort_source
        self.default_model = default_model
        self.default_effort = default_effort
    }
}

public struct ZRuntimeCatalogSnapshot: Codable, Hashable, Sendable {
    public var backends: [String: ZRuntimeBackendCatalog]
    public var generated_at: String?

    public init(backends: [String: ZRuntimeBackendCatalog] = [:], generated_at: String? = nil) {
        self.backends = backends
        self.generated_at = generated_at
    }

    public static let fallback = ZRuntimeCatalogSnapshot(backends: ZRuntimeCatalog.fallbackBackends)

    public func models(for backend: String) -> [ZRuntimeOption] {
        mergedOptions(
            primary: backends[backend.lowercased()]?.models,
            fallback: ZRuntimeCatalog.fallbackBackends[backend.lowercased()]?.models
        )
    }

    public func efforts(for backend: String) -> [ZRuntimeOption] {
        mergedOptions(
            primary: backends[backend.lowercased()]?.efforts,
            fallback: ZRuntimeCatalog.fallbackBackends[backend.lowercased()]?.efforts
        )
    }

    public func modelLabel(_ value: String?, backend: String) -> String {
        let clean = ZRuntimeCatalog.cleaned(value)
        guard !clean.isEmpty else { return serverDefaultModelLabel(for: backend) }
        return models(for: backend).first { $0.value == clean }?.label ?? clean
    }

    public func effortLabel(_ value: String?, backend: String) -> String {
        let clean = ZRuntimeCatalog.cleaned(value)
        guard !clean.isEmpty else { return serverDefaultEffortLabel(for: backend) }
        return efforts(for: backend).first { $0.value == clean }?.label ?? clean
    }

    public func compactSummary(for session: ZSession?) -> String {
        guard let session else { return "No runtime" }
        return [
            session.backend.capitalized,
            modelLabel(session.model, backend: session.backend),
            effortLabel(session.effort, backend: session.backend)
        ].filter { !$0.isEmpty && $0 != "Default" }.joined(separator: " · ")
    }

    private func mergedOptions(primary: [ZRuntimeOption]?, fallback: [ZRuntimeOption]?) -> [ZRuntimeOption] {
        let primaryHasSpecificOptions = primary?.contains { !ZRuntimeCatalog.cleaned($0.value).isEmpty } == true
        let values = primaryHasSpecificOptions ? primary : fallback
        let extras = primaryHasSpecificOptions ? [] : (primary ?? [])
        var seen = Set<String>()
        var out: [ZRuntimeOption] = []
        for option in (values ?? []) + extras {
            guard !seen.contains(option.value) else { continue }
            seen.insert(option.value)
            out.append(displayOption(option))
        }
        if !seen.contains(ZRuntimeCatalog.defaultValue) {
            out.insert(ZRuntimeCatalog.serverDefaultOption, at: 0)
        }
        return out
    }

    private func serverDefaultModelLabel(for backend: String) -> String {
        let key = backend.lowercased()
        return serverDefaultLabel(
            value: backends[key]?.default_model ?? ZRuntimeCatalog.fallbackBackends[key]?.default_model,
            options: models(for: backend)
        )
    }

    private func serverDefaultEffortLabel(for backend: String) -> String {
        let key = backend.lowercased()
        return serverDefaultLabel(
            value: backends[key]?.default_effort ?? ZRuntimeCatalog.fallbackBackends[key]?.default_effort,
            options: efforts(for: backend)
        )
    }

    private func serverDefaultLabel(value: String?, options: [ZRuntimeOption]) -> String {
        let clean = ZRuntimeCatalog.cleaned(value)
        guard !clean.isEmpty else { return "Default" }
        let label = options.first { $0.value == clean }?.label ?? clean
        return displayDefaultLabel(label)
    }

    private func displayOption(_ option: ZRuntimeOption) -> ZRuntimeOption {
        guard option.value.isEmpty else { return option }
        return ZRuntimeOption(value: option.value, label: displayDefaultLabel(option.label))
    }

    private func displayDefaultLabel(_ label: String) -> String {
        let clean = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return "Default" }
        if clean == "Server default" {
            return "Default"
        }
        let prefix = "Server default ("
        if clean.hasPrefix(prefix), clean.hasSuffix(")") {
            return String(clean.dropFirst(prefix.count).dropLast())
        }
        return clean
    }
}

public enum ZRuntimeCatalog {
    public static let defaultValue = ""
    public static let serverDefaultOption = ZRuntimeOption(value: "", label: "Default")
    public static let fallbackBackends: [String: ZRuntimeBackendCatalog] = [
        "claude": ZRuntimeBackendCatalog(),
        "codex": ZRuntimeBackendCatalog(
            models: [
                ZRuntimeOption(value: "", label: "GPT-5.5"),
                ZRuntimeOption(value: "gpt-5.5", label: "GPT-5.5"),
                ZRuntimeOption(value: "gpt-5.4", label: "GPT-5.4"),
                ZRuntimeOption(value: "gpt-5.3-codex", label: "GPT-5.3 Codex"),
                ZRuntimeOption(value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark"),
                ZRuntimeOption(value: "gpt-5.2", label: "GPT-5.2")
            ],
            efforts: [
                ZRuntimeOption(value: "", label: "XHigh"),
                ZRuntimeOption(value: "low", label: "Low"),
                ZRuntimeOption(value: "medium", label: "Medium"),
                ZRuntimeOption(value: "high", label: "High"),
                ZRuntimeOption(value: "xhigh", label: "XHigh")
            ],
            model_source: "local fallback",
            effort_source: "local fallback",
            default_model: "gpt-5.5",
            default_effort: "xhigh"
        )
    ]

    public static let efforts: [ZRuntimeOption] = ZRuntimeCatalogSnapshot.fallback.efforts(for: "codex")

    public static func models(for backend: String) -> [ZRuntimeOption] {
        ZRuntimeCatalogSnapshot.fallback.models(for: backend)
    }

    public static func modelLabel(_ value: String?, backend: String) -> String {
        let clean = cleaned(value)
        guard !clean.isEmpty else { return "Default" }
        return models(for: backend).first { $0.value == clean }?.label ?? clean
    }

    public static func effortLabel(_ value: String?) -> String {
        let clean = cleaned(value)
        guard !clean.isEmpty else { return "Default" }
        return efforts.first { $0.value == clean }?.label ?? clean
    }

    public static func cleanForAPI(_ value: String?) -> String? {
        let clean = cleaned(value)
        return clean.isEmpty ? "" : clean
    }

    public static func compactSummary(for session: ZSession?) -> String {
        ZRuntimeCatalogSnapshot.fallback.compactSummary(for: session)
    }

    public static func cleaned(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}

public struct ZTextPresenceGate: Sendable {
    private var lastPublishedPresence: Bool?

    public init() {}

    public mutating func shouldPublish(_ text: String) -> Bool {
        shouldPublish(hasText: !text.isEmpty)
    }

    public mutating func shouldPublish(hasText: Bool) -> Bool {
        guard lastPublishedPresence != hasText else { return false }
        lastPublishedPresence = hasText
        return true
    }

    public mutating func reset() {
        lastPublishedPresence = nil
    }
}

public enum ZEndpointCache {
    public static func namespace(serverURL: String, default defaultValue: String) -> String {
        safeComponent(ZenithServerURL.normalized(serverURL, default: defaultValue))
    }

    public static func key(serverURL: String, sessionID: String, default defaultValue: String) -> String {
        "\(namespace(serverURL: serverURL, default: defaultValue))|\(sessionID)"
    }

    private static func safeComponent(_ value: String) -> String {
        let clean = value.map { char -> Character in
            char.isLetter || char.isNumber ? char : "_"
        }
        let out = String(clean).trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        return out.isEmpty ? "default" : out
    }
}

public enum ZClipboardText {
    public static func normalizedForCopy(_ text: String, language: String? = nil) -> String {
        guard text.contains("\\\\") else { return text }
        let explicitShell = isShellLanguage(language)
        let globalShell = explicitShell || looksShellLike(text)
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var out: [String] = []
        out.reserveCapacity(lines.count)

        var inFence = false
        var fenceLanguage: String?

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if language == nil, trimmed.hasPrefix("```") {
                out.append(line)
                if inFence {
                    inFence = false
                    fenceLanguage = nil
                } else {
                    inFence = true
                    let rawLanguage = trimmed.dropFirst(3).trimmingCharacters(in: .whitespacesAndNewlines)
                    fenceLanguage = rawLanguage.split(separator: " ").first.map(String.init)
                }
                continue
            }

            let activeLanguage = language ?? (inFence ? fenceLanguage : nil)
            let shouldNormalize = isShellLanguage(activeLanguage) || (!inFence && globalShell)
            out.append(shouldNormalize ? normalizedShellContinuationLine(line) : line)
        }

        return out.joined(separator: "\n")
    }

    private static func normalizedShellContinuationLine(_ line: String) -> String {
        var core = line
        var trailingWhitespace = ""
        while let last = core.last, last == " " || last == "\t" {
            trailingWhitespace.insert(last, at: trailingWhitespace.startIndex)
            core.removeLast()
        }

        var prefix = core
        var slashCount = 0
        while prefix.last == "\\" {
            slashCount += 1
            prefix.removeLast()
        }

        guard slashCount >= 2, !looksLikeLatexLine(core) else {
            return line
        }
        return prefix + "\\" + trailingWhitespace
    }

    private static func isShellLanguage(_ language: String?) -> Bool {
        guard let language else { return false }
        let clean = language.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["bash", "sh", "shell", "zsh", "console", "terminal"].contains(clean)
    }

    private static func looksShellLike(_ text: String) -> Bool {
        let lower = text.lowercased()
        if lower.contains("cuda_visible_devices=") ||
            lower.contains(" python ") ||
            lower.contains("\npython ") ||
            lower.contains("\nbash ") ||
            lower.contains("\ncd ") ||
            lower.contains("\nexport ") ||
            lower.contains("\nconda ") ||
            lower.contains("\n  --") ||
            lower.contains("--checkpoint_path") ||
            lower.contains("--port ") ||
            lower.contains("command not found") {
            return true
        }
        return text.contains("$ ") && (lower.contains("--") || lower.contains("python") || lower.contains("bash"))
    }

    private static func looksLikeLatexLine(_ line: String) -> Bool {
        line.contains("\\begin") ||
            line.contains("\\end") ||
            line.contains("\\hline") ||
            line.contains(" & ")
    }
}

public struct ZFile: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public var session_id: String?
    public var event_id: String?
    public var event_seq: Int?
    public var kind: String?
    public var title: String?
    public var text: String?
    public var filename: String
    public var path: String?
    public var source_path: String?
    public var size: Int?
    public var content_type: String?
    public var created_at: String?
}

public struct ZJob: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public var session_id: String
    public var title: String
    public var prompt: String
    public var interval_seconds: Int?
    public var loop: Bool?
    public var enabled: Bool
    public var backend: String?
    public var created_at: String?
    public var updated_at: String?
    public var last_run_at: String?
    public var next_run_at_iso: String?
    public var run_count: Int?
}

public struct ZProcessLogHint: Codable, Identifiable, Hashable, Sendable {
    public var source: String
    public var path: String

    public var id: String { "\(source):\(path)" }
}

public struct ZProcessInfo: Codable, Identifiable, Hashable, Sendable {
    public var pid: Int
    public var ppid: Int?
    public var pgid: Int?
    public var sid: Int?
    public var stat: String?
    public var elapsed_seconds: Int?
    public var cpu_percent: Double?
    public var mem_percent: Double?
    public var rss_kb: Int?
    public var command: String?
    public var args: String?
    public var cwd: String?
    public var depth: Int?
    public var log_hints: [ZProcessLogHint]?

    public var id: Int { pid }
}

public struct ZProcessOutputTail: Codable, Hashable, Sendable {
    public var stream: String
    public var run_id: String?
    public var backend: String?
    public var lines: Int?
    public var total_lines: Int?
    public var truncated: Bool?
    public var text: String
    public var updated_at: String?
    public var generated_at: String?
}

public struct ZProcessSnapshot: Codable, Hashable, Sendable {
    public var session_id: String
    public var active: Bool
    public var run_id: String?
    public var backend: String?
    public var pid: Int?
    public var pgid: Int?
    public var cwd: String?
    public var argv: [String]?
    public var started_at: String?
    public var elapsed_seconds: Int?
    public var stop_requested: Bool?
    public var processes: [ZProcessInfo]
    public var stdout_tail: ZProcessOutputTail?
    public var generated_at: String?
}

public struct ZProcessLogTail: Codable, Hashable, Sendable {
    public var path: String
    public var size: Int?
    public var truncated: Bool?
    public var lines: Int?
    public var text: String
    public var generated_at: String?
}

public struct ZTerminalSnapshot: Codable, Hashable, Sendable {
    public var session_id: String
    public var name: String
    public var exists: Bool
    public var created: Bool?
    public var cwd: String?
    public var command: String?
    public var pane_pid: Int?
    public var attached: Int?
    public var columns: Int?
    public var rows: Int?
    public var lines: Int?
    public var text: String?
    public var killed: Bool?
    public var updated_at: String?
}

public struct ZTmuxPane: Codable, Identifiable, Hashable, Sendable {
    public var session_name: String
    public var window_index: Int?
    public var window_name: String?
    public var pane_index: Int?
    public var pane_id: String
    public var pane_pid: Int?
    public var command: String?
    public var cwd: String?
    public var active: Bool?
    public var attached: Int?
    public var title: String?
    public var matches: [String]?
    public var display: String?
    public var processes: [ZProcessInfo]?

    public var id: String { pane_id }
}

public struct ZTmuxSnapshot: Codable, Hashable, Sendable {
    public var session_id: String
    public var panes: [ZTmuxPane]
    public var total_panes: Int?
    public var filtered: Bool?
    public var generated_at: String?
}

public struct ZTmuxCapture: Codable, Hashable, Sendable {
    public var session_id: String
    public var pane_id: String
    public var lines: Int?
    public var text: String
    public var generated_at: String?
}

public struct ZTool: Codable, Hashable, Sendable {
    public var id: String?
    public var name: String
    public var input: JSONValue?
}

public struct ZEvent: Codable, Identifiable, Hashable, Sendable {
    public let seq: Int
    public let id: String
    public let session_id: String
    public let type: String
    public let ts: String
    public var run_id: String?
    public var queued_id: String?
    public var position: Int?
    public var backend: String?
    public var prompt: String?
    public var file_ids: [String]?
    public var text: String?
    public var result_text: String?
    public var message: String?
    public var error: String?
    public var output: String?
    public var raw: String?
    public var argv: [String]?
    public var exit_code: Int?
    public var is_error: Bool?
    public var provider_session_id: String?
    public var tool_id: String?
    public var tool: ZTool?
    public var file: ZFile?
    public var artifact: ZFile?
    public var job: ZJob?
    public var job_id: String?
    public var direction: String?
    public var positions: [ZQueuePosition]?
}

public struct ZQueuePosition: Codable, Identifiable, Hashable, Sendable {
    public var queued_id: String
    public var position: Int

    public var id: String { queued_id }
}

public struct ZMarkdownLinkContext: Hashable, Sendable {
    public var sessionID: String
    public var baseURL: URL
    public var accessToken: String?

    public init(sessionID: String, baseURL: URL, accessToken: String?) {
        self.sessionID = sessionID
        self.baseURL = baseURL
        let token = accessToken?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.accessToken = token?.isEmpty == false ? token : nil
    }

    public var cacheKey: String {
        "\(baseURL.absoluteString)|\(sessionID)|\(accessToken ?? "")"
    }

    public func resolvedURL(for target: String) -> URL? {
        let clean = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !clean.hasPrefix("#") else { return nil }

        if let url = URL(string: clean), let scheme = url.scheme?.lowercased() {
            if scheme == "http" || scheme == "https" || scheme == "mailto" {
                return url
            }
        }

        var comps = URLComponents(url: baseURL.appending(path: "/api/sessions/\(sessionID)/links/file"), resolvingAgainstBaseURL: false)
        var items = [URLQueryItem(name: "target", value: clean)]
        if let accessToken {
            items.append(URLQueryItem(name: "token", value: accessToken))
        }
        comps?.queryItems = items
        return comps?.url
    }
}

public enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? c.decode(Double.self) {
            self = .number(v)
        } else if let v = try? c.decode(String.self) {
            self = .string(v)
        } else if let v = try? c.decode([JSONValue].self) {
            self = .array(v)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }

    public var pretty: String {
        switch self {
        case .string(let value): return value
        case .number(let value): return String(value)
        case .bool(let value): return value ? "true" : "false"
        case .null: return "null"
        case .array, .object:
            let data = try? JSONEncoder().encode(self)
            return data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        }
    }
}

public struct APIClient: Sendable {
    public var baseURL: URL
    public var accessToken: String?

    public init(baseURL: URL, accessToken: String? = nil) {
        self.baseURL = baseURL
        let trimmedToken = accessToken?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.accessToken = trimmedToken?.isEmpty == false ? trimmedToken : nil
    }

    public func url(_ path: String) -> URL {
        baseURL.appending(path: path)
    }

    public func authenticatedURL(_ path: String) -> URL {
        guard let accessToken else { return url(path) }
        var comps = URLComponents(url: url(path), resolvingAgainstBaseURL: false)!
        var items = comps.queryItems ?? []
        items.append(URLQueryItem(name: "token", value: accessToken))
        comps.queryItems = items
        return comps.url ?? url(path)
    }

    public func wsURL(sessionID: String, after: Int) -> URL {
        var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comps.scheme = comps.scheme == "https" ? "wss" : "ws"
        comps.path = "/api/sessions/\(sessionID)/events"
        var items = [URLQueryItem(name: "after", value: "\(after)")]
        if let accessToken {
            items.append(URLQueryItem(name: "token", value: accessToken))
        }
        comps.queryItems = items
        return comps.url!
    }

    public func wsRequest(sessionID: String, after: Int) -> URLRequest {
        var req = URLRequest(url: wsURL(sessionID: sessionID, after: after))
        applyAuth(to: &req)
        return req
    }

    public func get<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        var req = URLRequest(url: url(path))
        applyAuth(to: &req)
        let (data, response) = try await URLSession.shared.data(for: req)
        try validate(response, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func get<T: Decodable>(_ path: String, queryItems: [URLQueryItem], as type: T.Type = T.self) async throws -> T {
        var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comps.path = path
        comps.queryItems = queryItems.isEmpty ? nil : queryItems
        var req = URLRequest(url: comps.url!)
        applyAuth(to: &req)
        let (data, response) = try await URLSession.shared.data(for: req)
        try validate(response, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func post<Body: Encodable, T: Decodable>(_ path: String, body: Body, as type: T.Type = T.self) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(to: &req)
        req.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: req)
        try validate(response, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func patch<Body: Encodable, T: Decodable>(_ path: String, body: Body, as type: T.Type = T.self) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = "PATCH"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(to: &req)
        req.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: req)
        try validate(response, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func delete<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = "DELETE"
        applyAuth(to: &req)
        let (data, response) = try await URLSession.shared.data(for: req)
        try validate(response, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func upload(sessionID: String, fileURL: URL) async throws -> ZFile {
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url("/api/sessions/\(sessionID)/files"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        applyAuth(to: &req)

        var body = Data()
        let name = fileURL.lastPathComponent
        let type = UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n")
        body.append("Content-Type: \(type)\r\n\r\n")
        body.append(try Data(contentsOf: fileURL))
        body.append("\r\n--\(boundary)--\r\n")
        req.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: req)
        try validate(response, data)
        struct UploadResponse: Codable { let file: ZFile }
        return try JSONDecoder().decode(UploadResponse.self, from: data).file
    }

    private func applyAuth(to request: inout URLRequest) {
        guard let accessToken else { return }
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(accessToken, forHTTPHeaderField: "X-ZenithDock-Token")
    }

    private func validate(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let text = String(data: data, encoding: .utf8) ?? "Request failed"
            throw NSError(domain: "ZenithDock.API", code: (response as? HTTPURLResponse)?.statusCode ?? -1, userInfo: [
                NSLocalizedDescriptionKey: text
            ])
        }
    }
}

public enum ZenithServerURL {
    public static func normalized(_ value: String, default defaultValue: String) -> String {
        var raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty {
            raw = defaultValue
        }
        while raw.hasSuffix("/") {
            raw.removeLast()
        }
        if !raw.contains("://") {
            raw = "http://\(raw)"
        }

        if var comps = URLComponents(string: raw), comps.host != nil {
            if comps.path == "/api/health" || comps.path == "/health" {
                comps.path = ""
            }
            comps.query = nil
            comps.fragment = nil
            if let normalizedURL = comps.url {
                raw = normalizedURL.absoluteString
            }
        }

        while raw.hasSuffix("/") {
            raw.removeLast()
        }
        return raw
    }

    public static func url(_ value: String, default defaultValue: String) -> URL {
        let normalizedValue = normalized(value, default: defaultValue)
        return URL(string: normalizedValue) ?? URL(string: defaultValue)!
    }
}

public enum ZenithTokenStore {
    private static let service = "com.zhengyiluo.ZenithDock"
    private static let account = "agent-access-token"
    private static let fallbackKey = "agentAccessToken"

    public static func load() -> String {
        var query = baseQuery()
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess,
           let data = result as? Data,
           let token = String(data: data, encoding: .utf8) {
            return token
        }
        return UserDefaults.standard.string(forKey: fallbackKey) ?? ""
    }

    public static func save(_ token: String) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            clear()
            return
        }

        let data = Data(trimmed.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery() as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var item = baseQuery()
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            if SecItemAdd(item as CFDictionary, nil) != errSecSuccess {
                UserDefaults.standard.set(trimmed, forKey: fallbackKey)
            } else {
                UserDefaults.standard.removeObject(forKey: fallbackKey)
            }
        } else if status != errSecSuccess {
            UserDefaults.standard.set(trimmed, forKey: fallbackKey)
        } else {
            UserDefaults.standard.removeObject(forKey: fallbackKey)
        }
    }

    public static func clear() {
        SecItemDelete(baseQuery() as CFDictionary)
        UserDefaults.standard.removeObject(forKey: fallbackKey)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}

private extension Data {
    mutating func append(_ string: String) {
        append(Data(string.utf8))
    }
}
