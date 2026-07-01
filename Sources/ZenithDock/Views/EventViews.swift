import Foundation
import SwiftUI
import ZenithCore

#if os(macOS)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

enum QueuedEventStatus: Equatable {
    case none
    case pending(position: Int?)
    case started
    case cancelled
}

struct MessageAttachment: Hashable {
    let file: ZFile
    let url: URL?
}

struct EventCard: View, Equatable {
    let event: ZEvent
    let showDebugEvents: Bool
    let queueStatus: QueuedEventStatus
    let attachments: [MessageAttachment]
    let artifactURL: URL?
    let fileURL: URL?
    let linkContext: ZMarkdownLinkContext?
    let job: ZJob?
    let isPinned: Bool
    let onTogglePin: (ZEvent) -> Void
    let onUnqueue: (ZEvent) -> Void

    @State private var expanded = false

    nonisolated static func == (lhs: EventCard, rhs: EventCard) -> Bool {
        lhs.event.id == rhs.event.id &&
            lhs.event.seq == rhs.event.seq &&
            lhs.event.type == rhs.event.type &&
            lhs.event.ts == rhs.event.ts &&
            lhs.showDebugEvents == rhs.showDebugEvents &&
            lhs.queueStatus == rhs.queueStatus &&
            lhs.attachments == rhs.attachments &&
            lhs.artifactURL == rhs.artifactURL &&
            lhs.fileURL == rhs.fileURL &&
            lhs.linkContext == rhs.linkContext &&
            lhs.job == rhs.job &&
            lhs.isPinned == rhs.isPinned
    }

    var body: some View {
        if event.type == "turn_started" {
            HStack {
                Spacer(minLength: 80)
                MessageBubble(
                    label: isDigestTurn ? "Digest Request" : "You",
                    text: event.prompt ?? "",
                    isUser: true,
                    isDigest: isDigestTurn,
                    timestamp: messageTimestamp,
                    attachments: attachments,
                    linkContext: linkContext,
                    isPinned: isPinned,
                    onTogglePin: { onTogglePin(event) }
                )
            }
        } else if event.type == "turn_queued" {
            HStack {
                Spacer(minLength: 80)
                MessageBubble(
                    label: queuedLabel,
                    text: event.prompt ?? "",
                    isUser: true,
                    isQueued: queueStatus.isPending,
                    timestamp: messageTimestamp,
                    attachments: attachments,
                    actionTitle: queueStatus.isPending ? "Unqueue" : nil,
                    actionSystemImage: queueStatus.isPending ? "xmark.circle" : nil,
                    linkContext: linkContext,
                    isPinned: isPinned,
                    onTogglePin: { onTogglePin(event) },
                    action: queueStatus.isPending ? { onUnqueue(event) } : nil
                )
            }
        } else if event.type == "assistant_text" {
            HStack {
                MessageBubble(
                    label: isDigestTurn ? "Digest" : "Assistant",
                    text: event.text ?? "",
                    isUser: false,
                    isDigest: isDigestTurn,
                    timestamp: messageTimestamp,
                    linkContext: linkContext,
                    isPinned: isPinned,
                    onTogglePin: { onTogglePin(event) }
                )
                Spacer(minLength: 80)
            }
        } else if event.type == "turn_finished", let text = event.result_text, !text.isEmpty {
            HStack {
                MessageBubble(
                    label: isDigestTurn ? "Digest" : (job.map { "Job Response · \($0.title)" } ?? "Assistant"),
                    text: text,
                    isUser: false,
                    isDigest: isDigestTurn,
                    isJob: job != nil,
                    timestamp: messageTimestamp,
                    linkContext: linkContext,
                    isPinned: isPinned,
                    onTogglePin: { onTogglePin(event) }
                )
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
                    if let messageTimestamp {
                        Text(messageTimestamp)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                    if showDebugEvents {
                        Text("#\(event.seq)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    if canPin {
                        Button {
                            onTogglePin(event)
                        } label: {
                            Image(systemName: isPinned ? "pin.fill" : "pin")
                        }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .help(isPinned ? "Unpin from right panel" : "Pin to right panel")
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
            MarkdownView(markdown: event.text ?? "", linkContext: linkContext)
        case "reasoning_summary":
            TraceDisclosureHeader(
                title: (event.text ?? "Reasoning").split(separator: "\n").first.map(String.init) ?? "Reasoning",
                detail: nil,
                isExpanded: $expanded
            )
            if expanded {
                MarkdownView(markdown: event.text ?? "", compact: true, linkContext: linkContext)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            }
        case "tool_started":
            ToolBody(event: event, expanded: $expanded)
        case "tool_finished":
            ToolBody(event: event, expanded: $expanded, output: event.output)
        case "artifact_created":
            if let artifact = event.artifact, let artifactURL {
                ArtifactPreview(file: artifact, url: artifactURL, linkContext: linkContext)
            }
        case "file_uploaded":
            if let file = event.file {
                UploadedFileLabel(file: file, url: fileURL)
            }
        case "turn_started":
            MarkdownView(markdown: event.prompt ?? "", compact: true, linkContext: linkContext)
                .foregroundStyle(.secondary)
        case "turn_queued":
            MarkdownView(markdown: event.prompt ?? "", compact: true, linkContext: linkContext)
                .foregroundStyle(.secondary)
        case "turn_finished":
            if let text = event.result_text, !text.isEmpty {
                MarkdownView(markdown: text, linkContext: linkContext)
            }
        case "error":
            Text(event.message ?? event.error ?? "Unknown error")
                .foregroundStyle(.red)
        case "handoff_digest_started":
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                MarkdownView(markdown: event.message ?? "Generating LLM context digest.", compact: true, linkContext: linkContext)
                    .foregroundStyle(.secondary)
            }
        case "handoff_digest_ready", "handoff_digest_sent":
            MarkdownView(markdown: event.message ?? "Context digest submitted.", compact: true, linkContext: linkContext)
                .foregroundStyle(.secondary)
        case "handoff_digest_error":
            Text(event.message ?? event.error ?? "Context digest failed")
                .foregroundStyle(.red)
        case "raw_event":
            TraceDisclosureHeader(title: "Raw JSON", detail: nil, isExpanded: $expanded)
            if expanded {
                CodeBlock(text: event.raw ?? "", language: "json", limit: nil)
            }
        default:
            MarkdownView(markdown: event.message ?? event.text ?? event.type, compact: true, linkContext: linkContext)
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
        case "handoff_digest_started": "Digest Generating"
        case "handoff_digest_ready": "Digest Ready"
        case "handoff_digest_sent": "Digest Submitted"
        case "handoff_digest_error": "Digest Error"
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
        case "job_created", "job_ran", "job_deferred": "clock.badge.checkmark"
        case "error": "exclamationmark.triangle"
        case "turn_started": "arrow.up.message"
        case "turn_queued": "text.badge.clock"
        case "turn_unqueued": "xmark.circle"
        case "turn_finished": "checkmark.circle"
        case "handoff_digest_started": "sparkles"
        case "handoff_digest_ready", "handoff_digest_sent": "checkmark.seal"
        case "handoff_digest_error": "exclamationmark.triangle"
        default: "circle"
        }
    }

    var color: Color {
        switch event.type {
        case "error": .red
        case "reasoning_summary": .purple
        case "tool_started", "tool_finished": .orange
        case "job_created", "job_ran", "job_deferred": .orange
        case "handoff_digest_started", "handoff_digest_ready", "handoff_digest_sent": .yellow
        case "handoff_digest_error": .red
        case "turn_queued", "turn_unqueued": .secondary
        case "artifact_created": .green
        default: .accentColor
        }
    }

    var cardBackground: some ShapeStyle {
        if event.type == "error" {
            return AnyShapeStyle(.red.opacity(0.08))
        }
        if event.type == "job_created" || event.type == "job_ran" || event.type == "job_deferred" {
            return AnyShapeStyle(Theme.jobBubble.opacity(0.70))
        }
        if event.type == "handoff_digest_started" || event.type == "handoff_digest_ready" || event.type == "handoff_digest_sent" {
            return AnyShapeStyle(Theme.queuedBubble.opacity(0.85))
        }
        if event.type == "handoff_digest_error" {
            return AnyShapeStyle(.red.opacity(0.08))
        }
        return AnyShapeStyle(Theme.card)
    }

    private var queuedLabel: String {
        switch queueStatus {
        case .cancelled:
            return "Removed from queue"
        case .started:
            return "Sent from queue"
        case .pending(let position):
            if let position, position > 1 {
                return "Queued #\(position)"
            }
            return "Queued"
        case .none:
            return "Queued"
        }
    }

    private var messageTimestamp: String? {
        localTimestampString(event.ts)
    }

    private var isDigestTurn: Bool {
        event.purpose == "handoff_digest"
    }

    private var canPin: Bool {
        event.artifact != nil ||
            event.file != nil ||
            [event.prompt, event.text, event.result_text, event.message, event.output, event.error].contains { value in
                guard let value else { return false }
                return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            }
    }
}

private extension QueuedEventStatus {
    var isPending: Bool {
        if case .pending = self { return true }
        return false
    }
}

struct MessageBubble: View {
    let label: String
    let text: String
    let isUser: Bool
    var isQueued = false
    var isDigest = false
    var isJob = false
    var timestamp: String?
    var attachments: [MessageAttachment] = []
    var actionTitle: String?
    var actionSystemImage: String?
    var linkContext: ZMarkdownLinkContext?
    var isPinned = false
    var onTogglePin: (() -> Void)?
    var action: (() -> Void)?

    @State private var fullTextExpanded = false

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
            HStack(spacing: 6) {
                if isUser { Spacer(minLength: 0) }
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if let timestamp {
                    Text(timestamp)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                if let action {
                    Button(action: action) {
                        Label(actionTitle ?? "Action", systemImage: actionSystemImage ?? "circle")
                            .labelStyle(.iconOnly)
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .help(actionTitle ?? "Action")
                }
                if let onTogglePin {
                    Button(action: onTogglePin) {
                        Image(systemName: isPinned ? "pin.fill" : "pin")
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .help(isPinned ? "Unpin from right panel" : "Pin to right panel")
                }
                if shouldClip {
                    Button {
                        fullTextExpanded.toggle()
                    } label: {
                        Label(fullTextExpanded ? "Collapse" : "Full text", systemImage: fullTextExpanded ? "chevron.up" : "text.page")
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .help(fullTextExpanded ? "Collapse message" : "Expand full message inline")
                }
                Button {
                    copyToPasteboard(ZClipboardText.normalizedForCopy(text))
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("Copy message")
                if !isUser { Spacer(minLength: 0) }
            }
            .frame(maxWidth: .infinity)
            MarkdownView(
                markdown: visibleText,
                copyMarkdown: text,
                alignment: isUser ? .trailing : .leading,
                allowTruncation: !fullTextExpanded,
                linkContext: linkContext
            )
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
            if !attachments.isEmpty {
                MessageAttachmentStrip(attachments: attachments, isUser: isUser)
            }
            if shouldClip {
                foldNotice
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: isUser ? 760 : .infinity, alignment: isUser ? .trailing : .leading)
        .background(bubbleBackground)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(bubbleStroke))
    }

    private var bubbleBackground: some ShapeStyle {
        if isQueued {
            return AnyShapeStyle(Theme.queuedBubble)
        }
        if isDigest {
            return AnyShapeStyle(Theme.queuedBubble)
        }
        if isJob {
            return AnyShapeStyle(Theme.jobBubble)
        }
        return isUser ? AnyShapeStyle(Theme.userBubble) : AnyShapeStyle(Theme.card)
    }

    private var bubbleStroke: some ShapeStyle {
        if isQueued {
            return AnyShapeStyle(Theme.queuedBubbleStroke)
        }
        if isDigest {
            return AnyShapeStyle(Theme.queuedBubbleStroke)
        }
        if isJob {
            return AnyShapeStyle(Theme.jobBubbleStroke)
        }
        return isUser ? AnyShapeStyle(Theme.userBubbleStroke) : AnyShapeStyle(Theme.softLine)
    }

    private var shouldClip: Bool {
        return text.count > collapsedCharacterLimit || lineCount > collapsedLineLimit
    }

    private var hiddenCharacterCount: Int {
        max(text.count - clippedBody.count, 0)
    }

    private var visibleText: String {
        guard shouldClip, !fullTextExpanded else { return text }
        return clippedBody.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var foldNotice: some View {
        HStack(spacing: 8) {
            Image(systemName: "text.page")
                .font(.caption.weight(.semibold))
            Text(fullTextExpanded ? "Full text shown inline" : "\(hiddenCharacterCount) characters hidden")
                .font(.caption.weight(.semibold))
            Text(fullTextExpanded ? "Copy uses the complete message." : "Copy and Full text use the complete message.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button(fullTextExpanded ? "Collapse" : "Open full text") {
                fullTextExpanded.toggle()
            }
            .buttonStyle(.borderless)
            .font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(foldNoticeBackground)
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(foldNoticeStroke))
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }

    private var foldNoticeBackground: some ShapeStyle {
        if isUser {
            return AnyShapeStyle(Color.green.opacity(0.16))
        }
        if isJob {
            return AnyShapeStyle(Color.orange.opacity(0.16))
        }
        return AnyShapeStyle(Color.accentColor.opacity(0.12))
    }

    private var foldNoticeStroke: some ShapeStyle {
        if isUser {
            return AnyShapeStyle(Color.green.opacity(0.35))
        }
        if isJob {
            return AnyShapeStyle(Color.orange.opacity(0.35))
        }
        return AnyShapeStyle(Color.accentColor.opacity(0.28))
    }

    private var clippedBody: String {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let lineClipped = lines.prefix(collapsedLineLimit).joined(separator: "\n")
        if lineClipped.count > collapsedCharacterLimit {
            return String(lineClipped.prefix(collapsedCharacterLimit))
        }
        return lineClipped
    }

    private var collapsedCharacterLimit: Int {
        isContextDigest ? 1_800 : 4_200
    }

    private var collapsedLineLimit: Int {
        isContextDigest ? 18 : 48
    }

    private var lineCount: Int {
        text.split(separator: "\n", omittingEmptySubsequences: false).count
    }

    private var isContextDigest: Bool {
        text.contains("# ZenithDock Context Digest")
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

struct JobRunBubble: View, Equatable {
    let jobRun: JobRunRow
    let linkContext: ZMarkdownLinkContext?

    nonisolated static func == (lhs: JobRunBubble, rhs: JobRunBubble) -> Bool {
        lhs.jobRun == rhs.jobRun && lhs.linkContext == rhs.linkContext
    }

    var body: some View {
        HStack {
            MessageBubble(
                label: label,
                text: bodyText,
                isUser: false,
                isJob: true,
                timestamp: timestamp,
                linkContext: linkContext
            )
            Spacer(minLength: 80)
        }
    }

    private var label: String {
        jobRunLabel(jobRun)
    }

    private var bodyText: String {
        jobRunBodyText(jobRun)
    }

    private var timestamp: String? {
        localTimestampString(jobRun.finishedAt ?? jobRun.lastEventAt ?? jobRun.runEvent.ts)
    }
}

struct JobRunGroupBubble: View, Equatable {
    let group: JobRunGroupRow
    let linkContext: ZMarkdownLinkContext?
    @State private var olderOpen = false

    nonisolated static func == (lhs: JobRunGroupBubble, rhs: JobRunGroupBubble) -> Bool {
        lhs.group == rhs.group && lhs.linkContext == rhs.linkContext
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 6) {
                    Label("Latest Job Status", systemImage: "clock.badge.checkmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text("· \(group.latest.job.title)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text("· \(group.runs.count) runs")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    if let runtime = jobRunRuntimeText(group.latest) {
                        Text("· \(runtime)")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    if let timestamp {
                        Text("· \(timestamp)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 0)
                    Button {
                        copyToPasteboard(ZClipboardText.normalizedForCopy(latestText))
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .help("Copy latest job output")
                }

                MarkdownView(markdown: latestText, linkContext: linkContext)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if !group.olderNewestFirst.isEmpty {
                    DisclosureGroup(isExpanded: $olderOpen) {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(group.olderNewestFirst.prefix(6)), id: \.id) { run in
                                JobRunCompactLine(jobRun: run)
                            }
                            if group.olderNewestFirst.count > 6 {
                                Text("\(group.olderNewestFirst.count - 6) more earlier runs hidden")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.top, 4)
                    } label: {
                        Text("\(group.olderNewestFirst.count) earlier job run\(group.olderNewestFirst.count == 1 ? "" : "s") hidden")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(.orange.opacity(0.75))
                    .frame(width: 3)
            }
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.jobBubbleStroke.opacity(0.65)))
            Spacer(minLength: 80)
        }
    }

    private var latestText: String {
        jobRunBodyText(group.latest)
    }

    private var timestamp: String? {
        localTimestampString(group.latest.finishedAt ?? group.latest.lastEventAt ?? group.latest.runEvent.ts)
    }

    private func copyToPasteboard(_ string: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
    }
}

private struct JobRunCompactLine: View {
    let jobRun: JobRunRow
    @State private var detailOpen = false

    var body: some View {
        Button {
            detailOpen = true
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
                    .frame(width: 16)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    Text(jobRunLabel(jobRun))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                    Text(preview)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Text("Open")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.softLine))
        .help("Open full job run details")
        .sheet(isPresented: $detailOpen) {
            FullMessageSheet(label: jobRunLabel(jobRun), text: jobRunBodyText(jobRun))
        }
    }

    private var preview: String {
        jobRunBodyText(jobRun)
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty }) ?? "No output yet"
    }
}

private func jobRunLabel(_ jobRun: JobRunRow) -> String {
    let title: String
    if jobRun.isFinished {
        title = "Job Response · \(jobRun.job.title)"
    } else {
        title = "Job Running · \(jobRun.job.title)"
    }
    guard let runtime = jobRunRuntimeText(jobRun) else {
        return title
    }
    return "\(title) · \(runtime)"
}

private func jobRunBodyText(_ jobRun: JobRunRow) -> String {
    if let result = jobRun.resultText?.trimmingCharacters(in: .whitespacesAndNewlines), !result.isEmpty {
        return result
    }
    if let error = jobRun.errorText?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty {
        return error
    }
    return "Scheduled job started. Waiting for agent output..."
}

private func jobRunRuntimeText(_ jobRun: JobRunRow) -> String? {
    guard let start = jobRunDate(jobRun.startedAt ?? jobRun.runEvent.ts) else { return nil }
    let end = jobRunDate(jobRun.finishedAt) ?? jobRunDate(jobRun.lastEventAt) ?? start
    let seconds = max(0, Int(end.timeIntervalSince(start)))
    let suffix = jobRun.isFinished ? "" : " so far"
    return "runtime \(jobRunDurationString(seconds))\(suffix)"
}

private func jobRunDate(_ value: String?) -> Date? {
    parseServerDate(value)
}

private func jobRunDurationString(_ seconds: Int) -> String {
    if seconds < 60 {
        return "\(seconds)s"
    }
    if seconds < 3600 {
        let minutes = seconds / 60
        let remainder = seconds % 60
        return remainder == 0 ? "\(minutes)m" : "\(minutes)m \(remainder)s"
    }
    let hours = seconds / 3600
    let minutes = (seconds % 3600) / 60
    return minutes == 0 ? "\(hours)h" : "\(hours)h \(minutes)m"
}

private struct MessageAttachmentStrip: View {
    let attachments: [MessageAttachment]
    let isUser: Bool

    private let columns = Array(repeating: GridItem(.flexible(minimum: 120, maximum: 190), spacing: 8), count: 4)

    var body: some View {
#if AGENTSDOCK_LAZY_TIMELINE
        Grid(
            alignment: isUser ? .trailing : .leading,
            horizontalSpacing: 8,
            verticalSpacing: 8
        ) {
            ForEach(eagerGridRows(attachments, columnCount: columns.count), id: \.first?.file.id) { row in
                GridRow {
                    ForEach(row, id: \.file.id) { attachment in
                        MessageAttachmentPreview(attachment: attachment)
                            .frame(minWidth: 120, idealWidth: 190, maxWidth: 190)
                    }
                    eagerGridPlaceholders(count: columns.count - row.count, minWidth: 120, maxWidth: 190)
                }
            }
        }
        .frame(maxWidth: 792, alignment: isUser ? .trailing : .leading)
        .padding(.vertical, 1)
#else
        LazyVGrid(columns: columns, alignment: isUser ? .trailing : .leading, spacing: 8) {
            ForEach(attachments, id: \.file.id) { attachment in
                MessageAttachmentPreview(attachment: attachment)
            }
        }
        .frame(maxWidth: 792, alignment: isUser ? .trailing : .leading)
        .padding(.vertical, 1)
#endif
    }
}

private struct MessageAttachmentPreview: View {
    let attachment: MessageAttachment

    var body: some View {
        Group {
            if let url = attachment.url,
               attachment.file.content_type?.hasPrefix("image/") == true {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .scaledToFill()
                } placeholder: {
                    ZStack {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color.black.opacity(0.08))
                        ProgressView()
                    }
                }
                .frame(height: 116)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                HStack(spacing: 7) {
                    Image(systemName: icon)
                    Text(attachment.file.filename)
                        .lineLimit(1)
                }
                .font(.caption.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 116)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Color.black.opacity(0.07))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
        .overlay(alignment: .topTrailing) {
            if let url = attachment.url {
                MacArtifactDownloadButton(file: attachment.file, url: url, title: "")
                    .padding(6)
                    .background(.ultraThinMaterial, in: Circle())
                    .help("Download attachment")
            }
        }
        .contentShape(Rectangle())
        .onDrag {
            if let url = attachment.url {
                return ArtifactDragItemProvider.provider(for: attachment.file, url: url)
            }
            return NSItemProvider(object: attachment.file.filename as NSString)
        }
        .help(attachment.file.filename)
    }

    private var icon: String {
        if attachment.file.content_type?.hasPrefix("video/") == true { return "film" }
        if attachment.file.content_type?.hasPrefix("image/") == true { return "photo" }
        return "doc"
    }
}

struct ArtifactGridItem: Identifiable, Hashable {
    let file: ZFile
    let url: URL

    var id: String { file.id }
}

struct ArtifactGridCard: View, Equatable {
    let artifacts: [ArtifactGridItem]
    var linkContext: ZMarkdownLinkContext?
    var isPinned: (ZFile) -> Bool
    var onTogglePin: (ZFile) -> Void
    @State private var isExpanded = false

    nonisolated static func == (lhs: ArtifactGridCard, rhs: ArtifactGridCard) -> Bool {
        lhs.artifacts == rhs.artifacts && lhs.linkContext == rhs.linkContext
    }

    private let columns = Array(repeating: GridItem(.flexible(minimum: 150, maximum: 210), spacing: 10), count: 4)
    private let initialArtifactLimit = 4

    private var visibleArtifacts: [ArtifactGridItem] {
        isExpanded ? artifacts : Array(artifacts.prefix(initialArtifactLimit))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "shippingbox")
                .foregroundStyle(.green)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text("Files & Videos")
                        .font(.subheadline.weight(.semibold))
                    Text("\(artifacts.count)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                let mediaArtifacts = visibleArtifacts.filter { $0.file.isPreviewableArtifact }
                let fileArtifacts = visibleArtifacts.filter { !$0.file.isPreviewableArtifact }
                if !mediaArtifacts.isEmpty {
#if AGENTSDOCK_LAZY_TIMELINE
                    Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 10) {
                        ForEach(eagerGridRows(mediaArtifacts, columnCount: columns.count), id: \.first?.id) { row in
                            GridRow {
                                ForEach(row) { artifact in
                                    ArtifactGridTile(
                                        file: artifact.file,
                                        url: artifact.url,
                                        linkContext: linkContext,
                                        isPinned: isPinned(artifact.file),
                                        onTogglePin: { onTogglePin(artifact.file) }
                                    )
                                    .frame(minWidth: 150, idealWidth: 210, maxWidth: 210)
                                }
                                eagerGridPlaceholders(
                                    count: columns.count - row.count,
                                    minWidth: 150,
                                    maxWidth: 210
                                )
                            }
                        }
                    }
#else
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 10) {
                        ForEach(mediaArtifacts) { artifact in
                            ArtifactGridTile(
                                file: artifact.file,
                                url: artifact.url,
                                linkContext: linkContext,
                                isPinned: isPinned(artifact.file),
                                onTogglePin: { onTogglePin(artifact.file) }
                            )
                        }
                    }
#endif
                }
                if !fileArtifacts.isEmpty {
                    VStack(spacing: 6) {
                        ForEach(fileArtifacts) { artifact in
                            ArtifactFileRow(
                                file: artifact.file,
                                url: artifact.url,
                                isPinned: isPinned(artifact.file),
                                onTogglePin: { onTogglePin(artifact.file) }
                            )
                        }
                    }
                }
                if artifacts.count > initialArtifactLimit {
                    Button {
                        isExpanded.toggle()
                    } label: {
                        Label(
                            isExpanded ? "Show fewer" : "Show \(artifacts.count - initialArtifactLimit) more",
                            systemImage: isExpanded ? "chevron.up" : "chevron.down"
                        )
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help(isExpanded ? "Collapse files and videos" : "Show all files and videos from this turn")
                }
            }
            .padding(14)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator.opacity(0.35)))
            .frame(maxWidth: 900, alignment: .leading)
        }
        .onChange(of: artifacts.map(\.id).joined(separator: ":")) {
            isExpanded = false
        }
    }
}

#if AGENTSDOCK_LAZY_TIMELINE
private func eagerGridRows<Element>(_ elements: [Element], columnCount: Int) -> [[Element]] {
    stride(from: 0, to: elements.count, by: columnCount).map { startIndex in
        Array(elements[startIndex..<min(startIndex + columnCount, elements.count)])
    }
}

@ViewBuilder
private func eagerGridPlaceholders(count: Int, minWidth: CGFloat, maxWidth: CGFloat) -> some View {
    ForEach(0..<count, id: \.self) { _ in
        Color.clear
            .frame(minWidth: minWidth, idealWidth: maxWidth, maxWidth: maxWidth)
            .gridCellUnsizedAxes(.vertical)
            .accessibilityHidden(true)
    }
}
#endif

private struct ArtifactGridTile: View {
    let file: ZFile
    let url: URL
    var linkContext: ZMarkdownLinkContext?
    var isPinned: Bool
    var onTogglePin: () -> Void
    @State private var imagePreviewOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let text = file.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                MarkdownView(markdown: text, compact: true, linkContext: linkContext)
                    .font(.caption)
                    .lineLimit(3)
            }
            previewableMedia
            fileFooter
        }
        .padding(8)
        .background(Color.black.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
        .contentShape(Rectangle())
        .onDrag {
            ArtifactDragItemProvider.provider(for: file, url: url)
        }
        .help(file.filename)
        .sheet(isPresented: $imagePreviewOpen) {
            MacImagePreviewSheet(file: file, url: url)
        }
    }

    private var fileFooter: some View {
        HStack(spacing: 6) {
            Image(systemName: file.artifactIcon)
                .font(.caption2.weight(.semibold))
            Text(file.title ?? file.filename)
                .lineLimit(1)
            Spacer(minLength: 0)
            Link(destination: url) {
                Image(systemName: "arrow.up.right.square")
            }
            MacArtifactDownloadButton(file: file, url: url, title: "")
            Button(action: onTogglePin) {
                Image(systemName: isPinned ? "pin.fill" : "pin")
            }
            .buttonStyle(.borderless)
            .help(isPinned ? "Unpin from right panel" : "Pin to right panel")
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var previewableMedia: some View {
        if file.content_type?.hasPrefix("image/") == true {
            Button {
                imagePreviewOpen = true
            } label: {
                media
                    .frame(height: 112)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(alignment: .bottomTrailing) {
                        Label("Preview", systemImage: "arrow.up.left.and.arrow.down.right")
                            .labelStyle(.iconOnly)
                            .font(.caption.weight(.bold))
                            .padding(7)
                            .background(.black.opacity(0.55), in: Circle())
                            .foregroundStyle(.white)
                            .padding(6)
                    }
            }
            .buttonStyle(.plain)
            .help("Open image preview")
        } else {
            media
                .frame(height: 112)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    @ViewBuilder
    private var media: some View {
        if file.content_type?.hasPrefix("image/") == true {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else if file.content_type?.hasPrefix("video/") == true {
            InlineVideoView(url: url)
        }
    }
}

private struct ArtifactFileRow: View {
    let file: ZFile
    let url: URL
    var isPinned = false
    var onTogglePin: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: file.artifactIcon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.title ?? file.filename)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !metadata.isEmpty {
                    Text(metadata)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            Link(destination: url) {
                Image(systemName: "arrow.up.right.square")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            MacArtifactDownloadButton(file: file, url: url, title: "")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if let onTogglePin {
                Button(action: onTogglePin) {
                    Image(systemName: isPinned ? "pin.fill" : "pin")
                }
                .buttonStyle(.borderless)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .help(isPinned ? "Unpin from right panel" : "Pin to right panel")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
        .contentShape(Rectangle())
        .onDrag {
            ArtifactDragItemProvider.provider(for: file, url: url)
        }
        .help(file.filename)
    }

    private var metadata: String {
        var parts: [String] = []
        if let contentType = file.content_type, !contentType.isEmpty {
            parts.append(contentType)
        }
        if let size = file.size {
            parts.append(byteString(size))
        }
        return parts.joined(separator: " · ")
    }

}

private extension ZFile {
    var isPreviewableArtifact: Bool {
        content_type?.hasPrefix("image/") == true ||
            content_type?.hasPrefix("video/") == true
    }

    var artifactIcon: String {
        if content_type?.hasPrefix("video/") == true { return "film" }
        if content_type?.hasPrefix("image/") == true { return "photo" }
        return "doc"
    }
}

private struct FullMessageSheet: View {
    let label: String
    let text: String
    @Environment(\.dismiss) private var dismiss

    private var displayText: String {
        ZClipboardText.normalizedForCopy(text)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(label)
                    .font(.headline)
                Text("\(text.count) chars")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(displayText, forType: .string)
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                Button("Done") {
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
            .padding(14)
            Divider()
            ScrollView {
                Text(displayText)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
        }
        .frame(minWidth: 760, idealWidth: 900, minHeight: 560, idealHeight: 720)
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

struct TraceGroupCard: View, Equatable {
    let events: [ZEvent]
    let linkContext: ZMarkdownLinkContext?
    private let summary: TraceGroupComputedSummary
    private let summaryKey: String
    @State private var expanded = false
    @State private var changeSummary: TraceChangeSummary?

    init(events: [ZEvent], linkContext: ZMarkdownLinkContext?) {
        self.events = events
        self.linkContext = linkContext
        summaryKey = TraceGroupSummaryCache.cacheKey(for: events)
        summary = TraceGroupSummaryCache.summary(for: events)
        _changeSummary = State(initialValue: nil)
    }

    nonisolated static func == (lhs: TraceGroupCard, rhs: TraceGroupCard) -> Bool {
        signature(for: lhs.events) == signature(for: rhs.events) &&
            lhs.linkContext == rhs.linkContext
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 8) {
                if let changeSummary {
                    TraceChangeSetCard(summary: changeSummary)
                        .padding(.bottom, 2)
                }
                TraceDisclosureHeader(title: summary.title, detail: summary.detail, isExpanded: $expanded)
                if expanded {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(events) { event in
                            TraceEventDetail(event: event, linkContext: linkContext)
                        }
                    }
                    .padding(.top, 8)
                } else if let previewText = summary.previewText {
                    Text(previewText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.tail)
                        .padding(.leading, 20)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(.secondary.opacity(0.07))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
        }
        .task(id: summaryKey) {
            let loaded = await TraceGroupChangeSummaryCache.shared.summary(
                forKey: summaryKey,
                events: events
            )
            guard !Task.isCancelled else { return }
            changeSummary = loaded
        }
    }

    private var signature: String {
        Self.signature(for: events)
    }

    nonisolated private static func signature(for events: [ZEvent]) -> String {
        "\(events.count):\(events.first?.id ?? ""):\(events.last?.id ?? "")"
    }
}

private struct TraceGroupComputedSummary: Equatable {
    let title: String
    let detail: String
    let previewText: String?
}

private final class TraceGroupSummaryEntry: NSObject {
    let summary: TraceGroupComputedSummary

    init(_ summary: TraceGroupComputedSummary) {
        self.summary = summary
    }
}

private enum TraceGroupSummaryCache {
    nonisolated(unsafe) private static let cache: NSCache<NSString, TraceGroupSummaryEntry> = {
        let cache = NSCache<NSString, TraceGroupSummaryEntry>()
        cache.countLimit = 2_000
        cache.totalCostLimit = 64 * 1_024 * 1_024
        return cache
    }()

    static func summary(for events: [ZEvent]) -> TraceGroupComputedSummary {
        let key = cacheKey(for: events) as NSString
        if let cached = cache.object(forKey: key) {
            return cached.summary
        }
        let summary = makeSummary(for: events)
        cache.setObject(
            TraceGroupSummaryEntry(summary),
            forKey: key,
            cost: estimatedCost(of: summary)
        )
        return summary
    }

    private static func estimatedCost(of summary: TraceGroupComputedSummary) -> Int {
        var cost = 512
        cost += summary.title.utf8.count
        cost += summary.detail.utf8.count
        cost += summary.previewText?.utf8.count ?? 0
        return max(1, cost)
    }

    private static func makeSummary(for events: [ZEvent]) -> TraceGroupComputedSummary {
        let toolEventCount = events.filter { $0.type == "tool_started" || $0.type == "tool_finished" }.count
        let reasoningCount = events.filter { $0.type == "reasoning_summary" }.count
        let ids = Set(events.compactMap { $0.tool?.id ?? $0.tool_id })
        let toolCount = ids.isEmpty ? events.filter { $0.type == "tool_started" }.count : ids.count
        let title: String
        if toolCount > 0 && reasoningCount == 0 {
            title = "Ran \(toolCount) \(toolCount == 1 ? "tool" : "tools")"
        } else if reasoningCount > 0 && toolCount == 0 {
            title = "Reasoning trace"
        } else {
            title = "Trace"
        }

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

        let previewText = tracePreviewText(for: events)
        return TraceGroupComputedSummary(
            title: title,
            detail: parts.joined(separator: " · "),
            previewText: previewText
        )
    }

    private static func tracePreviewText(for events: [ZEvent]) -> String? {
        let pieces = events.compactMap { event -> String? in
            switch event.type {
            case "reasoning_summary":
                return event.text?
                    .split(separator: "\n")
                    .first?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            case "tool_started", "tool_finished":
                return toolPreview(for: event)
            default:
                return nil
            }
        }
        guard !pieces.isEmpty else { return nil }
        return pieces.prefix(2).joined(separator: " · ")
    }

    private static func toolPreview(for event: ZEvent) -> String? {
        if let command = event.tool?.traceCommandText {
            return command
        }
        if let name = event.tool?.name {
            return name
        }
        return event.tool_id
    }

    static func cacheKey(for events: [ZEvent]) -> String {
        guard let first = events.first, let last = events.last else {
            return "empty"
        }
        let middle = events.count > 2 ? events[events.count / 2] : last
        return "\(events.count):\(first.seq):\(first.id):\(middle.seq):\(middle.id):\(last.seq):\(last.id)"
    }
}

private actor TraceGroupChangeSummaryCache {
    struct Entry: Sendable {
        let summary: TraceChangeSummary?
        let cost: Int
    }

    static let shared = TraceGroupChangeSummaryCache()

    private var entries: [String: Entry] = [:]
    private var insertionOrder: [String] = []
    private var totalCost = 0
    private let countLimit = 2_000
    private let totalCostLimit = 64 * 1_024 * 1_024

    func summary(forKey key: String, events: [ZEvent]) -> TraceChangeSummary? {
        if let cached = entries[key] {
            return cached.summary
        }
        guard !Task.isCancelled else { return nil }

        let summary = TraceChangeSummary.extract(from: events)
        guard !Task.isCancelled else { return summary }
        insert(summary, forKey: key)
        return summary
    }

    private func insert(_ summary: TraceChangeSummary?, forKey key: String) {
        let cost = estimatedCost(of: summary)
        entries[key] = Entry(summary: summary, cost: cost)
        insertionOrder.append(key)
        totalCost += cost

        while entries.count > countLimit || totalCost > totalCostLimit {
            guard !insertionOrder.isEmpty else { break }
            let oldest = insertionOrder.removeFirst()
            if let removed = entries.removeValue(forKey: oldest) {
                totalCost -= removed.cost
            }
        }
    }

    private func estimatedCost(of summary: TraceChangeSummary?) -> Int {
        guard let summary else { return 64 }
        let paths = summary.files.reduce(into: 0) { partial, file in
            partial += file.path.utf8.count + 32
        }
        return max(1, 256 + paths + summary.reviewText.utf8.count)
    }
}

private struct TraceEventDetail: View {
    let event: ZEvent
    let linkContext: ZMarkdownLinkContext?
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
            MarkdownView(markdown: event.text ?? "", compact: true, linkContext: linkContext)
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
        case "job_created", "job_ran", "job_deferred":
            JobEventSummary(event: event)
        case "error", "job_error", "artifact_error", "handoff_digest_error":
            VStack(alignment: .leading, spacing: 6) {
                Text(event.message ?? event.error ?? "Unknown error")
                    .foregroundStyle(.red)
                if let job = event.job {
                    Text(job.title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
        case "handoff_digest_started":
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text(event.message ?? "Generating LLM context digest.")
                    .foregroundStyle(.secondary)
            }
        case "handoff_digest_ready", "handoff_digest_sent":
            Text(event.message ?? "Context digest submitted.")
                .foregroundStyle(.secondary)
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
        case "job_created": "Job Created"
        case "job_ran": "Job Ran"
        case "job_deferred": "Job Deferred"
        case "job_error": "Job Error"
        case "handoff_digest_started": "Digest Generating"
        case "handoff_digest_ready": "Digest Ready"
        case "handoff_digest_sent": "Digest Submitted"
        case "handoff_digest_error": "Digest Error"
        case "artifact_error": "Artifact Error"
        default: event.type.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private var icon: String {
        switch event.type {
        case "reasoning_summary": "brain.head.profile"
        case "tool_started", "tool_finished": "terminal"
        case "raw_event": "curlybraces"
        case "job_created", "job_ran", "job_deferred": "clock.badge.checkmark"
        case "handoff_digest_started": "sparkles"
        case "handoff_digest_ready", "handoff_digest_sent": "checkmark.seal"
        case "error", "job_error", "artifact_error", "handoff_digest_error": "exclamationmark.triangle"
        default: "circle"
        }
    }

    private var color: Color {
        switch event.type {
        case "reasoning_summary": .purple
        case "tool_started", "tool_finished": .orange
        case "job_created", "job_ran", "job_deferred": .orange
        case "handoff_digest_started", "handoff_digest_ready", "handoff_digest_sent": .yellow
        case "error", "job_error", "artifact_error", "handoff_digest_error": .red
        default: .secondary
        }
    }
}

private struct JobEventSummary: View {
    let event: ZEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(event.message ?? fallbackMessage)
                .font(.callout.weight(.medium))
            if let job = event.job {
                HStack(spacing: 8) {
                    Label(job.loop == true ? "Loop" : "One shot", systemImage: job.loop == true ? "repeat" : "timer")
                    Text("\(job.run_count ?? 0) run\(job.run_count == 1 ? "" : "s")")
                    if let next = localTimestampString(job.next_run_at_iso), job.enabled {
                        Text("Next \(next)")
                    } else if !job.enabled {
                        Text("Paused")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
        }
    }

    private var fallbackMessage: String {
        switch event.type {
        case "job_created":
            return "Scheduled job created"
        case "job_ran":
            return "Scheduled job ran"
        case "job_deferred":
            return "Scheduled job deferred"
        default:
            return event.type
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
    var linkContext: ZMarkdownLinkContext?
    @State private var imagePreviewOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: icon)
                Text(file.title ?? file.filename)
                    .font(.headline)
                Spacer()
                MacArtifactDownloadButton(file: file, url: url, title: "")
            }
            if let text = file.text {
                MarkdownView(markdown: text, compact: true, linkContext: linkContext)
                    .foregroundStyle(.secondary)
            }
            if file.content_type?.hasPrefix("image/") == true {
                Button {
                    imagePreviewOpen = true
                } label: {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFit()
                    } placeholder: {
                        ProgressView()
                    }
                    .frame(maxHeight: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .help("Open image preview")
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
                        Label("Open Player", systemImage: "play.rectangle")
                    }
                    .buttonStyle(.link)
                    #endif
                    Link(destination: url) {
                        Label("Open", systemImage: "arrow.up.right.square")
                    }
                    MacArtifactDownloadButton(file: file, url: url, title: "")
                }
                .font(.caption)
            }
        }
        .contentShape(Rectangle())
        .onDrag {
            ArtifactDragItemProvider.provider(for: file, url: url)
        }
        .help("Drag file to Finder or another app")
        .sheet(isPresented: $imagePreviewOpen) {
            MacImagePreviewSheet(file: file, url: url)
        }
    }

    var icon: String {
        if file.content_type?.hasPrefix("video/") == true { return "film" }
        if file.content_type?.hasPrefix("image/") == true { return "photo" }
        return "doc"
    }
}

private struct MacImagePreviewSheet: View {
    let file: ZFile
    let url: URL
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "photo")
                    .foregroundStyle(.green)
                Text(file.title ?? file.filename)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 16)
                Link(destination: url) {
                    Label("Open", systemImage: "arrow.up.right.square")
                }
                MacArtifactDownloadButton(file: file, url: url, title: "Download")
                Button("Done") {
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
            .padding(14)
            Divider()
            ZStack {
                Color.black.opacity(0.88)
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .scaledToFit()
                        .padding(12)
                } placeholder: {
                    ProgressView()
                        .controlSize(.large)
                }
            }
        }
        .frame(minWidth: 760, minHeight: 540)
    }
}

private struct UploadedFileLabel: View {
    let file: ZFile
    let url: URL?

    var body: some View {
        if let url {
            HStack(spacing: 8) {
                Label(file.filename, systemImage: "tray.and.arrow.up")
                Spacer(minLength: 6)
                MacArtifactDownloadButton(file: file, url: url, title: "")
            }
            .contentShape(Rectangle())
            .onDrag {
                ArtifactDragItemProvider.provider(for: file, url: url)
            }
            .help("Drag file to Finder or another app")
        } else {
            Label(file.filename, systemImage: "tray.and.arrow.up")
        }
    }
}
