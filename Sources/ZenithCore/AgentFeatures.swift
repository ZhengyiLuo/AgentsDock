import Foundation

public struct ZTimelineSearchResult: Codable, Identifiable, Hashable, Sendable {
    public var session_id: String
    public var event_id: String
    public var seq: Int
    public var ts: String?
    public var role: String
    public var snippet: String
    public var match_count: Int?

    public var id: String { "\(session_id):\(event_id)" }
}

public struct ZTimelineSearchResponse: Codable, Hashable, Sendable {
    public var results: [ZTimelineSearchResult]
}

public struct ZTimelineLandmark: Codable, Identifiable, Hashable, Sendable {
    public var key: String
    public var kind: String
    public var start_seq: Int
    public var end_seq: Int
    public var title: String
    public var preview: String
    public var meta: String?
    public var timestamp: String?

    public var id: String { key }
}

public struct ZTimelineIndex: Codable, Hashable, Sendable {
    public var session_id: String
    public var landmarks: [ZTimelineLandmark]
    public var latest_seq: Int
    public var event_count: Int
    public var generated_at: String?
}

public struct ZTerminalWindow: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var index: Int
    public var name: String
    public var active: Bool
    public var panes: Int
}

public struct ZTerminalWindowsSnapshot: Codable, Hashable, Sendable {
    public var session_id: String
    public var name: String
    public var exists: Bool
    public var mouse_enabled: Bool?
    public var windows: [ZTerminalWindow]
}

public enum ZTerminalAction: String, Codable, Hashable, Sendable {
    case newWindow = "new-window"
    case splitRight = "split-right"
    case splitDown = "split-down"
    case nextWindow = "next-window"
    case previousWindow = "previous-window"
    case selectWindow = "select-window"
    case killWindow = "kill-window"
    case killPane = "kill-pane"
    case toggleMouse = "toggle-mouse"
}

public struct ZPinnedItem: Codable, Identifiable, Hashable, Sendable {
    public enum Kind: String, Codable, Hashable, Sendable {
        case message
        case file
    }

    public var id: String
    public var sessionID: String
    public var kind: Kind
    public var eventID: String?
    public var eventSeq: Int?
    public var fileID: String?
    public var title: String
    public var subtitle: String?
    public var body: String?
    public var createdAt: Date

    public init(
        id: String,
        sessionID: String,
        kind: Kind,
        eventID: String? = nil,
        eventSeq: Int? = nil,
        fileID: String? = nil,
        title: String,
        subtitle: String? = nil,
        body: String? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.sessionID = sessionID
        self.kind = kind
        self.eventID = eventID
        self.eventSeq = eventSeq
        self.fileID = fileID
        self.title = title
        self.subtitle = subtitle
        self.body = body
        self.createdAt = createdAt
    }
}

public enum ZDiffLineKind: String, Codable, Hashable, Sendable {
    case context
    case added
    case removed
    case hunk
    case metadata
}

public struct ZDiffLine: Identifiable, Hashable, Sendable {
    public var id: String
    public var kind: ZDiffLineKind
    public var oldNumber: Int?
    public var newNumber: Int?
    public var prefix: String
    public var text: String
}

public struct ZDiffFile: Identifiable, Hashable, Sendable {
    public var id: String { path }
    public var path: String
    public var oldPath: String?
    public var newPath: String?
    public var lines: [ZDiffLine]

    public var additions: Int { lines.lazy.filter { $0.kind == .added }.count }
    public var deletions: Int { lines.lazy.filter { $0.kind == .removed }.count }
}

public struct ZUnifiedDiff: Hashable, Sendable {
    public var files: [ZDiffFile]
    public var source: String

    public var additions: Int { files.reduce(0) { $0 + $1.additions } }
    public var deletions: Int { files.reduce(0) { $0 + $1.deletions } }
}

public enum ZUnifiedDiffParser {
    public static func parse(_ source: String) -> ZUnifiedDiff {
        guard !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return ZUnifiedDiff(files: [], source: source)
        }
        let rawLines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var files: [ZDiffFile] = []
        var currentPath: String?
        var oldPath: String?
        var newPath: String?
        var currentLines: [ZDiffLine] = []
        var oldLine: Int?
        var newLine: Int?
        var fileOrdinal = 0

        func cleanPath(_ value: String) -> String? {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed != "/dev/null" else { return nil }
            let unquoted = trimmed.hasPrefix("\"") && trimmed.hasSuffix("\"")
                ? String(trimmed.dropFirst().dropLast())
                : trimmed
            if unquoted.hasPrefix("a/") || unquoted.hasPrefix("b/") {
                return String(unquoted.dropFirst(2))
            }
            return unquoted
        }

        func flush() {
            guard currentPath != nil || !currentLines.isEmpty else { return }
            let path = currentPath ?? newPath ?? oldPath ?? "Changes"
            files.append(ZDiffFile(path: path, oldPath: oldPath, newPath: newPath, lines: currentLines))
            fileOrdinal += 1
            currentPath = nil
            oldPath = nil
            newPath = nil
            currentLines = []
            oldLine = nil
            newLine = nil
        }

        func append(_ kind: ZDiffLineKind, _ prefix: String, _ text: String, old: Int? = nil, new: Int? = nil) {
            currentLines.append(ZDiffLine(
                id: "\(fileOrdinal):\(currentLines.count)",
                kind: kind,
                oldNumber: old,
                newNumber: new,
                prefix: prefix,
                text: text
            ))
        }

        for raw in rawLines {
            if raw.hasPrefix("diff --git ") {
                flush()
                let parts = raw.split(separator: " ", omittingEmptySubsequences: true)
                if parts.count >= 4 {
                    oldPath = cleanPath(String(parts[2]))
                    newPath = cleanPath(String(parts[3]))
                    currentPath = newPath ?? oldPath
                }
                append(.metadata, "", raw)
                continue
            }
            if raw.hasPrefix("--- ") {
                oldPath = cleanPath(String(raw.dropFirst(4)))
                append(.metadata, "", raw)
                continue
            }
            if raw.hasPrefix("+++ ") {
                newPath = cleanPath(String(raw.dropFirst(4)))
                currentPath = newPath ?? oldPath ?? currentPath
                append(.metadata, "", raw)
                continue
            }
            if raw.hasPrefix("@@") {
                let range = parseHunkHeader(raw)
                oldLine = range.old
                newLine = range.new
                append(.hunk, "", raw)
                continue
            }
            if raw.hasPrefix("+") {
                append(.added, "+", String(raw.dropFirst()), new: newLine)
                if let value = newLine { newLine = value + 1 }
                continue
            }
            if raw.hasPrefix("-") {
                append(.removed, "-", String(raw.dropFirst()), old: oldLine)
                if let value = oldLine { oldLine = value + 1 }
                continue
            }
            if raw.hasPrefix(" ") {
                append(.context, " ", String(raw.dropFirst()), old: oldLine, new: newLine)
                if let value = oldLine { oldLine = value + 1 }
                if let value = newLine { newLine = value + 1 }
                continue
            }
            append(.metadata, "", raw)
        }
        flush()
        return ZUnifiedDiff(files: files, source: source)
    }

    private static func parseHunkHeader(_ line: String) -> (old: Int?, new: Int?) {
        let pattern = #"@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@"#
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let match = expression.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              let oldRange = Range(match.range(at: 1), in: line),
              let newRange = Range(match.range(at: 2), in: line) else {
            return (nil, nil)
        }
        return (Int(line[oldRange]), Int(line[newRange]))
    }
}
