import Foundation
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
    public var created_at: String?
    public var updated_at: String?
}

public struct ZFile: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public var session_id: String?
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

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }

    public func url(_ path: String) -> URL {
        baseURL.appending(path: path)
    }

    public func wsURL(sessionID: String, after: Int) -> URL {
        var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comps.scheme = comps.scheme == "https" ? "wss" : "ws"
        comps.path = "/api/sessions/\(sessionID)/events"
        comps.queryItems = [URLQueryItem(name: "after", value: "\(after)")]
        return comps.url!
    }

    public func get<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        let (data, response) = try await URLSession.shared.data(from: url(path))
        try validate(response, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func get<T: Decodable>(_ path: String, queryItems: [URLQueryItem], as type: T.Type = T.self) async throws -> T {
        var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comps.path = path
        comps.queryItems = queryItems.isEmpty ? nil : queryItems
        let (data, response) = try await URLSession.shared.data(from: comps.url!)
        try validate(response, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func post<Body: Encodable, T: Decodable>(_ path: String, body: Body, as type: T.Type = T.self) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: req)
        try validate(response, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func patch<Body: Encodable, T: Decodable>(_ path: String, body: Body, as type: T.Type = T.self) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = "PATCH"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: req)
        try validate(response, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func delete<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = "DELETE"
        let (data, response) = try await URLSession.shared.data(for: req)
        try validate(response, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func upload(sessionID: String, fileURL: URL) async throws -> ZFile {
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url("/api/sessions/\(sessionID)/files"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

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

    private func validate(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let text = String(data: data, encoding: .utf8) ?? "Request failed"
            throw NSError(domain: "ZenithDock.API", code: (response as? HTTPURLResponse)?.statusCode ?? -1, userInfo: [
                NSLocalizedDescriptionKey: text
            ])
        }
    }
}

private extension Data {
    mutating func append(_ string: String) {
        append(Data(string.utf8))
    }
}
