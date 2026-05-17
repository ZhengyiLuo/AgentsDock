import SwiftUI
import UniformTypeIdentifiers
import ZenithCore

#if canImport(UIKit)
import UIKit
#endif

struct MobileTimelineView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var importerOpen: Bool
    @Binding var resumeOpen: Bool
    @State private var isAtBottom = true
    @State private var optionsOpen = false
    @State private var olderHistoryLoadArmed = true
    @State private var suppressScrollHistoryLoadUntilTopLeaves = false
    @State private var visibleRowLimit = 90
    @State private var isFileDropTargeted = false
    private let bottomID = "mobile-timeline-bottom"
    private let rowPageSize = 70

    var body: some View {
        let displayEvents = store.displayEvents
        let allRows = MobileTimelineRows.build(from: displayEvents)
        let jobsByRunID = MobileTimelineRows.jobsByRunID(displayEvents)
        let hiddenRenderedRowCount = max(0, allRows.count - visibleRowLimit)
        let rows = Array(allRows.suffix(visibleRowLimit))

        VStack(spacing: 0) {
            MobileChatHeader(
                resumeOpen: $resumeOpen,
                optionsOpen: $optionsOpen
            )
            Divider()
            ScrollViewReader { proxy in
                ZStack(alignment: .bottomTrailing) {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            if store.isLoading {
                                ProgressView()
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 40)
                            }
                            if store.hiddenDisplayEventCount > 0 || hiddenRenderedRowCount > 0 {
                                MobileTimelineHistoryLoader(hiddenRenderedRowCount: hiddenRenderedRowCount) {
                                    revealOlderRows(preservingPositionWith: proxy)
                                } onLoadOlder: {
                                    loadOlderHistoryFromIntent(proxy)
                                }
                                    .background(MobileHistoryTopReader())
                                    .onAppear {
                                        if !isAtBottom {
                                            handleHistoryTopChange(0, proxy: proxy)
                                        }
                                    }
                                    .onDisappear {
                                        olderHistoryLoadArmed = true
                                        suppressScrollHistoryLoadUntilTopLeaves = false
                                    }
                            }
                            ForEach(rows) { row in
                                switch row {
                                case .event(let event):
                                    MobileEventCard(event: event, job: event.run_id.flatMap { jobsByRunID[$0] })
                                        .id(row.id)
                                case .job(let jobRun):
                                    MobileJobRunBubble(
                                        jobRun: jobRun,
                                        linkContext: store.markdownLinkContext(sessionID: jobRun.runEvent.session_id)
                                    )
                                        .id(row.id)
                                case .jobGroup(let group):
                                    MobileJobRunGroupBubble(
                                        group: group,
                                        linkContext: store.markdownLinkContext(sessionID: group.latest.runEvent.session_id)
                                    )
                                        .id(row.id)
                                case .trace(_, let events):
                                    MobileTraceCard(
                                        events: events,
                                        linkContext: events.first.map { store.markdownLinkContext(sessionID: $0.session_id) }
                                    )
                                        .id(row.id)
                                }
                            }
                            Color.clear
                                .frame(height: 1)
                                .id(bottomID)
                                .onAppear { isAtBottom = true }
                                .onDisappear { isAtBottom = false }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                    }
                    .coordinateSpace(name: "mobileTimelineScroll")
                    .refreshable {
                        await loadOlderHistoryFromPull(proxy)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 8)
                            .onChanged { _ in dismissMobileKeyboard() }
                    )
                    .simultaneousGesture(
                        TapGesture()
                            .onEnded { dismissMobileKeyboard() }
                    )
                    if !isAtBottom && !displayEvents.isEmpty {
                        Button {
                            scrollToBottom(proxy)
                        } label: {
                            Image(systemName: "arrow.down.to.line.compact")
                                .font(.headline)
                        }
                        .buttonStyle(.borderedProminent)
                        .clipShape(Circle())
                        .padding(16)
                    }
                    if isFileDropTargeted {
                        MobileTimelineFileDropOverlay()
                            .padding(18)
                            .allowsHitTesting(false)
                    }
                }
                .onDrop(of: MobileTimelineFileDrop.supportedTypes, isTargeted: $isFileDropTargeted) { providers in
                    acceptTimelineFileDrop(providers)
                }
                .onChange(of: store.scrollRevision) {
                    if isAtBottom {
                        scrollToBottom(proxy)
                    }
                }
                .onChange(of: store.selectedSessionID) {
                    isAtBottom = true
                    olderHistoryLoadArmed = true
                    suppressScrollHistoryLoadUntilTopLeaves = false
                    visibleRowLimit = 90
                    scrollToBottom(proxy)
                }
                .onChange(of: displayEvents.count) {
                    if displayEvents.isEmpty {
                        visibleRowLimit = 90
                    } else if isAtBottom {
                        visibleRowLimit = min(max(visibleRowLimit, 90), max(MobileTimelineRows.build(from: displayEvents).count, 90))
                    }
                }
                .onChange(of: store.hiddenDisplayEventCount) {
                    if store.hiddenDisplayEventCount <= 0 {
                        olderHistoryLoadArmed = false
                        suppressScrollHistoryLoadUntilTopLeaves = false
                    }
                }
                .onPreferenceChange(MobileHistoryTopPreferenceKey.self) { topY in
                    handleHistoryTopChange(topY, proxy: proxy)
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            MobileComposerView(importerOpen: $importerOpen)
        }
        .sheet(isPresented: $optionsOpen) {
            MobileChatOptionsView(isPresented: $optionsOpen, resumeOpen: $resumeOpen)
                .environmentObject(store)
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.snappy) {
            proxy.scrollTo(bottomID, anchor: .bottom)
            isAtBottom = true
        }
    }

    private func handleHistoryTopChange(_ topY: CGFloat?, proxy: ScrollViewProxy) {
        guard let topY else { return }
        let topIsVisible = topY >= -24 && topY <= 96
        let topHasLeftViewport = topY < -64 || topY > 160

        if topHasLeftViewport {
            olderHistoryLoadArmed = true
            suppressScrollHistoryLoadUntilTopLeaves = false
            return
        }

        guard topIsVisible,
              !isAtBottom,
              olderHistoryLoadArmed,
              !suppressScrollHistoryLoadUntilTopLeaves else {
            return
        }
        if revealOlderRows(preservingPositionWith: proxy) {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            return
        }
        guard store.canLoadOlderHistory else { return }
        olderHistoryLoadArmed = false
        suppressScrollHistoryLoadUntilTopLeaves = true
        loadOlderHistoryPreservingPosition(proxy)
    }

    private func loadOlderHistoryFromIntent(_ proxy: ScrollViewProxy) {
        if revealOlderRows(preservingPositionWith: proxy) {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            return
        }
        guard store.canLoadOlderHistory else { return }
        olderHistoryLoadArmed = false
        suppressScrollHistoryLoadUntilTopLeaves = true
        loadOlderHistoryPreservingPosition(proxy)
    }

    private func loadOlderHistoryFromPull(_ proxy: ScrollViewProxy) async {
        if revealOlderRows(preservingPositionWith: proxy) {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            return
        }
        if store.canLoadOlderHistory {
            let anchorID = firstRenderedRowID()
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            await store.loadOlderHistory()
            restoreScrollPosition(to: anchorID, proxy: proxy)
            return
        }
        await store.refreshTimelineFromPull()
    }

    @discardableResult
    private func revealOlderRows(preservingPositionWith proxy: ScrollViewProxy) -> Bool {
        let anchorID = firstRenderedRowID()
        let rowCount = MobileTimelineRows.build(from: store.displayEvents).count
        guard visibleRowLimit < rowCount else { return false }
        visibleRowLimit = min(rowCount, visibleRowLimit + rowPageSize)
        restoreScrollPosition(to: anchorID, proxy: proxy)
        return true
    }

    private func loadOlderHistoryPreservingPosition(_ proxy: ScrollViewProxy) {
        let anchorID = firstRenderedRowID()
        Task {
            await store.loadOlderHistory()
            restoreScrollPosition(to: anchorID, proxy: proxy)
        }
    }

    private func firstRenderedRowID() -> String? {
        let rows = MobileTimelineRows.build(from: store.displayEvents)
        return Array(rows.suffix(visibleRowLimit)).first?.id
    }

    private func restoreScrollPosition(to rowID: String?, proxy: ScrollViewProxy) {
        guard let rowID else { return }
        DispatchQueue.main.async {
            proxy.scrollTo(rowID, anchor: .top)
            isAtBottom = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                olderHistoryLoadArmed = true
                suppressScrollHistoryLoadUntilTopLeaves = false
            }
        }
    }

    private func acceptTimelineFileDrop(_ providers: [NSItemProvider]) -> Bool {
        guard store.selectedSessionID != nil else { return false }
        Task {
            let urls = await MobileTimelineFileDrop.urls(from: providers)
            guard !urls.isEmpty else { return }
            await store.upload(urls: urls)
        }
        return true
    }
}

private struct MobileTimelineFileDropOverlay: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 16)
            .fill(Color.accentColor.opacity(0.14))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(Color.accentColor.opacity(0.75), style: StrokeStyle(lineWidth: 2, dash: [7, 5]))
            )
            .overlay {
                Label("Drop files to attach", systemImage: "paperclip")
                    .font(.headline.weight(.semibold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
            }
    }
}

enum MobileTimelineFileDrop {
    static let supportedTypes: [UTType] = [.fileURL, .url, .item]

    @MainActor
    static func urls(from providers: [NSItemProvider]) async -> [URL] {
        var urls: [URL] = []
        var seen = Set<String>()

        for provider in providers {
            guard let url = await url(from: provider), url.isFileURL else { continue }
            let key = url.standardizedFileURL.path
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            urls.append(url)
        }
        return urls
    }

    @MainActor
    private static func url(from provider: NSItemProvider) async -> URL? {
        for type in [UTType.fileURL.identifier, UTType.url.identifier] {
            guard provider.hasItemConformingToTypeIdentifier(type),
                  let item = try? await provider.loadItem(forTypeIdentifier: type) else {
                continue
            }
            if let url = decodeURL(item) {
                return url
            }
        }

        for type in provider.registeredTypeIdentifiers {
            guard let url = await loadInPlaceFileURL(from: provider, typeIdentifier: type) else { continue }
            return url
        }
        return nil
    }

    private static func decodeURL(_ item: NSSecureCoding) -> URL? {
        if let url = item as? URL {
            return url
        }
        if let url = item as? NSURL {
            return url as URL
        }
        if let data = item as? Data {
            return URL(dataRepresentation: data, relativeTo: nil)
        }
        if let string = item as? String {
            return URL(string: string)
        }
        if let string = item as? NSString {
            return URL(string: string as String)
        }
        return nil
    }

    @MainActor
    private static func loadInPlaceFileURL(from provider: NSItemProvider, typeIdentifier: String) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadInPlaceFileRepresentation(forTypeIdentifier: typeIdentifier) { url, _, _ in
                continuation.resume(returning: url)
            }
        }
    }
}

@MainActor
private func dismissMobileKeyboard() {
    #if canImport(UIKit)
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    #endif
}

private struct MobileChatHeader: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var resumeOpen: Bool
    @Binding var optionsOpen: Bool

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(store.selectedSession?.title ?? "Chat")
                    .font(.headline)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Menu {
                Button {
                    resumeOpen = true
                } label: {
                    Label("Resume Chat", systemImage: "arrow.uturn.forward.circle")
                }
                Button {
                    optionsOpen = true
                } label: {
                    Label("Chat Options", systemImage: "slider.horizontal.3")
                }
                Picker("Backend", selection: Binding(
                    get: { store.selectedSession?.backend ?? "claude" },
                    set: { newValue in Task { await store.updateSelected(backend: newValue, model: "") } }
                )) {
                    Text("Claude").tag("claude")
                    Text("Codex").tag("codex")
                }
                if let session = store.selectedSession {
                    Picker("Model", selection: Binding(
                        get: { normalized(session.model) },
                        set: { newValue in Task { await store.updateSelected(model: newValue) } }
                    )) {
                        ForEach(modelOptions(for: session)) { option in
                            Text(option.label).tag(option.value)
                        }
                    }
                    Picker("Effort", selection: Binding(
                        get: { normalized(session.effort) },
                        set: { newValue in Task { await store.updateSelected(effort: newValue) } }
                    )) {
                        ForEach(effortOptions(for: session)) { option in
                            Text(option.label).tag(option.value)
                        }
                    }
                }
                if let session = store.selectedSession {
                    Button {
                        Task { await store.togglePin(session) }
                    } label: {
                        Label(session.pinned == true ? "Unpin Chat" : "Pin Chat", systemImage: session.pinned == true ? "pin.slash" : "pin")
                    }
                    Button {
                        Task { await store.forkSelected() }
                    } label: {
                        Label("Fork Chat", systemImage: "arrow.triangle.branch")
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var subtitle: String {
        guard let session = store.selectedSession else { return store.status }
        if let provider = compactProviderID(session.session_id) {
            return "\(store.runtimeCatalog.compactSummary(for: session)) · session \(provider)"
        }
        return "\(store.runtimeCatalog.compactSummary(for: session)) · \(session.folder ?? "General")"
    }

    private func modelOptions(for session: ZSession) -> [ZRuntimeOption] {
        optionsWithCurrent(store.runtimeCatalog.models(for: session.backend), current: session.model)
    }

    private func effortOptions(for session: ZSession) -> [ZRuntimeOption] {
        optionsWithCurrent(store.runtimeCatalog.efforts(for: session.backend), current: session.effort)
    }

    private func optionsWithCurrent(_ options: [ZRuntimeOption], current: String?) -> [ZRuntimeOption] {
        let clean = normalized(current)
        guard !clean.isEmpty, !options.contains(where: { $0.value == clean }) else {
            return options
        }
        return options + [ZRuntimeOption(value: clean, label: clean)]
    }

    private func normalized(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}

private struct MobileTimelineHistoryLoader: View {
    @EnvironmentObject private var store: MobileAppStore
    let hiddenRenderedRowCount: Int
    let onShowOlderRows: () -> Void
    let onLoadOlder: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
                .foregroundStyle(.secondary)
            Text("\(totalOlderCount) older")
                .font(.caption.weight(.semibold))
            Text("messages")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            if hiddenRenderedRowCount > 0 {
                Button {
                    onShowOlderRows()
                } label: {
                    Label("Show", systemImage: "arrow.up")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            } else if store.isLoadingOlderHistory {
                ProgressView()
                    .controlSize(.small)
            } else {
                Button {
                    onLoadOlder()
                } label: {
                    Label("Load", systemImage: "arrow.up")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(!store.canLoadOlderHistory)
            }
        }
        .font(.caption)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.thinMaterial)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(MobileTheme.softLine))
    }

    private var totalOlderCount: Int {
        store.hiddenDisplayEventCount + hiddenRenderedRowCount
    }
}

private struct MobileHistoryTopReader: View {
    var body: some View {
        GeometryReader { proxy in
            Color.clear.preference(
                key: MobileHistoryTopPreferenceKey.self,
                value: proxy.frame(in: .named("mobileTimelineScroll")).minY
            )
        }
    }
}

private struct MobileHistoryTopPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat? = nil

    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
        value = nextValue() ?? value
    }
}

private enum MobileTimelineRow: Identifiable {
    case event(ZEvent)
    case job(MobileJobRunRow)
    case jobGroup(MobileJobRunGroupRow)
    case trace(String, [ZEvent])

    var id: String {
        switch self {
        case .event(let event): return "event-\(event.id)"
        case .job(let jobRun): return "job-\(jobRun.id)-\(jobRun.lastSeq)"
        case .jobGroup(let group): return "job-group-\(group.id)"
        case .trace(let id, _): return id
        }
    }
}

private enum MobileTimelineRows {
    private static let traceTypes: Set<String> = [
        "reasoning_summary",
        "tool_started",
        "tool_finished",
        "idle_warning",
        "raw_event",
        "process_started",
        "provider_session",
        "cwd_fallback",
        "history_imported",
        "backend_changed",
        "artifact_error",
        "session_created"
    ]

    static func build(from events: [ZEvent]) -> [MobileTimelineRow] {
        let jobRuns = jobRunsByRunID(events)
        let jobRunIDs = Set(jobRuns.keys)
        var rows: [MobileTimelineRow] = []
        var trace: [ZEvent] = []
        var pendingJobRuns: [MobileJobRunRow] = []

        func flushTrace() {
            guard let first = trace.first, let last = trace.last else { return }
            rows.append(.trace("trace-\(first.seq)-\(last.seq)", trace))
            trace.removeAll(keepingCapacity: true)
        }

        func flushJobRuns() {
            guard !pendingJobRuns.isEmpty else { return }
            if pendingJobRuns.count == 1, let run = pendingJobRuns.first {
                rows.append(.job(run))
            } else {
                rows.append(.jobGroup(MobileJobRunGroupRow(runs: pendingJobRuns)))
            }
            pendingJobRuns.removeAll(keepingCapacity: true)
        }

        func appendJobRun(_ run: MobileJobRunRow) {
            if let previous = pendingJobRuns.last, previous.job.id != run.job.id {
                flushJobRuns()
            }
            pendingJobRuns.append(run)
        }

        for event in events {
            if event.type == "job_ran", let runID = event.run_id, let jobRun = jobRuns[runID] {
                flushTrace()
                appendJobRun(jobRun)
                continue
            }
            if shouldFoldIntoJobResponse(event, jobRunIDs: jobRunIDs) {
                continue
            }
            flushJobRuns()
            if traceTypes.contains(event.type) {
                trace.append(event)
            } else {
                flushTrace()
                rows.append(.event(event))
            }
        }
        flushJobRuns()
        flushTrace()
        return rows
    }

    static func jobsByRunID(_ events: [ZEvent]) -> [String: ZJob] {
        jobRunsByRunID(events).mapValues(\.job)
    }

    static func jobRunsByRunID(_ events: [ZEvent]) -> [String: MobileJobRunRow] {
        var rows: [String: MobileJobRunRow] = [:]
        var assistantText: [String: [String]] = [:]
        var errors: [String: [String]] = [:]

        for event in events {
            guard let runID = event.run_id else { continue }
            switch event.type {
            case "job_ran":
                if let job = event.job {
                    rows[runID] = MobileJobRunRow(
                        id: runID,
                        runEvent: event,
                        job: job,
                        resultText: nil,
                        errorText: nil,
                        isFinished: false,
                        lastSeq: event.seq
                    )
                }
            case "assistant_text":
                if let text = event.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                    assistantText[runID, default: []].append(text)
                }
            case "turn_finished":
                if var row = rows[runID] {
                    let result = event.result_text?.trimmingCharacters(in: .whitespacesAndNewlines)
                    row.resultText = result?.isEmpty == false ? result : assistantText[runID]?.joined(separator: "\n\n")
                    row.isFinished = true
                    row.lastSeq = max(row.lastSeq, event.seq)
                    rows[runID] = row
                }
            case "error":
                let message = (event.message ?? event.error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !message.isEmpty {
                    errors[runID, default: []].append(message)
                }
            default:
                break
            }
        }

        for (runID, textParts) in assistantText {
            guard var row = rows[runID], row.resultText?.isEmpty != false else { continue }
            let text = textParts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                row.resultText = text
                rows[runID] = row
            }
        }

        for (runID, errorParts) in errors {
            guard var row = rows[runID] else { continue }
            row.errorText = errorParts.joined(separator: "\n\n")
            rows[runID] = row
        }

        return rows
    }

    private static func shouldFoldIntoJobResponse(_ event: ZEvent, jobRunIDs: Set<String>) -> Bool {
        guard let runID = event.run_id, jobRunIDs.contains(runID) else { return false }
        switch event.type {
        case "turn_started",
             "assistant_text",
             "process_started",
             "provider_session",
             "reasoning_summary",
             "tool_started",
             "tool_finished",
             "raw_event",
             "idle_warning",
             "cwd_fallback",
             "turn_finished",
             "error":
            return true
        default:
            return false
        }
    }
}

struct MobileJobRunRow: Identifiable, Hashable {
    let id: String
    let runEvent: ZEvent
    let job: ZJob
    var resultText: String?
    var errorText: String?
    var isFinished: Bool
    var lastSeq: Int
}

struct MobileJobRunGroupRow: Identifiable, Hashable {
    let id: String
    let runs: [MobileJobRunRow]

    init(runs: [MobileJobRunRow]) {
        self.runs = runs
        let first = runs.first
        let last = runs.last
        self.id = "\(last?.job.id ?? "job")-\(first?.runEvent.seq ?? 0)-\(last?.lastSeq ?? 0)-\(runs.count)"
    }

    var latest: MobileJobRunRow {
        runs[runs.count - 1]
    }

    var olderNewestFirst: [MobileJobRunRow] {
        Array(runs.dropLast().reversed())
    }
}
