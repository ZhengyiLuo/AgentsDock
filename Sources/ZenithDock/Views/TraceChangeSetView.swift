import SwiftUI
import ZenithCore

struct TraceChangeSetCard: View {
    let summary: TraceChangeSummary
    @State private var reviewOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 10) {
                Image(systemName: "doc.badge.gearshape")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 28, height: 28)
                    .background(Color.accentColor.opacity(0.16))
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Edited \(summary.files.count) \(summary.files.count == 1 ? "file" : "files")")
                        .font(.subheadline.weight(.semibold))
                    Text(summary.deltaLabel)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button("Review") {
                    reviewOpen = true
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }

            VStack(alignment: .leading, spacing: 0) {
                ForEach(summary.visibleFiles) { file in
                    HStack(spacing: 8) {
                        Text(file.status.shortLabel)
                            .font(.caption2.weight(.bold).monospaced())
                            .foregroundStyle(file.status.color)
                            .frame(width: 18, alignment: .leading)
                        Text(file.path)
                            .font(.caption.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 8)
                    }
                    .padding(.vertical, 4)
                }
                if summary.hiddenFileCount > 0 {
                    Text("Show \(summary.hiddenFileCount) more in review")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.top, 3)
                }
            }
        }
        .padding(12)
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
        .sheet(isPresented: $reviewOpen) {
            TraceChangeReviewSheet(summary: summary)
        }
    }
}

private struct TraceChangeReviewSheet: View {
    let summary: TraceChangeSummary
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text("Code Changes")
                    .font(.headline)
                Text(summary.deltaLabel)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Done") {
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
            .padding(14)
            Divider()
            HStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(summary.files) { file in
                            HStack(spacing: 8) {
                                Text(file.status.shortLabel)
                                    .font(.caption2.weight(.bold).monospaced())
                                    .foregroundStyle(file.status.color)
                                    .frame(width: 18, alignment: .leading)
                                Text(file.path)
                                    .font(.caption.monospaced())
                                    .lineLimit(2)
                                    .truncationMode(.middle)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .background(.secondary.opacity(0.06))
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                        }
                    }
                    .padding(12)
                }
                .frame(width: 320)
                Divider()
                ScrollView {
                    CodeBlock(text: summary.reviewText, language: "diff", limit: 28_000)
                        .padding(14)
                }
            }
        }
        .frame(minWidth: 900, idealWidth: 1080, minHeight: 560, idealHeight: 720)
    }
}

struct TraceChangedFile: Identifiable, Hashable {
    let path: String
    var status: TraceChangeStatus

    var id: String { path }
}

enum TraceChangeStatus: Hashable {
    case added
    case modified
    case deleted
    case renamed
    case unknown

    var shortLabel: String {
        switch self {
        case .added: return "A"
        case .modified: return "M"
        case .deleted: return "D"
        case .renamed: return "R"
        case .unknown: return "*"
        }
    }

    var priority: Int {
        switch self {
        case .added: return 4
        case .deleted: return 3
        case .renamed: return 2
        case .modified: return 1
        case .unknown: return 0
        }
    }

    var color: Color {
        switch self {
        case .added: return .green
        case .modified: return .blue
        case .deleted: return .red
        case .renamed: return .purple
        case .unknown: return .secondary
        }
    }
}

struct TraceChangeSummary: Equatable {
    let files: [TraceChangedFile]
    let insertions: Int
    let deletions: Int
    let reviewText: String

    var visibleFiles: [TraceChangedFile] {
        Array(files.prefix(5))
    }

    var hiddenFileCount: Int {
        max(0, files.count - visibleFiles.count)
    }

    var deltaLabel: String {
        let plus = insertions > 0 ? "+\(insertions)" : "+?"
        let minus = deletions > 0 ? "-\(deletions)" : "-?"
        return "\(plus) \(minus)"
    }

    static func extract(from events: [ZEvent]) -> TraceChangeSummary? {
        var filesByPath: [String: TraceChangedFile] = [:]
        var fileOrder: [String] = []
        var insertions = 0
        var deletions = 0
        var reviewSnippets: [String] = []

        func remember(path rawPath: String, status: TraceChangeStatus) {
            let path = cleanPath(rawPath)
            guard !path.isEmpty, path != "/dev/null" else { return }
            if var existing = filesByPath[path] {
                if status.priority > existing.status.priority {
                    existing.status = status
                    filesByPath[path] = existing
                }
            } else {
                filesByPath[path] = TraceChangedFile(path: path, status: status)
                fileOrder.append(path)
            }
        }

        for event in events.prefix(80) where event.type == "tool_started" || event.type == "tool_finished" {
            for text in candidateTexts(for: event) where hasChangeSignal(text) {
                reviewSnippets.append(String(text.prefix(24_000)))
                let parsed = parse(text)
                for file in parsed.files {
                    remember(path: file.path, status: file.status)
                }
                insertions += parsed.insertions
                deletions += parsed.deletions
            }
        }

        let files = fileOrder.compactMap { filesByPath[$0] }
        guard !files.isEmpty else { return nil }
        let reviewText = reviewSnippets
            .joined(separator: "\n\n---\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return TraceChangeSummary(
            files: files,
            insertions: insertions,
            deletions: deletions,
            reviewText: reviewText.isEmpty ? files.map(\.path).joined(separator: "\n") : reviewText
        )
    }

    private static func candidateTexts(for event: ZEvent) -> [String] {
        [
            event.tool?.traceCommandText,
            event.tool?.input?.pretty,
            event.output
        ]
        .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
    }

    private static func hasChangeSignal(_ text: String) -> Bool {
        let lower = text.lowercased()
        return lower.contains("*** update file:") ||
            lower.contains("*** add file:") ||
            lower.contains("*** delete file:") ||
            lower.contains("files changed") ||
            lower.contains("git diff") ||
            lower.contains("git status") ||
            lower.contains("diff --git") ||
            lower.contains("success. updated the following files:")
    }

    private static func parse(_ text: String) -> (files: [TraceChangedFile], insertions: Int, deletions: Int) {
        var files: [TraceChangedFile] = []
        var insertions = 0
        var deletions = 0

        func append(_ path: String, _ status: TraceChangeStatus) {
            files.append(TraceChangedFile(path: cleanPath(path), status: status))
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            let lower = trimmed.lowercased()

            if lower.hasPrefix("*** update file:") {
                append(String(trimmed.dropFirst("*** Update File:".count)), .modified)
            } else if lower.hasPrefix("*** add file:") {
                append(String(trimmed.dropFirst("*** Add File:".count)), .added)
            } else if lower.hasPrefix("*** delete file:") {
                append(String(trimmed.dropFirst("*** Delete File:".count)), .deleted)
            } else if lower.hasPrefix("*** move to:") {
                append(String(trimmed.dropFirst("*** Move to:".count)), .renamed)
            } else if lower.hasPrefix("diff --git "), let path = trimmed.components(separatedBy: " b/").last {
                append(path, .modified)
            } else if let statusFile = parseGitStatusLine(rawLine) {
                append(statusFile.path, statusFile.status)
            } else if let stat = parseDiffStatLine(trimmed) {
                append(stat.path, .modified)
                insertions += stat.insertions
                deletions += stat.deletions
            } else if lower.contains("files changed") || lower.contains("file changed") {
                insertions += countNumber(before: "insertion", in: lower)
                deletions += countNumber(before: "deletion", in: lower)
            }
        }

        return (files, insertions, deletions)
    }

    private static func parseGitStatusLine(_ line: String) -> (path: String, status: TraceChangeStatus)? {
        guard line.count >= 4 else { return nil }
        let prefix = String(line.prefix(3))
        let path = String(line.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return nil }
        switch prefix {
        case " M ", "M  ", "MM ", "AM ":
            return (path, .modified)
        case " A ", "A  ", "?? ":
            return (path, .added)
        case " D ", "D  ":
            return (path, .deleted)
        case " R ", "R  ":
            return (path, .renamed)
        default:
            return nil
        }
    }

    private static func parseDiffStatLine(_ line: String) -> (path: String, insertions: Int, deletions: Int)? {
        guard line.contains("|"), !line.contains("files changed") else { return nil }
        let parts = line.split(separator: "|", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        let path = parts[0].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty, !path.hasPrefix("...") else { return nil }
        let markerText = parts[1]
        let insertions = markerText.filter { $0 == "+" }.count
        let deletions = markerText.filter { $0 == "-" }.count
        guard insertions + deletions > 0 else { return nil }
        return (path, insertions, deletions)
    }

    private static func countNumber(before marker: String, in text: String) -> Int {
        guard let range = text.range(of: marker) else { return 0 }
        let prefix = text[..<range.lowerBound]
        return prefix
            .split(whereSeparator: { !$0.isNumber })
            .last
            .flatMap { Int($0) } ?? 0
    }

    private static func cleanPath(_ raw: String) -> String {
        var path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.hasPrefix("a/") || path.hasPrefix("b/") {
            path.removeFirst(2)
        }
        return path.trimmingCharacters(in: CharacterSet(charactersIn: "\"'` "))
    }
}

extension ZTool {
    var traceCommandText: String? {
        guard let input else { return nil }
        if case .object(let object) = input,
           case .string(let command)? = object["command"],
           !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return command
        }
        return nil
    }
}
