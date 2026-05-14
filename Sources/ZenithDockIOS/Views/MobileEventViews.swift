import AVKit
import SwiftUI
import ZenithCore

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct MobileEventCard: View {
    @EnvironmentObject private var store: MobileAppStore
    let event: ZEvent

    var body: some View {
        switch event.type {
        case "turn_started":
            userBubble(label: "You", text: event.prompt ?? "")
        case "turn_queued":
            let isPending = store.isQueuedEventPending(event)
            userBubble(
                label: queuedLabel,
                text: event.prompt ?? "",
                queued: isPending,
                actionTitle: isPending ? "Unqueue" : nil,
                actionSystemImage: isPending ? "xmark.circle" : nil,
                action: isPending ? { Task { await store.unqueue(event) } } : nil
            )
        case "assistant_text":
            assistantBubble(text: event.text ?? "")
        case "turn_finished":
            if let text = event.result_text, !text.isEmpty {
                assistantBubble(text: text)
            }
        case "artifact_created":
            if let artifact = event.artifact {
                MobileArtifactView(file: artifact, url: store.fileURL(artifact))
            }
        case "file_uploaded":
            if let file = event.file {
                MobileSystemCard(icon: "tray.and.arrow.up", title: "Upload") {
                    Text(file.filename)
                }
            }
        case "error":
            MobileSystemCard(icon: "exclamationmark.triangle", title: "Error", tint: .red) {
                Text(event.message ?? event.error ?? "Unknown error")
                    .foregroundStyle(.red)
            }
        default:
            MobileSystemCard(icon: "circle", title: event.type.replacingOccurrences(of: "_", with: " ").capitalized) {
                MobileMarkdownView(markdown: event.message ?? event.text ?? event.type)
            }
        }
    }

    private var queuedLabel: String {
        if store.hasCancelledQueuedEvent(event) {
            return "Removed from queue"
        }
        if store.hasStartedQueuedEvent(event) {
            return "Sent from queue"
        }
        if let position = event.position, position > 1 {
            return "Queued #\(position)"
        }
        return "Queued"
    }

    private func userBubble(
        label: String,
        text: String,
        queued: Bool = false,
        actionTitle: String? = nil,
        actionSystemImage: String? = nil,
        action: (() -> Void)? = nil
    ) -> some View {
        HStack {
            Spacer(minLength: 44)
            MobileMessageBubble(
                label: label,
                text: text,
                isUser: true,
                queued: queued,
                actionTitle: actionTitle,
                actionSystemImage: actionSystemImage,
                action: action
            )
        }
    }

    private func assistantBubble(text: String) -> some View {
        HStack {
            MobileMessageBubble(label: "Assistant", text: text, isUser: false)
            Spacer(minLength: 44)
        }
    }
}

struct MobileMessageBubble: View {
    let label: String
    let text: String
    let isUser: Bool
    var queued = false
    var actionTitle: String?
    var actionSystemImage: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 7) {
            HStack(spacing: 6) {
                if isUser { Spacer(minLength: 0) }
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if let action {
                    Button(action: action) {
                        Label(actionTitle ?? "Action", systemImage: actionSystemImage ?? "circle")
                            .labelStyle(.iconOnly)
                    }
                    .buttonStyle(.borderless)
                }
                Button {
                    copyToPasteboard(text)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                if !isUser { Spacer(minLength: 0) }
            }
            MobileMarkdownView(markdown: text)
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 11)
        .frame(maxWidth: 700, alignment: isUser ? .trailing : .leading)
        .background(background)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(queued ? .secondary.opacity(0.30) : MobileTheme.softLine))
    }

    private var background: some ShapeStyle {
        if queued {
            return AnyShapeStyle(.secondary.opacity(0.10))
        }
        return isUser ? AnyShapeStyle(MobileTheme.userBubble) : AnyShapeStyle(MobileTheme.card)
    }
}

struct MobileSystemCard<Content: View>: View {
    let icon: String
    let title: String
    var tint: Color = .secondary
    @ViewBuilder var content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                content
            }
            .padding(12)
            .background(MobileTheme.card)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(MobileTheme.softLine))
        }
    }
}

struct MobileTraceCard: View {
    let events: [ZEvent]
    @State private var expanded = false

    var body: some View {
        MobileSystemCard(icon: "chevron.left.forwardslash.chevron.right", title: "") {
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(events) { event in
                        MobileTraceRow(event: event)
                    }
                }
                .padding(.top, 6)
            } label: {
                HStack {
                    Text(traceTitle)
                        .font(.subheadline.weight(.semibold))
                    Text(traceSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var traceTitle: String {
        toolCount > 0 ? "Ran \(toolCount) \(toolCount == 1 ? "tool" : "tools")" : "Trace"
    }

    private var traceSubtitle: String {
        let thoughts = events.filter { $0.type == "reasoning_summary" }.count
        return thoughts > 0 ? "\(thoughts) thought\(thoughts == 1 ? "" : "s")" : "\(events.count) events"
    }

    private var toolCount: Int {
        let ids = Set(events.compactMap { $0.tool?.id ?? $0.tool_id })
        if !ids.isEmpty { return ids.count }
        return events.filter { $0.type == "tool_started" }.count
    }
}

private struct MobileTraceRow: View {
    let event: ZEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            switch event.type {
            case "reasoning_summary":
                MobileMarkdownView(markdown: event.text ?? "")
            case "tool_started", "tool_finished":
                Text(toolSummary)
                    .font(.caption.monospaced())
                    .lineLimit(3)
            default:
                Text(event.message ?? event.text ?? event.type)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var title: String {
        switch event.type {
        case "reasoning_summary": return "Reasoning"
        case "tool_started": return "Tool Started"
        case "tool_finished": return "Tool Finished"
        default: return event.type.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private var toolSummary: String {
        if case .object(let object)? = event.tool?.input,
           case .string(let command)? = object["command"] {
            return command
        }
        return event.tool?.name ?? event.tool_id ?? "Tool"
    }
}

struct MobileMarkdownView: View {
    let markdown: String

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(MobileMarkdownParser.parse(markdown)) { block in
                switch block.kind {
                case .prose:
                    Text(attributed(block.text))
                        .font(.body)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                case .code:
                    MobileCodeBlock(text: block.text, language: block.language)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func attributed(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

struct MobileCodeBlock: View {
    let text: String
    var language: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(language?.isEmpty == false ? language! : "code")
                    .font(.caption.weight(.semibold).monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    copyToPasteboard(text)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.black.opacity(0.04))
            Divider()
            ScrollView(.horizontal, showsIndicators: true) {
                Text(text)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .background(.black.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(MobileTheme.softLine))
    }
}

struct MobileArtifactView: View {
    let file: ZFile
    let url: URL
    @State private var fullscreenVideo = false

    var body: some View {
        MobileSystemCard(icon: icon, title: file.title ?? file.filename, tint: .green) {
            VStack(alignment: .leading, spacing: 10) {
                if file.content_type?.hasPrefix("image/") == true {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFit()
                    } placeholder: {
                        ProgressView()
                    }
                    .frame(maxHeight: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                } else if file.content_type?.hasPrefix("video/") == true {
                    VideoPlayer(player: AVPlayer(url: url))
                        .frame(height: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    HStack(spacing: 12) {
                        Label(file.size.map(mobileByteString) ?? "Video", systemImage: "film")
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 8)
                        Button {
                            fullscreenVideo = true
                        } label: {
                            Label("Fullscreen", systemImage: "arrow.up.left.and.arrow.down.right")
                        }
                    }
                    .font(.caption.weight(.semibold))
                }
                if let text = file.text {
                    MobileMarkdownView(markdown: text)
                }
                Link(destination: url) {
                    Label("Open file", systemImage: "arrow.up.right.square")
                }
                .font(.caption.weight(.semibold))
            }
        }
        .mobileVideoFullscreen(isPresented: $fullscreenVideo, url: url, title: file.title ?? file.filename)
    }

    private var icon: String {
        if file.content_type?.hasPrefix("video/") == true { return "film" }
        if file.content_type?.hasPrefix("image/") == true { return "photo" }
        return "doc"
    }
}

private extension View {
    @ViewBuilder
    func mobileVideoFullscreen(isPresented: Binding<Bool>, url: URL, title: String) -> some View {
        #if os(iOS)
        self.fullScreenCover(isPresented: isPresented) {
            MobileFullscreenVideoView(url: url, title: title)
        }
        #else
        self.sheet(isPresented: isPresented) {
            MobileFullscreenVideoView(url: url, title: title)
                .frame(minWidth: 900, minHeight: 560)
        }
        #endif
    }
}

private struct MobileFullscreenVideoView: View {
    let url: URL
    let title: String
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer

    init(url: URL, title: String) {
        self.url = url
        self.title = title
        _player = State(initialValue: AVPlayer(url: url))
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            VideoPlayer(player: player)
                .ignoresSafeArea()
            Button {
                player.pause()
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.white)
                    .padding(18)
            }
            .accessibilityLabel("Close fullscreen video")
        }
        .onAppear {
            player.play()
        }
        .onDisappear {
            player.pause()
        }
    }
}

private func copyToPasteboard(_ string: String) {
    #if canImport(UIKit)
    UIPasteboard.general.string = string
    #elseif canImport(AppKit)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(string, forType: .string)
    #endif
}

private struct MobileMarkdownBlock: Identifiable {
    enum Kind {
        case prose
        case code
    }

    let id: Int
    let kind: Kind
    let text: String
    let language: String?
}

private enum MobileMarkdownParser {
    static func parse(_ markdown: String) -> [MobileMarkdownBlock] {
        let lines = markdown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var blocks: [MobileMarkdownBlock] = []
        var prose: [String] = []
        var code: [String] = []
        var inFence = false
        var language: String?

        func flushProse() {
            let text = prose.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                blocks.append(MobileMarkdownBlock(id: blocks.count, kind: .prose, text: text, language: nil))
            }
            prose.removeAll(keepingCapacity: true)
        }

        func flushCode() {
            blocks.append(MobileMarkdownBlock(id: blocks.count, kind: .code, text: code.joined(separator: "\n"), language: language))
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
                    language = trimmed.dropFirst(3).split(separator: " ").first.map(String.init)
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
        return blocks
    }
}
