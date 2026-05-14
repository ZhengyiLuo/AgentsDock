import SwiftUI
import ZenithCore

#if os(macOS)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

struct EventCard: View {
    @EnvironmentObject private var store: AppStore
    let event: ZEvent
    @State private var expanded = false

    var body: some View {
        if event.type == "turn_started" {
            HStack {
                Spacer(minLength: 80)
                MessageBubble(label: "You", text: event.prompt ?? "", isUser: true)
            }
        } else if event.type == "turn_queued" {
            HStack {
                Spacer(minLength: 80)
                let isPending = store.isQueuedEventPending(event)
                MessageBubble(
                    label: queuedLabel,
                    text: event.prompt ?? "",
                    isUser: true,
                    isQueued: isPending,
                    actionTitle: isPending ? "Unqueue" : nil,
                    actionSystemImage: isPending ? "xmark.circle" : nil,
                    action: isPending ? { Task { await store.unqueue(event) } } : nil
                )
            }
        } else if event.type == "assistant_text" {
            HStack {
                MessageBubble(label: "Assistant", text: event.text ?? "", isUser: false)
                Spacer(minLength: 80)
            }
        } else if event.type == "turn_finished", let text = event.result_text, !text.isEmpty {
            HStack {
                MessageBubble(label: "Assistant", text: text, isUser: false)
                Spacer(minLength: 80)
            }
        } else {
            systemCard
        }
    }

    var systemCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(color)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    if store.showDebugEvents {
                        Text("#\(event.seq)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
                content
            }
            .padding(14)
            .background(cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator.opacity(0.35)))
        }
    }

    @ViewBuilder
    var content: some View {
        switch event.type {
        case "assistant_text":
            MarkdownView(markdown: event.text ?? "")
        case "reasoning_summary":
            TraceDisclosureHeader(
                title: (event.text ?? "Reasoning").split(separator: "\n").first.map(String.init) ?? "Reasoning",
                detail: nil,
                isExpanded: $expanded
            )
            if expanded {
                MarkdownView(markdown: event.text ?? "", compact: true)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            }
        case "tool_started":
            ToolBody(event: event, expanded: $expanded)
        case "tool_finished":
            ToolBody(event: event, expanded: $expanded, output: event.output)
        case "artifact_created":
            if let artifact = event.artifact {
                ArtifactPreview(file: artifact, url: store.fileURL(artifact))
            }
        case "file_uploaded":
            if let file = event.file {
                Label(file.filename, systemImage: "tray.and.arrow.up")
            }
        case "turn_started":
            MarkdownView(markdown: event.prompt ?? "", compact: true)
                .foregroundStyle(.secondary)
        case "turn_queued":
            MarkdownView(markdown: event.prompt ?? "", compact: true)
                .foregroundStyle(.secondary)
        case "turn_finished":
            if let text = event.result_text, !text.isEmpty {
                MarkdownView(markdown: text)
            }
        case "error":
            Text(event.message ?? event.error ?? "Unknown error")
                .foregroundStyle(.red)
        case "raw_event":
            TraceDisclosureHeader(title: "Raw JSON", detail: nil, isExpanded: $expanded)
            if expanded {
                CodeBlock(text: event.raw ?? "", language: "json", limit: nil)
            }
        default:
            MarkdownView(markdown: event.message ?? event.text ?? event.type, compact: true)
                .foregroundStyle(.secondary)
        }
    }

    var title: String {
        switch event.type {
        case "turn_started": "Prompt"
        case "turn_queued": "Queued"
        case "turn_unqueued": "Removed from Queue"
        case "assistant_text": "Assistant"
        case "reasoning_summary": "Reasoning Summary"
        case "tool_started": "Tool Started"
        case "tool_finished": "Tool Finished"
        case "artifact_created": "Artifact"
        case "file_uploaded": "Upload"
        case "turn_finished": "Turn Finished"
        case "provider_session": "Provider Session"
        case "process_started": "Process"
        case "idle_warning": "Idle Warning"
        case "error": "Error"
        default: event.type.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    var icon: String {
        switch event.type {
        case "assistant_text": "text.bubble"
        case "reasoning_summary": "brain.head.profile"
        case "tool_started", "tool_finished": "terminal"
        case "artifact_created": "shippingbox"
        case "file_uploaded": "tray.and.arrow.up"
        case "error": "exclamationmark.triangle"
        case "turn_started": "arrow.up.message"
        case "turn_queued": "text.badge.clock"
        case "turn_unqueued": "xmark.circle"
        case "turn_finished": "checkmark.circle"
        default: "circle"
        }
    }

    var color: Color {
        switch event.type {
        case "error": .red
        case "reasoning_summary": .purple
        case "tool_started", "tool_finished": .orange
        case "turn_queued", "turn_unqueued": .secondary
        case "artifact_created": .green
        default: .accentColor
        }
    }

    var cardBackground: some ShapeStyle {
        event.type == "error" ? AnyShapeStyle(.red.opacity(0.08)) : AnyShapeStyle(Theme.card)
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
}

struct MessageBubble: View {
    let label: String
    let text: String
    let isUser: Bool
    var isQueued = false
    var actionTitle: String?
    var actionSystemImage: String?
    var action: (() -> Void)?

    @State private var showFullText = false

    private let collapsedCharacterLimit = 12_000

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
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
                    .controlSize(.small)
                    .help(actionTitle ?? "Action")
                }
                Button {
                    copyToPasteboard(text)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("Copy message")
                if !isUser { Spacer(minLength: 0) }
            }
            .frame(maxWidth: .infinity)
            MarkdownView(markdown: visibleText, alignment: isUser ? .trailing : .leading)
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
            if shouldClip {
                HStack(spacing: 8) {
                    Text(showFullText ? "Full message shown" : "\(hiddenCharacterCount) characters hidden")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button(showFullText ? "Show less" : "Show full message") {
                        showFullText.toggle()
                    }
                    .buttonStyle(.borderless)
                    .font(.caption.weight(.semibold))
                }
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: 760, alignment: isUser ? .trailing : .leading)
        .background(bubbleBackground)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(bubbleStroke))
    }

    private var bubbleBackground: some ShapeStyle {
        if isQueued {
            return AnyShapeStyle(.secondary.opacity(0.10))
        }
        return isUser ? AnyShapeStyle(Color.accentColor.opacity(0.14)) : AnyShapeStyle(Theme.card)
    }

    private var bubbleStroke: some ShapeStyle {
        if isQueued {
            return AnyShapeStyle(.secondary.opacity(0.30))
        }
        return isUser ? AnyShapeStyle(Color.accentColor.opacity(0.2)) : AnyShapeStyle(Theme.softLine)
    }

    private var shouldClip: Bool {
        text.count > collapsedCharacterLimit
    }

    private var hiddenCharacterCount: Int {
        max(text.count - collapsedCharacterLimit, 0)
    }

    private var visibleText: String {
        guard shouldClip, !showFullText else { return text }
        return String(text.prefix(collapsedCharacterLimit)).trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n[message clipped in UI; copy still uses full text]"
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

struct ToolBody: View {
    let event: ZEvent
    @Binding var expanded: Bool
    var output: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text(event.tool?.name ?? event.tool_id ?? "Tool")
                    .font(.callout.weight(.semibold).monospaced())
                if let summary {
                    Text(summary)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                if hasDetails {
                    Button(expanded ? "Hide details" : "Details") {
                        expanded.toggle()
                    }
                    .font(.caption)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
            if expanded {
                if let input = event.tool?.input {
                    CodeBlock(text: input.pretty, language: "json", limit: nil)
                }
                if let output, !output.isEmpty {
                    CodeBlock(text: output, language: "text", limit: nil)
                }
            }
        }
    }

    private var hasDetails: Bool {
        event.tool?.input != nil || output?.isEmpty == false
    }

    private var summary: String? {
        if let command = commandText {
            return command
        }
        if let input = event.tool?.input {
            let pretty = input.pretty.trimmingCharacters(in: .whitespacesAndNewlines)
            return pretty.isEmpty ? nil : pretty
        }
        return output?.split(separator: "\n").first.map(String.init)
    }

    private var commandText: String? {
        guard let input = event.tool?.input else { return nil }
        if case .object(let object) = input,
           case .string(let command)? = object["command"],
           !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return command
        }
        return nil
    }
}

struct TraceGroupCard: View {
    let events: [ZEvent]
    @State private var expanded = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 8) {
                TraceDisclosureHeader(title: summaryTitle, detail: summaryDetail, isExpanded: $expanded)
                if expanded {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(events) { event in
                            TraceEventDetail(event: event)
                        }
                    }
                    .padding(.top, 8)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(.secondary.opacity(0.07))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
        }
    }

    private var summaryTitle: String {
        if toolCount > 0 && reasoningCount == 0 {
            return "Ran \(toolCount) \(toolCount == 1 ? "tool" : "tools")"
        }
        if reasoningCount > 0 && toolCount == 0 {
            return "Reasoning trace"
        }
        return "Trace"
    }

    private var summaryDetail: String {
        var parts: [String] = []
        if toolCount > 0 {
            parts.append("\(toolCount) \(toolCount == 1 ? "tool" : "tools")")
        }
        if reasoningCount > 0 {
            parts.append("\(reasoningCount) \(reasoningCount == 1 ? "thought" : "thoughts")")
        }
        let other = events.count - toolEventCount - reasoningCount
        if other > 0 {
            parts.append("\(other) system")
        }
        return parts.joined(separator: " · ")
    }

    private var toolEventCount: Int {
        events.filter { $0.type == "tool_started" || $0.type == "tool_finished" }.count
    }

    private var toolCount: Int {
        let ids = Set(events.compactMap { $0.tool?.id ?? $0.tool_id })
        if !ids.isEmpty { return ids.count }
        return events.filter { $0.type == "tool_started" }.count
    }

    private var reasoningCount: Int {
        events.filter { $0.type == "reasoning_summary" }.count
    }
}

private struct TraceEventDetail: View {
    let event: ZEvent
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .foregroundStyle(color)
                    .frame(width: 18)
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Text("#\(event.seq)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            content
                .padding(.leading, 26)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch event.type {
        case "reasoning_summary":
            MarkdownView(markdown: event.text ?? "", compact: true)
                .foregroundStyle(.secondary)
        case "tool_started":
            ToolBody(event: event, expanded: $expanded)
        case "tool_finished":
            ToolBody(event: event, expanded: $expanded, output: event.output)
        case "raw_event":
            TraceDisclosureHeader(title: "Raw JSON", detail: nil, isExpanded: $expanded)
            if expanded {
                CodeBlock(text: event.raw ?? "", language: "json", limit: nil)
            }
        case "process_started":
            if let argv = event.argv {
                CodeBlock(text: argv.joined(separator: " "), language: "shell", limit: 1200)
            } else {
                Text(event.message ?? event.type)
                    .foregroundStyle(.secondary)
            }
        case "error", "job_error", "artifact_error":
            Text(event.message ?? event.error ?? "Unknown error")
                .foregroundStyle(.red)
        default:
            Text(event.message ?? event.text ?? event.type)
                .foregroundStyle(.secondary)
        }
    }

    private var title: String {
        switch event.type {
        case "reasoning_summary": "Reasoning"
        case "tool_started": "Tool Started"
        case "tool_finished": "Tool Finished"
        case "raw_event": "Raw Event"
        case "process_started": "Process"
        case "provider_session": "Provider Session"
        case "cwd_fallback": "Directory"
        case "history_imported": "History"
        case "backend_changed": "Backend"
        case "job_ran": "Job"
        case "job_error": "Job Error"
        case "artifact_error": "Artifact Error"
        default: event.type.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private var icon: String {
        switch event.type {
        case "reasoning_summary": "brain.head.profile"
        case "tool_started", "tool_finished": "terminal"
        case "raw_event": "curlybraces"
        case "error", "job_error", "artifact_error": "exclamationmark.triangle"
        default: "circle"
        }
    }

    private var color: Color {
        switch event.type {
        case "reasoning_summary": .purple
        case "tool_started", "tool_finished": .orange
        case "error", "job_error", "artifact_error": .red
        default: .secondary
        }
    }
}

private struct TraceDisclosureHeader: View {
    let title: String
    let detail: String?
    @Binding var isExpanded: Bool

    var body: some View {
        Button {
            isExpanded.toggle()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.caption.weight(.semibold))
                    .frame(width: 12)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct ArtifactPreview: View {
    let file: ZFile
    let url: URL

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: icon)
                Text(file.title ?? file.filename)
                    .font(.headline)
                Spacer()
                Link(destination: url) {
                    Image(systemName: "arrow.down.circle")
                }
            }
            if file.content_type?.hasPrefix("image/") == true {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFit()
                } placeholder: {
                    ProgressView()
                }
                .frame(maxHeight: 260)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            } else if file.content_type?.hasPrefix("video/") == true {
                InlineVideoView(url: url)
                    .frame(height: 300)
                HStack {
                    Label(file.size.map(byteString) ?? "Video", systemImage: "film")
                        .foregroundStyle(.secondary)
	                    Spacer(minLength: 12)
	                    #if os(macOS)
	                    Button {
	                        VideoFullscreenPresenter.present(url: url)
	                    } label: {
	                        Label("Fullscreen", systemImage: "arrow.up.left.and.arrow.down.right")
	                    }
	                    .buttonStyle(.link)
	                    #endif
	                    Link(destination: url) {
	                        Label("Open", systemImage: "arrow.up.right.square")
	                    }
                }
                .font(.caption)
            }
            if let text = file.text {
                MarkdownView(markdown: text, compact: true)
                    .foregroundStyle(.secondary)
            }
        }
    }

    var icon: String {
        if file.content_type?.hasPrefix("video/") == true { return "film" }
        if file.content_type?.hasPrefix("image/") == true { return "photo" }
        return "doc"
    }
}
