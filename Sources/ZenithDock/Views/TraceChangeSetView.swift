import AppKit
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
    @State private var selectedFileID: String?
    @State private var copied = false

    private var sections: [TraceReviewFileSection] {
        TraceReviewFileSection.build(from: summary)
    }

    private var selectedSection: TraceReviewFileSection {
        let selected = selectedFileID ?? sections.first?.id
        return sections.first { $0.id == selected } ?? sections.first ?? TraceReviewFileSection.empty(summary: summary)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "document.badge.gearshape")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 30, height: 30)
                    .background(Color.accentColor.opacity(0.16))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                Text("Code Changes")
                    .font(.headline)
                Text(summary.deltaLabel)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    copyText(summary.reviewText)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.2))
                        copied = false
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy Diff", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                Button("Done") {
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
            .padding(14)
            Divider()
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(sections) { section in
                                TraceReviewFileRow(
                                    section: section,
                                    isSelected: selectedSection.id == section.id
                                ) {
                                    selectedFileID = section.id
                                }
                            }
                        }
                        .padding(10)
                    }
                }
                .frame(width: 315)
                .background(Color.primary.opacity(0.025))
                Divider()
                TraceReviewDiffPane(section: selectedSection)
            }
        }
        .background(Theme.window)
        .frame(minWidth: 980, idealWidth: 1180, minHeight: 650, idealHeight: 780)
    }

    private func copyText(_ string: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
    }
}

private struct TraceReviewFileRow: View {
    let section: TraceReviewFileSection
    let isSelected: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(section.status.shortLabel)
                        .font(.caption2.weight(.bold).monospaced())
                        .foregroundStyle(section.status.color)
                        .frame(width: 18, alignment: .leading)
                    Text(section.path)
                        .font(.caption.weight(.semibold).monospaced())
                        .lineLimit(2)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                }
                HStack(spacing: 8) {
                    if section.insertions > 0 {
                        Text("+\(section.insertions)")
                            .foregroundStyle(.green)
                    }
                    if section.deletions > 0 {
                        Text("-\(section.deletions)")
                            .foregroundStyle(.red)
                    }
                    if section.insertions == 0 && section.deletions == 0 {
                        Text("\(section.lines.count) lines")
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.caption2.monospacedDigit())
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? Color.accentColor.opacity(0.16) : Color.primary.opacity(0.045))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .stroke(isSelected ? Color.accentColor.opacity(0.35) : Color.clear, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
    }
}

private struct TraceReviewDiffPane: View {
    let section: TraceReviewFileSection

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(section.path)
                    .font(.subheadline.weight(.semibold).monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                if section.insertions > 0 {
                    Text("+\(section.insertions)")
                        .foregroundStyle(.green)
                }
                if section.deletions > 0 {
                    Text("-\(section.deletions)")
                        .foregroundStyle(.red)
                }
            }
            .font(.caption.monospacedDigit())
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.primary.opacity(0.045))
            Divider()

            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(section.lines) { line in
                        TraceDiffLineView(line: line)
                    }
                }
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct TraceDiffLineView: View {
    let line: TraceReviewLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(line.oldNumber.map(String.init) ?? " ")
                .frame(width: 42, alignment: .trailing)
            Text(line.newNumber.map(String.init) ?? " ")
                .frame(width: 42, alignment: .trailing)
            Text(line.prefix)
                .frame(width: 20, alignment: .center)
            Text(line.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
                .frame(minWidth: 0, alignment: .leading)
        }
        .font(.system(size: 12.5, weight: .regular, design: .monospaced))
        .foregroundStyle(line.foreground)
        .padding(.horizontal, 10)
        .padding(.vertical, line.kind == .hunk ? 5 : 2)
        .background(line.background)
    }
}

private struct TraceReviewFileSection: Identifiable, Equatable {
    let id: String
    let path: String
    let status: TraceChangeStatus
    let lines: [TraceReviewLine]

    var insertions: Int {
        lines.filter { $0.kind == .added }.count
    }

    var deletions: Int {
        lines.filter { $0.kind == .removed }.count
    }

    static func empty(summary: TraceChangeSummary) -> TraceReviewFileSection {
        TraceReviewFileSection(
            id: "changes",
            path: "Changes",
            status: .unknown,
            lines: TraceReviewLine.parse(summary.reviewText)
        )
    }

    static func build(from summary: TraceChangeSummary) -> [TraceReviewFileSection] {
        let parsed = parseSections(from: summary.reviewText, knownFiles: summary.files)
        if !parsed.isEmpty {
            return parsed
        }
        return summary.files.map { file in
            TraceReviewFileSection(
                id: file.path,
                path: file.path,
                status: file.status,
                lines: TraceReviewLine.parse(summary.reviewText)
            )
        }
    }

    private static func parseSections(from text: String, knownFiles: [TraceChangedFile]) -> [TraceReviewFileSection] {
        let knownByPath = Dictionary(uniqueKeysWithValues: knownFiles.map { ($0.path, $0.status) })
        var sections: [TraceReviewFileSection] = []
        var currentPath: String?
        var currentStatus: TraceChangeStatus = .modified
        var currentLines: [String] = []

        func flush() {
            guard let path = currentPath else { return }
            sections.append(TraceReviewFileSection(
                id: path,
                path: path,
                status: knownByPath[path] ?? currentStatus,
                lines: TraceReviewLine.parse(currentLines.joined(separator: "\n"))
            ))
            currentLines.removeAll(keepingCapacity: true)
        }

        for line in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if let header = fileHeader(from: line) {
                flush()
                currentPath = header.path
                currentStatus = header.status
                currentLines = [line]
            } else if currentPath != nil {
                currentLines.append(line)
            }
        }
        flush()
        return sections
    }

    private static func fileHeader(from line: String) -> (path: String, status: TraceChangeStatus)? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        if lower.hasPrefix("*** update file:") {
            return (TraceChangeSummary.cleanPathForReview(String(trimmed.dropFirst("*** Update File:".count))), .modified)
        }
        if lower.hasPrefix("*** add file:") {
            return (TraceChangeSummary.cleanPathForReview(String(trimmed.dropFirst("*** Add File:".count))), .added)
        }
        if lower.hasPrefix("*** delete file:") {
            return (TraceChangeSummary.cleanPathForReview(String(trimmed.dropFirst("*** Delete File:".count))), .deleted)
        }
        if lower.hasPrefix("diff --git "), let path = trimmed.components(separatedBy: " b/").last {
            return (TraceChangeSummary.cleanPathForReview(path), .modified)
        }
        return nil
    }
}

private struct TraceReviewLine: Identifiable, Equatable {
    enum Kind: Equatable {
        case context
        case added
        case removed
        case hunk
        case metadata
    }

    let id: Int
    let kind: Kind
    let oldNumber: Int?
    let newNumber: Int?
    let text: String

    var prefix: String {
        switch kind {
        case .added: "+"
        case .removed: "-"
        default: " "
        }
    }

    var foreground: Color {
        switch kind {
        case .hunk, .metadata: .secondary
        default: .primary
        }
    }

    var background: Color {
        switch kind {
        case .added: Color.green.opacity(0.16)
        case .removed: Color.red.opacity(0.16)
        case .hunk: Color.primary.opacity(0.08)
        case .metadata: Color.primary.opacity(0.035)
        case .context: Color.clear
        }
    }

    static func parse(_ text: String) -> [TraceReviewLine] {
        var oldLine: Int?
        var newLine: Int?
        var output: [TraceReviewLine] = []

        for (index, rawLine) in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init).enumerated() {
            let kind: Kind
            let oldNumber: Int?
            let newNumber: Int?
            let displayText: String

            if rawLine.hasPrefix("@@") {
                let parsed = parseHunkHeader(rawLine)
                oldLine = parsed.old
                newLine = parsed.new
                kind = .hunk
                oldNumber = nil
                newNumber = nil
                displayText = rawLine
            } else if rawLine.hasPrefix("+"), !rawLine.hasPrefix("+++") {
                kind = .added
                oldNumber = nil
                newNumber = newLine
                newLine = newLine.map { $0 + 1 }
                displayText = String(rawLine.dropFirst())
            } else if rawLine.hasPrefix("-"), !rawLine.hasPrefix("---") {
                kind = .removed
                oldNumber = oldLine
                newNumber = nil
                oldLine = oldLine.map { $0 + 1 }
                displayText = String(rawLine.dropFirst())
            } else if rawLine.hasPrefix("***") || rawLine.hasPrefix("diff --git") || rawLine.hasPrefix("index ") || rawLine.hasPrefix("+++") || rawLine.hasPrefix("---") {
                kind = .metadata
                oldNumber = nil
                newNumber = nil
                displayText = rawLine
            } else {
                kind = .context
                oldNumber = oldLine
                newNumber = newLine
                oldLine = oldLine.map { $0 + 1 }
                newLine = newLine.map { $0 + 1 }
                displayText = rawLine.hasPrefix(" ") ? String(rawLine.dropFirst()) : rawLine
            }

            output.append(TraceReviewLine(
                id: index,
                kind: kind,
                oldNumber: oldNumber,
                newNumber: newNumber,
                text: displayText.isEmpty ? " " : displayText
            ))
        }

        return output
    }

    private static func parseHunkHeader(_ line: String) -> (old: Int?, new: Int?) {
        let parts = line.split(separator: " ")
        var oldStart: Int?
        var newStart: Int?
        for part in parts {
            if part.hasPrefix("-") {
                oldStart = part.dropFirst().split(separator: ",").first.flatMap { Int($0) }
            } else if part.hasPrefix("+") {
                newStart = part.dropFirst().split(separator: ",").first.flatMap { Int($0) }
            }
        }
        return (oldStart, newStart)
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
            guard isLikelyChangedPath(path) else { return }
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

    static func cleanPathForReview(_ raw: String) -> String {
        cleanPath(raw)
    }

    private static func cleanPath(_ raw: String) -> String {
        var path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.hasPrefix("a/") || path.hasPrefix("b/") {
            path.removeFirst(2)
        }
        return path.trimmingCharacters(in: CharacterSet(charactersIn: "\"'` "))
    }

    private static func isLikelyChangedPath(_ path: String) -> Bool {
        guard !path.isEmpty, path != "/dev/null", path != "---", path != "+++" else { return false }
        guard !path.hasPrefix("+"), !path.hasPrefix("-") else { return false }
        guard !(path.contains(" ") && !path.contains("/")) else { return false }
        return true
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
