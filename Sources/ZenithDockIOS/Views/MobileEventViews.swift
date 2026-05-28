import AVFoundation
import AVKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers
import ZenithCore

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct MobileMessageAttachment: Hashable {
    let file: ZFile
    let url: URL?
}

struct MobileEventCard: View {
    @EnvironmentObject private var store: MobileAppStore
    let event: ZEvent
    var job: ZJob?

    var body: some View {
        switch event.type {
        case "turn_started":
            userBubble(label: "You", text: event.prompt ?? "", attachments: promptAttachments)
        case "turn_queued":
            let isPending = store.isQueuedEventPending(event)
            userBubble(
                label: queuedLabel,
                text: event.prompt ?? "",
                queued: isPending,
                attachments: promptAttachments,
                actionTitle: isPending ? "Unqueue" : nil,
                actionSystemImage: isPending ? "xmark.circle" : nil,
                action: isPending ? { Task { await store.unqueue(event) } } : nil
            )
        case "assistant_text":
            assistantBubble(text: event.text ?? "")
        case "turn_finished":
            if let text = event.result_text, !text.isEmpty {
                assistantBubble(
                    label: job.map { "Job Response · \($0.title)" } ?? "Assistant",
                    text: text,
                    isJob: job != nil
                )
            }
        case "artifact_created":
            if let artifact = event.artifact {
                MobileArtifactView(file: artifact, url: store.fileURL(artifact), linkContext: linkContext)
            }
        case "file_uploaded":
            if let file = event.file {
                MobileSystemCard(icon: "tray.and.arrow.up", title: "Upload", timestamp: messageTimestamp) {
                    MobileUploadedFileLabel(file: file, url: store.fileURL(file))
                }
            }
        case "job_created", "job_ran":
            MobileSystemCard(
                icon: "clock.badge.checkmark",
                title: event.type == "job_created" ? "Job Created" : "Job Ran",
                timestamp: messageTimestamp,
                tint: .orange
            ) {
                MobileJobEventSummary(event: event)
            }
        case "error", "job_error", "artifact_error":
            MobileSystemCard(
                icon: "exclamationmark.triangle",
                title: event.type == "job_error" ? "Job Error" : "Error",
                timestamp: messageTimestamp,
                tint: .red
            ) {
                Text(event.message ?? event.error ?? "Unknown error")
                    .foregroundStyle(.red)
            }
        default:
            MobileSystemCard(
                icon: "circle",
                title: event.type.replacingOccurrences(of: "_", with: " ").capitalized,
                timestamp: messageTimestamp
            ) {
                MobileMarkdownView(markdown: event.message ?? event.text ?? event.type, linkContext: linkContext)
            }
        }
    }

    private var linkContext: ZMarkdownLinkContext {
        store.markdownLinkContext(sessionID: event.session_id)
    }

    private var promptAttachments: [MobileMessageAttachment] {
        store.promptFiles(for: event).map { MobileMessageAttachment(file: $0, url: store.fileURL($0)) }
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
        attachments: [MobileMessageAttachment] = [],
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
                timestamp: messageTimestamp,
                attachments: attachments,
                actionTitle: actionTitle,
                actionSystemImage: actionSystemImage,
                linkContext: linkContext,
                action: action
            )
        }
    }

    private func assistantBubble(label: String = "Assistant", text: String, isJob: Bool = false) -> some View {
        HStack {
            MobileMessageBubble(label: label, text: text, isUser: false, isJob: isJob, timestamp: messageTimestamp, linkContext: linkContext)
            Spacer(minLength: 44)
        }
    }

    private var messageTimestamp: String? {
        mobileMessageTimestampString(event.ts)
    }
}

private struct MobileJobEventSummary: View {
    let event: ZEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(event.message ?? fallbackMessage)
                .font(.subheadline.weight(.medium))
            if let job = event.job {
                HStack(spacing: 8) {
                    Label(job.loop == true ? "Loop" : "One shot", systemImage: job.loop == true ? "repeat" : "timer")
                    Text("\(job.run_count ?? 0) run\(job.run_count == 1 ? "" : "s")")
                    if let next = job.next_run_at_iso, job.enabled {
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
        event.type == "job_created" ? "Scheduled job created" : "Scheduled job ran"
    }
}

struct MobileMessageBubble: View {
    let label: String
    let text: String
    let isUser: Bool
    var queued = false
    var isJob = false
    var timestamp: String?
    var attachments: [MobileMessageAttachment] = []
    var actionTitle: String?
    var actionSystemImage: String?
    var linkContext: ZMarkdownLinkContext?
    var action: (() -> Void)?
    @State private var fullTextExpanded = false

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 7) {
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
                }
                if shouldClip {
                    Button {
                        fullTextExpanded.toggle()
                    } label: {
                        Image(systemName: fullTextExpanded ? "chevron.up" : "text.page")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(fullTextExpanded ? "Collapse message" : "Expand full message")
                }
                Button {
                    copyToPasteboard(ZClipboardText.normalizedForCopy(text))
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                if !isUser { Spacer(minLength: 0) }
            }
            MobileMarkdownView(markdown: visibleText, linkContext: linkContext)
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
            if !attachments.isEmpty {
                MobileMessageAttachmentStrip(attachments: attachments, isUser: isUser)
            }
            if shouldClip {
                HStack(spacing: 8) {
                    Text(fullTextExpanded ? "Full text shown" : "\(hiddenCharacterCount) hidden")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button(fullTextExpanded ? "Collapse" : "Full text") {
                        fullTextExpanded.toggle()
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.borderless)
                }
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 11)
        .frame(maxWidth: isUser ? 700 : .infinity, alignment: isUser ? .trailing : .leading)
        .background(background)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(strokeColor))
    }

    private var background: some ShapeStyle {
        if queued {
            return AnyShapeStyle(MobileTheme.queuedBubble)
        }
        if isJob {
            return AnyShapeStyle(MobileTheme.jobBubble)
        }
        return isUser ? AnyShapeStyle(MobileTheme.userBubble) : AnyShapeStyle(MobileTheme.card)
    }

    private var strokeColor: Color {
        if queued {
            return MobileTheme.queuedBubbleStroke
        }
        if isJob {
            return MobileTheme.jobBubbleStroke
        }
        if isUser {
            return MobileTheme.userBubbleStroke
        }
        return MobileTheme.softLine
    }

    private var shouldClip: Bool {
        guard isContextDigest else { return false }
        return text.count > collapsedCharacterLimit || lineCount > collapsedLineLimit
    }

    private var hiddenCharacterCount: Int {
        max(text.count - clippedBody.count, 0)
    }

    private var visibleText: String {
        guard shouldClip, !fullTextExpanded else { return text }
        return clippedBody.trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n[message folded in UI; copy and full text use the complete message]"
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
        isContextDigest ? 1_350 : 1_800
    }

    private var collapsedLineLimit: Int {
        isContextDigest ? 15 : 18
    }

    private var lineCount: Int {
        text.split(separator: "\n", omittingEmptySubsequences: false).count
    }

    private var isContextDigest: Bool {
        text.contains("# ZenithDock Context Digest")
    }
}

struct MobileJobRunBubble: View {
    let jobRun: MobileJobRunRow
    let linkContext: ZMarkdownLinkContext?

    var body: some View {
        HStack {
            MobileMessageBubble(
                label: label,
                text: bodyText,
                isUser: false,
                isJob: true,
                timestamp: timestamp,
                linkContext: linkContext
            )
            Spacer(minLength: 44)
        }
    }

    private var label: String {
        mobileJobRunLabel(jobRun)
    }

    private var bodyText: String {
        mobileJobRunBodyText(jobRun)
    }

    private var timestamp: String? {
        mobileMessageTimestampString(jobRun.finishedAt ?? jobRun.lastEventAt ?? jobRun.runEvent.ts)
    }
}

struct MobileJobRunGroupBubble: View {
    let group: MobileJobRunGroupRow
    let linkContext: ZMarkdownLinkContext?
    @State private var olderOpen = false

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 6) {
                    Label("Latest Job Status", systemImage: "clock.badge.checkmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text("· \(group.runs.count) runs")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    if let runtime = mobileJobRunRuntimeText(group.latest) {
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
                        UIPasteboard.general.string = ZClipboardText.normalizedForCopy(latestText)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Copy latest job output")
                }
                Text(group.latest.job.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                MobileMarkdownView(markdown: latestText, linkContext: linkContext)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if !group.olderNewestFirst.isEmpty {
                    DisclosureGroup(isExpanded: $olderOpen) {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(group.olderNewestFirst.prefix(6)), id: \.id) { run in
                                MobileJobRunCompactLine(jobRun: run)
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
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MobileTheme.card)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 12)
                    .fill(.orange.opacity(0.75))
                    .frame(width: 3)
            }
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(MobileTheme.jobBubbleStroke.opacity(0.65)))
            Spacer(minLength: 44)
        }
    }

    private var latestText: String {
        mobileJobRunBodyText(group.latest)
    }

    private var timestamp: String? {
        mobileMessageTimestampString(group.latest.finishedAt ?? group.latest.lastEventAt ?? group.latest.runEvent.ts)
    }
}

private struct MobileJobRunCompactLine: View {
    let jobRun: MobileJobRunRow
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
                    Text(mobileJobRunLabel(jobRun))
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
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(MobileTheme.softLine))
        .accessibilityLabel("Open full job run details")
        .sheet(isPresented: $detailOpen) {
            MobileFullMessageSheet(label: mobileJobRunLabel(jobRun), text: mobileJobRunBodyText(jobRun))
        }
    }

    private var preview: String {
        mobileJobRunBodyText(jobRun)
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty }) ?? "No output yet"
    }
}

private func mobileJobRunLabel(_ jobRun: MobileJobRunRow) -> String {
    let title: String
    if jobRun.isFinished {
        title = "Job Response · \(jobRun.job.title)"
    } else {
        title = "Job Running · \(jobRun.job.title)"
    }
    guard let runtime = mobileJobRunRuntimeText(jobRun) else {
        return title
    }
    return "\(title) · \(runtime)"
}

private func mobileJobRunBodyText(_ jobRun: MobileJobRunRow) -> String {
    if let result = jobRun.resultText?.trimmingCharacters(in: .whitespacesAndNewlines), !result.isEmpty {
        return result
    }
    if let error = jobRun.errorText?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty {
        return error
    }
    return "Scheduled job started. Waiting for agent output..."
}

private func mobileJobRunRuntimeText(_ jobRun: MobileJobRunRow) -> String? {
    guard let start = mobileJobRunDate(jobRun.startedAt ?? jobRun.runEvent.ts) else { return nil }
    let end = mobileJobRunDate(jobRun.finishedAt) ?? mobileJobRunDate(jobRun.lastEventAt) ?? start
    let seconds = max(0, Int(end.timeIntervalSince(start)))
    let suffix = jobRun.isFinished ? "" : " so far"
    return "runtime \(mobileJobRunDurationString(seconds))\(suffix)"
}

private func mobileJobRunDate(_ value: String?) -> Date? {
    guard let value, !value.isEmpty else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) {
        return date
    }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: value)
}

private func mobileJobRunDurationString(_ seconds: Int) -> String {
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

private struct MobileMessageAttachmentStrip: View {
    let attachments: [MobileMessageAttachment]
    let isUser: Bool

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments, id: \.file.id) { attachment in
                    MobileMessageAttachmentPreview(attachment: attachment)
                }
            }
            .padding(.vertical, 1)
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }
}

private struct MobileMessageAttachmentPreview: View {
    let attachment: MobileMessageAttachment

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
                        RoundedRectangle(cornerRadius: 10)
                            .fill(.black.opacity(0.08))
                        ProgressView()
                    }
                }
                .frame(width: 170, height: 118)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            } else {
                HStack(spacing: 7) {
                    Image(systemName: icon)
                    Text(attachment.file.filename)
                        .lineLimit(1)
                }
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(.black.opacity(0.07))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(MobileTheme.softLine))
        .accessibilityLabel(attachment.file.filename)
    }

    private var icon: String {
        if attachment.file.content_type?.hasPrefix("video/") == true { return "film" }
        if attachment.file.content_type?.hasPrefix("image/") == true { return "photo" }
        return "doc"
    }
}

private struct MobileFullMessageSheet: View {
    let label: String
    let text: String
    @Environment(\.dismiss) private var dismiss

    private var displayText: String {
        ZClipboardText.normalizedForCopy(text)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(displayText)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .navigationTitle(label)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        copyToPasteboard(displayText)
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                }
            }
        }
    }
}

struct MobileSystemCard<Content: View>: View {
    let icon: String
    let title: String
    var timestamp: String?
    var tint: Color = .secondary
    @ViewBuilder var content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Text(title)
                        .font(.caption.weight(.semibold))
                    if let timestamp {
                        Text(timestamp)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 0)
                }
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

private func mobileMessageTimestampString(_ value: String?) -> String? {
    guard let date = mobileMessageDate(value) else { return value }

    let calendar = Calendar.autoupdatingCurrent
    let timeFormatter = DateFormatter()
    timeFormatter.locale = .autoupdatingCurrent
    timeFormatter.timeZone = .autoupdatingCurrent
    timeFormatter.timeStyle = .short
    timeFormatter.dateStyle = .none

    if calendar.isDateInToday(date) {
        return "\(timeFormatter.string(from: date)) today"
    }

    if calendar.isDateInTomorrow(date) {
        return "\(timeFormatter.string(from: date)) tomorrow"
    }

    let formatter = DateFormatter()
    formatter.locale = .autoupdatingCurrent
    formatter.timeZone = .autoupdatingCurrent
    if calendar.component(.year, from: date) == calendar.component(.year, from: Date()) {
        formatter.setLocalizedDateFormatFromTemplate("MMM d, h:mm a")
    } else {
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
    }
    return formatter.string(from: date)
}

private func mobileMessageDate(_ value: String?) -> Date? {
    guard let value, !value.isEmpty else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) {
        return date
    }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: value)
}

struct MobileTraceCard: View {
    let events: [ZEvent]
    var linkContext: ZMarkdownLinkContext?
    @State private var expanded = false

    var body: some View {
        MobileSystemCard(icon: "chevron.left.forwardslash.chevron.right", title: "") {
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(events) { event in
                        MobileTraceRow(event: event, linkContext: linkContext)
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
    var linkContext: ZMarkdownLinkContext?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            switch event.type {
            case "reasoning_summary":
                MobileMarkdownView(markdown: event.text ?? "", linkContext: linkContext)
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
    var linkContext: ZMarkdownLinkContext?

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(MobileMarkdownParser.parse(MobileTextCleanup.stripDecorativePrefixes(markdown))) { block in
                switch block.kind {
                case .prose:
                    Text(attributed(block.text, linkContext: linkContext))
                        .font(.body)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                case .code:
                    MobileCodeBlock(text: block.text, language: block.language)
                case .table:
                    if let table = block.table {
                        MobileMarkdownTableView(table: table, linkContext: linkContext)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func attributed(_ text: String, linkContext: ZMarkdownLinkContext?) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        resolveMarkdownLinks(in: &parsed, context: linkContext)
        return parsed
    }
}

private struct MobileMarkdownTableView: View {
    let table: MobileMarkdownTable
    var linkContext: ZMarkdownLinkContext?

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
            .background(MobileTheme.card)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(MobileTheme.softLine))
            .textSelection(.enabled)
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
        Text(attributed(text, linkContext: linkContext))
            .font(.callout.weight(isHeader ? .semibold : .regular))
            .lineLimit(nil)
            .fixedSize(horizontal: false, vertical: true)
            .frame(width: table.columnWidth(column), alignment: table.alignments[safe: column]?.swiftAlignment ?? .leading)
            .padding(.horizontal, 9)
            .padding(.vertical, isHeader ? 8 : 7)
            .background(isHeader ? Color.primary.opacity(0.045) : Color.clear)
            .overlay(alignment: .trailing) {
                if column < table.columnCount - 1 {
                    Rectangle()
                        .fill(MobileTheme.softLine)
                        .frame(width: 1)
                }
            }
    }

    private func attributed(_ text: String, linkContext: ZMarkdownLinkContext?) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        resolveMarkdownLinks(in: &parsed, context: linkContext)
        return parsed
    }
}

private func resolveMarkdownLinks(in attributed: inout AttributedString, context: ZMarkdownLinkContext?) {
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

private enum MobileTextCleanup {
    static func stripDecorativePrefixes(_ text: String) -> String {
        guard text.contains(":") else { return text }
        let pattern = #"(?m)^[ \t]*(?::[A-Za-z0-9_+\-]+:[ \t]*)+"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: "")
    }
}

struct MobileCodeBlock: View {
    let text: String
    var language: String?

    private var displayText: String {
        ZClipboardText.normalizedForCopy(text, language: language)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(language?.isEmpty == false ? language! : "code")
                    .font(.caption.weight(.semibold).monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    copyToPasteboard(displayText)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.black.opacity(0.04))
            Divider()
            ScrollView(.horizontal, showsIndicators: true) {
                Text(displayText)
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
    var linkContext: ZMarkdownLinkContext?
    @State private var fullscreenVideo = false
    @State private var videoThumbnail: UIImage?
    @State private var videoThumbnailFailed = false

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
                    MobileTimelineVideoPoster(image: videoThumbnail, failed: videoThumbnailFailed)
                        .frame(maxWidth: .infinity)
                        .aspectRatio(16.0 / 9.0, contentMode: .fit)
                        .onTapGesture {
                            fullscreenVideo = true
                        }
                    HStack(spacing: 12) {
                        Label(file.size.map(mobileByteString) ?? "Video", systemImage: "film")
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 8)
                        MobileArtifactShareButton(file: file, url: url)
                        Button {
                            fullscreenVideo = true
                        } label: {
                            Label("Fullscreen", systemImage: "arrow.up.left.and.arrow.down.right")
                        }
                    }
                    .font(.caption.weight(.semibold))
                }
                if let text = file.text {
                    MobileMarkdownView(markdown: text, linkContext: linkContext)
                }
                Link(destination: url) {
                    Label("Open file", systemImage: "arrow.up.right.square")
                }
                .font(.caption.weight(.semibold))
                MobileArtifactShareButton(file: file, url: url)
                    .font(.caption.weight(.semibold))
            }
        }
        .mobileVideoFullscreen(isPresented: $fullscreenVideo, url: url, title: file.title ?? file.filename)
        .contentShape(Rectangle())
        .onDrag {
            MobileArtifactDragItemProvider.provider(for: file, url: url)
        }
        .task(id: url) {
            if file.content_type?.hasPrefix("video/") == true {
                await loadVideoThumbnail()
            }
        }
    }

    private var icon: String {
        if file.content_type?.hasPrefix("video/") == true { return "film" }
        if file.content_type?.hasPrefix("image/") == true { return "photo" }
        return "doc"
    }

    private func loadVideoThumbnail() async {
        videoThumbnail = nil
        videoThumbnailFailed = false
        let data = await MobileTimelineVideoThumbnailCache.shared.thumbnailData(for: url)
        guard let data else {
            videoThumbnailFailed = true
            return
        }
        videoThumbnail = UIImage(data: data)
        videoThumbnailFailed = videoThumbnail == nil
    }
}

private struct MobileTimelineVideoPoster: View {
    let image: UIImage?
    let failed: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10)
                .fill(.black.opacity(0.18))
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: failed ? "film" : "photo.on.rectangle")
                    .font(.title.weight(.semibold))
                    .foregroundStyle(.green)
            }
            LinearGradient(
                colors: [.black.opacity(0.32), .clear, .black.opacity(0.24)],
                startPoint: .top,
                endPoint: .bottom
            )
            Image(systemName: "play.circle.fill")
                .font(.system(size: 44, weight: .semibold))
                .foregroundStyle(.white.opacity(0.94))
                .shadow(radius: 4)
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .clipped()
    }
}

private actor MobileTimelineVideoThumbnailCache {
    static let shared = MobileTimelineVideoThumbnailCache()

    private var cached: [String: Data] = [:]
    private var order: [String] = []
    private var failed: Set<String> = []
    private let maxCached = 160

    func thumbnailData(for url: URL) async -> Data? {
        let key = url.absoluteString
        if let data = cached[key] {
            return data
        }
        if failed.contains(key) {
            return nil
        }
        do {
            let data = try await Task.detached(priority: .utility) {
                try makeMobileTimelineVideoThumbnailData(from: url)
            }.value
            cached[key] = data
            order.append(key)
            trimIfNeeded()
            return data
        } catch {
            failed.insert(key)
            return nil
        }
    }

    private func trimIfNeeded() {
        guard order.count > maxCached else { return }
        let overflow = order.count - maxCached
        let expired = order.prefix(overflow)
        for key in expired {
            cached.removeValue(forKey: key)
        }
        order.removeFirst(overflow)
    }
}

private func makeMobileTimelineVideoThumbnailData(from url: URL) throws -> Data {
    let asset = AVURLAsset(url: url)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 720, height: 420)
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
    let image = try generator.copyCGImage(at: CMTime(seconds: 0.2, preferredTimescale: 600), actualTime: nil)
    guard let data = UIImage(cgImage: image).jpegData(compressionQuality: 0.72) else {
        throw CocoaError(.fileWriteUnknown)
    }
    return data
}

struct MobileArtifactShareButton: View {
    let file: ZFile
    let url: URL
    var title: String = "Save"

    @State private var isPreparing = false
    @State private var shareURL: MobileShareFile?
    @State private var errorText: String?

    var body: some View {
        Button {
            Task { await prepareShare() }
        } label: {
            Label(isPreparing ? "Preparing" : title, systemImage: "square.and.arrow.down")
        }
        .disabled(isPreparing)
        .sheet(item: $shareURL) { item in
            MobileActivityView(activityItems: [item.url])
        }
        .alert("Download Failed", isPresented: errorBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorText ?? "Could not prepare this file for sharing.")
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding {
            errorText != nil
        } set: { newValue in
            if !newValue {
                errorText = nil
            }
        }
    }

    @MainActor
    private func prepareShare() async {
        isPreparing = true
        defer { isPreparing = false }
        do {
            let localURL = try await MobileArtifactDragFileCache.shared.localFile(for: file, remoteURL: url)
            shareURL = MobileShareFile(url: localURL)
        } catch {
            errorText = "Could not download \(file.filename)."
        }
    }
}

struct MobileShareFile: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

#if canImport(UIKit)
struct MobileActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
#endif

private struct MobileUploadedFileLabel: View {
    let file: ZFile
    let url: URL

    var body: some View {
        Text(file.filename)
            .contentShape(Rectangle())
            .onDrag {
                MobileArtifactDragItemProvider.provider(for: file, url: url)
            }
    }
}

enum MobileArtifactDragItemProvider {
    static func provider(for file: ZFile, url: URL) -> NSItemProvider {
        let provider = NSItemProvider()
        let type = dragType(for: file)
        provider.suggestedName = file.filename
        provider.registerFileRepresentation(
            forTypeIdentifier: type.identifier,
            fileOptions: [],
            visibility: .all
        ) { completion in
            let progress = Progress(totalUnitCount: 100)
            Task.detached(priority: .userInitiated) {
                do {
                    let localURL = try await MobileArtifactDragFileCache.shared.localFile(for: file, remoteURL: url)
                    progress.completedUnitCount = 100
                    completion(localURL, true, nil)
                } catch {
                    completion(nil, false, error)
                }
            }
            return progress
        }
        provider.registerObject(url as NSURL, visibility: .all)
        provider.registerObject(url.absoluteString as NSString, visibility: .all)
        return provider
    }

    private static func dragType(for file: ZFile) -> UTType {
        if let ext = file.filename.split(separator: ".").last,
           ext != file.filename,
           let type = UTType(filenameExtension: String(ext)) {
            return type
        }
        if let contentType = file.content_type,
           let type = UTType(contentType) {
            return type
        }
        return .data
    }
}

actor MobileArtifactDragFileCache {
    static let shared = MobileArtifactDragFileCache()

    private var cached: [String: URL] = [:]

    func localFile(for file: ZFile, remoteURL: URL) async throws -> URL {
        if remoteURL.isFileURL {
            return remoteURL
        }

        if let existing = cached[file.id], FileManager.default.fileExists(atPath: existing.path) {
            return existing
        }

        let destination = try cacheURL(for: file)
        if FileManager.default.fileExists(atPath: destination.path) {
            cached[file.id] = destination
            return destination
        }

        let (tempURL, response) = try await URLSession.shared.download(from: remoteURL)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw CocoaError(.fileReadUnknown)
        }

        let folder = destination.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.moveItem(at: tempURL, to: destination)
        cached[file.id] = destination
        return destination
    }

    private func cacheURL(for file: ZFile) throws -> URL {
        guard let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            throw CocoaError(.fileNoSuchFile)
        }
        let safeID = sanitizedPathComponent(file.id.isEmpty ? UUID().uuidString : file.id)
        let safeName = sanitizedFilename(file.filename)
        return root
            .appendingPathComponent("ZenithDock", isDirectory: true)
            .appendingPathComponent("DragArtifacts", isDirectory: true)
            .appendingPathComponent(safeID, isDirectory: true)
            .appendingPathComponent(safeName, isDirectory: false)
    }

    private func sanitizedFilename(_ name: String) -> String {
        let cleaned = sanitizedPathComponent(name)
        return cleaned.isEmpty ? "artifact" : cleaned
    }

    private func sanitizedPathComponent(_ value: String) -> String {
        let illegal = CharacterSet(charactersIn: "/:\\")
            .union(.newlines)
            .union(.controlCharacters)
        return value
            .components(separatedBy: illegal)
            .joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
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

struct MobileFullscreenVideoView: View {
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
        case table
    }

    let id: Int
    let kind: Kind
    let text: String
    let language: String?
    let table: MobileMarkdownTable?
}

private enum MobileMarkdownColumnAlignment: Hashable {
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

private struct MobileMarkdownTable: Hashable {
    let headers: [String]
    let alignments: [MobileMarkdownColumnAlignment]
    let rows: [[String]]

    var columnCount: Int {
        max(headers.count, rows.map(\.count).max() ?? 0)
    }

    func columnWidth(_ column: Int) -> CGFloat {
        let samples = ([headers[safe: column]] + rows.map { $0[safe: column] }).compactMap { $0 }
        let longest = samples.map(\.count).max() ?? 0
        if alignments[safe: column] == .trailing {
            return min(max(CGFloat(longest) * 8.0 + 22, 70), 118)
        }
        return min(max(CGFloat(longest) * 7.2 + 26, 88), 300)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
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
                blocks.append(MobileMarkdownBlock(id: blocks.count, kind: .prose, text: text, language: nil, table: nil))
            }
            prose.removeAll(keepingCapacity: true)
        }

        func flushCode() {
            blocks.append(MobileMarkdownBlock(id: blocks.count, kind: .code, text: code.joined(separator: "\n"), language: language, table: nil))
            code.removeAll(keepingCapacity: true)
            language = nil
        }

        func appendTable(_ table: MobileMarkdownTable) {
            blocks.append(MobileMarkdownBlock(id: blocks.count, kind: .table, text: "", language: nil, table: table))
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
                    language = trimmed.dropFirst(3).split(separator: " ").first.map(String.init)
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
        return blocks
    }

    private static func parseTable(lines: [String], start: Int) -> (table: MobileMarkdownTable, consumed: Int)? {
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

        return (
            MobileMarkdownTable(headers: header, alignments: separator.map(alignment), rows: rows),
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

    private static func alignment(_ value: String) -> MobileMarkdownColumnAlignment {
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
