import Foundation
import SwiftUI
import ZenithCore

#if os(macOS)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

struct MarkdownView: View {
    let markdown: String
    var copyMarkdown: String? = nil
    var alignment: HorizontalAlignment = .leading
    var compact = false
    var allowTruncation = true
    var linkContext: ZMarkdownLinkContext?

    private var blocks: [MarkdownBlock] {
        MarkdownRenderCache.blocks(for: Self.renderable(markdown, allowTruncation: allowTruncation))
    }

    private var copyCodeBlocks: [MarkdownBlock] {
        let source = copyMarkdown ?? markdown
        return MarkdownRenderCache.blocks(for: Self.renderable(source, allowTruncation: false))
            .filter { $0.kind == .code }
    }

    private var frameAlignment: Alignment {
        alignment == .trailing ? .trailing : .leading
    }

    var body: some View {
        VStack(alignment: alignment, spacing: compact ? 8 : 12) {
            ForEach(blocks) { block in
                switch block.kind {
                case .prose:
                    MarkdownText(block.text, linkContext: linkContext)
                        .frame(maxWidth: .infinity, alignment: frameAlignment)
                case .code:
                    CodeBlock(text: block.text, copySource: copyCodeText(for: block), language: block.language)
                case .table:
                    if let table = block.table {
                        MarkdownTableView(table: table, linkContext: linkContext)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: frameAlignment)
    }

    private func copyCodeText(for block: MarkdownBlock) -> String {
        let visibleCodeIndex = blocks
            .filter { $0.kind == .code && $0.id < block.id }
            .count
        return copyCodeBlocks[safe: visibleCodeIndex]?.text ?? block.text
    }

    private static func renderable(_ text: String, allowTruncation: Bool) -> String {
        let text = EmojiShortcodes.stripDecorativePrefixes(text)
        guard allowTruncation else { return text }
        let max = 32_000
        guard text.count > max else { return text }
        return String(text.prefix(max)) + "\n\n[message trimmed for UI]"
    }
}

private struct MarkdownText: View {
    let text: String
    var linkContext: ZMarkdownLinkContext?
    @AppStorage("chatFontSize") private var chatFontSize = 14.0
    @AppStorage("chatFontDesign") private var chatFontDesign = "default"

    init(_ text: String, linkContext: ZMarkdownLinkContext? = nil) {
        self.text = EmojiShortcodes.render(text)
        self.linkContext = linkContext
    }

    var body: some View {
        Text(attributed)
            .lineSpacing(lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .contextMenu {
                Button("Copy Text") {
                    copyToPasteboard(ZClipboardText.normalizedForCopy(text))
                }
            }
    }

    private var attributed: AttributedString {
        MarkdownRenderCache.attributedText(for: text, fontSize: chatFontSize, design: chatFontDesign, linkContext: linkContext)
    }

    private var lineSpacing: CGFloat {
        max(3, chatFontSize * 0.22)
    }

    private func copyToPasteboard(_ string: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        #elseif canImport(UIKit)
        UIPasteboard.general.string = string
        #endif
    }
}

private enum EmojiShortcodes {
    private static let map: [String: String] = [
        "+1": "\u{1F44D}",
        "-1": "\u{1F44E}",
        "100": "\u{1F4AF}",
        "bangbang": "\u{203C}\u{FE0F}",
        "boom": "\u{1F4A5}",
        "bulb": "\u{1F4A1}",
        "check": "\u{2705}",
        "checkered_flag": "\u{1F3C1}",
        "clap": "\u{1F44F}",
        "eyes": "\u{1F440}",
        "fire": "\u{1F525}",
        "green_circle": "\u{1F7E2}",
        "grey_question": "\u{2754}",
        "heart": "\u{2764}\u{FE0F}",
        "heavy_check_mark": "\u{2714}\u{FE0F}",
        "information_source": "\u{2139}\u{FE0F}",
        "joy": "\u{1F602}",
        "large_blue_circle": "\u{1F535}",
        "large_green_circle": "\u{1F7E2}",
        "large_red_circle": "\u{1F534}",
        "large_yellow_circle": "\u{1F7E1}",
        "memo": "\u{1F4DD}",
        "no_entry": "\u{26D4}",
        "ok_hand": "\u{1F44C}",
        "point_down": "\u{1F447}",
        "point_left": "\u{1F448}",
        "point_right": "\u{1F449}",
        "point_up": "\u{261D}\u{FE0F}",
        "raised_hands": "\u{1F64C}",
        "red_circle": "\u{1F534}",
        "rocket": "\u{1F680}",
        "rotating_light": "\u{1F6A8}",
        "smile": "\u{1F604}",
        "sparkles": "\u{2728}",
        "thumbsdown": "\u{1F44E}",
        "thumbsup": "\u{1F44D}",
        "trophy": "\u{1F3C6}",
        "warning": "\u{26A0}\u{FE0F}",
        "white_check_mark": "\u{2705}",
        "x": "\u{274C}",
        "yellow_circle": "\u{1F7E1}",
        "zap": "\u{26A1}"
    ]

    static func render(_ text: String) -> String {
        guard text.contains(":") else { return text }
        let pattern = #":([A-Za-z0-9_+\-]+):"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }

        var result = text
        let matches = regex.matches(in: text, range: NSRange(text.startIndex..<text.endIndex, in: text)).reversed()
        for match in matches {
            guard match.numberOfRanges == 2,
                  let fullRange = Range(match.range(at: 0), in: result),
                  let nameRange = Range(match.range(at: 1), in: text) else {
                continue
            }
            let name = String(text[nameRange]).lowercased()
            if let emoji = map[name] {
                result.replaceSubrange(fullRange, with: emoji)
            }
        }
        return result
    }

    static func stripDecorativePrefixes(_ text: String) -> String {
        guard text.contains(":") else { return text }
        let pattern = #"(?m)^[ \t]*(?::[A-Za-z0-9_+\-]+:[ \t]*)+"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: "")
    }
}

private struct MarkdownTableView: View {
    let table: MarkdownTable
    var linkContext: ZMarkdownLinkContext?
    @AppStorage("chatFontSize") private var chatFontSize = 14.0

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                tableRow(table.headers, isHeader: true)
                Divider()
                ForEach(Array(table.rows.enumerated()), id: \.offset) { index, row in
                    tableRow(row, isHeader: false)
                        .background(index.isMultiple(of: 2) ? Color.clear : Color.primary.opacity(0.025))
                    if index < table.rows.count - 1 {
                        Divider()
                    }
                }
            }
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
            .textSelection(.enabled)
            .contextMenu {
                Button("Copy Table") {
                    copyToPasteboard(table.plainText)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tableRow(_ cells: [String], isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(0..<table.columnCount, id: \.self) { column in
                tableCell(
                    text: column < cells.count ? cells[column] : "",
                    column: column,
                    isHeader: isHeader
                )
            }
        }
    }

    private func tableCell(text: String, column: Int, isHeader: Bool) -> some View {
        Text(MarkdownRenderCache.attributedText(
            for: text,
            fontSize: max(12, chatFontSize - (isHeader ? 0 : 1)),
            design: isHeader ? "default" : "default",
            linkContext: linkContext
        ))
        .fontWeight(isHeader ? .semibold : .regular)
        .lineLimit(nil)
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: table.columnWidth(column), alignment: table.alignments[safe: column]?.swiftAlignment ?? .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, isHeader ? 9 : 8)
        .background(isHeader ? Color.primary.opacity(0.045) : Color.clear)
        .overlay(alignment: .trailing) {
            if column < table.columnCount - 1 {
                Rectangle()
                    .fill(Theme.softLine)
                    .frame(width: 1)
            }
        }
    }

    private func copyToPasteboard(_ string: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        #elseif canImport(UIKit)
        UIPasteboard.general.string = string
        #endif
    }
}

struct CodeBlock: View {
    let text: String
    var copySource: String? = nil
    var language: String?
    var limit: Int?

    @State private var copied = false
    @AppStorage("chatFontSize") private var chatFontSize = 14.0

    private var shown: String {
        let effectiveLimit = limit ?? 12_000
        guard text.count > effectiveLimit else { return text }
        return String(text.prefix(effectiveLimit)).trimmingCharacters(in: .whitespacesAndNewlines) + "\n..."
    }

    private var visibleDisplayText: String {
        ZClipboardText.normalizedForCopy(shown, language: language)
    }

    private var copyText: String {
        ZClipboardText.normalizedForCopy(copySource ?? text, language: language)
    }

    private var languageLabel: String {
        let clean = language?.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean?.isEmpty == false ? clean! : "code"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(languageLabel)
                    .font(.caption.weight(.semibold).monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    copyToPasteboard(copyText)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.2))
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help(copied ? "Copied" : "Copy full code")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.black.opacity(0.045))

            Divider()

            ScrollView(.horizontal, showsIndicators: true) {
                Text(CodeHighlighter.highlight(visibleDisplayText, language: language, fontSize: max(12, chatFontSize - 1)))
                    .padding(12)
                    .fixedSize(horizontal: true, vertical: false)
                    .textSelection(.enabled)
                    .frame(minWidth: 0, alignment: .leading)
                    .contextMenu {
                        Button("Copy Code") {
                            copyToPasteboard(copyText)
                        }
                    }
            }
        }
        .background(.black.opacity(0.065))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func copyToPasteboard(_ string: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        #elseif canImport(UIKit)
        UIPasteboard.general.string = string
        #endif
    }
}

private struct MarkdownBlock: Identifiable {
    enum Kind {
        case prose
        case code
        case table
    }

    let id: Int
    let kind: Kind
    let text: String
    let language: String?
    let table: MarkdownTable?
}

private enum MarkdownColumnAlignment: Hashable {
    case leading
    case center
    case trailing

    var swiftAlignment: Alignment {
        switch self {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

private struct MarkdownTable: Hashable {
    let headers: [String]
    let alignments: [MarkdownColumnAlignment]
    let rows: [[String]]

    var columnCount: Int {
        max(headers.count, rows.map(\.count).max() ?? 0)
    }

    func columnWidth(_ column: Int) -> CGFloat {
        let samples = ([headers[safe: column]] + rows.map { $0[safe: column] }).compactMap { $0 }
        let longest = samples.map(\.count).max() ?? 0
        if alignments[safe: column] == .trailing {
            return min(max(CGFloat(longest) * 8.5 + 24, 76), 130)
        }
        return min(max(CGFloat(longest) * 7.6 + 28, 96), 360)
    }

    var plainText: String {
        ([headers] + rows)
            .map { $0.joined(separator: "\t") }
            .joined(separator: "\n")
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

private final class MarkdownBlocksEntry: NSObject {
    let blocks: [MarkdownBlock]

    init(_ blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }
}

private final class AttributedStringEntry: NSObject {
    let value: AttributedString

    init(_ value: AttributedString) {
        self.value = value
    }
}

private enum MarkdownRenderCache {
    nonisolated(unsafe) private static let blockCache: NSCache<NSString, MarkdownBlocksEntry> = {
        let cache = NSCache<NSString, MarkdownBlocksEntry>()
        cache.countLimit = 600
        cache.totalCostLimit = 6_000_000
        return cache
    }()

    nonisolated(unsafe) private static let attributedCache: NSCache<NSString, AttributedStringEntry> = {
        let cache = NSCache<NSString, AttributedStringEntry>()
        cache.countLimit = 900
        cache.totalCostLimit = 8_000_000
        return cache
    }()

    nonisolated(unsafe) private static let codeCache: NSCache<NSString, AttributedStringEntry> = {
        let cache = NSCache<NSString, AttributedStringEntry>()
        cache.countLimit = 250
        cache.totalCostLimit = 8_000_000
        return cache
    }()

    static func blocks(for markdown: String) -> [MarkdownBlock] {
        let key = cacheKey("blocks", markdown)
        if let cached = blockCache.object(forKey: key) {
            return cached.blocks
        }
        let parsed = MarkdownParser.parse(markdown)
        blockCache.setObject(MarkdownBlocksEntry(parsed), forKey: key, cost: markdown.utf8.count)
        return parsed
    }

    static func attributedText(for text: String, fontSize: Double, design: String, linkContext: ZMarkdownLinkContext? = nil) -> AttributedString {
        let key = cacheKey("text:\(fontSize):\(design):\(linkContext?.cacheKey ?? "-")", text)
        if let cached = attributedCache.object(forKey: key) {
            return cached.value
        }

        let rendered = EmojiShortcodes.render(text)
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        var parsed = (try? AttributedString(markdown: rendered, options: options)) ?? AttributedString(rendered)
        parsed.font = .system(size: fontSize, design: fontDesign(for: design))
        autolinkBareURLs(in: &parsed)
        resolveMarkdownLinks(in: &parsed, context: linkContext)
        attributedCache.setObject(AttributedStringEntry(parsed), forKey: key, cost: rendered.utf8.count)
        return parsed
    }

    static func highlightedCode(_ source: String, language: String?, fontSize: Double) -> AttributedString {
        let normalized = language ?? ""
        let key = cacheKey("code:\(fontSize):\(normalized)", source)
        if let cached = codeCache.object(forKey: key) {
            return cached.value
        }

        let highlighted = CodeHighlighter.highlightUncached(source, language: language, fontSize: fontSize)
        codeCache.setObject(AttributedStringEntry(highlighted), forKey: key, cost: source.utf8.count)
        return highlighted
    }

    private static func cacheKey(_ scope: String, _ text: String) -> NSString {
        "\(scope):\(text.count):\(text.hashValue)" as NSString
    }

    private static func fontDesign(for name: String) -> Font.Design {
        switch name {
        case "rounded": return .rounded
        case "serif": return .serif
        case "monospaced": return .monospaced
        default: return .default
        }
    }

    private static func autolinkBareURLs(in attributed: inout AttributedString) {
        let displayedText = String(attributed.characters)
        guard displayedText.contains("://"),
              let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return
        }

        let nsRange = NSRange(displayedText.startIndex..<displayedText.endIndex, in: displayedText)
        for match in detector.matches(in: displayedText, range: nsRange) {
            guard let url = match.url,
                  let range = Range(match.range, in: displayedText),
                  let lower = AttributedString.Index(range.lowerBound, within: attributed),
                  let upper = AttributedString.Index(range.upperBound, within: attributed) else {
                continue
            }
            attributed[lower..<upper].link = url
            attributed[lower..<upper].foregroundColor = .accentColor
        }
    }

    private static func resolveMarkdownLinks(in attributed: inout AttributedString, context: ZMarkdownLinkContext?) {
        guard let context else { return }
        for run in attributed.runs {
            guard let link = run.link else { continue }
            let raw = link.scheme == nil ? link.relativeString : link.absoluteString
            guard let resolved = context.resolvedURL(for: raw) else { continue }
            attributed[run.range].link = resolved
            attributed[run.range].foregroundColor = .accentColor
            attributed[run.range].underlineStyle = .single
        }
    }
}

private enum MarkdownParser {
    static func parse(_ markdown: String) -> [MarkdownBlock] {
        let lines = markdown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var blocks: [MarkdownBlock] = []
        var prose: [String] = []
        var code: [String] = []
        var inFence = false
        var language: String?

        func flushProse() {
            let text = prose.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                blocks.append(MarkdownBlock(id: blocks.count, kind: .prose, text: text, language: nil, table: nil))
            }
            prose.removeAll(keepingCapacity: true)
        }

        func flushCode() {
            blocks.append(MarkdownBlock(id: blocks.count, kind: .code, text: code.joined(separator: "\n"), language: language, table: nil))
            code.removeAll(keepingCapacity: true)
            language = nil
        }

        func appendTable(_ table: MarkdownTable) {
            blocks.append(MarkdownBlock(id: blocks.count, kind: .table, text: "", language: nil, table: table))
        }

        var index = 0
        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inFence {
                    flushCode()
                    inFence = false
                } else {
                    flushProse()
                    inFence = true
                    let rawLanguage = trimmed.dropFirst(3).trimmingCharacters(in: .whitespacesAndNewlines)
                    language = rawLanguage.split(separator: " ").first.map(String.init)
                }
            } else if inFence {
                code.append(line)
            } else if let parsed = parseTable(lines: lines, start: index) {
                flushProse()
                appendTable(parsed.table)
                index += parsed.consumed
                continue
            } else {
                prose.append(line)
            }
            index += 1
        }

        if inFence {
            flushCode()
        } else {
            flushProse()
        }

        if blocks.isEmpty {
            blocks.append(MarkdownBlock(id: 0, kind: .prose, text: markdown, language: nil, table: nil))
        }
        return blocks
    }

    private static func parseTable(lines: [String], start: Int) -> (table: MarkdownTable, consumed: Int)? {
        guard start + 1 < lines.count else { return nil }
        let header = splitTableRow(lines[start])
        let separator = splitTableRow(lines[start + 1])
        guard header.count >= 2,
              separator.count == header.count,
              separator.allSatisfy(isSeparatorCell) else {
            return nil
        }

        var rows: [[String]] = []
        var index = start + 2
        while index < lines.count {
            let trimmed = lines[index].trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.contains("|"), !trimmed.isEmpty else { break }
            let row = splitTableRow(lines[index])
            guard row.count >= 2 else { break }
            rows.append(padded(row, count: header.count))
            index += 1
        }

        let alignments = separator.map(alignment)
        return (
            MarkdownTable(headers: header, alignments: alignments, rows: rows),
            index - start
        )
    }

    private static func splitTableRow(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.first == "|" {
            trimmed.removeFirst()
        }
        if trimmed.last == "|" {
            trimmed.removeLast()
        }

        var cells: [String] = []
        var current = ""
        var escaped = false
        for char in trimmed {
            if escaped {
                current.append(char)
                escaped = false
            } else if char == "\\" {
                escaped = true
            } else if char == "|" {
                cells.append(cleanCell(current))
                current.removeAll(keepingCapacity: true)
            } else {
                current.append(char)
            }
        }
        cells.append(cleanCell(current))
        return cells
    }

    private static func cleanCell(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isSeparatorCell(_ value: String) -> Bool {
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean.count >= 3 else { return false }
        return clean.allSatisfy { $0 == "-" || $0 == ":" }
    }

    private static func alignment(_ value: String) -> MarkdownColumnAlignment {
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.hasPrefix(":"), clean.hasSuffix(":") { return .center }
        if clean.hasSuffix(":") { return .trailing }
        return .leading
    }

    private static func padded(_ row: [String], count: Int) -> [String] {
        if row.count >= count { return Array(row.prefix(count)) }
        return row + Array(repeating: "", count: count - row.count)
    }
}

private enum CodeHighlighter {
    static func highlight(_ source: String, language: String?, fontSize: Double) -> AttributedString {
        MarkdownRenderCache.highlightedCode(source, language: language, fontSize: fontSize)
    }

    fileprivate static func highlightUncached(_ source: String, language: String?, fontSize: Double) -> AttributedString {
        var attributed = AttributedString(source)
        attributed.font = .system(size: fontSize, design: .monospaced)
        attributed.foregroundColor = .primary

        let normalized = (language ?? "").lowercased()
        if source.count > 12_000 || ["text", "plain", "plaintext"].contains(normalized) {
            return attributed
        }
        apply(pattern: #"(?<![\w.])-?\b\d+(?:\.\d+)?\b"#, color: Color(red: 0.50, green: 0.36, blue: 0.75), to: &attributed, source: source)

        if let keywordPattern = keywordPattern(for: normalized) {
            apply(pattern: keywordPattern, color: Color(red: 0.13, green: 0.38, blue: 0.68), to: &attributed, source: source)
        }

        apply(pattern: #""(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'"#, color: Color(red: 0.72, green: 0.28, blue: 0.22), to: &attributed, source: source)

        if let commentPattern = commentPattern(for: normalized) {
            apply(pattern: commentPattern, color: Color.secondary, to: &attributed, source: source)
        }

        return attributed
    }

    private static func keywordPattern(for language: String) -> String? {
        let words: [String]
        if ["swift"].contains(language) {
            words = ["actor", "associatedtype", "await", "case", "catch", "class", "enum", "extension", "false", "for", "func", "guard", "if", "import", "in", "let", "nil", "private", "protocol", "public", "return", "self", "static", "struct", "switch", "throw", "throws", "true", "try", "var", "while"]
        } else if ["py", "python"].contains(language) {
            words = ["and", "as", "async", "await", "class", "def", "elif", "else", "except", "False", "finally", "for", "from", "if", "import", "in", "is", "lambda", "None", "not", "or", "pass", "return", "self", "True", "try", "while", "with", "yield"]
        } else if ["js", "javascript", "ts", "typescript", "tsx", "jsx"].contains(language) {
            words = ["async", "await", "break", "case", "catch", "class", "const", "continue", "default", "else", "export", "false", "for", "from", "function", "if", "import", "interface", "let", "new", "null", "return", "switch", "throw", "true", "try", "type", "undefined", "var", "while"]
        } else if ["json"].contains(language) {
            words = ["true", "false", "null"]
        } else if ["sh", "shell", "bash", "zsh"].contains(language) {
            words = ["case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in", "local", "then", "while"]
        } else if ["text", "plain", "plaintext", "md", "markdown"].contains(language) {
            words = []
        } else {
            words = ["false", "nil", "none", "null", "return", "true"]
        }
        guard !words.isEmpty else { return nil }
        return #"\b("# + words.map(NSRegularExpression.escapedPattern(for:)).joined(separator: "|") + #")\b"#
    }

    private static func commentPattern(for language: String) -> String? {
        if ["json", "text", "plain", "plaintext", "md", "markdown"].contains(language) {
            return nil
        }
        if ["py", "python", "sh", "shell", "bash", "zsh", "yaml", "yml"].contains(language) {
            return #"(?m)#.*$"#
        }
        return #"(?m)//.*$|/\*[\s\S]*?\*/"#
    }

    private static func apply(pattern: String, color: Color, to attributed: inout AttributedString, source: String) {
        guard !source.isEmpty, let regex = try? NSRegularExpression(pattern: pattern) else { return }
        let nsRange = NSRange(source.startIndex..<source.endIndex, in: source)
        for match in regex.matches(in: source, range: nsRange) {
            guard let range = Range(match.range, in: source),
                  let lower = AttributedString.Index(range.lowerBound, within: attributed),
                  let upper = AttributedString.Index(range.upperBound, within: attributed) else {
                continue
            }
            attributed[lower..<upper].foregroundColor = color
        }
    }
}
