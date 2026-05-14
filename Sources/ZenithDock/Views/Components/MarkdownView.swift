import SwiftUI

#if os(macOS)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

struct MarkdownView: View {
    let markdown: String
    var alignment: HorizontalAlignment = .leading
    var compact = false

    private var blocks: [MarkdownBlock] {
        MarkdownParser.parse(Self.renderable(markdown))
    }

    private var frameAlignment: Alignment {
        alignment == .trailing ? .trailing : .leading
    }

    var body: some View {
        VStack(alignment: alignment, spacing: compact ? 8 : 12) {
            ForEach(blocks) { block in
                switch block.kind {
                case .prose:
                    MarkdownText(block.text)
                        .frame(maxWidth: .infinity, alignment: frameAlignment)
                case .code:
                    CodeBlock(text: block.text, language: block.language)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: frameAlignment)
    }

    private static func renderable(_ text: String) -> String {
        let text = EmojiShortcodes.stripDecorativePrefixes(text)
        let max = 32_000
        guard text.count > max else { return text }
        return String(text.prefix(max)) + "\n\n[message trimmed for UI]"
    }
}

private struct MarkdownText: View {
    let text: String
    @AppStorage("chatFontSize") private var chatFontSize = 14.0
    @AppStorage("chatFontDesign") private var chatFontDesign = "default"

    init(_ text: String) {
        self.text = EmojiShortcodes.render(text)
    }

    var body: some View {
        Text(attributed)
            .lineSpacing(lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    private var attributed: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        var parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        parsed.font = .system(size: chatFontSize, design: fontDesign)
        return parsed
    }

    private var lineSpacing: CGFloat {
        max(3, chatFontSize * 0.22)
    }

    private var fontDesign: Font.Design {
        switch chatFontDesign {
        case "rounded": return .rounded
        case "serif": return .serif
        case "monospaced": return .monospaced
        default: return .default
        }
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

struct CodeBlock: View {
    let text: String
    var language: String?
    var limit: Int?

    @State private var copied = false
    @AppStorage("chatFontSize") private var chatFontSize = 14.0

    private var shown: String {
        let effectiveLimit = limit ?? 24_000
        guard text.count > effectiveLimit else { return text }
        return String(text.prefix(effectiveLimit)).trimmingCharacters(in: .whitespacesAndNewlines) + "\n..."
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
                    copyToPasteboard(shown)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.2))
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help(copied ? "Copied" : "Copy code")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.black.opacity(0.045))

            Divider()

            ScrollView(.horizontal, showsIndicators: true) {
                Text(CodeHighlighter.highlight(shown, language: language, fontSize: max(12, chatFontSize - 1)))
                    .padding(12)
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(minWidth: 0, alignment: .leading)
                    .textSelection(.enabled)
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
    }

    let id: Int
    let kind: Kind
    let text: String
    let language: String?
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
                blocks.append(MarkdownBlock(id: blocks.count, kind: .prose, text: text, language: nil))
            }
            prose.removeAll(keepingCapacity: true)
        }

        func flushCode() {
            blocks.append(MarkdownBlock(id: blocks.count, kind: .code, text: code.joined(separator: "\n"), language: language))
            code.removeAll(keepingCapacity: true)
            language = nil
        }

        for line in lines {
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
            } else {
                prose.append(line)
            }
        }

        if inFence {
            flushCode()
        } else {
            flushProse()
        }

        if blocks.isEmpty {
            blocks.append(MarkdownBlock(id: 0, kind: .prose, text: markdown, language: nil))
        }
        return blocks
    }
}

private enum CodeHighlighter {
    static func highlight(_ source: String, language: String?, fontSize: Double) -> AttributedString {
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
